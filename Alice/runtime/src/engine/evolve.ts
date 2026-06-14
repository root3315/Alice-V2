/**
 * Поток EVOLVE: цикл тиков по таймеру (ADR-26 v5).
 *
 * Каждый тик:
 * 1. Обслуживание Self (обновление проекции эмоций)
 * 2. PERCEIVE (потребление событий)
 * 3. Вычисление давлений → карта напряжений → фокус-множество → голос → выбор действия/цели
 * 4. Гейтинг (ограничение частоты действий + Social Value Gate)
 * 5. При прохождении — enqueue в ActionQueue
 *
 * ADR-268: проекция self-аффекта, действие digest, System1Options.
 */

import { eq } from "drizzle-orm";
import type { Config } from "../config.js";
import type { Dispatcher } from "../core/dispatcher.js";
import { typedQuery } from "../core/query-helpers.js";
import { writeAuditEvent } from "../db/audit.js";
import { getDb } from "../db/connection.js";
import { type DecisionTracePayload, writeDecisionTrace } from "../db/decision-trace.js";
import { gcExpiredFacts } from "../db/maintenance.js";
import {
  makeCandidateId,
  makeEnqueueId,
  makeRankedCandidateId,
  pressureVectorFromDims,
  writeCandidateTrace,
  writePressureDeltasForPreviousTrace,
  writeQueueTrace,
  writeTickTrace,
} from "../db/observation-spine.js";
import { rhythmProfiles, silenceLog, tickLog } from "../db/schema.js";
import { flushGraph } from "../db/snapshot.js";
import { computeClosureHealth } from "../diagnostics/closure-health.js";
import { appraiseLonelySilence } from "../emotion/appraisal.js";
import { updateEmotionStateOnGraph } from "../emotion/graph.js";
import {
  ALICE_SELF,
  chatIdToContactId,
  ensureChannelId,
  ensureContactId,
  extractNumericId,
} from "../graph/constants.js";
import type { DunbarTier } from "../graph/entities.js";
import { buildTensionMap, routeContributions } from "../graph/tension.js";
import type { WorldModel } from "../graph/world-model.js";
import { isAnyProviderHealthy } from "../llm/client.js";
import { persistBehavioralInsights } from "../llm/self-observation.js";
import {
  type AdaptiveKappa,
  type AllPressures,
  computeAllPressures,
  type PressureHistory,
} from "../pressure/aggregate.js";
import { updateAttentionDebt } from "../pressure/attention-debt.js";
import { computeGoldilocksUtility } from "../pressure/goldilocks.js";
import {
  computeHawkesLambdaDiscount,
  effectiveMu,
  getDefaultParams as getHawkesParams,
  type HawkesParams,
  type HawkesState,
  queryIntensity,
} from "../pressure/hawkes.js";
import { computeNaturalness } from "../pressure/naturalness.js";
import type { CuriosityHistory } from "../pressure/p6-curiosity.js";
import {
  ACT_SILENCE_SAFETY_THRESHOLD,
  computeHabituationFactor,
  DORMANT_PRESSURE_FACTOR,
  effectiveActSilences,
  effectiveObligation,
  effectiveRisk,
  isConversationContinuation,
  isInQuietWindow,
  OBLIGATION_THRESHOLDS,
  SILENCE_COOLDOWN_THRESHOLD,
} from "../pressure/signal-decay.js";
import { ChatTarget } from "../prompt/types.js";
import { maybeAutoUpgrade } from "../skills/auto-upgrade.js";
import type { EventBuffer } from "../telegram/events.js";
import { createLogger } from "../utils/logger.js";
import type { AgentMode, TickClock } from "../utils/time.js";
import { computeLoudness, computeUncertainty } from "../voices/loudness.js";
import { type FacetContext, normalizePressuresForFacet, selectFacet } from "../voices/palette.js";
import type { PersonalityVector, VoiceAction } from "../voices/personality.js";
import { selectAction } from "../voices/selection.js";
import type { ActionQueue } from "./action-queue.js";
import {
  commitTickEvents,
  emit as emitConsciousness,
  gc as gcConsciousness,
} from "./consciousness.js";
import { tickConversations } from "./conversation.js";
import { evaluateDeferredOutcome, scanPendingOutcomes } from "./deferred-outcome.js";
import {
  addImpulse,
  type DeliberationState,
  IMPULSE_MIN_VALUE,
  onActionEnqueued,
  onSilence,
  type PendingImpulse,
  SILENCE_VOI_DECAY_RATE,
} from "./deliberation.js";
import { deriveDesires, findTopDesireForTarget } from "./desire.js";
import {
  type EpisodeWorkingState,
  injectResidueContributions,
  refreshResidueCache,
  updateEpisode,
} from "./episode.js";
import {
  classifyChatType,
  countActionsByClass,
  gateAPIFloor,
  gateClosingConversation,
  gateConversationAware,
  gateIdleSelfStart,
  resolveIsBot,
  runGateChain,
  type SilenceLevel,
  type SilenceValues,
} from "./gates.js";
import { runGenerators, updateChannelRateEma } from "./generators.js";
import {
  assembleIAUSReason,
  type CandidateContext,
  type IAUSCandidate,
  type IAUSConfig,
  type IAUSFilterStats,
  type IAUSScoredCandidate,
  type RhythmTimingProfile,
  scoreAllCandidatesDetailed,
} from "./iaus-scorer.js";
import { perceiveTick } from "./perceive.js";
import { classifySilence, computeVoINull } from "./silence.js";
import { trySystem1 } from "./system1.js";

const log = createLogger("evolve");

/** ADR-252 Wave 1: queue/ACT active saturation at or above this value suppresses non-bypass IAUS winners. */
const IAUS_QUEUE_BACKPRESSURE_SATURATION = 0.8;
/** Post-wakeup recovery: briefly keep Alice on a small set of already-open targets. */
export const POST_WAKEUP_RECOVERY_MS = 10 * 60 * 1000;
const POST_WAKEUP_RECOVERY_TARGET_BUDGET = 2;

/**
 * ADR-64 II-2: записывает событие тишины в таблицу silence_log.
 * Вызывается на выходе gate skip после того, как голос выбран и цель определена.
 */
function recordSilence(
  tick: number,
  voice: string,
  target: string | null,
  reason: string,
  values: SilenceValues,
  silenceLevel?: SilenceLevel,
): void {
  try {
    const db = getDb();
    db.insert(silenceLog)
      .values({
        tick,
        voice,
        target,
        reason,
        netValue: values.netValue ?? null,
        deltaP: values.deltaP ?? null,
        socialCost: values.socialCost ?? null,
        apiValue: values.apiValue ?? null,
        silenceLevel: silenceLevel ?? null,
      })
      .run();
  } catch (e) {
    log.warn("Failed to write silence log", e);
  }
}

export interface EvolveState {
  G: WorldModel;
  personality: PersonalityVector;
  clock: TickClock;
  buffer: EventBuffer;
  queue: ActionQueue;
  config: Config;
  /** История сглаженного P6 curiosity pressure; семантика — давление, а не novelty satisfaction. */
  curiosityHistory: CuriosityHistory;
  recentEventCounts: number[];
  /**
   * Журнал последних реальных действий.
   * ADR-173: записывается только после подтверждения действия в Telegram потоком act (коллбэк recordAction),
   * не при enqueue оптимистично — устраняет фантомные записи (silence/observe/llm_failed).
   */
  recentActions: Array<{ tick: number; action: string; ms: number; target: string | null }>;
  dispatcher: Dispatcher;
  /** H1: метка стенных часов последнего действия (мс). */
  lastActionMs: number;
  /** D2 Trend: инстанциированная история давлений (устраняет глобальное изменяемое состояние). */
  pressureHistory: PressureHistory;
  /**
   * ADR-75: рабочая память среднего временного масштаба.
   * Усталость голоса + сохранение импульсов + накопление тишины + линейка действий.
   * @see docs/adr/75-deliberation-state/75-deliberation-state.md
   */
  deliberation: DeliberationState;
  /** Инжектируемый UTC-час (0-23) для circadian-гейтинга. При отсутствии — берётся с настенных часов. */
  utcHour?: number;
  /**
   * ADR-100: карта долга внимания (channel → debt).
   * Поддерживается между тиками, обновляется в пайплайне evolve.
   * @see docs/adr/100-attention-debt.md §9
   */
  attentionDebtMap: Map<string, number>;
  /** ADR-100: выбранная цель действия на предыдущем тике (для оценки накопления долга). null = молчание/skip. */
  lastSelectedTarget: string | null;
  /** ADR-182 D1: выбранная пара (action, target) на предыдущем тике — основа Momentum Bonus. */
  lastSelectedCandidate: { action: VoiceAction; target: string } | null;

  // ── Agent Mode FSM (статья §6.2) ─────────────────────────────────
  /** Текущий режим работы. */
  mode: AgentMode;
  /** Целевой канал, зафиксированный в режиме conversation. */
  focusTarget?: string;
  /** Метка стенных часов входа в текущий режим (мс). */
  modeEnteredMs: number;
  /** ADR-112 D4: инстанция адаптивного κ. */
  adaptiveKappa: AdaptiveKappa;
  /**
   * ADR-115: EMA скорости сообщений per-channel.
   * @see docs/adr/115-evolve-observability/
   */
  channelRateEma: Map<string, { ema: number; variance: number }>;
  /**
   * ADR-191: счётчик сообщений per-channel последнего вызова perceiveTick.
   * Источник данных spike-сигналов — computeTickPlan сравнивает с channelRateEma для вычисления z-score.
   */
  lastChannelCounts: Map<string, number>;
  /** ADR-147 D2: EMA счётчика событий (базовый уровень обнаружения переполнения). */
  eventCountEma: number;
  /** ADR-147 D12: счётчик последовательных flood-тиков (для исключения avgP1 при cap P1). */
  floodTickCount: number;
  /** ADR-190: число тиков, прошедших в режиме wakeup. */
  wakeupTicksElapsed: number;
  /** ADR-190: цели, к которым было активное обращение в период wakeup (разрешает продолжение разговора, ограничивает распространение на новые цели). */
  wakeupEngagedTargets: Set<string>;
  /** Post-wakeup recovery window end timestamp. Ordinary proactive stays near wakeup targets. */
  wakeupRecoveryUntilMs?: number;
  /** Последнее агрегированное значение API (используется startEvolveLoop для расчёта интервала). */
  lastAPI: number;
  /** ADR-195: Peak-based API — управляет расписанием тик-интервала. */
  lastAPIPeak: number;
  /** Метка стенных часов последнего успешного flushGraph (мс). Используется для повтора OL-5. */
  lastFlushMs: number;
  /** dt текущего тика (секунды), вычисляется advance(). */
  currentDt: number;

  // ── ADR-190: экспоненциальная отсрочка при сбоях LLM на уровне планировщика ───────────────────
  /**
   * Отслеживание результатов LLM-вызовов потока act.
   * Поток evolve читает это в startEvolveLoop для вычисления мультипликатора отсрочки тик-интервала.
   * Поток act записывает через коллбэк ActContext.reportLLMOutcome.
   */
  llmBackoff: {
    /** Количество последовательных сбоев LLM. Сбрасывается в 0 при первом успехе. */
    consecutiveFailures: number;
    /** Метка стенных часов последнего сбоя (мс). Используется для автосброса по таймауту отсрочки. */
    lastFailureMs: number;
  };

  // ── ADR-215: Cognitive Episode Graph ──────────────────────────────────
  /**
   * Рабочее состояние когнитивных эпизодов.
   * Поддерживается между тиками: текущий активный episode + кэш активных residue.
   * @see docs/adr/215-cognitive-episode-graph.md
   */
  episodeState: EpisodeWorkingState;
}

// ═══════════════════════════════════════════════════════════════════════════
// ADR-147: обнаружение переполнения — скачок EMA + состояние mtcute = единый предикат
// ═══════════════════════════════════════════════════════════════════════════

export const EMA_ALPHA = 0.1;

/**
 * Обнаружение переполнения по EMA: если eventCount превышает 3×EMA (не менее 50), фиксируется переполнение.
 * События переполнения не участвуют в обновлении EMA (чтобы не загрязнять базовый уровень).
 *
 * @see docs/adr/147-flood-backlog-recovery.md §D2
 */
export function detectBacklog(state: { eventCountEma: number }, eventCount: number): boolean {
  const threshold = Math.max(3 * state.eventCountEma, 50);
  return eventCount > threshold;
  // ADR-147 D9: обновление EMA перенесено в единственную точку вызова evolveTick, эта функция — чистый запрос.
}

/**
 * Единый предикат flood-условия: восстановление после переподключения mtcute ИЛИ статистический вывод EMA.
 * Все нижестоящие потребители (cap P1, защита mode) используют этот предикат единообразно.
 *
 * @see docs/adr/147-flood-backlog-recovery.md §D2
 */
export function isFloodCondition(
  state: { buffer: { isRecovering: boolean }; eventCountEma: number },
  eventCount: number,
): boolean {
  return state.buffer.isRecovering || detectBacklog(state, eventCount);
}

