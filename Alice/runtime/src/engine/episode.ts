/**
 * ADR-215: Cognitive Episode Graph — управление жизненным циклом Episode.
 *
 * Episode = отрезок связной когнитивной активности, начинающийся с target engagement и завершающийся естественным прерыванием.
 * Автоматическая сегментация (Event Segmentation Theory), без явного объявления LLM.
 *
 * Ключевая инновация: Residue (остаточное напряжение) кодирует неразрешённые психические состояния,
 * инжектируемые через channelPressures в конкуренцию за вовлечённость — биомиметическая субъектная активность.
 *
 * @see docs/adr/215-cognitive-episode-graph.md
 * @see CompassMem arXiv:2601.04726 (Event Segmentation Theory)
 * @see MAGMA arXiv:2601.03236 (четырёхграфная развязка + двухпоточная эволюция)
 */

import { and, eq, gt, isNotNull, lt } from "drizzle-orm";
import { getDb } from "../db/connection.js";
import { episodes } from "../db/schema.js";
import { ensureChannelId, ensureContactId } from "../graph/constants.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("episode");

// ── Types ────────────────────────────────────────────────────────────────

export interface EpisodeResidue {
  /** Семантическая классификация (выведена из outcome, может быть ненадёжной — только для справки). */
  type: "unfinished" | "unresolved_emotion" | "interrupted" | "curiosity";
  /** Исходный сигнал outcome (ground truth, можно переопределить при ненадёжной классификации). */
  outcome: string;
  /** Исходный engagement outcome (complete/timeout/preempted/limit/llm_failed и т.д.). */
  engagementOutcome: string | null;
  /** Значение API-давления на момент завершения episode. */
  pressure: number;
  intensity: number; // 0..1
  toward: string | null; // entity ID or null
  decayHalfLifeMs: number;
  createdMs: number;
}

export interface ActiveResidue {
  episodeId: string;
  residue: EpisodeResidue;
}

/** Рабочее состояние Episode в EvolveState. */
export interface EpisodeWorkingState {
  /** ID текущего активного episode, null = нет активного episode. */
  currentId: string | null;
  /** Target текущего episode. */
  currentTarget: string | null;
  /** Стартовый tick текущего episode. */
  currentTickStart: number | null;
  /** Кэш активных residue в памяти (чтобы не запрашивать DB каждый tick). */
  activeResidues: ActiveResidue[];
}

/** Снимок решения, передаваемый из applyPlan. */
export interface EpisodePlanSnapshot {
  type: "enqueue" | "silent" | "skip" | "system1";
  target: string | null;
  voice: string;
  api: number;
  dominantPressure: string;
  focalEntities: string[];
}

// ── Constants ────────────────────────────────────────────────────────────

/** Минимальная продолжительность episode (в тиках), защита от фрагментации. */
const MIN_EPISODE_TICKS = 2;

/** Период полураспада Residue (мс), разбитый по типам. */
const RESIDUE_HALF_LIFE: Record<EpisodeResidue["type"], number> = {
  unfinished: 30 * 60 * 1000, // 30 минут
  unresolved_emotion: 60 * 60 * 1000, // 1 час
  interrupted: 20 * 60 * 1000, // 20 минут
  curiosity: 45 * 60 * 1000, // 45 минут
};

/** Вклад Residue ниже этого значения игнорируется. */
const RESIDUE_MIN_CONTRIBUTION = 0.01;

/** Максимальный возраст активного residue (мс) — после превышения не запрашивается. */
const RESIDUE_MAX_AGE_MS = 4 * 60 * 60 * 1000; // 4 часа

/** Срок хранения Episode (мс). */
const EPISODE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 дней

/** Максимальный разрыв в тиках для вывода caused_by. */
const CAUSATION_MAX_GAP_TICKS = 5;

// ── Lifecycle ────────────────────────────────────────────────────────────

/** Инициализация EpisodeWorkingState. Вызывается один раз при запуске evolve. */
export function initEpisodeState(): EpisodeWorkingState {
  const activeResidues = loadActiveResidues(Date.now());
  log.info("Episode state initialized", { activeResidues: activeResidues.length });
  return {
    currentId: null,
    currentTarget: null,
    currentTickStart: null,
    activeResidues,
  };
}

/**
 * Вызывается каждый тик в конце applyPlan. Определяет границы episode, автоматически открывает/закрывает episode.
 *
 * Граничные условия (Event Segmentation Theory):
 * - смена target
 * - plan.type не является enqueue (молчание/skip)
 * - смена модуса (через флаг modeChanged)
 */
