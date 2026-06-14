/**
 * A1 Анализ ритма действий/тишины — ADR-76 автоматизированная верификация поведения.
 *
 * - Распределение интервалов между действиями (медиана / P90 / сравнение по целям) → верификация дифференцированного ритма V3 Tier
 * - Обнаружение периодов пилообразной волны → верификация траектории давления V1
 * - Верификация циркадной модуляции (час UTC × тепловая карта частоты действий)
 *
 * Целевые базовые показатели: ответ в личке человека 5-30 с, интервал сообщений в группе 30 с — 5 мин
 *
 * @see docs/adr/76-naturalness-validation-methodology.md
 * @see docs/adr/63-theory-validation-checklist.md §V1, §V3
 */

import { asc } from "drizzle-orm";
import { getDb } from "../db/connection.js";
import { actionLog, tickLog } from "../db/schema.js";

// ═══════════════════════════════════════════════════════════════════════════
// Типы
// ═══════════════════════════════════════════════════════════════════════════

export interface IntervalStats {
  median: number;
  p90: number;
  count: number;
}

export interface SawtoothDetection {
  /** Число обнаруженных периодов пилообразной волны. */
  cycleCount: number;
  /** Медианная длина периода (в тиках). */
  medianCycleLength: number;
  /** Доля тиков, соответствующих пилообразному паттерну. */
  sawtoothRatio: number;
}

export interface RhythmReport {
  actionIntervals: IntervalStats & {
    /** Статистика интервалов по целевым сущностям (цель как прокси для tier). */
    byTarget: Record<string, IntervalStats>;
  };
  sawtoothDetection: SawtoothDetection;
  /** UTC-час (0-23) → количество действий за этот час. */
  circadianHeatmap: Record<number, number>;
}

// ═══════════════════════════════════════════════════════════════════════════
// Статистические утилиты
// ═══════════════════════════════════════════════════════════════════════════

function sortedCopy(arr: number[]): number[] {
  return [...arr].sort((a, b) => a - b);
}

function median(arr: number[]): number {
  if (arr.length === 0) return 0;
  const sorted = sortedCopy(arr);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function percentile(arr: number[], p: number): number {
  if (arr.length === 0) return 0;
  const sorted = sortedCopy(arr);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

function intervalStats(intervals: number[]): IntervalStats {
  return {
    median: median(intervals),
    p90: percentile(intervals, 90),
    count: intervals.length,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Функции анализа
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Анализирует ритм действий/тишины.
 *
 * Читает данные из tick_log + action_log, вычисляет:
 * 1. Распределение интервалов между действиями → верификация дифференцированного ритма V3 Tier
 * 2. Обнаружение периодов пилообразной волны P1 → верификация траектории давления V1
 * 3. Циркадная тепловая карта → верификация внутридневного ритма
 */
export function analyzeRhythm(): RhythmReport {
  const db = getDb();

  // ── 1. Распределение интервалов между действиями ─────────────────────
  const actions = db
    .select({ tick: actionLog.tick, target: actionLog.target })
    .from(actionLog)
    .orderBy(asc(actionLog.tick))
    .all();

  const allIntervals: number[] = [];
  const intervalsByTarget: Record<string, number[]> = {};

  // Вычисление интервалов с группировкой по цели — интервалы между последовательными действиями к одной цели
  const lastTickByTarget: Record<string, number> = {};
  for (const row of actions) {
    const target = row.target ?? "__no_target__";
    if (lastTickByTarget[target] !== undefined) {
      const interval = row.tick - lastTickByTarget[target];
      allIntervals.push(interval);
      if (!intervalsByTarget[target]) intervalsByTarget[target] = [];
      intervalsByTarget[target].push(interval);
    }
    lastTickByTarget[target] = row.tick;
  }

  const byTarget: Record<string, IntervalStats> = {};
  for (const [target, intervals] of Object.entries(intervalsByTarget)) {
    byTarget[target] = intervalStats(intervals);
  }

  // ── 2. Обнаружение пилообразной волны (V1) ──────────────────────────
  // P1 idle growth: резкий спад после действия, нарастание в idle-период
  const ticks = db
    .select({
      tick: tickLog.tick,
      p1: tickLog.p1,
      target: tickLog.target,
    })
    .from(tickLog)
    .orderBy(asc(tickLog.tick))
    .all();

  let cycleCount = 0;
  const cycleLengths: number[] = [];
  let sawtoothTicks = 0;
  let lastDropIdx = -1;

  for (let i = 1; i < ticks.length; i++) {
    const hasAction = ticks[i].target !== null;

    if (ticks[i].p1 >= ticks[i - 1].p1) {
      // P1 нарастает — соответствует переднему фронту пилы
      sawtoothTicks++;
    }

    if (hasAction && ticks[i].p1 < ticks[i - 1].p1) {
      // Резкий спад давления после действия — задний фронт пилы
      cycleCount++;
      sawtoothTicks++;
      if (lastDropIdx >= 0) {
        cycleLengths.push(i - lastDropIdx);
      }
      lastDropIdx = i;
    }
  }

  // ── 3. Циркадная тепловая карта ──────────────────────────────────────
  const circadianHeatmap: Record<number, number> = {};
  for (let h = 0; h < 24; h++) circadianHeatmap[h] = 0;

  const actionsWithTime = db.select({ createdAt: actionLog.createdAt }).from(actionLog).all();

  for (const row of actionsWithTime) {
    if (row.createdAt) {
      const ts = row.createdAt instanceof Date ? row.createdAt : new Date(Number(row.createdAt));
      circadianHeatmap[ts.getUTCHours()]++;
    }
  }

  return {
    actionIntervals: {
      ...intervalStats(allIntervals),
      byTarget,
    },
    sawtoothDetection: {
      cycleCount,
      medianCycleLength: median(cycleLengths),
      sawtoothRatio: ticks.length > 1 ? sawtoothTicks / (ticks.length - 1) : 0,
    },
    circadianHeatmap,
  };
}