/**
 * Постановка в очередь + учёт состояния (вынесено из 3 мест copy-paste).
 * Устанавливает lastActionTick, отслеживает recentActions, очищает устаревшее окно.
 */
function enqueueAndRecord(
  state: EvolveState,
  tick: number,
  nowMs: number,
  action: VoiceAction,
  target: string | null,
  pressures: AllPressures,
  focalEntities: string[],
  reason?: string,
  vmaxScored?: IAUSScoredCandidate[],
  vmaxSpread?: number,
  facetId?: string,
): void {
  const candidateId = makeCandidateId(tick, action, target);
  const enqueueId = makeEnqueueId(tick, action, target);
  const pressureSnapshot: [number, number, number, number, number, number] = [
    pressures.P1,
    pressures.P2,
    pressures.P3,
    pressures.P4,
    pressures.P5,
    pressures.P6,
  ];
  const item = {
    enqueueTick: tick,
    action,
    target,
    pressureSnapshot,
    contributions: pressures.contributions,
    focalEntities,
    reason: state.mode === "wakeup" ? "wakeup" : reason,
    vmaxScored,
    vmaxSpread,
    facetId,
    // ADR-215: episode ID детерминирован (episode:${tick}), можно вычислить заранее.
    // updateEpisode выполняется после enqueue, но ID можно определить заблаговременно.
    episodeId:
      state.episodeState.currentId ??
      (target && target !== state.episodeState.currentTarget ? `episode:${tick}` : undefined),
    observation: { candidateId, enqueueId, api: pressures.API, apiPeak: pressures.API_peak },
  };
  const result = state.queue.enqueue(item);
  const metrics = state.queue.getMetrics();
  writeQueueTrace({
    tick,
    candidateId,
    enqueueId,
    enqueueOutcome: result.outcome,
    fate: result.outcome === "accepted" ? "accepted" : "dropped",
    queueDepth: metrics.queued,
    activeCount: metrics.active,
    saturation: metrics.saturation,
    reasonCode: result.outcome === "accepted" ? `enqueue_${result.delivery}` : "rejected_overflow",
  });
  if (result.evicted?.observation) {
    writeQueueTrace({
      tick,
      candidateId: result.evicted.observation.candidateId,
      enqueueId: result.evicted.observation.enqueueId,
      enqueueOutcome: "accepted",
      fate: "dropped",
      queueDepth: metrics.queued,
      activeCount: metrics.active,
      saturation: metrics.saturation,
      supersededByEnqueueId: enqueueId,
      reasonCode: "overflow_evicted",
    });
  }
  state.lastActionMs = nowMs;
  // ADR-173: recentActions здесь не записывается — записывается коллбэком recordAction после подтверждения потоком act.
  // lastActionMs сохраняет оптимистичное обновление: семантика "время, когда Alice последний раз намеревалась действовать" (оценка простоя),
  // отделена от семантики recentActions "журнал реальных выполнений" (подсчёт частоты).
}

// ═══════════════════════════════════════════════════════════════════════════
// TickPlan — чистый вывод пайплайна evolve
// ═══════════════════════════════════════════════════════════════════════════

/**
 * TickPlan — чистый вывод пайплайна evolve.
 * Описывает "что должно произойти", не выполняя побочных эффектов.
 * @see paper/ eq. G → P → τ → (L, E_v) → a* → G'
 */
type TickPlan =
  | {
      type: "enqueue";
      action: VoiceAction;
      target: string | null;
      pressures: AllPressures;
      focalEntities: string[];
      voice: string;
      /** Net Social Value победителя V-max (для линейки действий ADR-75). */
      netValue: number;
      /** Структурированное обоснование действия на стороне движка. */
      reason?: string;
      /** ADR-115: ожидаемое снижение давления ΔP. */
      deltaP?: number;
      /** ADR-115: социальная стоимость C_social. */
      socialCost?: number;
      /** ADR-115: вероятность выбора softmax. */
      selectedProbability?: number;
      /** D8: оцениваемые кандидаты V-max (для fan-out). */
      vmaxScored?: IAUSScoredCandidate[];
      /** D8: разброс кандидатов V-max (условие запуска fan-out). */
      vmaxSpread?: number;
      /** ADR-174: ID персонального аспекта. */
      facetId?: string;
    }
  | {
      type: "system1";
      decision: ReturnType<typeof trySystem1>;
      pressures: AllPressures;
      voice: string;
      target: string | null;
      focalEntities: string[];
    }
  | {
      type: "silent";
      pressures: AllPressures;
      voice: string;
      target: string | null;
      reason: string;
      level: SilenceLevel;
      values: SilenceValues;
      focalEntities: string[];
      /** ADR-75: высокий V-импульс при VoI-deferred (addImpulse выполняется в applyPlan). */
      impulseToRetain?: Omit<PendingImpulse, "decay" | "salience">;
      /** ADR-258: сохранять пул кандидатов IAUS, оценённых в этом tick, даже если в итоге выбрано молчание. */
      vmaxScored?: IAUSScoredCandidate[];
    }
  | { type: "skip"; reason: string };

/** ADR-115: форматирует унифицированную метку результата решения для аудита tick_log. */
function formatGateVerdict(plan: TickPlan): string {
  switch (plan.type) {
    case "enqueue":
      return "enqueue";
    case "system1":
      return `system1:${plan.decision.action}`;
    case "silent":
      return `silent:${plan.level}`;
    case "skip":
      return `skip:${plan.reason}`;
  }
}

function pressureTracePayload(pressures: AllPressures): Record<string, number> {
  return {
    p1: pressures.P1,
    p2: pressures.P2,
    p3: pressures.P3,
    p4: pressures.P4,
    p5: pressures.P5,
    p6: pressures.P6,
    api: pressures.API,
    apiPeak: pressures.API_peak,
  };
}

function pressureVectorSnapshot(pressures: AllPressures) {
  return pressureVectorFromDims(
    [pressures.P1, pressures.P2, pressures.P3, pressures.P4, pressures.P5, pressures.P6],
    pressures.API,
    pressures.API_peak,
  );
}

function silenceValuesFromCandidate(
  candidate: IAUSCandidate,
  bestV: number,
  apiValue: number,
  extra: SilenceValues = {},
): SilenceValues {
  return {
    ...extra,
    netValue: bestV,
    deltaP: candidate.deltaP,
    socialCost: candidate.socialCost,
    apiValue,
  };
}

function topIausFilterReason(stats: IAUSFilterStats | null | undefined): {
  reason: string;
  count: number;
} | null {
  if (!stats) return null;
  let top: { reason: string; count: number } | null = null;
  for (const [reason, count] of Object.entries(stats.filtered)) {
    const n = Number(count ?? 0);
    if (n <= 0) continue;
    if (!top || n > top.count) top = { reason, count: n };
  }
  return top;
}

function emptyCandidatePoolReason(stats: IAUSFilterStats | null | undefined): string {
  const top = topIausFilterReason(stats);
  return top ? `candidate_pool_empty:${top.reason}` : "all_candidates_negative";
}

function emptyCandidatePoolValues(
  apiValue: number,
  stats: IAUSFilterStats | null | undefined,
): SilenceValues {
  const top = topIausFilterReason(stats);
  return {
    apiValue,
    ...(stats
      ? {
          iausFilterTotalChannels: stats.totalChannels,
          iausFilterEligibleTargets: stats.eligibleTargets,
        }
      : {}),
    ...(top ? { iausFilterTopReasonCount: top.count } : {}),
  };
}

function makeRhythmTimingProfileReader(): (
  target: string,
  chatType?: string,
) => RhythmTimingProfile | null {
  const cache = new Map<string, RhythmTimingProfile | null>();

  return (target: string, chatType?: string) => {
    const cacheKey = `${chatType ?? "unknown"}:${target}`;
    if (cache.has(cacheKey)) return cache.get(cacheKey) ?? null;

    try {
      for (const entityId of rhythmProfileLookupIds(target, chatType)) {
        const row = getDb()
          .select({
            activeNowScore: rhythmProfiles.activeNowScore,
            quietNowScore: rhythmProfiles.quietNowScore,
            confidence: rhythmProfiles.confidence,
            stale: rhythmProfiles.stale,
          })
          .from(rhythmProfiles)
          .where(eq(rhythmProfiles.entityId, entityId))
          .get();

        const profile = row ? rhythmTimingProfileFromRow(row) : null;
        if (profile) {
          cache.set(cacheKey, profile);
          return profile;
        }
      }

      const profile = null;
      cache.set(cacheKey, profile);
      return profile;
    } catch {
      cache.set(cacheKey, null);
      return null;
    }
  };
}

function rhythmProfileLookupIds(target: string, chatType?: string): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  const push = (id: string | null) => {
    if (!id || seen.has(id)) return;
    seen.add(id);
    ids.push(id);
  };

  push(target);
  const channelId = ensureChannelId(target);
  const contactId = positiveContactId(target);
  if (chatType === "private") {
    push(contactId);
    push(channelId);
    return ids;
  }

  push(channelId);
  if (chatType !== "channel") push(contactId);
  return ids;
}

function positiveContactId(target: string): string | null {
  const numericId = extractNumericId(target);
  if (numericId == null || numericId < 0) return null;
  return ensureContactId(String(numericId));
}

function rhythmTimingProfileFromRow(row: {
  activeNowScore: number;
  quietNowScore: number;
  confidence: string;
  stale: boolean;
}): RhythmTimingProfile | null {
  if (row.confidence !== "low" && row.confidence !== "medium" && row.confidence !== "high") {
    return null;
  }
  return {
    activeNowScore: row.activeNowScore,
    quietNowScore: row.quietNowScore,
    confidence: row.confidence,
    stale: row.stale,
  };
}

type CandidateTracePayload = {
  [key: string]: number | IAUSScoredCandidate["diagnostics"] | undefined;
  __diagnostics?: IAUSScoredCandidate["diagnostics"];
};

function traceConsiderations(
  candidate: IAUSScoredCandidate | null | undefined,
): CandidateTracePayload {
  if (!candidate) return {};
  if (!candidate.diagnostics || Object.keys(candidate.diagnostics).length === 0) {
    return candidate.considerations;
  }
  return {
    ...candidate.considerations,
    __diagnostics: candidate.diagnostics,
  };
}

function planCandidateId(tick: number, plan: Exclude<TickPlan, { type: "skip" }>): string | null {
  if (plan.type === "system1") return null;
  if (plan.type === "enqueue") return makeCandidateId(tick, plan.action, plan.target);
  return makeCandidateId(tick, plan.voice, plan.target);
}

function recordObservationSpineTick(tick: number, nowMs: number, plan: TickPlan): void {
  if (plan.type === "skip") return;
  const pressureVector = pressureVectorSnapshot(plan.pressures);
  try {
    writePressureDeltasForPreviousTrace(tick, pressureVector);
    const candidateId = planCandidateId(tick, plan);
    writeTickTrace({
      tick,
      occurredAtMs: nowMs,
      pressureVector,
      schedulerPhase: plan.type,
      selectedCandidateId: candidateId,
      silenceMarker: plan.type === "silent" ? plan.reason : null,
      sampleStatus: "real",
    });
    if (plan.type === "enqueue") {
      const selectedRank = plan.vmaxScored?.findIndex(
        (candidate) => candidate.action === plan.action && candidate.target === plan.target,
      );
      const selected =
        selectedRank !== undefined && selectedRank >= 0 ? plan.vmaxScored?.[selectedRank] : null;
      writeCandidateTrace({
        candidateId: candidateId ?? makeCandidateId(tick, plan.action, plan.target),
        tick,
        target: plan.target,
        actionType: plan.action,
        normalizedConsiderations: traceConsiderations(selected),
        deltaP: plan.deltaP ?? null,
        socialCost: plan.socialCost ?? null,
        netValue: plan.netValue,
        bottleneck: selected?.bottleneck ?? null,
        gatePlane: plan.reason === "directed_override" ? "directed_override" : "none",
        selected: true,
        candidateRank: selectedRank !== undefined && selectedRank >= 0 ? selectedRank : null,
        silenceReason: "N/A",
        sampleStatus: "real",
      });
      for (const [rank, candidate] of (plan.vmaxScored ?? []).entries()) {
        if (rank === selectedRank) continue;
        writeCandidateTrace({
          candidateId: makeRankedCandidateId(tick, candidate.action, candidate.target, rank),
          tick,
          target: candidate.target,
          actionType: candidate.action,
          normalizedConsiderations: traceConsiderations(candidate),
          deltaP: candidate.deltaP,
          socialCost: candidate.socialCost,
          netValue: candidate.netValue,
          bottleneck: candidate.bottleneck,
          gatePlane: "iaus_competition",
          selected: false,
          candidateRank: rank,
          silenceReason: "lost_candidate",
          sampleStatus: "real",
        });
      }
    } else if (plan.type === "silent") {
      writeCandidateTrace({
        candidateId: candidateId ?? makeCandidateId(tick, plan.voice, plan.target),
        tick,
        target: plan.target,
        actionType: plan.voice,
        normalizedConsiderations: plan.values,
        deltaP: plan.values.deltaP ?? null,
        socialCost: plan.values.socialCost ?? null,
        netValue: plan.values.netValue ?? null,
        bottleneck: plan.reason,
        gatePlane: "policy",
        selected: false,
        candidateRank: null,
        silenceReason: plan.reason,
        retainedImpulse: plan.impulseToRetain ?? null,
        sampleStatus: plan.values.netValue == null ? "partial" : "real",
      });
      for (const [rank, candidate] of (plan.vmaxScored ?? []).entries()) {
        writeCandidateTrace({
          candidateId: makeRankedCandidateId(tick, candidate.action, candidate.target, rank),
          tick,
          target: candidate.target,
          actionType: candidate.action,
          normalizedConsiderations: traceConsiderations(candidate),
          deltaP: candidate.deltaP,
          socialCost: candidate.socialCost,
          netValue: candidate.netValue,
          bottleneck: candidate.bottleneck,
          gatePlane: "iaus_competition",
          selected: false,
          candidateRank: rank,
          silenceReason: "lost_candidate",
          sampleStatus: "real",
        });
      }
    }
  } catch (e) {
    log.warn("Failed to write ADR-258 observation spine", e);
  }
}