export function updateEpisode(
  epState: EpisodeWorkingState,
  plan: EpisodePlanSnapshot,
  tick: number,
  nowMs: number,
  modeChanged: boolean,
  engagementOutcome?: string,
): void {
  const newTarget = plan.type === "enqueue" ? plan.target : null;
  const prevTarget = epState.currentTarget;
  const prevId = epState.currentId;

  // ── Условия завершения ──
  const shouldClose =
    prevId != null &&
    (newTarget !== prevTarget || // target изменился
      newTarget == null || // молчание/skip
      modeChanged || // смена модуса
      engagementOutcome === "leave"); // явный выход

  if (shouldClose && prevId) {
    closeEpisode(epState, tick);
  }

  // ── Условия открытия ──
  if (newTarget && newTarget !== prevTarget) {
    openEpisode(epState, plan, tick, nowMs);
  }
}

function openEpisode(
  epState: EpisodeWorkingState,
  plan: EpisodePlanSnapshot,
  tick: number,
  nowMs: number,
): void {
  const id = `episode:${tick}`;

  // Вывод caused_by (временная близость + совпадение residue + пересечение сущностей)
  const causedBy = inferCausedBy(epState, plan.target, plan.voice, plan.focalEntities, tick);

  try {
    getDb()
      .insert(episodes)
      .values({
        id,
        tickStart: tick,
        target: plan.target,
        voice: plan.voice,
        pressureApi: plan.api,
        pressureDominant: plan.dominantPressure,
        entityIds: JSON.stringify(plan.focalEntities),
        causedBy: causedBy.length > 0 ? JSON.stringify(causedBy) : null,
        createdMs: nowMs,
      })
      .run();
  } catch (e) {
    log.warn("Failed to open episode", { id, error: e instanceof Error ? e.message : String(e) });
    return;
  }

  epState.currentId = id;
  epState.currentTarget = plan.target;
  epState.currentTickStart = tick;

  log.debug("Episode opened", {
    id,
    target: plan.target,
    voice: plan.voice,
    causedBy: causedBy.length > 0 ? causedBy : undefined,
  });
}

/**
 * Закрытие episode в потоке Evolve — только маркировка границы и очистка рабочего состояния.
 *
 * Настоящий outcome + residue записывает поток act через closeEpisodeFromAct(),
 * поскольку только processResult имеет реальный сигнал engagement.
 *
 * Поток evolve вызывает эту функцию при смене target:
 * - Если episode слишком короткий (< MIN_EPISODE_TICKS) → удалить
 * - Если поток act уже записал outcome → не перезаписывать (уже корректно закрыт)
 * - Если поток act ещё не записал → установить tickEnd, но не писать outcome/residue (ждём act)
 */
function closeEpisode(epState: EpisodeWorkingState, tick: number): void {
  const id = epState.currentId;
  if (!id || !epState.currentTickStart) return;

  // Проверка минимальной продолжительности — слишком короткие episode удаляются сразу
  if (tick - epState.currentTickStart < MIN_EPISODE_TICKS) {
    try {
      getDb().delete(episodes).where(eq(episodes.id, id)).run();
    } catch {
      /* ignore */
    }
    epState.currentId = null;
    epState.currentTarget = null;
    epState.currentTickStart = null;
    return;
  }

  // Устанавливаем только tickEnd (если поток act ещё не закрыл episode)
  try {
    const row = getDb()
      .select({ outcome: episodes.outcome })
      .from(episodes)
      .where(eq(episodes.id, id))
      .get();
    if (row && !row.outcome) {
      // Поток act ещё не записал outcome → устанавливаем границу tickEnd
      getDb().update(episodes).set({ tickEnd: tick }).where(eq(episodes.id, id)).run();
    }
    // Если row.outcome уже заполнен, поток act корректно закрыл episode — не перезаписываем
  } catch (e) {
    log.warn("Failed to mark episode boundary", {
      id,
      error: e instanceof Error ? e.message : String(e),
    });
  }

  log.debug("Episode boundary marked (evolve)", { id, tick });

  epState.currentId = null;
  epState.currentTarget = null;
  epState.currentTickStart = null;
}

// ── Causal Edge Inference ────────────────────────────────────────────────

