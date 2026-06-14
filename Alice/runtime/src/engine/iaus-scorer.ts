/**
 * Скорер IAUS (Infinite Axis Utility System) — ADR-180 Phase 2.
 *
 * Заменяет аддитивное NSV-оценивание V-maximizer:
 * - старое: NSV = ΔP - λ·C_social (аддитивно, голос выбирается сначала → цель потом, два шага)
 * - новое: V = CF(∏ U_k) (мультипликативные Considerations, action_type × target выбираются за один шаг)
 *
 * Каждый Consideration — чистая функция (input, curve) → [ε, 1].
 * Произведение всех Considerations корректируется Compensation Factor и выбирается через Boltzmann softmax.
 *
 * Caution больше не является независимым action_type. R_Caution как U_conflict_avoidance —
 * общий Consideration, участвующий в мультипликативном оценивании всех action_type.
 *
 * @see docs/adr/180-iaus-migration/README.md
 * @see paper/ §3: шестимерное поле давления
 */

import type { BeliefStore } from "../belief/store.js";
import { readEmotionControlPatch } from "../emotion/graph.js";
import type { EmotionControlPatch } from "../emotion/types.js";
import { type TensionVector, ZERO_TENSION } from "../graph/tension.js";
import type { WorldModel } from "../graph/world-model.js";
import {
  effectiveActSilences,
  effectiveAversion,
  effectiveObligation,
  isConversationContinuation,
  isSelfResting,
  OBLIGATION_THRESHOLDS,
} from "../pressure/signal-decay.js";
import {
  computeSocialCost,
  type SaturationCostConfig,
  type SocialCostConfig,
} from "../pressure/social-cost.js";
import { computeVoI, estimateDeltaP } from "../pressure/social-value.js";
import { type ChannelClass, ChatTarget } from "../prompt/types.js";
import type { PressureDims } from "../utils/math.js";
import { std } from "../utils/math.js";
import { rCaution, readSelfMood } from "../voices/focus.js";
import { type PersonalityVector, VOICE_INDEX, type VoiceAction } from "../voices/personality.js";
import { DEFAULT_VOICE_COOLDOWN, voiceFatigue } from "./deliberation.js";
import { type Desire, findTopDesireForTarget } from "./desire.js";
import { classifyChatType, gateClosingConversation, resolveIsBot } from "./gates.js";

// ═══════════════════════════════════════════════════════════════════════════
// Константы
// ═══════════════════════════════════════════════════════════════════════════

/** Минимальное значение Consideration — абсолютное вето запрещено. */
const EPSILON = 0.01;

/** ADR-185 §1: Коэффициент буста Desire по умолчанию. */
const DEFAULT_DESIRE_BOOST = 0.15;
/** ADR-182 D1: Коэффициент Momentum bonus по умолчанию. */
const DEFAULT_MOMENTUM_BONUS = 0.2;
/** ADR-182 D1: Таймаут затухания Momentum (мс). */
const DEFAULT_MOMENTUM_DECAY_MS = 300_000;
/** ADR-251 Wave 1: Окно мягкого восстановления после короткой серии без ответа на private proactive. */
const PROACTIVE_PACING_MIN_INTERVAL_MS = 60_000;
/** ADR-251 Wave 1: Нижний предел мягкого демпфирования недавнего проактивного контакта. Жёсткий лимит — только для семантических ворот со 100% уверенностью. */
const PROACTIVE_PACING_RECENT_MIN = 0.2;
/** ADR-251 Wave 1: Наклон демпфирования одностороннего непрерывного вывода. */
const PROACTIVE_PACING_CONSECUTIVE_GAIN = 2.5;
/** ADR-268: lonely connection pull must not amplify repeated unsolicited outreach. */
const EMOTION_PROACTIVE_CAP_MIN = 0.2;
/** ADR-268: active affect gently modulates non-obligatory action tendency. */
const EMOTION_ACTION_UTILITY_MIN = 0.55;
const EMOTION_ACTION_UTILITY_MAX = 1.08;
/** После долгого отсутствия входящих в личке начинается мягкое снижение веса проактивного контакта. */
const INACTIVITY_STALE_GRACE_MS = 24 * 3600_000;
/** Полное окно мягкого снижения веса при отсутствии входящих. */
const INACTIVITY_STALE_FULL_MS = 7 * 24 * 3600_000;
/** Stale — не доказательство недостижимости, поэтому только мягкое снижение, без обнуления. */
const INACTIVITY_STALE_MIN = 0.15;
/** ADR-273/274: class cadence is soft self-pacing, not target eligibility. */
const CLASS_PACING_MIN = 0.05;

/**
 * ADR-218 Phase 2: U_fairness — Consideration пропорциональной справедливости обслуживания по принципу CFS.
 *
 * Степенное отображение: U_fairness = clamp(ratio^(-α), ε, U_MAX)
 *   ratio = actual_share / expected_share
 *   actual_share = service(target, window) / total_service
 *   expected_share = V_raw(target) / Σ V_raw
 *
 * ratio < 1 (недообслужен) → boost > 1.0 (бонус для underserved цели)
 * ratio = 1 (справедливо) → 1.0 (нейтрально)
 * ratio > 1 (переобслужен) → penalty < 1.0 (штраф для overserved цели)
 *
 * Единый заменитель трёх дискретных механизмов Phase 1 (URGENCY_BOOST, URGENCY_BUDGET, U_coverage).
 * Непрерывное затухание, без дискретных скачков.
 *
 * @see docs/adr/218-attention-fairness-rank-gate-starvation.md §A4 Phase 2
 * @see Linux CFS: vruntime += delta/weight → выбирается min(vruntime)
 * @see Shreedhar & Varghese 1995 (DRR deficit counter)
 */
const FAIRNESS_ALPHA = 2.0;
/** Верхняя граница U_fairness: предотвращает бесконечность при ratio→0. 4.0 = максимум 4-кратный бонус. */
const U_FAIRNESS_MAX = 4.0;
/** При недостатке данных об обслуживании (холодный старт) справедливость не применяется. */
const FAIRNESS_MIN_TOTAL_SERVICE = 5;

/**
 * ADR-151: дисперсия наблюдательного шума (константа знаменателя информационного отношения Калмана).
 * @see docs/adr/151-algorithm-audit/ #1 член информационного выигрыша VoI
 */
const SIGMA2_OBS = 0.1;

/** Нижняя граница демпфирования группового молчания, предотвращает нисходящую спираль. @see ADR-116 */
const GROUP_SILENCE_DAMPING_FLOOR = 0.3;

/** 3 типа действий в кандидатах IAUS (Caution свёрнут в U_conflict_avoidance). */
const IAUS_ACTIONS: readonly VoiceAction[] = ["diligence", "curiosity", "sociability"] as const;

/** Коэффициент модуляции настроения. @see loudness.ts PSI */
const MOOD_DELTA = 0.3;

/** ADR-183: нейтральная точка равновесной личности (π_v = 0.25 → кривая не меняется). */
const PERSONALITY_NEUTRAL = 0.25;
/** ADR-183: сила модуляции кривой по умолчанию. */
const DEFAULT_CURVE_MODULATION_STRENGTH = 0.5;

// ═══════════════════════════════════════════════════════════════════════════
// Response Curves
// ═══════════════════════════════════════════════════════════════════════════

type CurveType = "sigmoid" | "inv_sigmoid" | "linear" | "linear_dec" | "log" | "exp_recovery";

export interface ResponseCurve {
  type: CurveType;
  /** Середина sigmoid / начало диапазона linear. */
  midpoint: number;
  /** Наклон sigmoid / полная ширина linear. */
  slope: number;
  /** Нижняя граница вывода (≥ ε). */
  min: number;
  /** Верхняя граница вывода (≤ 1.0). */
  max: number;
}