function isPostWakeupRecoveryActive(state: EvolveState, nowMs: number): boolean {
  return state.mode !== "wakeup" && (state.wakeupRecoveryUntilMs ?? 0) > nowMs;
}

/** ADR-248 W1: запись decision_trace в EVOLVE. Только аудиторские факты, не участвует в управлении потоком. */
function recordEvolveDecisionTrace(tick: number, plan: TickPlan): void {
  if (plan.type === "skip") return;

  const payload: DecisionTracePayload = {
    pressureOutput: pressureTracePayload(plan.pressures),
    selectedVoice: plan.voice,
    selectedAction:
      plan.type === "enqueue" ? plan.action : plan.type === "system1" ? plan.decision.action : null,
    gateResults: [{ verdict: formatGateVerdict(plan) }],
  };

  if (plan.type === "enqueue") {
    payload.candidates = plan.vmaxScored;
    payload.netValue = plan.netValue;
    payload.deltaP = plan.deltaP ?? null;
    payload.socialCost = plan.socialCost ?? null;
    payload.selectedProbability = plan.selectedProbability ?? null;
    payload.facetId = plan.facetId ?? null;
    payload.reason = plan.reason ?? null;
  } else if (plan.type === "silent") {
    payload.silenceLevel = plan.level;
    payload.values = plan.values;
    payload.reason = plan.reason;
    payload.retainedImpulse = plan.impulseToRetain ?? null;
  } else {
    payload.reason = `system1:${plan.decision.action}`;
  }

  try {
    writeDecisionTrace({
      tick,
      phase: "evolve",
      target: "target" in plan ? plan.target : null,
      finalDecision:
        plan.type === "enqueue" ? "enqueue" : plan.type === "silent" ? "silence" : "execute",
      reason: formatGateVerdict(plan),
      payload,
    });
  } catch (e) {
    log.warn("Failed to write evolve decision trace", e);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// computeTickPlan — пайплайн чистых функций
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Чистая функция: G → P(G,n) → τ(e) → (L, E_v) → gates → TickPlan
 * Не производит никаких побочных эффектов (нет записи в DB, dispatch, enqueue).
 *
 * @see paper/ §3: P_k(G, n) = f_k(G, n)
 * @see paper-five-dim/ Def 3.6: L_v = π_v × mean(R_v(τ(e))) + ε_v
 * @see paper/ Def 9: V(a,n) = ΔP - λ·C_social
 */
function computeTickPlan(
  state: EvolveState,
  tick: number,
  nowMs: number,
  lastEventCount = 0,
): TickPlan {
  const { G, personality, config } = state;

  // ADR-195 D6: полное размыкание LLM → пропустить весь пайплайн (устраняет tick-шторм)
  // При размыкании всех провайдеров результат IAUS не меняется (граф не изменился) → обязательно в очередь → обязательно провал.
  // Прямой skip экономит CPU и исключает бессмысленные записи tick_log.
  if (!isAnyProviderHealthy()) {
    return { type: "skip", reason: "llm_all_circuit_open" };
  }

  // D1: P(G, n) — вычисление шести сил
  // ADR-112 D4: используется адаптивный κ (текущее значение ≥ kappaMin)
  // @see paper/ §3 eq 1-6
  const effectiveKappa = state.adaptiveKappa.current();
  const pressures = computeAllPressures(G, tick, {
    kappa: effectiveKappa,
    threadAgeScale: config.threadAgeScale,
    mu: config.mu,
    d: config.d,

    deltaDeadline: config.delta,
    history: state.pressureHistory,
    nowMs,
    eta: config.eta,
    k: config.k,
    curiosityHistory: state.curiosityHistory,
    // ADR-161 §3.4: theta, управляемый групповой траекторией — P3 групповой theta выводится из channelRateEma
    channelRateEma: state.channelRateEma,
    tickDt: state.currentDt,
  });
  // Обновляем EMA (следующий тик использует обновлённый κ)
  // Исправление аудита: передаётся интервал тика (сек), чтобы период полураспада EMA был основан на стенных часах, а не на счётчике тиков.
  state.adaptiveKappa.update(
    [pressures.P1, pressures.P2, pressures.P3, pressures.P4, pressures.P5, pressures.P6],
    state.currentDt,
  );

  // ADR-147 D7: мягкий cap P1 при flood — предотвращает взрыв агрегации по нескольким каналам, не подавляя нормальную обработку
  // Ожидаемое поведение при переполнении — обрабатывать нормально, как человек, а не игнорировать. Временного затухания D5 достаточно;
  // cap защищает только от крайних аномалий (долгий разрыв × очень много каналов → P1 намного выше нормы).
  // cap = max(5 × средний исторический P1, 3 × κ₁) — мягкий верхний предел, даёт Alice достаточный бюджет внимания.
  // @see docs/adr/147-flood-backlog-recovery.md §D7
  if (isFloodCondition(state, lastEventCount)) {
    state.floodTickCount++;
    // D12: исключаем значения P1 последних flood-тиков, чтобы cap не самоувеличивался
    const safeHistory =
      state.floodTickCount > 0
        ? state.pressureHistory.slice(
            0,
            Math.max(0, state.pressureHistory.length - state.floodTickCount),
          )
        : state.pressureHistory;
    const histP1 = safeHistory.map((h) => h[0]);
    const avgP1 = histP1.length > 0 ? histP1.reduce((a, b) => a + b, 0) / histP1.length : 0;
    const p1Cap = Math.max(5 * avgP1, 3 * effectiveKappa[0]);
    if (pressures.P1 > p1Cap) {
      log.info("Flood P1 cap applied", { rawP1: pressures.P1, cap: p1Cap });
      pressures.P1 = p1Cap;
    }
    // ADR-190: защита P3 от flood (симметрично P1 D7) — предотвращает взрыв агрегации давления отношений в период переполнения
    // @see docs/adr/190-wakeup-mode.md §P3 защита от flood
    const histP3 = safeHistory.map((h) => h[2]);
    const avgP3 = histP3.length > 0 ? histP3.reduce((a, b) => a + b, 0) / histP3.length : 0;
    const p3Cap = Math.max(5 * avgP3, 3 * effectiveKappa[2]);
    if (pressures.P3 > p3Cap) {
      log.info("Flood P3 cap applied", { rawP3: pressures.P3, cap: p3Cap });
      pressures.P3 = p3Cap;
    }
  } else {
    state.floodTickCount = 0;
  }

  // ADR-190: демпфирование при Wakeup — P3 восстанавливается постепенно по α_w
  // α_w(n) = min(1, wakeupTicksElapsed / N_wakeup)
  // Агрегированное значение + вклады per-entity масштабируются синхронно (tensionMap / IAUS используют вклады)
  const isWakeup = state.mode === "wakeup";
  if (isWakeup) {
    const alphaW = Math.min(1, state.wakeupTicksElapsed / config.wakeupGraduationTicks);
    pressures.P3 *= alphaW;
    if (alphaW < 1 && pressures.contributions.P3) {
      for (const key of Object.keys(pressures.contributions.P3)) {
        pressures.contributions.P3[key] *= alphaW;
      }
    }
  }

  // ρ: V → V_A — маршрутизация вкладов: проецирует не-активные сущности на активные каналы.
  // P3→contact, P4→thread, P2→info_item, P6→contact маршрутизируются в каналы channel:*.
  // Все нижестоящие (карта напряжений, фокус-множество, V-maximizer, долг внимания) используют маршрутизированные вклады.
  // @see docs/adr/101-contribution-routing.md
  const routed = routeContributions(pressures.contributions, pressures.prospectContributions, G);

  // ADR-100: обновление долга внимания — извлекает суммарное давление per-entity из contributions
  // channelPressures: entity → Σ_k contributions[Pk][entity] (сумма по всем измерениям)
  // @see docs/adr/100-attention-debt.md §9
  const channelPressures = new Map<string, number>();
  for (const dimContribs of Object.values(routed.contributions)) {
    for (const [eid, val] of Object.entries(dimContribs)) {
      channelPressures.set(eid, (channelPressures.get(eid) ?? 0) + Math.abs(val));
    }
  }
  // P_prospect добавляется отдельно
  for (const [eid, val] of Object.entries(routed.prospectContributions)) {
    channelPressures.set(eid, (channelPressures.get(eid) ?? 0) + Math.abs(val));
  }
  // ADR-215: инжекция Residue → channelPressures.
  // Обновляем кэш из DB (поток act мог записать новые residue), затем инжектируем в конкуренцию давлений.
  state.episodeState.activeResidues = refreshResidueCache(nowMs);
  injectResidueContributions(state.episodeState.activeResidues, channelPressures, nowMs);

  // Строим карту lastIncomingMs: метка стенных часов последнего входящего сообщения для каждого канала.
  // Каналы без новых сообщений более 7 дней только накапливают затухание долга, не накапливают долг — внимание движется сообщениями.
  const lastIncomingMs = new Map<string, number>();
  for (const chId of G.getEntitiesByType("channel")) {
    const ms = Number(G.getChannel(chId).last_incoming_ms ?? 0);
    if (ms > 0) lastIncomingMs.set(chId, ms);
  }
  state.attentionDebtMap = updateAttentionDebt(
    state.attentionDebtMap,
    channelPressures,
    state.lastSelectedTarget,
    config.attentionDebt,
    state.currentDt,
    lastIncomingMs,
    nowMs,
  );

  // ADR-181: инжекция сигнала риска в вектор напряжений (компонента τ_risk для R_Caution)
  const riskContribs: Record<string, number> = {};
  for (const chId of G.getEntitiesByType("channel")) {
    const risk = effectiveRisk(G, chId, nowMs);
    if (risk > 0) riskContribs[chId] = risk;
  }

  // ADR-178: инжекция сигнала притяжения в вектор напряжений
  const attractionContribs: Record<string, number> = {};
  for (const chId of G.getEntitiesByType("channel")) {
    const cId = chatIdToContactId(chId);
    if (!cId || !G.has(cId)) continue;
    const rvAttraction = G.getContact(cId).rv_attraction ?? 0;
    if (rvAttraction > 0) attractionContribs[chId] = rvAttraction;
  }

  // ADR-191: всплеск скорости → tauSpike (прямой структурный путь, замена потока anomaly)
  // @see docs/adr/191-anomaly-thread-elimination.md
  const spikeContribs: Record<string, number> = {};
  for (const [chId, count] of state.lastChannelCounts) {
    const stats = state.channelRateEma.get(chId);
    if (!stats || stats.variance < 0.01) continue;
    const z = (count - stats.ema) / Math.sqrt(stats.variance);
    if (z > 1.0) spikeContribs[chId] = z; // инжектируем только положительные всплески
  }

  // ADR-222: адаптивное затухание — применяет ρ_H ко всем давлениям кроме P5.
  // P5 (обязательства) не затухает: когда собеседник ждёт ответа, насыщение не должно уводить Alice.
  // @see docs/adr/222-habituation-truth-model.md §Definition (Habituation Modulation)
  {
    const habAlpha = config.habituationAlpha;
    const habHL = config.habituationHalfLifeS;
    for (const pk of ["P1", "P2", "P3", "P4", "P6"] as const) {
      const pkContribs = routed.contributions[pk];
      if (!pkContribs) continue;
      for (const eid of Object.keys(pkContribs)) {
        if (!G.has(eid)) continue;
        const ch = G.getChannel(eid);
        const factor = computeHabituationFactor(
          ch.habituation ?? 0,
          ch.habituation_ms ?? 0,
          nowMs,
          habAlpha,
          habHL,
        );
        pkContribs[eid] *= factor;
      }
    }
    // prospect тоже затухает
    for (const eid of Object.keys(routed.prospectContributions)) {
      if (!G.has(eid)) continue;
      const ch = G.getChannel(eid);
      const factor = computeHabituationFactor(
        ch.habituation ?? 0,
        ch.habituation_ms ?? 0,
        nowMs,
        habAlpha,
        habHL,
      );
      routed.prospectContributions[eid] *= factor;
    }
  }

  // ADR-225: модуляция Dormant ρ_C — во время сна все измерения давления ×0.1 (включая P5).
  // Ортогонально habituation: hab — насыщение взаимодействием, dormant — суточный ритм.
  if (state.mode === "dormant") {
    for (const pk of ["P1", "P2", "P3", "P4", "P5", "P6"] as const) {
      const pkContribs = routed.contributions[pk];
      if (!pkContribs) continue;
      for (const eid of Object.keys(pkContribs)) {
        pkContribs[eid] *= DORMANT_PRESSURE_FACTOR;
      }
    }
    for (const eid of Object.keys(routed.prospectContributions)) {
      routed.prospectContributions[eid] *= DORMANT_PRESSURE_FACTOR;
    }
  }

  // τ(e) = Pᵀ — вектор напряжений per-entity
  // @see paper/ §3.3: tension as transpose of contributions
  const tensionMap = buildTensionMap(
    routed.contributions,
    routed.prospectContributions,
    riskContribs,
    attractionContribs,
    spikeContribs,
  );

  // ADR-185 §1: вывод Desire — tension → явные цели
  const desires = deriveDesires(tensionMap, G, nowMs);

  // (L, E_v) = voice(τ, π) — конкуренция голосов + фокус-множество
  // @see paper-five-dim/ Def 3.6 eq 13
  const { loudness, focalSets } = computeLoudness(tensionMap, personality, G, tick, {
    recentEventCounts: state.recentEventCounts,
    // ADR-75: усталость голоса — уравнение статьи voice-fatigue
    voiceLastWon: state.deliberation.voiceLastWon,
    targetWhitelist: config.focusWhitelist,
  });
  const [, action] = selectAction(loudness);

  const focal = focalSets[action];
  if (!focal) return { type: "skip", reason: "no_focal_set" };
  const target = focal.primaryTarget;

  // ADR-101: маршрутизированный фокус-набор должен содержать только channel. Утечка не-channel — баг выше по потоку, здесь — защита
  if (target && G.has(target) && G.getNodeType(target) !== "channel") {
    log.warn("Non-channel primaryTarget leaked past routing", {
      target,
      type: G.getNodeType(target),
      action,
    });
    return { type: "skip", reason: "non_channel_target" };
  }

  // ADR-174: выбор Persona Facet из победившего голоса (персональный аспект)
  // facet оставляет ощутимый личностный след во всём prompt (guidance + whisper + example tags)
  const targetTier = (() => {
    if (!target || !G.has(target)) return null;
    const cId = chatIdToContactId(target);
    return cId && G.has(cId) ? (G.getContact(cId).tier as number | null) : null;
  })();
  const targetChatTypeForFacet = target && G.has(target) ? G.getChannel(target).chat_type : null;
  // ADR-206: откат channel target к isGroup=false (режим private).
  // channel вытесняется изоляцией давления до очень низкой оценки IAUS, этот путь почти недостижим.
  const isGroupForFacet =
    targetChatTypeForFacet === "group" || targetChatTypeForFacet === "supergroup";
  const facetCtx: FacetContext = {
    normalized: normalizePressuresForFacet(pressures, effectiveKappa),
    isGroup: isGroupForFacet,
    tier: targetTier,
  };
  const facet = selectFacet(action, facetCtx);

  // ── ADR-189: shouldBypassGates интегрирован в IAUS per-candidate pre-filter ──
  // Bypass на уровне пайплайна устранён — каждый кандидат несёт собственный bypass-сигнал (computeCandidateBypass).
  // isContinuation сохраняется только для быстрого пути System 1.
  const isContinuation = target != null && isConversationContinuation(G, target, nowMs);

  // ADR-180: Engagement Exclusivity перенесён в IAUS retry loop.
  // ADR-136: Proactive cooldown свёрнут в подкомпонент C_sat σ_cool.

  // Pre-gate chain — самозапуск при простое
  // ADR-81: gateReflectionGuarantee удалён (голос Reflection устранён)
  // ADR-190: в wakeup самозапуск при простое не срабатывает (человек встаёт и просматривает сообщения, не инициирует)
  // ADR-225: в dormant самозапуск при простое не срабатывает (спит и не ищет дел)
  // Миграция dt: оценка простоя основана на разнице стенных часов в секундах
  const idleSinceActionS = (nowMs - state.lastActionMs) / 1000;
  const isDormant = state.mode === "dormant";
  const preGate =
    isWakeup || isDormant
      ? ({ type: "pass" } as const)
      : runGateChain([
          () =>
            gateIdleSelfStart(
              idleSinceActionS,
              config.idleThreshold,
              action,
              target,
              target != null ? focal.entities : [],
            ),
        ]);
  if (preGate.type === "act") {
    return {
      type: "enqueue",
      action: preGate.candidate.action,
      target,
      pressures,
      focalEntities: preGate.candidate.focalEntities,
      voice: action,
      netValue: preGate.candidate.netValue,
      facetId: facet.id,
    };
  }

  // Быстрый путь System 1
  const s1 = trySystem1(action, focalSets, G, tick, {
    leakProb: config.s10LeakProb,
    isConversationContinuation: isContinuation,
    nowMs, // ADR-124: effectiveObligation требует времени стенных часов
  });
  if (s1.handled) {
    return {
      type: "system1",
      decision: s1,
      pressures,
      voice: action,
      target,
      focalEntities: focal.entities,
    };
  }

  // ADR-186: глобальная блокировка hasActive() удалена — заменена на per-target эксклюзивность.
  // excludeTargets предзаполняется активными target перед оценкой IAUS (см. ниже),
  // retry loop IAUS имеет проверку isTargetActive() per-target.
  // Быстрый путь System 1 (mark_read и т.д.) не ограничивается.

  // ADR-110: цепочка гейтов System 2 — используется окно в мс стенных часов
  const windowStartMs = nowMs - config.actionRateWindow * 1000;
  const recentInWindow = state.recentActions.filter((a) => a.ms > windowStartMs);
  const crisisChannels = typedQuery(state.dispatcher, "crisis_channels") ?? [];

  // ADR-113 F15: статистика классификации с учётом chat-type, общая для rate_cap и active_cooling.
  // Вычисляется один раз, используется в двух местах — V-max не изменяет recentActions, стабильно внутри тика.
  const classCounts = countActionsByClass(recentInWindow, G);
  // ADR-189: targetClass / convAware / postGate (gateClosingConversation, gateCrisisMode, gateRateCap)
  // внутренне перенесены в IAUS per-candidate pre-filter. convAware — после определения победителя IAUS.

  // ADR-180: оценка IAUS — мультипликативные Considerations заменяют аддитивный NSV
  // V = CF(∏ U_k) — action_type × target выбираются за один шаг
  // @see docs/adr/180-iaus-phase2/README.md

  // Гейт API floor + циркадная модуляция Hawkes (требует предварительного вычисления из-за замыкания candidateCtx)
  const hour = state.utcHour ?? new Date().getUTCHours();
  const peakHourResult = typedQuery(state.dispatcher, "best_time");
  const circadian = circadianMultiplier(hour, config.timezoneOffset, peakHourResult?.peakHour);
  const effectiveFloor = G.tick < 100 ? 0.02 : config.actionRateFloor;

  const candidateCtx: CandidateContext = {
    G,
    nowMs,
    getRhythmTimingProfile: makeRhythmTimingProfileReader(),
    // ADR-153: Hawkes discount теплоты разговора — λ(t) высокий → discount низкий → социальная стоимость снижается
    getHawkesDiscount: (target: string) => {
      if (!G.has(target)) return 1.0;
      const chAttrs = G.getChannel(target);
      const chatType = chAttrs.chat_type;
      const isGroupChat = ChatTarget.isGroupChat(chatType);

      // Личный чат: contact Hawkes + онлайн-калибровка Phase 2 + суточная модуляция
      if (!isGroupChat) {
        const cId = chatIdToContactId(target);
        if (!cId || !G.has(cId)) return 1.0;
        const contact = G.getContact(cId);
        if (contact.hawkes_last_event_ms == null) return 1.0;
        const baseParams = getHawkesParams(contact.tier, false);
        const effMu = effectiveMu(
          baseParams.mu,
          contact.hawkes_event_count,
          contact.hawkes_first_event_ms,
          nowMs,
          circadian,
        );
        const effParams: HawkesParams = { ...baseParams, mu: effMu };
        const hState: HawkesState = {
          lambdaCarry: contact.hawkes_carry ?? 0,
          lastEventMs: contact.hawkes_last_event_ms ?? 0,
        };
        return computeHawkesLambdaDiscount(queryIntensity(effParams, hState, nowMs));
      }

      // Группа: channel Hawkes + суточная модуляция
      if (chAttrs.hawkes_last_event_ms == null) return 1.0;
      const baseParams = getHawkesParams(chAttrs.tier_contact, true);
      const effMu = effectiveMu(baseParams.mu, undefined, undefined, undefined, circadian);
      const effParams: HawkesParams = { ...baseParams, mu: effMu };
      const hState: HawkesState = {
        lambdaCarry: chAttrs.hawkes_carry ?? 0,
        lastEventMs: chAttrs.hawkes_last_event_ms ?? 0,
      };
      return computeHawkesLambdaDiscount(queryIntensity(effParams, hState, nowMs));
    },
    // ADR-154: Goldilocks utility — за пределами окна подавляет proactive ΔP, внутри — пропускает.
    // Мёртвая зона (Hawkes затух ~ до Goldilocks tMin) — ожидаемое поведение:
    // только закончившего разговор не надо трогать в период охлаждения. Обязательные сообщения через bypassGates не затрагиваются.
    // @see docs/adr/154-goldilocks-window/README.md §5.4
    getGoldilocksUtility: (target: string) => {
      if (!G.has(target)) return 1.0;
      const chAttrs = G.getChannel(target);

      // Время тишины: отсчитывается от последней активности канала
      const lastActivityMs = Number(chAttrs.last_activity_ms ?? 0);
      if (lastActivityMs <= 0) return 1.0; // нет истории взаимодействий → без ограничений
      const silenceS = Math.max(0, (nowMs - lastActivityMs) / 1000);

      // Получаем tier
      const cId = chatIdToContactId(target);
      const tier: DunbarTier =
        cId && G.has(cId)
          ? (G.getContact(cId).tier as DunbarTier)
          : (chAttrs.tier_contact as DunbarTier);

      // Опционально: адаптивный EMA + расширение из-за неопределённости σ²
      const ema = cId && G.has(cId) ? G.getContact(cId).ema_contact_interval_s : undefined;
      const sigma2 = cId ? G.beliefs.getOrDefault(cId, "tier").sigma2 : undefined;

      // ADR-191: групповой дисконт убран. Канал bypass делал приватные чаты иммунными к дисконту,
      // что приводило к односторонним штрафам для групп. Система Social Cost уже структурно разделяет группы и личку.
      return computeGoldilocksUtility(silenceS, tier, ema, sigma2);
    },
  };

  // ── IAUS scoring + post-gates retry loop ─────────────────────────────────
  // ADR-180: оценка IAUS заменяет V-max. Повтор при срабатывании per-target rate limit.
  // ADR-186: предварительное исключение target с активным engagement (замена глобальной блокировки).
  const excludedTargets = new Set<string>(state.queue.getActiveTargets());
  const MAX_PER_TARGET_RETRIES = 3;

  // Глобальная неопределённость (базовый уровень U_conflict_avoidance) — ADR-112 D3: включает неопределённость среды
  const uncertainty = computeUncertainty(state.recentEventCounts, 10, 2.0, G);

  const iausConfig: IAUSConfig = {
    candidateCtx,
    kappa: config.kappa,
    contributions: routed.contributions,
    beliefs: G.beliefs,
    beliefGamma: config.beliefGamma,
    thompsonEta: config.thompsonEta,
    socialCost: config.socialCost,
    saturationCost: config.saturationCost,
    windowStartMs,
    uncertainty,
    personality,
    voiceLastWon: state.deliberation.voiceLastWon,
    nowMs,
    targetWhitelist: config.focusWhitelist,
    deterministic: config.iausDeterministic,
    // ADR-182 D1: бонус за инерцию (Momentum Bonus)
    lastWinner: state.lastSelectedCandidate,
    lastActionMs: state.lastActionMs,
    momentumBonus: config.momentumBonus,
    momentumDecayMs: config.momentumDecayMs,
    // ADR-183: модуляция кривых личностью
    curveModulationStrength: config.curveModulationStrength,
    // ADR-185 §1: усиление Desire (Desire Boost)
    desires,
    desireBoost: config.desireBoost,
    // ADR-218 Phase 2: attentionDebtMap/Config больше не передаётся в IAUS (U_coverage → U_fairness).
    // Накопление долга по-прежнему ведётся в evolve (мониторинг давления + вход channelPressures).
    // ADR-189: Gate внутренне перенесён в IAUS per-candidate pre-filter
    crisisChannels,
    classRateCaps: config.rateCap,
    classActionCounts: classCounts,
  };

  let detailedIaus = scoreAllCandidatesDetailed(
    tensionMap,
    G,
    tick,
    state.recentActions,
    iausConfig,
  );
  let iausResult = detailedIaus.result;
  let lastIausFilterStats: IAUSFilterStats | undefined = detailedIaus.filterStats;
  let lastIausScored: IAUSScoredCandidate[] | undefined = iausResult?.scored;
  let perTargetRetryCount = 0;
  let postWakeupRecoverySuppression: {
    action: VoiceAction;
    target: string | null;
    bestV: number;
    deltaP: number;
    socialCost: number;
    focalEntities: string[];
  } | null = null;
  let queueBackpressureSuppression: {
    action: VoiceAction;
    target: string | null;
    bestV: number;
    deltaP: number;
    socialCost: number;
    focalEntities: string[];
    metrics: ReturnType<ActionQueue["getMetrics"]>;
  } | null = null;

  // eslint-disable-next-line no-constant-condition
  while (iausResult) {
    lastIausScored = iausResult.scored;
    const { candidate: best, bestV } = iausResult;

    // Engagement Exclusivity: target победителя IAUS может уже иметь активный engagement.
    if (best.target && state.queue.isTargetActive(best.target)) {
      if (perTargetRetryCount < MAX_PER_TARGET_RETRIES) {
        excludedTargets.add(best.target);
        perTargetRetryCount++;
        log.debug("IAUS winner target already active, retrying with exclusion", {
          excluded: best.target,
          retry: perTargetRetryCount,
        });
        detailedIaus = scoreAllCandidatesDetailed(tensionMap, G, tick, state.recentActions, {
          ...iausConfig,
          excludeTargets: excludedTargets,
        });
        iausResult = detailedIaus.result;
        lastIausFilterStats = detailedIaus.filterStats;
        lastIausScored = iausResult?.scored ?? lastIausScored;
        continue;
      }
      iausResult = null;
      break; // попытки исчерпаны → fallback на directedCandidate
    }

    // ADR-190: ограничение разнообразия целей при Wakeup — не более 1 новой проактивной цели за тик
    // Обязательство (winnerBypassGates) или ранее задействованные цели не ограничиваются
    if (isWakeup && best.target && !iausResult.winnerBypassGates) {
      if (!state.wakeupEngagedTargets.has(best.target) && state.wakeupEngagedTargets.size > 0) {
        log.info("Wakeup diversity throttle — suppressing new proactive target", {
          target: best.target,
          engaged: state.wakeupEngagedTargets.size,
        });
        iausResult = null;
        break; // → fallback на directedCandidate (обязательные сообщения по-прежнему проходят)
      }
    }

    // Post-wakeup recovery: после выпуска из wakeup кратковременно сохраняется инерция “сначала обработать уже открытые цели”.
    // Подавляет только распространение на новые цели обычного proactive; directed / continuation bypass не затрагивается.
    if (
      isPostWakeupRecoveryActive(state, nowMs) &&
      best.target &&
      !iausResult.winnerBypassGates &&
      !state.wakeupEngagedTargets.has(best.target) &&
      state.wakeupEngagedTargets.size >= POST_WAKEUP_RECOVERY_TARGET_BUDGET
    ) {
      log.info("Post-wakeup recovery — suppressing new proactive target", {
        target: best.target,
        engaged: state.wakeupEngagedTargets.size,
        recoveryRemainingMs: Math.max(0, (state.wakeupRecoveryUntilMs ?? 0) - nowMs),
      });
      postWakeupRecoverySuppression = {
        action: best.action,
        target: best.target ?? null,
        bestV,
        deltaP: best.deltaP,
        socialCost: best.socialCost,
        focalEntities: best.focalEntities,
      };
      iausResult = null;
      break; // → fallback на directedCandidate; при отсутствии обязательства — пишем post_wakeup_recovery
    }

    // ADR-252 Wave 1: противодавление Queue/ACT относится к Execution Resource Plane.
    // Подавляет только обычных победителей proactive; bypass-обязательства directed / continuation продолжают ставиться в очередь.
    {
      const queueMetrics = state.queue.getMetrics();
      if (
        !iausResult.winnerBypassGates &&
        queueMetrics.saturation >= IAUS_QUEUE_BACKPRESSURE_SATURATION
      ) {
        log.info("IAUS queue backpressure — suppressing non-bypass winner", {
          target: best.target,
          action: best.action,
          saturation: queueMetrics.saturation,
          active: queueMetrics.active,
          maxDepth: queueMetrics.maxDepth,
        });
        queueBackpressureSuppression = {
          action: best.action,
          target: best.target ?? null,
          bestV,
          deltaP: best.deltaP,
          socialCost: best.socialCost,
          focalEntities: best.focalEntities,
          metrics: queueMetrics,
        };
        iausResult = null;
        break; // → fallback на directedCandidate; при отсутствии обязательства — обычный путь молчания
      }
    }

    // VoI(null) — лучше ли выжидать, чем действовать
    // ADR-189: convAware использует target победителя IAUS (не target Voice)
    // ADR-75: затухание накопленной тишины — стенные часы заменяют счётчик тиков, режим conversation больше не ускоряет затухание в 20x
    // @see paper-pomdp/ Def 5.3
    const voiNull = computeVoINull(best.focalEntities, G.beliefs, tick);
    const convAware = gateConversationAware(G, best.target ?? null);
    const voiMultiplier = convAware.silenceBoost ? 2.0 : 1.0;
    const silenceDurationS = (nowMs - state.lastActionMs) / 1000;
    const silenceDecay = 1 / (1 + silenceDurationS * SILENCE_VOI_DECAY_RATE);
    const effectiveVoI = voiNull * voiMultiplier * silenceDecay;
    if (effectiveVoI > bestV && bestV > 0) {
      const silLvl = classifySilence(
        pressures.API,
        config.actionRateFloor,
        bestV,
        effectiveVoI,
        false,
      );
      return {
        type: "silent",
        pressures,
        voice: best.action,
        target: best.target ?? null,
        reason: "voi_deferred",
        level: silLvl,
        values: silenceValuesFromCandidate(best, bestV, pressures.API),
        focalEntities: best.focalEntities,
        vmaxScored: iausResult.scored,
        impulseToRetain:
          best.netValue >= IMPULSE_MIN_VALUE
            ? {
                action: best.action,
                target: best.target ?? "",
                netValue: best.netValue,
                originTick: tick,
                originMs: nowMs,
              }
            : undefined,
      };
    }

    // Гейт API floor (суточная модуляция)
    // @see paper-five-dim/ Axiom 4: silence when V ≤ 0
    // ADR-180: post-IAUS bypass использует сигналы победителя IAUS.
    const apiVerdict = gateAPIFloor(
      pressures.API,
      effectiveFloor,
      circadian,
      iausResult.winnerBypassGates,
      bestV,
    );
    if (apiVerdict.type === "silent") {
      const silLvl = classifySilence(
        pressures.API,
        effectiveFloor * circadian,
        bestV,
        voiNull,
        false,
      );
      return {
        type: "silent",
        pressures,
        voice: best.action,
        target: best.target ?? null,
        reason: apiVerdict.reason,
        level: silLvl,
        values: silenceValuesFromCandidate(best, bestV, pressures.API, apiVerdict.values ?? {}),
        focalEntities: best.focalEntities,
        vmaxScored: iausResult.scored,
      };
    }

    // ADR-274 W2: normal cadence must not randomly kill a winner after IAUS selection.
    // ADR-189: per-target rate limit внутренне перенесён в IAUS per-candidate pre-filter.

    break; // все гейты пройдены
  }

  if (!iausResult) {
    // ADR-180: directedFallback — перебирает obligation всех channel-сущностей, ставит в очередь target с наибольшим обязательством.
    // Замена selectTopK(loudness): прямой перебор всех channel более полный.
    const directedCandidate = (() => {
      let bestTarget: string | null = null;
      let bestObligation = 0;
      let bestAction: VoiceAction = action;
      let bestFocalEntities = focal.entities;
      for (const chId of G.getEntitiesByType("channel")) {
        if (!G.has(chId)) continue;
        if (G.getChannel(chId).failure_type === "permanent") continue;
        // ADR-136: сохраняем мягкую фильтрацию: effectiveActSilences > 5 всё равно пропускается (страховочная сеть для крайних сценариев сбоя).
        const effSilences = effectiveActSilences(G, chId, nowMs);
        if (effSilences > ACT_SILENCE_SAFETY_THRESHOLD) continue;
        // Engagement Exclusivity: цель с активным engagement пропускается
        if (state.queue.isTargetActive(chId)) continue;
        // Обещание прощания leave(): разговор в состоянии closing пропускается
        if (gateClosingConversation(G, chId).type === "silent") continue;
        // Явное обязательство
        const obligation = effectiveObligation(G, chId, nowMs);
        if (obligation > bestObligation) {
          bestObligation = obligation;
          bestTarget = chId;
          bestAction = "diligence"; // обязательство по умолчанию выбирает diligence
          bestFocalEntities = [chId];
        }
      }
      // ADR-189: жёсткий предел consecutive_outgoing — directedCandidate больше не обходит cap на серию отправок
      // ADR-189 аудит-тараканов Fix 1: сильное обязательство (effectiveObligation > θ_bypassGates) пропускает outgoing cap.
      // Обычное continuation разговора больше не попадает в directed_override; оно идёт только через основной путь IAUS.
      // @see docs/adr/189-gate-iaus-unification.md §蟑螂审计
      const isStrongObligation = bestObligation > OBLIGATION_THRESHOLDS.bypassGates;
      if (bestTarget && G.has(bestTarget) && !isStrongObligation) {
        const outgoing = Number(G.getChannel(bestTarget).consecutive_outgoing ?? 0);
        const cls = classifyChatType(
          G.getChannel(bestTarget).chat_type,
          resolveIsBot(G, bestTarget),
        );
        const hardCap =
          cls === "group"
            ? config.saturationCost.outgoingCapGroup
            : config.saturationCost.outgoingCapPrivate;
        if (outgoing >= hardCap) {
          bestTarget = null; // отказ — жёсткий лимит последовательных отправок
        }
      }
      return bestTarget
        ? { target: bestTarget, action: bestAction, focalEntities: bestFocalEntities }
        : null;
    })();

    if (directedCandidate) {
      // При полном размыкании автоматов не принуждать к действию — LLM недоступен, принудительный enqueue лишь впустую тратит тики
      // @see docs/adr/156-emotional-reactivity-damping.md — анализ каскадных сбоев
      if (!isAnyProviderHealthy()) {
        log.warn("IAUS directed but all LLM providers circuit-open — suppressing", {
          target: directedCandidate.target,
        });
      } else {
        log.info("IAUS all filtered but directed — forcing action", {
          target: directedCandidate.target,
          voice: directedCandidate.action,
        });
        return {
          type: "enqueue",
          action: directedCandidate.action,
          target: directedCandidate.target,
          pressures,
          voice: directedCandidate.action,
          reason: "directed_override",
          focalEntities: directedCandidate.focalEntities,
          netValue: 0.01,
          vmaxScored: lastIausScored,
          facetId: facet.id,
        };
      }
    }

    if (postWakeupRecoverySuppression) {
      const {
        action: suppressedAction,
        bestV,
        deltaP,
        focalEntities,
        socialCost,
        target: suppressedTarget,
      } = postWakeupRecoverySuppression;
      const silLvl = classifySilence(pressures.API, config.actionRateFloor, bestV, 0, true);
      return {
        type: "silent",
        pressures,
        voice: suppressedAction,
        target: suppressedTarget,
        reason: "post_wakeup_recovery",
        level: silLvl,
        values: { netValue: bestV, deltaP, socialCost, apiValue: pressures.API },
        focalEntities,
        vmaxScored: lastIausScored,
        impulseToRetain:
          suppressedTarget && bestV >= IMPULSE_MIN_VALUE
            ? {
                action: suppressedAction,
                target: suppressedTarget,
                netValue: bestV,
                originTick: tick,
                originMs: nowMs,
              }
            : undefined,
      };
    }

    if (queueBackpressureSuppression) {
      const {
        action: suppressedAction,
        bestV,
        deltaP,
        focalEntities,
        metrics,
        socialCost,
        target: suppressedTarget,
      } = queueBackpressureSuppression;
      const silLvl = classifySilence(pressures.API, config.actionRateFloor, bestV, 0, true);
      return {
        type: "silent",
        pressures,
        voice: suppressedAction,
        target: suppressedTarget,
        reason: "queue_backpressure",
        level: silLvl,
        values: {
          netValue: bestV,
          deltaP,
          socialCost,
          apiValue: pressures.API,
          queueQueued: metrics.queued,
          queueProcessing: metrics.processing,
          queueActive: metrics.active,
          queueSaturation: metrics.saturation,
          queueBackpressureThreshold: IAUS_QUEUE_BACKPRESSURE_SATURATION,
        },
        focalEntities,
        vmaxScored: lastIausScored,
        impulseToRetain:
          suppressedTarget && bestV >= IMPULSE_MIN_VALUE
            ? {
                action: suppressedAction,
                target: suppressedTarget,
                netValue: bestV,
                originTick: tick,
                originMs: nowMs,
              }
            : undefined,
      };
    }

    // Все кандидаты отфильтрованы — тишина
    const actSilences = target && G.has(target) ? effectiveActSilences(G, target, nowMs) : 0;
    const silLvl = classifySilence(pressures.API, config.actionRateFloor, 0, 0, false);
    const emptyReason =
      actSilences >= SILENCE_COOLDOWN_THRESHOLD
        ? "silence_cooldown"
        : emptyCandidatePoolReason(lastIausFilterStats);
    return {
      type: "silent",
      pressures,
      voice: action,
      target,
      reason: emptyReason,
      level: silLvl,
      values: emptyCandidatePoolValues(pressures.API, lastIausFilterStats),
      focalEntities: focal.entities,
      vmaxScored: lastIausScored,
    };
  }

  const { candidate: best, bestV } = iausResult;

  // Все гейты пройдены — победитель IAUS ставится в очередь
  // Статья L5: degraded action передаётся через reason в слой act, ограничивая вывод LLM коротким ответом
  const finalVoiNull = computeVoINull(best.focalEntities, G.beliefs, tick);
  const topDesire = best.target ? findTopDesireForTarget(desires, best.target) : undefined;
  const baseReason = assembleIAUSReason(
    best,
    pressures.API,
    finalVoiNull,
    iausResult.selectedProbability,
    topDesire,
  );
  return {
    type: "enqueue",
    action: best.action,
    target: best.target ?? null,
    pressures,
    focalEntities: best.focalEntities,
    voice: action,
    netValue: bestV,
    reason: best.degraded ? `degraded_action, ${baseReason}` : baseReason,
    // ADR-115: IAUS trace
    deltaP: best.deltaP,
    socialCost: best.socialCost,
    selectedProbability: iausResult.selectedProbability,
    // D8: для fan-out
    vmaxScored: iausResult.scored,
    vmaxSpread: iausResult.spread,
    // ADR-174: персональный аспект
    facetId: facet.id,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// applyPlan — единственная точка выхода побочных эффектов
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Исполняет TickPlan: запись в DB + уведомление dispatcher + операции с очередью.
 * Это единственная функция в пайплайне evolve, порождающая побочные эффекты.
 */
function applyPlan(state: EvolveState, plan: TickPlan, tick: number, nowMs: number): boolean {
  // 1. Уведомление Dispatcher + tick_log (требуется для всех путей кроме skip)
  if (plan.type !== "skip") {
    const focalEntities = "focalEntities" in plan ? plan.focalEntities : [];
    state.dispatcher.dispatch("UPDATE_PRESSURES", {
      pressures: plan.pressures,
      focalEntities,
    });
    state.dispatcher.dispatch("SET_VOICE", { voice: plan.voice });
    // ADR-174: передаём результат выбора facet в soul.mod
    if (plan.type === "enqueue" && plan.facetId) {
      state.dispatcher.dispatch("SET_FACET", { facetId: plan.facetId });
    }

    try {
      // ADR-115: путь enqueue несёт V-max trace, другие пути — null
      // ADR-135 Change 5: silent plan также записывает target для диагностики реальной перехваченной цели
      const trace =
        plan.type === "enqueue"
          ? {
              target: plan.target,
              netValue: plan.netValue,
              deltaP: plan.deltaP ?? null,
              socialCost: plan.socialCost ?? null,
              selectedProbability: plan.selectedProbability ?? null,
            }
          : {
              target: "target" in plan ? plan.target : null,
              netValue: null,
              deltaP: null,
              socialCost: null,
              selectedProbability: null,
            };

      const db = getDb();
      db.insert(tickLog)
        .values({
          tick,
          p1: plan.pressures.P1,
          p2: plan.pressures.P2,
          p3: plan.pressures.P3,
          p4: plan.pressures.P4,
          p5: plan.pressures.P5,
          p6: plan.pressures.P6,
          api: plan.pressures.API,
          apiPeak: plan.pressures.API_peak,
          action: plan.voice,
          ...trace,
          gateVerdict: formatGateVerdict(plan),
          mode: state.mode,
        })
        .run();
    } catch (e) {
      log.warn("Failed to write tick log", e);
    }
  }

  recordObservationSpineTick(tick, nowMs, plan);
  recordEvolveDecisionTrace(tick, plan);

  // 2. Выполняем в зависимости от типа plan
  switch (plan.type) {
    case "skip":
      // ADR-100: тик тишины → цель не выбрана
      state.lastSelectedTarget = null;
      state.lastSelectedCandidate = null;
      return false;

    case "enqueue": {
      enqueueAndRecord(
        state,
        tick,
        nowMs,
        plan.action,
        plan.target,
        plan.pressures,
        plan.focalEntities,
        plan.reason,
        plan.vmaxScored,
        plan.vmaxSpread,
        plan.facetId,
      );
      // ADR-75: обновление состояния совещания (усталость голоса + сброс тишины + линейка действий)
      onActionEnqueued(state.deliberation, tick, plan.action, plan.target, plan.netValue, nowMs);
      // ADR-100: записываем выбранную цель для оценки накопления долга на следующем тике
      state.lastSelectedTarget = plan.target;
      // ADR-182 D1: записываем (action, target) для Momentum Bonus на следующем тике
      state.lastSelectedCandidate = plan.target
        ? { action: plan.action, target: plan.target }
        : null;

      // ADR-180: отслеживание consecutive_caution_acts удалено — IAUS не производит тип действия "caution",
      // Caution свёрнут в общий Consideration U_conflict_avoidance.

      // ADR-190 + post-wakeup recovery: отслеживаем задействованные цели, ограничиваем распространение на новые в период восстановления.
      if ((state.mode === "wakeup" || isPostWakeupRecoveryActive(state, nowMs)) && plan.target) {
        state.wakeupEngagedTargets.add(plan.target);
      }

      // ADR-222: после постановки действия в очередь увеличиваем H(v) (habituation).
      // Сначала затухание до текущего момента, затем +1.0 (одно действие = один импульс Дирака).
      if (plan.target && state.G.has(plan.target)) {
        const ch = state.G.getChannel(plan.target);
        const prevH = ch.habituation ?? 0;
        const prevMs = ch.habituation_ms ?? 0;
        const ageS = Math.max(0, (nowMs - prevMs) / 1000);
        const decayedH = prevH * 2 ** (-ageS / state.config.habituationHalfLifeS);
        state.G.updateChannel(plan.target, {
          habituation: decayedH + 1.0,
          habituation_ms: nowMs,
        });
      }

      log.info("Action enqueued", { tick, action: plan.action, target: plan.target });
      return true;
    }

    case "system1": {
      const { decision: s1 } = plan;
      if (s1.action === "mark_read" && s1.target && state.G.has(s1.target)) {
        state.G.updateChannel(s1.target, { unread: 0, unread_ewms: 0, recently_cleared_ms: nowMs });
        state.lastActionMs = nowMs;
      } else if (s1.action === "digest" && s1.target && state.G.has(s1.target)) {
        executeDigest(state.G, s1.target, tick, nowMs);
        state.lastActionMs = nowMs;
      }
      log.debug("System 1 handled", { tick, action: s1.action, target: s1.target });
      return s1.action === "mark_read" || s1.action === "digest";
    }

    case "silent":
      recordSilence(tick, plan.voice, plan.target, plan.reason, plan.values, plan.level);
      // ADR-75: обновление состояния совещания (накопление тишины + затухание импульсов)
      onSilence(state.deliberation, tick, plan.reason, nowMs);
      // ADR-75: сохранение высокого V-импульса при VoI-deferred (чистые функции это не могут — делается здесь)
      if (plan.impulseToRetain) addImpulse(state.deliberation, plan.impulseToRetain);
      // ADR-100: тик тишины → цель не выбрана
      state.lastSelectedTarget = null;
      state.lastSelectedCandidate = null;
      log.debug("Silence", { tick, voice: plan.voice, reason: plan.reason, level: plan.level });
      return false;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// updateSlidingWindows — вспомогательная функция
// ═══════════════════════════════════════════════════════════════════════════

function updateSlidingWindows(state: EvolveState, eventCount: number): void {
  state.recentEventCounts.push(eventCount);
  if (state.recentEventCounts.length > state.config.k) state.recentEventCounts.shift();
}

// ═══════════════════════════════════════════════════════════════════════════
// ADR-215: вспомогательная функция — возвращает имя доминирующего измерения давления
// ═══════════════════════════════════════════════════════════════════════════

function dominantDimension(p: AllPressures): string {
  const dims: [[string, number], ...[string, number][]] = [
    ["P1", p.P1],
    ["P2", p.P2],
    ["P3", p.P3],
    ["P4", p.P4],
    ["P5", p.P5],
    ["P6", p.P6],
  ];
  let best = dims[0];
  for (const d of dims) {
    if (d[1] > best[1]) best = d;
  }
  return best[0];
}

// ═══════════════════════════════════════════════════════════════════════════
// ADR-225: вспомогательные функции режима Dormant
// ═══════════════════════════════════════════════════════════════════════════

/** Возвращает локальный час для заданной временной метки. */
function getLocalHour(nowMs: number, timezoneOffset: number): number {
  const utcHour = new Date(nowMs).getUTCHours();
  return (((utcHour + timezoneOffset) % 24) + 24) % 24;
}

/** Проверяет, выполнены ли условия перехода в dormant-режим (засыпания). */
function shouldEnterDormant(api: number, nowMs: number, config: Config): boolean {
  const localHour = getLocalHour(nowMs, config.timezoneOffset);
  return (
    isInQuietWindow(localHour, config.quietWindowStart, config.quietWindowEnd) &&
    api < config.thetaDormantAPI
  );
}

/**
 * Проверяет, отправил ли достаточно близкий контакт directed-сообщение (чтобы разбудить Alice ночью).
 * Перебирает все каналы, проверяет pending_directed > 0 и tier связанного contact < wakeTier.
 */
function hasDormantWakeSignal(G: WorldModel, nowMs: number, wakeTier: number): boolean {
  for (const chId of G.getEntitiesByType("channel")) {
    if (effectiveObligation(G, chId, nowMs) <= OBLIGATION_THRESHOLDS.modeEnter) continue;
    const contactId = chatIdToContactId(chId);
    if (!contactId || !G.has(contactId)) continue;
    const contact = G.getContact(contactId);
    if ((contact.tier ?? 500) < wakeTier) return true;
  }
  return false;
}

// ═══════════════════════════════════════════════════════════════════════════
// Agent Mode FSM — статья §6.2 Definition 6.2
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Логика переходов между режимами. Вызывается в начале каждого тика, возвращает новый режим.
 *
 * Правила переходов:
 * - patrol → conversation: пришло directed-сообщение + высокий P5 (давление социальных обязательств) → фиксируем focus
 * - conversation → patrol: тишина на focus превысила θ_silence
 * - patrol → consolidation: API < θ_low и P2 > θ_mem
 * - consolidation → patrol: завершение или прерывание с высоким приоритетом
 * - patrol/consolidation → dormant: тихое окно + низкий API (ADR-225)
 * - dormant → patrol: выход из тихого окна или directed-сообщение от близкого контакта
 *
 * @see paper/ §6.2 Definition 6.2
 * @see docs/adr/225-dormant-mode.md
 */
function transitionMode(
  state: EvolveState,
  api: number,
  p2: number,
  p5: number,
  nowMs: number,
): void {
  const { config, mode } = state;
  const now = nowMs;

  switch (mode) {
    // ADR-190: режим Wakeup — постепенное восстановление после перезапуска
    case "wakeup": {
      state.wakeupTicksElapsed++;
      // Условие выпуска: достаточно тиков и нет flood
      if (
        state.wakeupTicksElapsed >= config.wakeupGraduationTicks &&
        !isFloodCondition(state, state.recentEventCounts.at(-1) ?? 0)
      ) {
        state.mode = "patrol";
        state.focusTarget = undefined;
        state.modeEnteredMs = now;
        state.wakeupRecoveryUntilMs = now + POST_WAKEUP_RECOVERY_MS;
        log.info("Mode transition: wakeup → patrol (graduated)", {
          ticksElapsed: state.wakeupTicksElapsed,
          recoveryMs: POST_WAKEUP_RECOVERY_MS,
        });
      }
      // В период wakeup переходы в другие режимы не выполняются
      break;
    }
    case "patrol": {
      // ADR-147 D8: при flood не переходим в режим conversation — остаёмся в patrol, пусть V-maximizer управляет глобально.
      // При обработке накопленных сообщений человек просматривает все каналы перед принятием решения, а не фиксируется на первом.
      // После разгрузки isFloodCondition снова становится false, нормальный переход в conversation автоматически возобновляется.
      // @see docs/adr/147-flood-backlog-recovery.md §D8
      if (isFloodCondition(state, state.recentEventCounts.at(-1) ?? 0)) break;
      // → conversation: есть неотвеченная directed-цель + высокое социальное давление
      // ADR-124: используем порог effectiveObligation вместо pending_directed > 0
      // @see docs/adr/126-obligation-field-decay.md §D3
      if (p5 > 0.3) {
        const channels = state.G.getEntitiesByType("channel");
        for (const ch of channels) {
          if (effectiveObligation(state.G, ch, now) > OBLIGATION_THRESHOLDS.modeEnter) {
            state.mode = "conversation";
            state.focusTarget = ch;
            state.modeEnteredMs = now;
            log.info("Mode transition: patrol → conversation", { focusTarget: ch, p5 });
            return;
          }
        }
      }
      // → consolidation: низкое давление + высокая потребность в консолидации памяти
      if (api < config.thetaLowAPI && p2 > config.thetaMem) {
        state.mode = "consolidation";
        state.focusTarget = undefined;
        state.modeEnteredMs = now;
        log.info("Mode transition: patrol → consolidation", { api, p2 });
        break;
      }
      // ADR-225: → dormant: тихое окно + низкий API (нечего делать — идём спать)
      if (shouldEnterDormant(api, now, config)) {
        state.mode = "dormant";
        state.focusTarget = undefined;
        state.modeEnteredMs = now;
        log.info("Mode transition: patrol → dormant", {
          api,
          localHour: getLocalHour(now, config.timezoneOffset),
        });
      }
      break;
    }
    case "conversation": {
      // → patrol: таймаут тишины на focus или focus не существует
      if (!state.focusTarget || !state.G.has(state.focusTarget)) {
        state.mode = "patrol";
        state.focusTarget = undefined;
        state.modeEnteredMs = now;
        log.info("Mode transition: conversation → patrol (focus lost)");
        break;
      }
      const focusLastActivityMs = Number(
        state.G.getChannel(state.focusTarget).last_activity_ms ?? state.modeEnteredMs,
      );
      const silenceS = (now - focusLastActivityMs) / 1000;
      if (silenceS > config.thetaSilenceS) {
        state.mode = "patrol";
        state.focusTarget = undefined;
        state.modeEnteredMs = now;
        log.info("Mode transition: conversation → patrol (silence timeout)", { silenceS });
        break;
      }
      // ADR-124: обязательство затухло ниже порога → выход из режима разговора (гистерезис)
      // θ_exit (0.1) < θ_enter (0.3) — структурно устраняет колебания режима
      // @see docs/adr/126-obligation-field-decay.md §D3
      if (
        state.focusTarget &&
        effectiveObligation(state.G, state.focusTarget, now) < OBLIGATION_THRESHOLDS.modeExit
      ) {
        state.mode = "patrol";
        state.focusTarget = undefined;
        state.modeEnteredMs = now;
        log.info("Mode transition: conversation → patrol (obligation decayed)");
        break;
      }
      // Прерывание с высоким приоритетом: другой directed срочнее, чем focus
      // (пока не реализовано — focus boost в V-maximizer справляется с большинством случаев)
      break;
    }
    case "consolidation": {
      // → patrol: API восстановлен или прерывание с высоким приоритетом
      if (api > config.thetaLowAPI * 2) {
        state.mode = "patrol";
        state.focusTarget = undefined;
        state.modeEnteredMs = now;
        log.info("Mode transition: consolidation → patrol (API restored)", { api });
        break;
      }
      // Автовыход из длительного consolidation (максимум 10 минут)
      if ((now - state.modeEnteredMs) / 1000 > 600) {
        // ADR-225: таймаут consolidation + тихое окно → сразу dormant (не возвращаемся через patrol)
        if (shouldEnterDormant(api, now, config)) {
          state.mode = "dormant";
          state.focusTarget = undefined;
          state.modeEnteredMs = now;
          log.info("Mode transition: consolidation → dormant (timeout + quiet window)");
        } else {
          state.mode = "patrol";
          state.focusTarget = undefined;
          state.modeEnteredMs = now;
          log.info("Mode transition: consolidation → patrol (timeout)");
        }
      }
      break;
    }
    // ADR-225: режим Dormant — суточный ритм сна
    case "dormant": {
      const localHour = getLocalHour(now, config.timezoneOffset);
      const inQuiet = isInQuietWindow(localHour, config.quietWindowStart, config.quietWindowEnd);

      // Условие пробуждения 1: выход из тихого окна (естественный подъём)
      if (!inQuiet) {
        // После пробуждения переходим в режим wakeup, повторно используем логику постепенного восстановления
        state.mode = "wakeup";
        state.focusTarget = undefined;
        state.modeEnteredMs = now;
        state.wakeupTicksElapsed = 0;
        state.wakeupEngagedTargets.clear();
        state.wakeupRecoveryUntilMs = undefined;
        log.info("Mode transition: dormant → wakeup (quiet window ended)", { localHour });
        break;
      }

      // Условие пробуждения 2: directed-сообщение от близкого контакта (разбудили)
      if (hasDormantWakeSignal(state.G, now, config.dormantWakeTier)) {
        state.mode = "wakeup";
        state.focusTarget = undefined;
        state.modeEnteredMs = now;
        state.wakeupTicksElapsed = 0;
        state.wakeupEngagedTargets.clear();
        state.wakeupRecoveryUntilMs = undefined;
        log.info("Mode transition: dormant → wakeup (intimate directed)", { localHour });
        break;
      }

      // Оставаемся в dormant — переходов в другие режимы нет
      break;
    }
  }
}

/** Интервал сохранения поведенческих инсайтов (секунды). */
const BEHAVIORAL_INSIGHT_INTERVAL_S = 3600; // 1 час
let lastBehavioralInsightMs = Date.now();

// ═══════════════════════════════════════════════════════════════════════════
// evolveTick — упрощённая главная точка входа
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Выполняет полный пайплайн EVOLVE за один тик.
 * Возвращает, было ли поставлено в очередь действие.
 *
 * Структура пайплайна:
 * Phase 0: переход режимов
 * Phase 1: подготовка графа (необходимые мутации перед вычислением давлений)
 * Phase 2: чистый пайплайн — G → P → τ → (L, E_v) → gates → plan
 * Phase 3: граница побочных эффектов (единственная точка мутации)
 * Phase 4: снимок (интервал стенных часов + повтор OL-5)
 */
export function evolveTick(state: EvolveState): boolean {
  const { tick, dt } = state.clock.advance();
  // ADR-110: единственный источник времени стенных часов, все подфункции одного тика разделяют один nowMs
  const nowMs = Date.now();
  state.currentDt = dt;
  state.G.tick = tick;
  state.dispatcher.startTick(tick, nowMs);

  try {
    // Phase 1: подготовка графа (необходимые мутации перед вычислением давлений)
    appraiseLonelySilence(state.G, nowMs);
    updateEmotionStateOnGraph(state.G, nowMs);
    state.G.beliefs.decayAll(nowMs);
    const { eventCount, channelCounts } = perceiveTick(state.G, state.buffer, tick);
    // ADR-191: сохраняем channelCounts для вычисления spike-сигналов в computeTickPlan
    state.lastChannelCounts = channelCounts;
    updateSlidingWindows(state, eventCount);
    // ADR-147 D2+D9: обнаружение переполнения (чистый запрос) + единственное обновление EMA
    const backlogDetected = detectBacklog(state, eventCount);
    if (backlogDetected) {
      log.warn("Backlog detected via EMA", { eventCount, ema: state.eventCountEma });
    } else {
      // D9: обновление EMA выполняется только здесь в единственной точке (detectBacklog — чистый запрос, без побочных эффектов)
      state.eventCountEma = EMA_ALPHA * eventCount + (1 - EMA_ALPHA) * state.eventCountEma;
    }
    tickConversations(state.G, tick, nowMs);

    // Phase 1.5: ADR-115 генерация эндогенных потоков (после perceive, до pressure)
    // @see docs/adr/115-evolve-observability/
    // ADR-166: передаётся реальное количество секунд тика стенных часов, адаптивный α непрерывного времени EMA
    updateChannelRateEma(state.channelRateEma, channelCounts, state.currentDt);
    runGenerators({
      G: state.G,
      db: getDb(),
      tick,
      nowMs,
      config: state.config,
      channelCounts,
      channelRateEma: state.channelRateEma,
      mode: state.mode, // ADR-225: в dormant периодические генераторы подавляются
    });

    // Phase 2: чистый пайплайн — G → P → τ → (L, E_v) → gates → plan
    const plan = computeTickPlan(state, tick, nowMs, eventCount);

    // Обновляем lastAPI (используется startEvolveLoop для расчёта interval и переходов режимов)
    if (plan.type !== "skip") {
      // ADR-204 C5: значительное изменение давления — emit
      const oldApi = state.lastAPI;
      state.lastAPI = plan.pressures.API;
      state.lastAPIPeak = plan.pressures.API_peak;
      if (Math.abs(plan.pressures.API - oldApi) > 0.15) {
        try {
          emitConsciousness(getDb(), tick, nowMs, {
            kind: "evolve:pressure",
            entityIds: plan.target ? [plan.target] : [],
            summary: plan.pressures.API > oldApi ? "things getting busier" : "things calming down",
          });
        } catch (e) {
          log.warn("consciousness pressure-emit failed", e);
        }
      }
      // Phase 0: смена режима (используются значения давления, вычисленные в текущем tick)
      // Примечание: transitionMode по-прежнему использует суммарный API — семантика смены режима "насколько занята в целом", нужна экстенсивная величина.
      transitionMode(state, plan.pressures.API, plan.pressures.P2, plan.pressures.P5, nowMs);
    }

    // Phase 3: граница побочных эффектов (единственная точка мутации)
    const prevMode = state.mode;
    const acted = applyPlan(state, plan, tick, nowMs);

    // Phase 3.1: ADR-215 — обнаружение границ Episode + обновление
    if (plan.type !== "skip") {
      try {
        const planSnapshot = {
          type: plan.type,
          target: "target" in plan ? (plan.target ?? null) : null,
          voice: plan.voice,
          api: plan.pressures.API,
          dominantPressure: dominantDimension(plan.pressures),
          focalEntities: "focalEntities" in plan ? plan.focalEntities : [],
        };
        updateEpisode(state.episodeState, planSnapshot, tick, nowMs, state.mode !== prevMode);
      } catch (e) {
        log.warn("Episode update failed", e);
      }
    } else if (state.episodeState.currentId) {
      // skip plan, но есть активный episode → завершить его
      try {
        updateEpisode(
          state.episodeState,
          {
            type: "skip",
            target: null,
            voice: "diligence",
            api: 0,
            dominantPressure: "P1",
            focalEntities: [],
          },
          tick,
          nowMs,
          false,
        );
      } catch (e) {
        log.warn("Episode close on skip failed", e);
      }
    }

    // Phase 3.5: ADR-204 — emit событий потока сознания (уровень решения)
    try {
      commitTickEvents(getDb(), tick, nowMs, plan);
    } catch (e) {
      log.warn("consciousness emit failed", e);
    }

    // Phase 4: снэпшот (по реальному времени + повтор OL-5)
    const now = Date.now();
    const timeSinceFlushS = (now - state.lastFlushMs) / 1000;
    if (timeSinceFlushS > state.config.snapshotIntervalS) {
      try {
        if (state.G.has(ALICE_SELF)) {
          state.G.updateAgent(ALICE_SELF, { runtime_last_seen_ms: now });
        }
        flushGraph(state.G);
        state.lastFlushMs = now;
      } catch (e) {
        log.error("Snapshot failed, will retry next tick", e);
        writeAuditEvent(tick, "error", "evolve", "snapshot_failed", {
          error: e instanceof Error ? e.message : String(e),
          timeSinceLastFlushS: timeSinceFlushS,
        });
        // OL-5: не обновляем lastFlushMs → автоматический повтор на следующем tick
      }
    }

    // Phase 5: сохранение поведенческих инсайтов (по реальному времени)
    if ((now - lastBehavioralInsightMs) / 1000 > BEHAVIORAL_INSIGHT_INTERVAL_S) {
      lastBehavioralInsightMs = now;
      try {
        const chatIds = state.G.getEntitiesByType("channel");
        persistBehavioralInsights(tick, state.dispatcher, chatIds);
      } catch (e) {
        log.warn("Failed to persist behavioral insights", e);
      }
    }

    // Phase 5.5: ADR-199 — сканирование отложенной обратной связи (каждые 5 tick)
    if (tick > 0 && tick % 5 === 0) {
      try {
        const pendings = scanPendingOutcomes(state.G, now);
        for (const p of pendings) {
          evaluateDeferredOutcome(state.G, p, now, tick);
        }
      } catch (e) {
        log.warn("Deferred outcome scan failed", e);
      }
    }

    // Phase 5.6: ADR-117 D6 — Fact GC + ADR-199 проверка закрытых контуров + ADR-204 GC потока сознания (каждые 100 tick)
    if (tick > 0 && tick % 100 === 0) {
      try {
        gcExpiredFacts(state.G, now);
      } catch (e) {
        log.warn("Fact GC failed", e);
      }
      // ADR-204: GC потока сознания — очистка устаревших событий с низкой salience
      try {
        const removed = gcConsciousness(getDb(), now);
        if (removed > 0) log.info("Consciousness GC", { removed });
      } catch (e) {
        log.warn("Consciousness GC failed", e);
      }
      // ADR-199 W4: проверка здоровья закрытых контуров
      try {
        const health = computeClosureHealth(getDb(), 100);
        if (health.overallHealth !== "healthy") {
          writeAuditEvent(tick, "warn", "closure-health", health.issues.join("; "), {
            actionStateRatio: health.actionStateRatio,
            feelCoverage: health.feelCoverage,
            deferredEvalCount: health.deferredEvalCount,
            autoWritebackRatio: health.autoWritebackRatio,
            overallHealth: health.overallHealth,
            totalMessages: health.totalMessages,
          });
          log.warn("Closure health degraded", health);
        } else {
          log.info("Closure health OK", {
            actionStateRatio: health.actionStateRatio.toFixed(2),
            feelCoverage: health.feelCoverage.toFixed(2),
            totalMessages: health.totalMessages,
          });
        }
      } catch (e) {
        log.warn("Closure health check failed", e);
      }
    }

    // Phase 6: ADR-112 D5 — метрики натуральности (вычисляются раз в 50 tick, низкая стоимость)
    if (tick > 0 && tick % 50 === 0) {
      const metrics = computeNaturalness(state.G, state.recentActions, now);
      if (metrics.idi !== null || metrics.vde !== null || metrics.rai !== null) {
        log.info("Naturalness metrics", {
          tick,
          idi: metrics.idi?.toFixed(3) ?? "n/a",
          vde: metrics.vde?.toFixed(3) ?? "n/a",
          rai: metrics.rai?.toFixed(3) ?? "n/a",
        });
      }
    }

    return acted;
  } finally {
    state.dispatcher.endTick(tick);
  }
}

// -- ADR-30: Self mood decay ------------------------------------------------

// -- M2: Циркадный модулятор --------------------------------------------------

/**
 * Циркадный множитель порогового gate: корректирует нижний порог API по локальному времени пользователя.
 *
 * Плавный переход по cos-кривой, без скачков:
 *   multiplier = 1.5 - cos(2π × (localHour - peakHour) / 24)
 *
 *   peakHour → 0.5  (максимальная активность, порог минимален)
 *   peakHour ± 12h → 2.5  (максимальная тишина, порог максимален)
 *
 * Чем выше множитель → выше floor → нужно большее давление для прохождения gate → меньше действий.
 *
 * ADR-34 F1: принимает параметр смещения часового пояса, чтобы избежать рассинхронизации сервера и пользователя.
 * ADR-47 G5: принимает userPeakHour — пиковый час, обученный на активности пользователя.
 * @see docs/adr/47-gap-closure.md §G5
 */
export function circadianMultiplier(
  hour: number,
  timezoneOffset = 0,
  userPeakHour?: number,
): number {
  // hour — UTC-час; добавляем смещение, получаем локальный час пользователя
  const localHour = (((hour + timezoneOffset) % 24) + 24) % 24;
  const peakHour = userPeakHour ?? 14; // по умолчанию 14:00 (обратная совместимость при отсутствии данных)
  const theta = (2 * Math.PI * (localHour - peakHour)) / 24;
  return 1.5 - Math.cos(theta);
}

// -- ADR-30: Действие Digest ---------------------------------------------------

/**
 * Digest: mark_read + поверхностное обновление состояния графа (без стоимости LLM).
 *
 * Градиент стоимости: skip(нуль) → mark_read(пометить прочитанным) → digest(поверхностное переваривание) → System 2(LLM)
 */
function executeDigest(
  G: WorldModel,
  target: string,
  _tick: number,
  nowMs: number = Date.now(),
): void {
  // ADR-101: защитный guard — digest работает только с атрибутами channel
  if (!G.has(target) || G.getNodeType(target) !== "channel") return;

  // базовый mark_read + затухание activity_relevance (спам-группа → постепенно снижаем внимание)
  const relevance = G.getChannel(target).activity_relevance ?? 0.5;
  G.updateChannel(target, {
    unread: 0,
    unread_ewms: 0, // ADR-150 D3: синхронный сброс EWMS в ноль (согласовано с read_history в mapper.ts)
    recently_cleared_ms: nowMs,
    activity_relevance: relevance * 0.95,
  });
}

/**
 * ADR-64 I-1: окно debounce для directed-сообщений (миллисекунды).
 * После получения первого directed-сообщения ждать это время перед пробуждением — чтобы не будить на каждое сообщение.
 */
const DIRECTED_DEBOUNCE_MS = 2000;

/** Минимальный интервал между tick (мс) для защиты от tick-шторма. */
const MIN_TICK_INTERVAL_MS = 3000;
/** Окно anyEvent debounce (мс).
 * ADR-190: 10s→30s. В сценарии с несколькими группами 10s деградирует patrol до почти реального времени опроса,
 * 30s достаточно быстро, но резко снижает холостые tick. */
const ANY_EVENT_DEBOUNCE_MS = 30_000;

// ── ADR-190: константы экспоненциального отступа при сбоях LLM ──────────────────────────────────────

/** Верхний предел множителя отступа. max = 2^4 = 16 → интервал увеличивается не более чем в 16 раз. */
const BACKOFF_MAX_MULTIPLIER = 16;
/** Время автосброса отступа (мс). Если в течение этого времени новых сбоев нет → LLM считается восстановленным.
 * Согласовано с circuitResetMs автомата защиты (60s). */
const BACKOFF_RESET_MS = 60_000;

/**
 * Вычисляет множитель отступа при сбоях LLM.
 * multiplier = min(maxMultiplier, 2^consecutiveFailures)
 * Если в течение BACKOFF_RESET_MS новых сбоев нет → сбрасывается в 1 (нормальная скорость).
 */
export function computeBackoffMultiplier(
  backoff: EvolveState["llmBackoff"],
  nowMs: number,
): number {
  if (backoff.consecutiveFailures <= 0) return 1;
  // автосброс по таймауту
  if (nowMs - backoff.lastFailureMs > BACKOFF_RESET_MS) return 1;
  return Math.min(BACKOFF_MAX_MULTIPLIER, 2 ** backoff.consecutiveFailures);
}

/**
 * Запускает цикл EVOLVE (адаптивный таймер + пробуждение по событиям).
 * Возвращает AbortController для остановки.
 *
 * Тройной Promise.race:
 * 1. directed wakeup (debounce 2s) — наивысший приоритет
 * 2. anyEvent wakeup (debounce 10s) — полезен в conversation mode
 * 3. таймаут computeInterval(lastAPI, mode) — адаптивный интервал
 *
 * @see paper/ §6.4 Definition 6.3
 */
export function startEvolveLoop(state: EvolveState): AbortController {
  const ac = new AbortController();

  // ADR-54: счётчик последовательных ошибок — предотвращает тихие постоянные сбои evolveTick
  const MAX_CONSECUTIVE_ERRORS = 10;
  const MAX_FATAL_ROUNDS = 3;

  (async () => {
    let consecutiveErrors = 0;
    let fatalRounds = 0;

    // ADR-64 I-1: механизм directed wakeup
    let directedResolve: (() => void) | null = null;
    let directedDebounce: ReturnType<typeof setTimeout> | null = null;
    // H3: событие могло прийти, пока шёл тик (waiter ещё не создан) — запоминаем, не теряем wakeup.
    let pendingDirectedWake = false;

    state.buffer.onDirected = () => {
      if (directedDebounce) clearTimeout(directedDebounce);
      directedDebounce = setTimeout(() => {
        directedDebounce = null;
        if (directedResolve) {
          directedResolve();
          directedResolve = null;
        } else {
          pendingDirectedWake = true; // нет waiter'а сейчас → разбудимся на следующем витке
        }
      }, DIRECTED_DEBOUNCE_MS);
    };

    // механизм anyEvent wakeup (низкий приоритет)
    let anyEventResolve: (() => void) | null = null;
    let anyEventDebounce: ReturnType<typeof setTimeout> | null = null;
    let pendingAnyEventWake = false; // H3: аналогично — не теряем событие, пришедшее во время тика

    state.buffer.onAnyEvent = () => {
      if (anyEventDebounce) clearTimeout(anyEventDebounce);
      anyEventDebounce = setTimeout(() => {
        anyEventDebounce = null;
        if (anyEventResolve) {
          anyEventResolve();
          anyEventResolve = null;
        } else {
          pendingAnyEventWake = true;
        }
      }, ANY_EVENT_DEBOUNCE_MS);
    };

    while (!ac.signal.aborted && !state.queue.closed) {
      const tickStart = Date.now();
      try {
        evolveTick(state);
        consecutiveErrors = 0;

        // ADR-201: автоматическое обновление Skill (незаметная проверка в паузе между tick)
        maybeAutoUpgrade(state.clock.tick, log).catch((e) => {
          log.warn("auto-upgrade check failed", {
            error: e instanceof Error ? e.message : String(e),
          });
        });
      } catch (e) {
        consecutiveErrors++;
        log.error("Evolve tick error", { error: e, consecutiveErrors });
        if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
          fatalRounds++;
          log.fatal(
            "EVOLVE loop: 连续 %d 次异常（第 %d 轮 fatal）",
            MAX_CONSECUTIVE_ERRORS,
            fatalRounds,
          );
          writeAuditEvent(state.clock.tick, "fatal", "evolve", "连续异常超限", {
            consecutiveErrors,
            fatalRounds,
            lastError: e instanceof Error ? e.message : String(e),
          });
          if (fatalRounds >= MAX_FATAL_ROUNDS) {
            log.fatal("EVOLVE loop: %d 轮 fatal，管线不可恢复", fatalRounds);
            ac.abort(`EVOLVE: ${fatalRounds} fatal rounds, pipeline unrecoverable`);
            break;
          }
          consecutiveErrors = 0;
        }
      }

      // Адаптивное планирование: вычисляем следующий интервал на основе lastAPI и текущего mode
      // ADR-190: при сбоях LLM экспоненциальный отступ увеличивает interval, снижая бесполезные tick
      const elapsed = Date.now() - tickStart;
      // ADR-195: интервал tick использует peak-based API (интенсивная величина), не раздувается с ростом числа сущностей
      const adaptiveInterval = state.clock.computeInterval(state.lastAPIPeak, state.mode);
      const backoffMult = computeBackoffMultiplier(state.llmBackoff, Date.now());
      const backedOffInterval = adaptiveInterval * backoffMult;
      const remaining = Math.max(MIN_TICK_INTERVAL_MS - elapsed, backedOffInterval - elapsed);
      if (backoffMult > 1) {
        log.info("LLM backoff active", {
          consecutiveFailures: state.llmBackoff.consecutiveFailures,
          multiplier: backoffMult,
          intervalMs: Math.round(backedOffInterval),
        });
      }
      if (elapsed > backedOffInterval) {
        log.warn("Tick overran interval", { elapsed, adaptiveIntervalMs: backedOffInterval });
      }

      // H3: событие пришло, пока шёл тик (waiter не существовал) — не засыпаем, сразу следующий тик.
      if (pendingDirectedWake || pendingAnyEventWake) {
        pendingDirectedWake = false;
        pendingAnyEventWake = false;
        continue;
      }

      // Тройной Promise.race
      let sleepTimer: ReturnType<typeof setTimeout> | undefined;
      const sleepPromise = new Promise<void>((resolve) => {
        sleepTimer = setTimeout(resolve, remaining);
      });
      const directedPromise = new Promise<void>((resolve) => {
        directedResolve = resolve;
      });
      const anyEventPromise = new Promise<void>((resolve) => {
        anyEventResolve = resolve;
      });
      await Promise.race([sleepPromise, directedPromise, anyEventPromise]);
      // очистка
      clearTimeout(sleepTimer);
      directedResolve = null;
      anyEventResolve = null;
    }
    // очистка колбэков
    state.buffer.onDirected = null;
    state.buffer.onAnyEvent = null;
    if (directedDebounce) clearTimeout(directedDebounce);
    if (anyEventDebounce) clearTimeout(anyEventDebounce);
    log.info("Evolve loop stopped");
  })().catch((err) => {
    log.fatal("Evolve loop crashed unexpectedly", {
      error: err instanceof Error ? err.message : String(err),
    });
    ac.abort(err instanceof Error ? err.message : String(err));
  });

  return ac;
}