function inferCausedBy(
  epState: EpisodeWorkingState,
  target: string | null,
  voice: string,
  focalEntities: string[],
  tick: number,
): string[] {
  const causes: string[] = [];

  // Правило 1: residue.toward указывает на текущий target
  for (const r of epState.activeResidues) {
    if (r.residue.toward === target && target != null) {
      causes.push(r.episodeId);
    }
  }

  if (causes.length > 0) return causes;

  // Правило 2: недавно завершённый episode (временная близость + пересечение сущностей или продолжение голоса)
  try {
    const recent = getDb()
      .select({ id: episodes.id, entityIds: episodes.entityIds, voice: episodes.voice })
      .from(episodes)
      .where(
        and(isNotNull(episodes.tickEnd), gt(episodes.tickStart, tick - CAUSATION_MAX_GAP_TICKS)),
      )
      .all();

    for (const ep of recent) {
      const epEntities: string[] = JSON.parse(ep.entityIds || "[]");
      const hasEntityOverlap = focalEntities.some((e) => epEntities.includes(e));
      const hasSameVoice = ep.voice === voice;

      if (hasEntityOverlap || hasSameVoice) {
        causes.push(ep.id);
      }
    }
  } catch {
    /* DB error → skip inference */
  }

  return causes;
}

// ── Pressure Contribution ────────────────────────────────────────────────

const LN2 = Math.LN2;

/**
 * Вычисляет вклад давления всех активных residue и инжектирует их в channelPressures map.
 * Вызывается после построения channelPressures в evolve.ts, перед updateAttentionDebt.
 */
export function injectResidueContributions(
  _activeResidues: ActiveResidue[],
  _channelPressures: Map<string, number>,
  _nowMs: number,
): void {
  // ADR-274 W3.5: residue is not a trusted runtime control input.
  // Keep the API as a no-op while W4 replaces it with typed target-bound continuity.
}

/**
 * Обновляет кэш residue — удаляет записи, затухшие ниже порога.
 * Вызывается один раз за тик, лёгкая операция.
 */
/**
 * Обновляет кэш residue из DB (поток act мог записать новые residue) + обрезает затухшие записи.
 * Вызывается один раз за тик. Чтение из DB вместо чисто памяти гарантирует согласованность между потоками.
 */
export function refreshResidueCache(nowMs: number): ActiveResidue[] {
  const fresh = loadActiveResidues(nowMs);
  return fresh.filter((r) => {
    const age = nowMs - r.residue.createdMs;
    if (age > RESIDUE_MAX_AGE_MS) return false;
    const contribution = r.residue.intensity * Math.exp((-LN2 * age) / r.residue.decayHalfLifeMs);
    return contribution >= RESIDUE_MIN_CONTRIBUTION;
  });
}

// ── DB Helpers ───────────────────────────────────────────────────────────

function loadActiveResidues(nowMs: number): ActiveResidue[] {
  try {
    const cutoff = nowMs - RESIDUE_MAX_AGE_MS;
    const rows = getDb()
      .select({ id: episodes.id, residue: episodes.residue })
      .from(episodes)
      .where(and(isNotNull(episodes.residue), gt(episodes.createdMs, cutoff)))
      .all();

    const result: ActiveResidue[] = [];
    for (const row of rows) {
      if (!row.residue) continue;
      try {
        const parsed = JSON.parse(row.residue) as EpisodeResidue;
        result.push({ episodeId: row.id, residue: parsed });
      } catch {
        /* malformed JSON → skip */
      }
    }
    return result;
  } catch {
    return [];
  }
}

/**
 * GC: удаляет устаревшие episode (> 7 дней). Вызывается на фазе обслуживания evolve.
 */
export function gcEpisodes(nowMs: number): number {
  try {
    const cutoff = nowMs - EPISODE_MAX_AGE_MS;
    const deleted = getDb().delete(episodes).where(lt(episodes.createdMs, cutoff)).run();
    return deleted.changes;
  } catch {
    return 0;
  }
}

/**
 * Записывает ребро consults — вызывается, когда LLM обращается к некоторому episode.
 */