/**
 * Вычисляет Response Curve. Вывод зажимается в [curve.min, curve.max].
 *
 * - sigmoid: S-образная кривая, от min до max, центр x=midpoint
 * - inv_sigmoid: обратная S-кривая, от max до min
 * - linear: линейно возрастающая (x=midpoint → min, x=midpoint+slope → max)
 * - linear_dec: линейно убывающая (x=midpoint → max, x=midpoint+slope → min)
 * - log: логарифмический рост
 * - exp_recovery: экспоненциальное восстановление (1 - exp(-...))
 */
export function evalCurve(curve: ResponseCurve, x: number): number {
  let t: number;
  switch (curve.type) {
    case "sigmoid":
      t = 1 / (1 + Math.exp(-curve.slope * (x - curve.midpoint)));
      break;
    case "inv_sigmoid":
      t = 1 - 1 / (1 + Math.exp(-curve.slope * (x - curve.midpoint)));
      break;
    case "linear":
      t = curve.slope > 0 ? clamp01((x - curve.midpoint) / curve.slope) : 0;
      break;
    case "linear_dec":
      t = 1 - (curve.slope > 0 ? clamp01((x - curve.midpoint) / curve.slope) : 0);
      break;
    case "log":
      if (curve.slope <= 0 || curve.midpoint <= 0) {
        t = 0;
      } else {
        t = clamp01(
          Math.log(1 + Math.max(0, x) * curve.slope) / Math.log(1 + curve.midpoint * curve.slope),
        );
      }
      break;
    case "exp_recovery":
      t = 1 - Math.exp(-curve.slope * Math.max(0, x - curve.midpoint));
      break;
  }
  return Math.max(curve.min, Math.min(curve.max, curve.min + (curve.max - curve.min) * t));
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

/**
 * ADR-183 Direction A: модуляция кривой, управляемая личностью.
 *
 * Высокий π_v → меньший midpoint (более раннее срабатывание) + более крутой slope (более резкая реакция).
 * Низкий π_v → больший midpoint (позднее срабатывание) + более пологий slope (более медленная реакция).
 * Равновесная личность (π_v = 0.25) = нулевая модуляция (базовая кривая без изменений).
 *
 * Гарантия стабильности: при π_v ∈ [0.05, 0.5] и strength ∈ [0, 1]
 * множитель midpoint ∈ [0.50, 1.40], множитель slope ∈ [0.60, 1.50] — никогда не отрицателен.
 * (при strength=0.5 по умолчанию: midpoint ∈ [0.75, 1.20], slope ∈ [0.80, 1.25])
 *
 * @see docs/adr/183-iaus-motive-layer-curve-modulation.md §3
 * @see Game AI Pro Ch.9 — "traits modify the shape of consideration curves"
 */
export function modulateCurve(base: ResponseCurve, piV: number, strength: number): ResponseCurve {
  if (strength <= 0) return base;
  const delta = (piV - PERSONALITY_NEUTRAL) * strength;
  return {
    ...base,
    midpoint: base.midpoint * (1 - delta * 2),
    slope: base.slope * (1 + delta * 2),
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Entity-Gated Dormancy
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Когда граф-сущность измерения давления отсутствует (τ₄=0 — нет потоков, τ₅=0 — нет обязательства ответа),
 * возвращает 1.0 (нейтрально), а не ε (вето).
 */
function dormantNeutral(rawInput: number, hasEntity: boolean, curve: ResponseCurve): number {
  if (!hasEntity && rawInput === 0) return 1.0;
  return evalCurve(curve, rawInput);
}

// ═══════════════════════════════════════════════════════════════════════════
// Типы
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Контекст кандидата IAUS: вывод bypassGates + замыкания Hawkes/Goldilocks.
 */
export interface CandidateContext {
  G: WorldModel;
  nowMs: number;
  getHawkesDiscount?: (target: string) => number;
  getGoldilocksUtility?: (target: string) => number;
  getRhythmTimingProfile?: (target: string, chatType?: string) => RhythmTimingProfile | null;
}

/** Минимальный интерфейс для построения кандидата в gates.ts и idle gate. */
export interface ActionCandidate {
  action: VoiceAction;
  target: string | null;
  focalEntities: string[];
  netValue: number;
  deltaP: number;
  socialCost: number;
  degraded?: boolean;
}

/** Полный кандидат, создаваемый скорером IAUS (расширяет ActionCandidate). */
export interface IAUSCandidate extends ActionCandidate {
  /** Оценки каждого Consideration по отдельности (для отладки). */
  considerations: Record<string, number>;
  /** Shadow-диагностика, не участвующая в оценивании. */
  diagnostics?: IAUSCandidateDiagnostics;
  /** Обходит ли gate-контроль. */
  bypassGates: boolean;
}

export interface IAUSScoredCandidate {
  action: string;
  target: string | null;
  V: number;
  bypassGates: boolean;
  bottleneck: string;
  deltaP: number;
  socialCost: number;
  netValue: number;
  considerations: Record<string, number>;
  diagnostics?: IAUSCandidateDiagnostics;
}

export interface RhythmTimingProfile {
  activeNowScore: number;
  quietNowScore: number;
  confidence: "low" | "medium" | "high";
  stale: boolean;
}

export interface TimingShadowDiagnostic {
  utility: number;
  applied: boolean;
  reason:
    | "bypass"
    | "unsupported_chat_type"
    | "missing_profile"
    | "low_confidence"
    | "stale"
    | "eligible";
  activeNowScore?: number;
  quietNowScore?: number;
  confidence?: RhythmTimingProfile["confidence"];
  stale?: boolean;
  netValue?: number;
  shadowNetValue?: number;
}

export interface IAUSCandidateDiagnostics {
  timingShadow?: TimingShadowDiagnostic;
}

export type IAUSFilterReason =
  | "target_whitelist"
  | "excluded_active_target"
  | "permanent_failure"
  | "consecutive_outgoing_cap"
  | "closing_conversation"
  | "crisis_mode"
  | "class_rate_cap"
  | "per_target_rate_limit"
  | "channel_action_scope"
  | "below_epsilon";

export interface IAUSFilterStats {
  totalChannels: number;
  eligibleTargets: number;
  filtered: Partial<Record<IAUSFilterReason, number>>;
}

export interface IAUSResult {
  candidate: IAUSCandidate;
  bestV: number;
  candidateCount: number;
  selectedProbability: number;
  winnerBypassGates: boolean;
  spread: number;
  scored: IAUSScoredCandidate[];
  filterStats: IAUSFilterStats;
}

export interface IAUSConfig {
  candidateCtx: CandidateContext;
  kappa: PressureDims;
  contributions: Record<string, Record<string, number>>;
  beliefs: BeliefStore;
  beliefGamma: number;
  thompsonEta: number;
  socialCost: SocialCostConfig;
  saturationCost: SaturationCostConfig;
  windowStartMs: number;
  uncertainty: number;
  personality: PersonalityVector;
  voiceLastWon: Record<VoiceAction, number>;
  nowMs: number;
  excludeTargets?: ReadonlySet<string>;
  /** Белый список целевых кандидатов. Если задан — в пул IAUS попадают только эти target. */
  targetWhitelist?: ReadonlySet<string> | null;
  /** Для тестов: отключает случайный выбор Boltzmann, используется argmax (детерминированно). */
  deterministic?: boolean;
  /** ADR-182 D1: победитель предыдущего tick (action, target). */
  lastWinner?: { action: VoiceAction; target: string } | null;
  /** ADR-182 D1: временная метка последнего действия (мс). */
  lastActionMs?: number;
  /** ADR-182 D1: коэффициент Momentum bonus (по умолчанию 0.2). */
  momentumBonus?: number;
  /** ADR-182 D1: таймаут затухания Momentum (мс, по умолчанию 300_000). */
  momentumDecayMs?: number;
  /** ADR-183: сила модуляции кривой (0 = нет модуляции, 1 = максимальная). */
  curveModulationStrength?: number;
  /** ADR-185 §1: список Desire, выведенных в текущем tick. */
  desires?: readonly Desire[];
  /** ADR-185 §1: коэффициент буста Desire (по умолчанию 0.15). */
  desireBoost?: number;
  // ADR-218 Phase 2: attentionDebtMap/attentionDebtConfig удалены.
  // U_coverage заменён U_fairness (post-scoring pass, не зависит от внешних данных долга).

  // ── ADR-189: Gate перенесён в IAUS per-candidate pre-filter ──
  /** Список кризисных каналов (предохранитель от флуда). */
  crisisChannels?: readonly string[];
  /** Жёсткий лимит частоты действий с учётом chat-type. */
  classRateCaps?: Record<ChannelClass, number>;
  /** Количество действий в окне по категориям class. */
  classActionCounts?: Record<ChannelClass, number>;
}

// ═══════════════════════════════════════════════════════════════════════════
// Вспомогательные функции (перенесены из v-maximizer.ts)
// ═══════════════════════════════════════════════════════════════════════════

function silenceDamping(actSilences: number, chatType: string): number {
  const raw = 1 / (1 + actSilences);
  // ADR-206: channel — не group; канал — сущность информационного потока, не участвует в расчёте социальной стоимости
  return ChatTarget.isGroupChat(chatType) ? Math.max(GROUP_SILENCE_DAMPING_FLOOR, raw) : raw;
}

function extractSigma2(beliefs: BeliefStore, target: string): number {
  return beliefs.getOrDefault(target, "tier").sigma2 + beliefs.getOrDefault(target, "mood").sigma2;
}

function extractVoI(beliefs: BeliefStore, target: string): number {
  return computeVoI(extractSigma2(beliefs, target), SIGMA2_OBS);
}

function gaussianRandom(): number {
  const u1 = Math.max(1e-10, Math.random());
  const u2 = Math.random();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/**
 * Вычисляет bypassGates для отдельного кандидата. Выделено из computeCandidateLambda в v-maximizer.ts.
 *
 * Приоритет:
 * 1. permanent failure → без bypass (исключение с высшим приоритетом)
 * 2. ADR-186: raw pending_directed > 0 → безусловный bypass (без затухания/дисконта)
 * 3. directed (effectiveObligation > θ_Ω) → bypass (покрывает не-@ обязательства)
 * 4. continuation разговора (alice_turn) → bypass
 */
export function computeCandidateBypass(ctx: CandidateContext, target: string): boolean {
  const { G, nowMs } = ctx;
  const isPermanentlyUnreachable =
    G.has(target) && G.getChannel(target).failure_type === "permanent";
  if (isPermanentlyUnreachable) return false;

  // ADR-186: raw pending_directed > 0 → безусловный bypass (без затухания/дисконта).
  // Кто-то назвал имя Алисы — где бы то ни было — это должно быть замечено.
  if (G.has(target)) {
    const rawDirected = Number(G.getChannel(target).pending_directed ?? 0);
    if (rawDirected > 0) return true;
  }

  // Затухшее обязательство всё ещё может триггерить bypass (покрывает не-@ обязательства)
  const obligation = G.has(target) ? effectiveObligation(G, target, nowMs) : 0;
  const targetHasDirected = obligation > OBLIGATION_THRESHOLDS.bypassGates;

  // Continuation разговора тоже даёт bypass
  const isContinuation = !targetHasDirected && isConversationContinuation(G, target, nowMs);

  return targetHasDirected || isContinuation;
}

export function computeCandidateStrongObligation(ctx: CandidateContext, target: string): boolean {
  const { G, nowMs } = ctx;
  if (!G.has(target)) return false;
  if (G.getChannel(target).failure_type === "permanent") return false;

  const rawDirected = Number(G.getChannel(target).pending_directed ?? 0);
  if (rawDirected > 0) return true;

  return effectiveObligation(G, target, nowMs) > OBLIGATION_THRESHOLDS.bypassGates;
}

/**
 * ADR-251: демпфирование проактивности, безопасное для горячих чатов.
 *
 * Это не обычный pre-CF consideration и не жёсткий gate. CF подтягивает единственный экстремально низкий элемент через геометрическое среднее,
 * поэтому данная утилита умножается после CF; она всё равно записывается в considerations для аудита узкого места.
 *
 * Инварианты:
 * - directed / obligation / continuation разговора не демпфируются;
 * - group/channel не демпфируются;
 * - в private, если собеседник снова написал после последнего слова Алисы (горячий чат) — не демпфируется;
 * - мягко давит только unsolicited private proactive без ответа.
 *
 * @see docs/adr/251-hot-chat-safe-proactive-damping.md
 */
export function computeProactivePacingUtility(opts: {
  chatType: string | undefined;
  bypassGates: boolean;
  nowMs: number;
  lastIncomingMs?: number;
  lastOutgoingMs?: number;
  lastProactiveOutreachMs?: number;
  consecutiveOutgoing?: number;
}): number {
  if (opts.bypassGates) return 1.0;

  const chatType = opts.chatType ?? "private";
  if (ChatTarget.isGroupChat(chatType) || ChatTarget.isChannelChat(chatType)) return 1.0;

  const lastIncomingMs = Number(opts.lastIncomingMs ?? 0);
  const lastOutgoingMs = Number(opts.lastOutgoingMs ?? 0);
  if (lastIncomingMs > lastOutgoingMs) return 1.0;

  const lastProactiveMs = Number(opts.lastProactiveOutreachMs ?? 0);
  let utility = 1.0;
  if (lastProactiveMs > 0) {
    const elapsedRatio = clamp01((opts.nowMs - lastProactiveMs) / PROACTIVE_PACING_MIN_INTERVAL_MS);
    utility *= PROACTIVE_PACING_RECENT_MIN + (1 - PROACTIVE_PACING_RECENT_MIN) * elapsedRatio ** 2;
  }

  const unilateralCount = Math.max(0, Number(opts.consecutiveOutgoing ?? 0) - 1);
  if (unilateralCount > 0) {
    utility *= 1 / (1 + PROACTIVE_PACING_CONSECUTIVE_GAIN * unilateralCount);
  }

  return Math.max(EPSILON, Math.min(1.0, utility));
}

export function computeEmotionProactiveCapUtility(opts: {
  chatType: string | undefined;
  bypassGates: boolean;
  proactiveCap: number | null;
  consecutiveOutgoing?: number;
  lastIncomingMs?: number;
  lastOutgoingMs?: number;
}): number {
  if (opts.bypassGates) return 1.0;
  if (opts.proactiveCap == null) return 1.0;

  const chatType = opts.chatType ?? "private";
  if (ChatTarget.isGroupChat(chatType) || ChatTarget.isChannelChat(chatType)) return 1.0;

  const lastIncomingMs = Number(opts.lastIncomingMs ?? 0);
  const lastOutgoingMs = Number(opts.lastOutgoingMs ?? 0);
  if (lastIncomingMs > lastOutgoingMs) return 1.0;

  const overCap = Math.max(0, Number(opts.consecutiveOutgoing ?? 0) - opts.proactiveCap);
  if (overCap <= 0) return 1.0;

  return Math.max(EPSILON, EMOTION_PROACTIVE_CAP_MIN / overCap);
}

export function computeInactivityStaleUtility(opts: {
  chatType: string | undefined;
  bypassGates: boolean;
  nowMs: number;
  lastIncomingMs?: number;
}): number {
  if (opts.bypassGates) return 1.0;

  const chatType = opts.chatType ?? "private";
  if (chatType !== "private") return 1.0;

  const lastIncomingMs = Number(opts.lastIncomingMs ?? 0);
  if (!Number.isFinite(lastIncomingMs) || lastIncomingMs <= 0) return 1.0;

  const inactiveMs = opts.nowMs - lastIncomingMs;
  if (inactiveMs <= INACTIVITY_STALE_GRACE_MS) return 1.0;

  const span = INACTIVITY_STALE_FULL_MS - INACTIVITY_STALE_GRACE_MS;
  const ratio = span > 0 ? clamp01((inactiveMs - INACTIVITY_STALE_GRACE_MS) / span) : 1.0;
  return 1.0 - ratio * (1.0 - INACTIVITY_STALE_MIN);
}

export function computeEmotionActionUtility(opts: {
  actionType: VoiceAction;
  chatType: string | undefined;
  bypassGates: boolean;
  control: EmotionControlPatch;
}): number {
  if (opts.bypassGates) return 1.0;

  const chatType = opts.chatType ?? "private";
  if (ChatTarget.isChannelChat(chatType)) return 1.0;

  const { voiceBias, styleBudget } = opts.control;
  let utility = 1.0;

  if (opts.actionType === "sociability") {
    utility += voiceBias.sociability;
    utility -= Math.max(0, voiceBias.caution) * 0.35;
    if (styleBudget.preferShort) utility -= 0.08;
    if (styleBudget.avoidSelfProof) utility -= 0.12;
  } else if (opts.actionType === "curiosity") {
    utility += Math.min(0, voiceBias.sociability) * 0.4;
    utility -= Math.max(0, voiceBias.caution) * 0.2;
    if (styleBudget.preferShort) utility -= 0.04;
  } else {
    utility -= Math.max(0, voiceBias.caution) * 0.1;
  }

  if (styleBudget.maxCharsMultiplier < 0.85) {
    utility -= (0.85 - styleBudget.maxCharsMultiplier) * 0.25;
  }

  return Math.max(EMOTION_ACTION_UTILITY_MIN, Math.min(EMOTION_ACTION_UTILITY_MAX, utility));
}

export function computeClassPacingUtility(opts: {
  classActionCount?: number;
  classSoftBudget?: number;
  bypassGates: boolean;
}): number {
  if (opts.bypassGates) return 1.0;

  const count = Math.max(0, Number(opts.classActionCount ?? 0));
  const budget = Math.max(0, Number(opts.classSoftBudget ?? Number.POSITIVE_INFINITY));
  if (!Number.isFinite(budget)) return 1.0;
  if (budget <= 0) return CLASS_PACING_MIN;

  const excess = Math.max(0, count - budget);
  if (excess <= 0) return 1.0;

  const lambda = Math.max(1, budget / 2);
  return Math.max(CLASS_PACING_MIN, Math.exp(-excess / lambda));
}

/**
 * ADR-261 Wave 3: timing utility по ритмическому профилю, только в режиме shadow.
 *
 * Функция производит только диагностические значения, не участвует в текущем мультипликативном оценивании IAUS. В будущем Wave 4, если будет включена,
 * сможет действовать только на non-bypass unsolicited private/channel proactive.
 */
export function computeTimingShadowUtility(opts: {
  chatType: string | undefined;
  bypassGates: boolean;
  profile?: RhythmTimingProfile | null;
}): TimingShadowDiagnostic {
  if (opts.bypassGates) {
    return { utility: 1.0, applied: false, reason: "bypass" };
  }

  const chatType = opts.chatType ?? "private";
  if (ChatTarget.isGroupChat(chatType) || chatType === "bot") {
    return { utility: 1.0, applied: false, reason: "unsupported_chat_type" };
  }

  const profile = opts.profile;
  if (!profile) {
    return { utility: 1.0, applied: false, reason: "missing_profile" };
  }

  if (profile.confidence === "low") {
    return {
      utility: 1.0,
      applied: false,
      reason: "low_confidence",
      activeNowScore: profile.activeNowScore,
      quietNowScore: profile.quietNowScore,
      confidence: profile.confidence,
      stale: profile.stale,
    };
  }

  if (profile.stale) {
    return {
      utility: 1.0,
      applied: false,
      reason: "stale",
      activeNowScore: profile.activeNowScore,
      quietNowScore: profile.quietNowScore,
      confidence: profile.confidence,
      stale: profile.stale,
    };
  }

  const utility = Math.max(
    0.3,
    Math.min(1.15, 1.0 + 0.15 * profile.activeNowScore - 0.45 * profile.quietNowScore),
  );

  return {
    utility,
    applied: true,
    reason: "eligible",
    activeNowScore: profile.activeNowScore,
    quietNowScore: profile.quietNowScore,
    confidence: profile.confidence,
    stale: profile.stale,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Кривые Consideration (параметры по умолчанию, откалиброваны в Phase 1 экспериментально)
// ═══════════════════════════════════════════════════════════════════════════

const CURVES = {
  // Общие
  conflict_avoidance: {
    type: "inv_sigmoid",
    midpoint: 0.6,
    slope: 5,
    min: EPSILON,
    max: 1,
  } as ResponseCurve,
  freshness: { type: "linear_dec", midpoint: 0, slope: 1, min: EPSILON, max: 1 } as ResponseCurve,
  reciprocity: { type: "linear_dec", midpoint: 0, slope: 3, min: 0.05, max: 1 } as ResponseCurve,
  // Усердие (Diligence)
  obligation: { type: "sigmoid", midpoint: 0.3, slope: 8, min: EPSILON, max: 1 } as ResponseCurve,
  attention: { type: "sigmoid", midpoint: 0.2, slope: 6, min: EPSILON, max: 1 } as ResponseCurve,
  thread_age: { type: "log", midpoint: 1, slope: 0.5, min: EPSILON, max: 1 } as ResponseCurve,
  deltaP: { type: "sigmoid", midpoint: 0.3, slope: 4, min: EPSILON, max: 1 } as ResponseCurve,
  prospect: { type: "sigmoid", midpoint: 0.1, slope: 6, min: EPSILON, max: 1 } as ResponseCurve,
  // Общительность (Sociability)
  cooling: { type: "sigmoid", midpoint: 0.3, slope: 5, min: EPSILON, max: 1 } as ResponseCurve,
  social_bond: { type: "sigmoid", midpoint: 0.2, slope: 4, min: EPSILON, max: 1 } as ResponseCurve,
  social_safety: {
    type: "inv_sigmoid",
    midpoint: 0.5,
    slope: 4,
    min: EPSILON,
    max: 1,
  } as ResponseCurve,
  // Curiosity. τ₆ is unmet curiosity pressure, not novelty satisfaction.
  curiosity_pressure: {
    type: "sigmoid",
    midpoint: 0.1,
    slope: 6,
    min: EPSILON,
    max: 1,
  } as ResponseCurve,
  info_pressure: {
    type: "sigmoid",
    midpoint: 0.2,
    slope: 5,
    min: EPSILON,
    max: 1,
  } as ResponseCurve,
  exploration: { type: "log", midpoint: 0.1, slope: 0.8, min: EPSILON, max: 1 } as ResponseCurve,
  // ADR-178: Attraction
  attraction: { type: "sigmoid", midpoint: 0.15, slope: 6, min: EPSILON, max: 1 } as ResponseCurve,
  // ADR-219 D1: Voice Affinity — доминирование давления среди голосов
  // midpoint=1/3 (нейтрально при равном разделении трёх голосов), slope=6 (умеренная крутизна)
  // share=0.6 → U≈0.83, share=0.1 → U≈0.12, мультипликативная различимость ~7x
  voice_affinity: {
    type: "sigmoid",
    midpoint: 0.33,
    slope: 6,
    min: EPSILON,
    max: 1,
  } as ResponseCurve,
} as const;

// ═══════════════════════════════════════════════════════════════════════════
// Compensation Factor
// ═══════════════════════════════════════════════════════════════════════════

/** Значение CF, откалиброванное в Phase 1. */
const CF = 0.4;

/**
 * Компенсирует проблему "чем больше Considerations, тем ниже оценка" в мультипликативном оценивании.
 * rawScore = ∏ U_k → geomMean = rawScore^(1/n) → скорректированный вывод.
 */
export function compensate(rawScore: number, n: number, cf: number): number {
  if (n <= 1 || rawScore <= 0) return rawScore;
  const geomMean = rawScore ** (1 / n);
  return geomMean * (1 + (1 - geomMean) * cf);
}

// ═══════════════════════════════════════════════════════════════════════════
// Voice Affinity (ADR-219 D1: доминирование давления среди голосов)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * ADR-219 D1: вычисляет аффинность голоса — относительное доминирование основного измерения давления этого voice на данном target.
 *
 * Каждый voice связан с определёнными измерениями давления (после κ-нормализации сопоставимы):
 *   Diligence:    P5 (обязательство) + P1 (внимание)
 *   Sociability:  P3 (охлаждение отношений)
 *   Curiosity:    P6 (любопытство) + P2 (информация)
 *
 * share = mySignal / totalSignal → sigmoid(midpoint=1/3) → [ε, 1]
 *
 * Восстанавливает cross-voice inhibition, утраченный при унификации IAUS (функция старой конкуренции loudness),
 * но участвует как мультипликативный consideration — другие considerations могут его переопределить.
 *
 * @see docs/adr/219-pressure-field-evolution-directions.md §D1
 */
function computeVoiceAffinity(
  tension: TensionVector,
  actionType: VoiceAction,
  kappa: PressureDims,
): number {
  // Основной сигнал давления на голос после κ-нормализации
  const k1 = Math.max(kappa[0], 1e-6);
  const k2 = Math.max(kappa[1], 1e-6);
  const k3 = Math.max(kappa[2], 1e-6);
  const k5 = Math.max(kappa[4], 1e-6);
  const k6 = Math.max(kappa[5], 1e-6);

  const dSignal = tension.tau5 / k5 + tension.tau1 / k1;
  const sSignal = tension.tau3 / k3;
  const cSignal = tension.tau6 / k6 + tension.tau2 / k2;

  const total = dSignal + sSignal + cSignal;
  if (total < 1e-6) return 1.0; // нет сигнала давления → нейтрально (не участвует в конкуренции голосов)

  const mySignal =
    actionType === "diligence" ? dSignal : actionType === "sociability" ? sSignal : cSignal;
  const share = mySignal / total;

  return evalCurve(CURVES.voice_affinity, share);
}

// ═══════════════════════════════════════════════════════════════════════════
// Вычисление Consideration
// ═══════════════════════════════════════════════════════════════════════════

interface SharedInputs {
  tension: TensionVector;
  chatType: string;
  reachabilityScore: number;
  effSilences: number;
  freshness: number; // recentActionsForTarget / perTargetCap
  consecutiveOutgoing: number;
  bypassGates: boolean;
}

/**
 * Вычисляет общие Considerations (умножаются для всех action_type).
 * ADR-218 Phase 2: U_coverage удалён (заменён U_fairness, вычисляется в post-scoring pass).
 */
function computeSharedConsiderations(
  inputs: SharedInputs,
  actionType: VoiceAction,
  config: IAUSConfig,
  selfMood: number,
): Record<string, number> {
  const { tension, chatType, reachabilityScore, effSilences, freshness, consecutiveOutgoing } =
    inputs;

  // U_conflict_avoidance: rCaution(tension, uncertainty) → inv_sigmoid
  const cautionInput = rCaution(tension, config.uncertainty);
  const U_conflict_avoidance = evalCurve(CURVES.conflict_avoidance, cautionInput);

  // U_freshness: ratio → linear_dec
  const U_freshness = evalCurve(CURVES.freshness, freshness);

  // U_reciprocity: consecutive_outgoing → linear_dec
  const U_reciprocity = evalCurve(CURVES.reciprocity, consecutiveOutgoing);

  // U_reachable: бинарный {ε, 1}
  const U_reachable = reachabilityScore > 0.5 ? 1.0 : EPSILON;

  // U_fatigue: voiceFatigue → прямая передача [0, 1]
  const lastWonMs = config.voiceLastWon[actionType];
  const U_fatigue = Math.max(
    EPSILON,
    voiceFatigue(config.nowMs, lastWonMs, DEFAULT_VOICE_COOLDOWN),
  );

  // U_mood: ψ_v(selfMood)
  // diligence/curiosity: 1.0 (нет эффекта настроения), sociability: 1 ± 0.3 × mood
  let U_mood: number;
  if (actionType === "sociability") {
    U_mood = Math.max(EPSILON, 1 + MOOD_DELTA * selfMood);
  } else {
    U_mood = 1.0;
  }

  // ADR-183: U_personality удалён — его эффект кодируется в специализированных кривых Consideration через modulateCurve().
  // Константный множитель + модуляция кривой = double-counting. Модуляция кривой создаёт входозависимую поверхность чувствительности (качественное изменение),
  // константный множитель — только равномерное масштабирование (количественное изменение).

  // U_silence_damping: 1/(1+n) with group floor
  const U_silence_damping = Math.max(EPSILON, silenceDamping(effSilences, chatType));

  // ADR-219 D1: U_voice_affinity — доминирование давления среди голосов.
  // Восстанавливает cross-voice inhibition, утраченный при унификации IAUS.
  // Основан на паттерне tension (не personality) → различимость сохраняется и при равновесной личности по умолчанию.
  const U_voice_affinity = computeVoiceAffinity(tension, actionType, config.kappa);

  return {
    U_conflict_avoidance,
    U_freshness,
    U_reciprocity,
    U_reachable,
    U_fatigue,
    U_mood,
    U_silence_damping,
    U_voice_affinity,
  };
}

/**
 * Специфические Considerations для Diligence (5 шт.).
 * ADR-183: все кривые модулируются через π_D — высокая Diligence-личность реагирует на сигнал обязательства раньше.
 */
function computeDiligenceConsiderations(
  tension: TensionVector,
  target: string,
  G: WorldModel,
  config: IAUSConfig,
): Record<string, number> {
  const { nowMs, contributions, kappa } = config;
  const piD = config.personality.weights[VOICE_INDEX.diligence];
  const cms = config.curveModulationStrength ?? DEFAULT_CURVE_MODULATION_STRENGTH;

  // U_obligation: effectiveObligation → sigmoid (с модуляцией личности)
  const obligationRaw = G.has(target) ? effectiveObligation(G, target, nowMs) : 0;
  const hasEntity = G.has(target);
  const U_obligation = dormantNeutral(
    obligationRaw,
    hasEntity,
    modulateCurve(CURVES.obligation, piD, cms),
  );

  // U_attention: τ₁ → sigmoid (с модуляцией личности)
  const U_attention = evalCurve(modulateCurve(CURVES.attention, piD, cms), tension.tau1);

  // U_thread_age: τ₄ → log (entity-gated: τ₄=0 и нет потоков → 1.0) (с модуляцией личности)
  const hasThreads = tension.tau4 > 0;
  const U_thread_age = dormantNeutral(
    tension.tau4,
    hasThreads,
    modulateCurve(CURVES.thread_age, piD, cms),
  );

  // U_deltaP: estimateDeltaP → sigmoid (с модуляцией личности)
  const rawDeltaP = estimateDeltaP(contributions, target, kappa);
  const U_deltaP = evalCurve(modulateCurve(CURVES.deltaP, piD, cms), rawDeltaP);

  // U_prospect: τ_P → sigmoid (entity-gated: τ_P=0 → 1.0) (с модуляцией личности)
  const hasProspect = tension.tauP > 0;
  const U_prospect = dormantNeutral(
    tension.tauP,
    hasProspect,
    modulateCurve(CURVES.prospect, piD, cms),
  );

  return { U_obligation, U_attention, U_thread_age, U_deltaP, U_prospect };
}

/**
 * Специфические Considerations для Sociability (6 шт.).
 * ADR-183: кривые evalCurve модулируются через π_S — высокая Sociability-личность реагирует на охлаждение отношений раньше.
 * U_goldilocks и U_hawkes — прямо передаваемые значения, не используют ResponseCurve, не модулируются.
 */
function computeSociabilityConsiderations(
  tension: TensionVector,
  target: string,
  G: WorldModel,
  tick: number,
  recentActions: Array<{ tick: number; action: string; ms?: number; target?: string | null }>,
  config: IAUSConfig,
  chatType: string,
  bypassGates: boolean,
): Record<string, number> {
  const { nowMs, socialCost: scConfig, candidateCtx } = config;
  const piS = config.personality.weights[VOICE_INDEX.sociability];
  const cms = config.curveModulationStrength ?? DEFAULT_CURVE_MODULATION_STRENGTH;

  // U_cooling: τ₃ → sigmoid (с модуляцией личности)
  const U_cooling = evalCurve(modulateCurve(CURVES.cooling, piS, cms), tension.tau3);

  // U_social_bond: τ₅ × 0.6 → sigmoid (entity-gated: τ₅=0 и не directed → 1.0) (с модуляцией личности)
  const bondInput = tension.tau5 * 0.6;
  const hasBond = tension.tau5 > 0 || bypassGates;
  const U_social_bond = dormantNeutral(
    bondInput,
    hasBond,
    modulateCurve(CURVES.social_bond, piS, cms),
  );

  // U_social_safety: computeSocialCost → inv_sigmoid (с модуляцией личности)
  // Наблюдение: высокий π_S → снижение midpoint → аварийный стоп по безопасности срабатывает раньше (выше чувствительность к социальной стоимости).
  // Текущая интерпретация: высокая социальная осознанность = высокая чувствительность к границам. При несоответствии с данными из прод-среды
  // можно независимо перевернуть направление модуляции для inv_sigmoid. @see отчёт ADR-183 P2
  const rawSocialCost = computeSocialCost(
    G,
    target,
    "sociability",
    tick,
    nowMs,
    recentActions,
    scConfig,
    chatType,
  );
  const U_social_safety = evalCurve(modulateCurve(CURVES.social_safety, piS, cms), rawSocialCost);

  // U_goldilocks: прямая передача [ε, 1] (bypassGates=true → 1.0) — не использует ResponseCurve, не модулируется личностью
  const goldilocksRaw =
    !bypassGates && candidateCtx.getGoldilocksUtility
      ? candidateCtx.getGoldilocksUtility(target)
      : 1.0;
  const U_goldilocks = Math.max(EPSILON, goldilocksRaw);

  // U_hawkes: Hawkes λ discount — прямая передача [ε, 1], не использует ResponseCurve, не модулируется личностью
  const hawkesRaw = candidateCtx.getHawkesDiscount?.(target) ?? 1.0;
  const U_hawkes = Math.max(EPSILON, hawkesRaw);

  // U_attraction: τ_attraction → sigmoid (ADR-178) (с модуляцией личности)
  const U_attraction = evalCurve(
    modulateCurve(CURVES.attraction, piS, cms),
    tension.tauAttraction ?? 0,
  );

  return { U_cooling, U_social_bond, U_social_safety, U_goldilocks, U_hawkes, U_attraction };
}

/**
 * Специфические Considerations для Curiosity (3 шт.).
 * ADR-183/аудит P6: все кривые модулируются через π_C.
 * τ₆ — неудовлетворённое давление любопытства; не называть novelty satisfaction.
 */
function computeCuriosityConsiderations(
  tension: TensionVector,
  target: string,
  config: IAUSConfig,
): Record<string, number> {
  const piC = config.personality.weights[VOICE_INDEX.curiosity];
  const cms = config.curveModulationStrength ?? DEFAULT_CURVE_MODULATION_STRENGTH;

  // U_curiosity_pressure: τ₆ → sigmoid (с модуляцией личности)
  const U_curiosity_pressure = evalCurve(
    modulateCurve(CURVES.curiosity_pressure, piC, cms),
    tension.tau6,
  );

  // U_info_pressure: τ₂ → sigmoid (с модуляцией личности)
  const U_info_pressure = evalCurve(modulateCurve(CURVES.info_pressure, piC, cms), tension.tau2);

  // U_exploration: VoI (Kalman σ²) → log (с модуляцией личности)
  const isPermanent =
    config.candidateCtx.G.has(target) &&
    config.candidateCtx.G.getChannel(target).failure_type === "permanent";
  const voiValue = !isPermanent && config.beliefGamma > 0 ? extractVoI(config.beliefs, target) : 0;
  const U_exploration = evalCurve(modulateCurve(CURVES.exploration, piC, cms), voiValue);

  return { U_curiosity_pressure, U_info_pressure, U_exploration };
}

// ═══════════════════════════════════════════════════════════════════════════
// Главный конвейер оценивания
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Выполняет IAUS-оценивание по всем channel × 3 action_types.
 *
 * @returns IAUSResult или null (все кандидаты набрали ≤ ε).
 */
export function scoreAllCandidates(
  tensionMap: Map<string, TensionVector>,
  G: WorldModel,
  tick: number,
  recentActions: Array<{ tick: number; action: string; ms?: number; target?: string | null }>,
  config: IAUSConfig,
): IAUSResult | null {
  return scoreAllCandidatesDetailed(tensionMap, G, tick, recentActions, config).result;
}

export function scoreAllCandidatesDetailed(
  tensionMap: Map<string, TensionVector>,
  G: WorldModel,
  tick: number,
  recentActions: Array<{ tick: number; action: string; ms?: number; target?: string | null }>,
  config: IAUSConfig,
): { result: IAUSResult | null; filterStats: IAUSFilterStats } {
  const { nowMs, candidateCtx, saturationCost: satConfig, windowStartMs } = config;
  const filterStats: IAUSFilterStats = {
    totalChannels: G.getEntitiesByType("channel").length,
    eligibleTargets: 0,
    filtered: {},
  };
  const noteFiltered = (reason: IAUSFilterReason, count = 1) => {
    filterStats.filtered[reason] = (filterStats.filtered[reason] ?? 0) + count;
  };

  if (isSelfResting(G, nowMs)) return { result: null, filterStats };

  const selfMood = readSelfMood(G, nowMs);
  const emotionControl = readEmotionControlPatch(G, nowMs);
  const channels = G.getEntitiesByType("channel").filter((target) => {
    const allowed = !config.targetWhitelist || config.targetWhitelist.has(target);
    if (!allowed) noteFiltered("target_whitelist");
    return allowed;
  });
  filterStats.eligibleTargets = channels.length;

  const scored: Array<{
    candidate: IAUSCandidate;
    V: number;
    bypassGates: boolean;
  }> = [];

  for (const target of channels) {
    if (config.excludeTargets?.has(target)) {
      noteFiltered("excluded_active_target");
      continue;
    }

    // Pre-filter: permanent-недостижимые target не оцениваются
    if (G.has(target) && G.getChannel(target).failure_type === "permanent") {
      noteFiltered("permanent_failure");
      continue;
    }

    // Общие входные данные, вычисляемые для каждого target один раз
    const tension = tensionMap.get(target) ?? ZERO_TENSION;
    const chatType = G.has(target) ? G.getChannel(target).chat_type : "private";
    const rawReach = G.has(target) ? G.getChannel(target).reachability_score : undefined;
    const reachabilityScore =
      typeof rawReach === "number" && !Number.isNaN(rawReach) ? rawReach : 1.0;
    const effSilences = effectiveActSilences(G, target, nowMs);
    const channelAttrs = G.has(target) ? G.getChannel(target) : null;
    const consecutiveOutgoing = channelAttrs ? Number(channelAttrs.consecutive_outgoing ?? 0) : 0;

    // U_freshness input: per-target action count in window / perTargetCap
    const targetActionsInWindow = recentActions.filter(
      (a) => (a.ms ?? 0) > windowStartMs && a.target === target,
    ).length;

    const bypass = computeCandidateBypass(candidateCtx, target);
    const strongObligation = computeCandidateStrongObligation(candidateCtx, target);

    // Pre-filter: consecutive_outgoing >= cap и нет обязательства → пропустить (защита от спама)
    // В V-max эта логика реализовалась через C_sat σ_out → V ≤ 0; мультипликативный IAUS не поддерживает абсолютное вето,
    // поэтому используется жёсткий gate. Сигнал обязательства (bypassGates) обходит это ограничение.
    const isGroupChat = ChatTarget.isGroupChat(chatType);
    const outgoingCap = isGroupChat ? satConfig.outgoingCapGroup : satConfig.outgoingCapPrivate;
    if (!strongObligation && consecutiveOutgoing >= outgoingCap) {
      noteFiltered("consecutive_outgoing_cap");
      continue;
    }

    const perTargetCap = bypass ? satConfig.perTargetCapBypass : satConfig.perTargetCap;
    const freshness =
      strongObligation || perTargetCap <= 0 ? 0 : targetActionsInWindow / perTargetCap;
    const channelClass = classifyChatType(chatType, resolveIsBot(G, target));

    // ── ADR-189: 4 gate внутренне перенесены в IAUS per-candidate pre-filter ──

    // 1. Closing conversation — обещание leave() заблокировано (безусловно, bypass не проходит сквозь прощание)
    if (gateClosingConversation(G, target).type === "silent") {
      noteFiltered("closing_conversation");
      continue;
    }

    // 2. Crisis mode — кризисный канал блокируется при отсутствии обязательства
    if (!bypass && config.crisisChannels?.includes(target)) {
      noteFiltered("crisis_mode");
      continue;
    }

    // ADR-273/274: class/per-target ordinary cadence is not target eligibility.
    // Per-target density is already represented by U_freshness; class density is
    // represented below by post-CF U_class_pacing so it remains visible in traces.
    const classPacingUtility = computeClassPacingUtility({
      bypassGates: bypass,
      classActionCount: config.classActionCounts?.[channelClass],
      classSoftBudget: config.classRateCaps?.[channelClass],
    });
    const proactivePacingUtility = computeProactivePacingUtility({
      chatType,
      bypassGates: bypass,
      nowMs,
      lastIncomingMs: Number(channelAttrs?.last_incoming_ms ?? 0),
      lastOutgoingMs: Number(channelAttrs?.last_outgoing_ms ?? 0),
      lastProactiveOutreachMs: Number(channelAttrs?.last_proactive_outreach_ms ?? 0),
      consecutiveOutgoing,
    });
    const emotionProactiveCapUtility = computeEmotionProactiveCapUtility({
      chatType,
      bypassGates: bypass,
      proactiveCap: emotionControl.actionCaps.proactiveMessages,
      consecutiveOutgoing,
      lastIncomingMs: Number(channelAttrs?.last_incoming_ms ?? 0),
      lastOutgoingMs: Number(channelAttrs?.last_outgoing_ms ?? 0),
    });
    const timingShadow = computeTimingShadowUtility({
      chatType,
      bypassGates: bypass,
      profile: candidateCtx.getRhythmTimingProfile?.(target, chatType) ?? null,
    });
    const inactivityStaleUtility = computeInactivityStaleUtility({
      chatType,
      bypassGates: bypass,
      nowMs,
      lastIncomingMs: Number(channelAttrs?.last_incoming_ms ?? 0),
    });

    const sharedInputs: SharedInputs = {
      tension,
      chatType,
      reachabilityScore,
      effSilences,
      freshness,
      consecutiveOutgoing: strongObligation ? 0 : consecutiveOutgoing,
      bypassGates: bypass,
    };

    // Итерация по 3 типам действий
    for (const actionType of IAUS_ACTIONS) {
      // ADR-206: channel может быть выбран только curiosity (сущность информационного потока, не социальный партнёр).
      // diligence можно разблокировать после реализации публикации в канале W7 (только для admin/owner).
      if (chatType === "channel" && actionType !== "curiosity") {
        noteFiltered("channel_action_scope");
        continue;
      }
      const shared = computeSharedConsiderations(sharedInputs, actionType, config, selfMood);
      let specific: Record<string, number>;
      let n: number;

      switch (actionType) {
        case "diligence":
          specific = computeDiligenceConsiderations(tension, target, G, config);
          n = Object.keys(shared).length + Object.keys(specific).length;
          break;
        case "sociability":
          specific = computeSociabilityConsiderations(
            tension,
            target,
            G,
            tick,
            recentActions,
            config,
            chatType,
            bypass,
          );
          n = Object.keys(shared).length + Object.keys(specific).length;
          break;
        case "curiosity":
          specific = computeCuriosityConsiderations(tension, target, config);
          n = Object.keys(shared).length + Object.keys(specific).length;
          break;
        default:
          continue;
      }

      // Произведение ∏ U_k. U_proactive_pacing из ADR-251 применяется после CF, чтобы не разбавлялось компенсацией геометрического среднего.
      const preCFConsiderations = { ...shared, ...specific };
      let rawScore = 1;
      for (const v of Object.values(preCFConsiderations)) {
        rawScore *= v;
      }

      // Compensation Factor
      let compensatedScore = compensate(rawScore, n, CF);

      // ADR-251: private proactive pacing — post-CF utility.
      // Давит только unsolicited private proactive без ответа; directed/hot-chat/group/channel = 1.0.
      compensatedScore *= classPacingUtility;
      compensatedScore *= proactivePacingUtility;
      compensatedScore *= emotionProactiveCapUtility;
      compensatedScore *= inactivityStaleUtility;
      const emotionActionUtility = computeEmotionActionUtility({
        actionType,
        chatType,
        bypassGates: bypass,
        control: emotionControl,
      });
      compensatedScore *= emotionActionUtility;
      const allConsiderations = {
        ...preCFConsiderations,
        U_class_pacing: classPacingUtility,
        U_proactive_pacing: proactivePacingUtility,
        U_emotion_proactive_cap: emotionProactiveCapUtility,
        U_inactivity_stale: inactivityStaleUtility,
        U_emotion_action: emotionActionUtility,
      };

      // ADR-217: Aversion — мультипликативная модуляция социального избегания.
      // V_eff = V × (1 - aversion). bypass не проходит сквозь aversion (активный выбор Алисы, обязательство не переопределяет).
      const aversion = effectiveAversion(G, target, nowMs);
      if (aversion > 0) {
        compensatedScore *= 1 - Math.min(aversion, 1);
      }

      // ADR-182 D1: Momentum Bonus — победитель предыдущего tick получает мультипликативный бонус
      const mBonus = config.momentumBonus ?? DEFAULT_MOMENTUM_BONUS;
      const mDecayMs = config.momentumDecayMs ?? DEFAULT_MOMENTUM_DECAY_MS;
      const lastWinner = config.lastWinner;
      const lastActMs = config.lastActionMs ?? 0;
      if (
        mBonus > 0 &&
        lastWinner &&
        actionType === lastWinner.action &&
        target === lastWinner.target &&
        nowMs - lastActMs < mDecayMs
      ) {
        compensatedScore *= 1 + mBonus;
      }

      // ADR-185 §1: Desire Boost — target, соответствующий desire, получает мультипликативный бонус
      const dBoost = config.desireBoost ?? DEFAULT_DESIRE_BOOST;
      if (dBoost > 0 && config.desires?.length) {
        const topDesire = findTopDesireForTarget(config.desires, target);
        if (topDesire) {
          compensatedScore *= 1 + dBoost * topDesire.urgency;
        }
      }

      // Фильтрация по ε
      if (compensatedScore <= EPSILON) {
        noteFiltered("below_epsilon");
        continue;
      }

      // deltaP и socialCost — для аудита
      const rawDeltaP = estimateDeltaP(config.contributions, target, config.kappa);
      const rawSocialCost = computeSocialCost(
        G,
        target,
        actionType,
        tick,
        nowMs,
        recentActions,
        config.socialCost,
        chatType,
      );

      scored.push({
        candidate: {
          action: actionType,
          target,
          focalEntities: [target],
          netValue: compensatedScore,
          deltaP: rawDeltaP,
          socialCost: rawSocialCost,
          considerations: allConsiderations,
          diagnostics: { timingShadow },
          bypassGates: bypass,
        },
        V: compensatedScore,
        bypassGates: bypass,
      });
    }
  }

  if (scored.length === 0) return { result: null, filterStats };

  // ── ADR-218 Phase 2: U_fairness — пропорциональная справедливость по принципу CFS ────────
  //
  // Единый заменитель трёх дискретных механизмов Phase 1:
  //   URGENCY_BOOST   → необслуженная цель естественно получает ratio^(-α) > 1.0 бонус
  //   URGENCY_BUDGET  → переобслуженная цель естественно получает ratio^(-α) < 1.0 штраф (непрерывное затухание, без скачков)
  //   U_coverage      → длительно недообслуженный ratio остаётся низким → бонус сохраняется (замена attention debt bonus)
  //
  // Формулы:
  //   expected_share(i) = V_raw(i) / Σ V_raw     (ожидаемая доля по пропорции utility)
  //   actual_share(i)   = service(i) / total       (фактическая доля обслуживания в окне)
  //   ratio(i)          = actual / expected
  //   U_fairness(i)     = clamp(ratio^(-α), ε, U_MAX)
  //
  // Гарантии инвариантов:
  //   I1 пропорциональная справедливость — штраф перегруженных + бонус недогруженных → долгосрочно service ∝ V_raw
  //   I2 ограниченный отклик — новое обязательство ratio≈0 → U_fairness=U_MAX → почти гарантированная победа
  //   I3 нет голодания — долгое недообслуживание → ratio стабильно низкий → U_fairness стабильно высокий → в итоге будет выбрано
  //   I5 самокоррекция — после выбора ratio↑ → U_fairness↓ → автоматически уступает место
  //
  // @see docs/adr/218-attention-fairness-rank-gate-starvation.md §A4
  // @see Linux CFS: vruntime += delta/weight → выбирается min(vruntime)
  const pool = scored; // единый пул

  // Подсчёт обслуживания per-target в окне
  const serviceInWindow = new Map<string, number>();
  let totalService = 0;
  for (const a of recentActions) {
    if ((a.ms ?? 0) > config.windowStartMs && a.target) {
      serviceInWindow.set(a.target, (serviceInWindow.get(a.target) ?? 0) + 1);
      totalService++;
    }
  }

  // Вычисляем Σ V_raw (для expected_share)
  const sumVRaw = pool.reduce((s, e) => s + e.V, 0);

  // Применяем U_fairness: второй проход
  if (totalService >= FAIRNESS_MIN_TOTAL_SERVICE && sumVRaw > 0) {
    for (const entry of pool) {
      const target = entry.candidate.target;
      if (!target) continue;

      const expectedShare = entry.V / sumVRaw;
      const actualShare = (serviceInWindow.get(target) ?? 0) / totalService;

      // ratio = actual / expected. ratio < 1 = недообслужен, ratio > 1 = переобслужен
      const ratio = actualShare / Math.max(1e-6, expectedShare);

      // Степенное отображение: ratio^(-α)
      // ratio=0.5 → 4.0 (сильный бонус), ratio=1 → 1.0, ratio=2 → 0.25 (сильный штраф)
      const rawFairness = Math.max(ratio, 1e-6) ** -FAIRNESS_ALPHA;
      const U_fairness = Math.max(EPSILON, Math.min(U_FAIRNESS_MAX, rawFairness));

      entry.V *= U_fairness;
      entry.candidate.considerations.U_fairness = U_fairness;
    }
  }

  for (const entry of pool) {
    const timingShadow = entry.candidate.diagnostics?.timingShadow;
    if (!timingShadow) continue;
    entry.candidate.diagnostics = {
      ...entry.candidate.diagnostics,
      timingShadow: {
        ...timingShadow,
        netValue: entry.V,
        shadowNetValue: entry.V * timingShadow.utility,
      },
    };
  }

  // ── Наложение шума Thompson Sampling ──────────────────────────────────────
  const eta = config.thompsonEta;
  let softmaxValues: number[];
  if (eta > 0 && pool.length > 1) {
    softmaxValues = pool.map((entry) => {
      const t = entry.candidate.target;
      if (!t) return entry.V;
      const isPermanent = G.has(t) && G.getChannel(t).failure_type === "permanent";
      const sigma2 = isPermanent ? 0 : extractSigma2(config.beliefs, t);
      if (sigma2 > 0) {
        return entry.V + eta * Math.sqrt(sigma2) * gaussianRandom();
      }
      return entry.V;
    });
  } else {
    softmaxValues = pool.map((s) => s.V);
  }

  // ── Выбор Boltzmann softmax с адаптивной температурой ─────────────────────────────
  const vValues = pool.map((s) => s.V);
  const spread = std(scored.map((s) => s.V)); // spread по-прежнему на основе всего scored (согласованность аудита)
  const tau = 0.05 + 0.2 / (1.0 + spread * 5.0);

  const maxV = Math.max(...softmaxValues);
  const exps = softmaxValues.map((v) => Math.exp((v - maxV) / tau));
  const sumExp = exps.reduce((a, b) => a + b, 0);
  const probs = sumExp > 0 ? exps.map((e) => e / sumExp) : vValues.map(() => 1.0 / vValues.length);

  let winnerIdx: number;
  if (config.deterministic) {
    // Детерминированный argmax — для тестов, избегает случайности Boltzmann
    winnerIdx = softmaxValues.indexOf(Math.max(...softmaxValues));
  } else {
    const r = Math.random();
    let cumulative = 0;
    winnerIdx = probs.length - 1;
    for (let i = 0; i < probs.length; i++) {
      cumulative += probs[i];
      if (r < cumulative) {
        winnerIdx = i;
        break;
      }
    }
  }

  const result: IAUSResult = {
    candidate: pool[winnerIdx].candidate,
    bestV: pool[winnerIdx].V,
    candidateCount: pool.length,
    selectedProbability: probs[winnerIdx],
    winnerBypassGates: pool[winnerIdx].bypassGates,
    spread,
    filterStats,
    // D5: scored возвращает все кандидаты (полнота аудита), сохраняются структурированные поля для контрфактического анализа.
    scored: scored.map((s) => ({
      action: s.candidate.action,
      target: s.candidate.target,
      V: s.V,
      bypassGates: s.bypassGates,
      bottleneck: Object.entries(s.candidate.considerations).reduce(
        (min, [k, v]) => (v < min[1] ? [k, v] : min),
        ["", Infinity] as [string, number],
      )[0],
      deltaP: s.candidate.deltaP,
      socialCost: s.candidate.socialCost,
      netValue: s.V,
      considerations: s.candidate.considerations,
      diagnostics: s.candidate.diagnostics,
    })),
  };
  return { result, filterStats };
}

// ═══════════════════════════════════════════════════════════════════════════
// Сборка Reason (перенесена из v-maximizer.ts)
// ═══════════════════════════════════════════════════════════════════════════

function magnitudeLabel(value: number, thresholds: [number, number] = [0.3, 1.0]): string {
  return value > thresholds[1] ? "high" : value > thresholds[0] ? "moderate" : "low";
}

/**
 * Переводит IAUSCandidate в машинно-генерируемое структурированное обоснование.
 *
 * ADR-185 §1: при наличии совпадающего desire первым элементом reason отображается метка desire и уровень urgency.
 */
export function assembleIAUSReason(
  candidate: IAUSCandidate,
  apiValue: number,
  voiNull?: number,
  selectedProbability?: number,
  desire?: Desire,
): string {
  const parts: string[] = [];

  // ADR-185 §1: desire первым элементом
  if (desire) {
    parts.push(`desire: ${desire.label} (urgency=${magnitudeLabel(desire.urgency)})`);
  }

  parts.push(`pressure=${magnitudeLabel(apiValue)}`);

  if (candidate.deltaP > 0) {
    parts.push(`relief=${magnitudeLabel(candidate.deltaP, [0.2, 0.8])}`);
  }
  if (candidate.socialCost > 0) {
    parts.push(`cost=${magnitudeLabel(candidate.socialCost, [0.2, 0.6])}`);
  }
  parts.push(`value=${magnitudeLabel(candidate.netValue, [0.1, 0.5])}`);

  if (selectedProbability !== undefined) {
    parts.push(`p=${(selectedProbability * 100).toFixed(0)}%`);
  }

  if (voiNull !== undefined && voiNull > 0.01) {
    parts.push(voiNull > 0.1 ? "waiting may help" : "acting is slightly better than waiting");
  }

  return parts.join(", ");
}
