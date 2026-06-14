/**
 * A3 Анализ качества бездействия — автоматизированная валидация поведения ADR-76.
 *
 * - Распределение причин молчания (api_floor / voi_deferred / rate_cap / active_cooling / all_candidates_negative)
 * - Задержка действия после VoI-deferred (разница тиков от silence до следующего action) → эффект сдерживания импульсов ADR-75
 * - Распределение длин непрерывных серий молчания (перекрёстная проверка с silence decay из ADR-75)
 *
 * @see docs/adr/76-naturalness-validation-methodology.md
 * @see docs/adr/75-deliberation-state/75-deliberation-state.md
 * @see docs/adr/64-runtime-theory-alignment-audit.md §II-2
 */

import { asc } from "drizzle-orm";
import { getDb } from "../db/connection.js";
import { actionLog, silenceLog } from "../db/schema.js";

// ═══════════════════════════════════════════════════════════════════════════
// Типы
// ═══════════════════════════════════════════════════════════════════════════

export interface SilenceQualityReport {
  /** Количество и доля каждой причины молчания. */
  reasonDistribution: Record<string, { count: number; ratio: number }>;
  /** Общее число молчаний. */
  totalSilences: number;
  /** Анализ последующих действий после VoI-deferred. */
  voiDeferredFollowup: VoIDeferredAnalysis;
  /** Анализ длин непрерывных серий молчания. */
  consecutiveSilenceRuns: ConsecutiveSilenceAnalysis;
  /** Распределение по пятиуровневому спектру D5. */
  silenceLevelDistribution: Record<string, { count: number; ratio: number }>;
}

export interface VoIDeferredAnalysis {
  /** Общее число молчаний VoI-deferred. */
  count: number;
  /** Медианная задержка в тиках от VoI-deferred до следующего действия. */
  medianDelayToAction: number;
  /** Задержка P90. */
  p90DelayToAction: number;
  /** Распределение задержек (тик → количество). */
  delayHistogram: Record<number, number>;
}

export interface ConsecutiveSilenceAnalysis {
  /** Распределение длин непрерывных серий молчания (длина → количество). */
  runLengthHistogram: Record<number, number>;
  /** Наибольшая непрерывная серия молчания. */
  maxRunLength: number;
  /** Средняя длина непрерывной серии молчания. */
  meanRunLength: number;
  /** Количество серий. */
  runCount: number;
}

// ═══════════════════════════════════════════════════════════════════════════
// Статистические утилиты
// ═══════════════════════════════════════════════════════════════════════════

function median(arr: number[]): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function percentile(arr: number[], p: number): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

// ═══════════════════════════════════════════════════════════════════════════
// Функции анализа
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Анализирует качество бездействия (молчания).
 *
 * Читает все записи молчания из silence_log, анализирует распределение причин,
 * эффективность VoI-deferred и характеристики непрерывных серий молчания.
 */
export function analyzeSilenceQuality(): SilenceQualityReport {
  const db = getDb();

  // ── 1. Распределение причин молчания ────────────────────────────────
  const silences = db
    .select({
      tick: silenceLog.tick,
      reason: silenceLog.reason,
      silenceLevel: silenceLog.silenceLevel,
      target: silenceLog.target,
    })
    .from(silenceLog)
    .orderBy(asc(silenceLog.tick))
    .all();

  const totalSilences = silences.length;
  const reasonCounts: Record<string, number> = {};
  const levelCounts: Record<string, number> = {};

  for (const row of silences) {
    reasonCounts[row.reason] = (reasonCounts[row.reason] ?? 0) + 1;
    if (row.silenceLevel) {
      levelCounts[row.silenceLevel] = (levelCounts[row.silenceLevel] ?? 0) + 1;
    }
  }

  const reasonDistribution: Record<string, { count: number; ratio: number }> = {};
  for (const [reason, count] of Object.entries(reasonCounts)) {
    reasonDistribution[reason] = {
      count,
      ratio: totalSilences > 0 ? count / totalSilences : 0,
    };
  }

  const silenceLevelDistribution: Record<string, { count: number; ratio: number }> = {};
  for (const [level, count] of Object.entries(levelCounts)) {
    silenceLevelDistribution[level] = {
      count,
      ratio: totalSilences > 0 ? count / totalSilences : 0,
    };
  }

  // ── 2. Задержка действия после VoI-deferred ─────────────────────────
  const actionTicks = db
    .select({ tick: actionLog.tick })
    .from(actionLog)
    .orderBy(asc(actionLog.tick))
    .all()
    .map((r) => r.tick);

  const voiDeferredSilences = silences.filter((s) => s.reason === "voi_deferred");
  const delays: number[] = [];
  const delayHistogram: Record<number, number> = {};

  for (const silence of voiDeferredSilences) {
    // Найти ближайший тик действия после silence
    const nextActionTick = actionTicks.find((t) => t > silence.tick);
    if (nextActionTick !== undefined) {
      const delay = nextActionTick - silence.tick;
      delays.push(delay);
      delayHistogram[delay] = (delayHistogram[delay] ?? 0) + 1;
    }
  }

  const voiDeferredFollowup: VoIDeferredAnalysis = {
    count: voiDeferredSilences.length,
    medianDelayToAction: median(delays),
    p90DelayToAction: percentile(delays, 90),
    delayHistogram,
  };

  // ── 3. Анализ непрерывных серий молчания ────────────────────────────
  // Объединить тики из silence_log и action_log, отсортировать по времени
  // silence = 1, action = 0 → считать длину серий из 1
  const allTicks = new Set([...silences.map((s) => s.tick), ...actionTicks]);
  const sortedTicks = [...allTicks].sort((a, b) => a - b);
  const silenceTickSet = new Set(silences.map((s) => s.tick));

  const runLengths: number[] = [];
  let currentRun = 0;

  for (const tick of sortedTicks) {
    if (silenceTickSet.has(tick)) {
      currentRun++;
    } else {
      if (currentRun > 0) {
        runLengths.push(currentRun);
      }
      currentRun = 0;
    }
  }
  if (currentRun > 0) runLengths.push(currentRun);

  const runLengthHistogram: Record<number, number> = {};
  for (const len of runLengths) {
    runLengthHistogram[len] = (runLengthHistogram[len] ?? 0) + 1;
  }

  const consecutiveSilenceRuns: ConsecutiveSilenceAnalysis = {
    runLengthHistogram,
    maxRunLength: runLengths.length > 0 ? Math.max(...runLengths) : 0,
    meanRunLength:
      runLengths.length > 0 ? runLengths.reduce((a, b) => a + b, 0) / runLengths.length : 0,
    runCount: runLengths.length,
  };

  return {
    reasonDistribution,
    totalSilences,
    voiDeferredFollowup,
    consecutiveSilenceRuns,
    silenceLevelDistribution,
  };
}