export function recordConsults(currentEpisodeId: string, consultedEpisodeId: string): void {
  try {
    const row = getDb()
      .select({ consults: episodes.consults })
      .from(episodes)
      .where(eq(episodes.id, currentEpisodeId))
      .get();

    if (!row) return;

    const existing: string[] = row.consults ? JSON.parse(row.consults) : [];
    if (existing.includes(consultedEpisodeId)) return;
    existing.push(consultedEpisodeId);

    getDb()
      .update(episodes)
      .set({ consults: JSON.stringify(existing) })
      .where(eq(episodes.id, currentEpisodeId))
      .run();

    log.debug("Recorded consults edge", { from: currentEpisodeId, to: consultedEpisodeId });
  } catch (e) {
    log.warn("Failed to record consults", { error: e instanceof Error ? e.message : String(e) });
  }
}

// ── Закрытие Episode в потоке Act (реальный сигнал) ─────────────────────

/** Реальный сигнал engagement, передаваемый из processResult. */
export interface ActOutcomeSignals {
  messageSent: boolean;
  isSilence: boolean;
  success: boolean;
  errorCount: number;
  scriptErrors: number;
  silenceReason: string | null;
  engagementOutcome: string | null;
  subcycles: number;
  durationMs: number;
  target: string | null;
  tick: number;
}

/**
 * Закрытие episode из потока act — слияние двух источников (LLM как основной + структурный запасной).
 *
 * Источники сигналов:
 * - llmResidue: когнитивный остаток, напрямую выраженный LLM в TickStepSchema.residue (семантика на стороне LLM)
 * - signals: структурные сигналы processResult (messageSent/error/silence)
 *
 * Правило слияния: в residue записывается только явно выраженный когнитивный остаток LLM; ошибки рантайма не маскируются под незавершённые мысли.
 *
 * @see docs/adr/215-cognitive-episode-graph.md
 */
export function closeEpisodeFromAct(
  episodeId: string,
  signals: ActOutcomeSignals,
  llmResidue?: import("../llm/schemas.js").LLMResidue,
): void {
  const nowMs = Date.now();

  const row = getDb().select().from(episodes).where(eq(episodes.id, episodeId)).get();
  if (!row) {
    log.debug("closeEpisodeFromAct: episode not found", { episodeId });
    return;
  }
  if (row.outcome) return;

  const outcome = signals.messageSent
    ? "message_sent"
    : signals.isSilence
      ? "silence"
      : !signals.success
        ? "error"
        : "silence";

  const residue = mergeResidue(llmResidue, outcome, signals, nowMs);

  try {
    getDb()
      .update(episodes)
      .set({
        tickEnd: signals.tick,
        outcome,
        residue: residue ? JSON.stringify(residue) : null,
      })
      .where(eq(episodes.id, episodeId))
      .run();

    log.debug("Episode closed from act", {
      episodeId,
      outcome,
      residueSource: llmResidue ? "llm" : "none",
      residueType: residue?.type ?? "none",
    });
  } catch (e) {
    log.warn("Failed to close episode from act", {
      episodeId,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

/** Соответствие LLM feeling → тип residue. */
const FEELING_MAP: Record<string, EpisodeResidue["type"]> = {
  unresolved: "unresolved_emotion",
  interrupted: "interrupted",
  curious: "curiosity",
  settled: "unfinished", // settled не порождает residue, это маппинг не используется
};

/** Соответствие LLM feeling → интенсивность. */
const FEELING_INTENSITY: Record<string, number> = {
  unresolved: 0.5,
  interrupted: 0.5,
  curious: 0.3,
  settled: 0,
};

/** Нормализация LLM residue. Ошибки рантайма больше не порождают структурный запасной residue. */
function mergeResidue(
  llm: import("../llm/schemas.js").LLMResidue | undefined,
  outcome: string,
  signals: ActOutcomeSignals,
  nowMs: number,
): EpisodeResidue | null {
  const raw = {
    outcome,
    engagementOutcome: signals.engagementOutcome,
    pressure: 0,
  };

  if (llm) {
    if (llm.feeling === "settled") return null; // LLM говорит всё в порядке → ничего
    const type = FEELING_MAP[llm.feeling] ?? "unresolved_emotion";
    const toward = llm.toward ? (ensureNodeId(llm.toward) ?? null) : null;
    return {
      type,
      ...raw,
      intensity: FEELING_INTENSITY[llm.feeling] ?? 0.4,
      toward,
      decayHalfLifeMs: RESIDUE_HALF_LIFE[type],
      createdMs: nowMs,
    };
  }

  return null;
}

/** Приводит ID любого формата из вывода LLM к унифицированному graph node ID. */
function ensureNodeId(id: string): string | null {
  return ensureChannelId(id) ?? ensureContactId(id) ?? null;
}
