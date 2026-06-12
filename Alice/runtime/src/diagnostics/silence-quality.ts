/**
 * A3 不行动质量分析 — ADR-76 自动化行为验证。
 *
 * - 沉默原因分布（api_floor / voi_deferred / rate_cap / active_cooling / all_candidates_negative）
 * - VoI-deferred 后的行动延迟（从 silence 到后续 action 的 tick 差）→ ADR-75 冲动保留效果
 * - 连续沉默序列长度分布（与 ADR-75 silence decay 交叉验证）
 *
 * @see docs/adr/76-naturalness-validation-methodology.md
 * @see docs/adr/75-deliberation-state/75-deliberation-state.md
 * @see docs/adr/64-runtime-theory-alignment-audit.md §II-2
 */

import { asc } from "drizzle-orm";
import { getDb } from "../db/connection.js";
import { actionLog, silenceLog } from "../db/schema.js";

// ═══════════════════════════════════════════════════════════════════════════
// 类型
// ═══════════════════════════════════════════════════════════════════════════

export interface SilenceQualityReport {
  /** 各沉默原因的计数和占比。 */
  reasonDistribution: Record<string, { count: number; ratio: number }>;
  /** 沉默总数。 */
  totalSilences: number;
  /** VoI-deferred 后续行动分析。 */
  voiDeferredFollowup: VoIDeferredAnalysis;
  /** 连续沉默序列长度分析。 */
  consecutiveSilenceRuns: ConsecutiveSilenceAnalysis;
  /** D5 五级谱分布。 */
  silenceLevelDistribution: Record<string, { count: number; ratio: number }>;
}

export interface VoIDeferredAnalysis {
  /** VoI-deferred 沉默总数。 */
  count: number;
  /** 从 VoI-deferred 到后续行动的 tick 延迟（中位数）。 */
  medianDelayToAction: number;
  /** P90 延迟。 */
  p90DelayToAction: number;
  /** 延迟分布（tick → 次数）。 */
  delayHistogram: Record<number, number>;
}

export interface ConsecutiveSilenceAnalysis {
  /** 连续沉默序列的长度分布（长度 → 次数）。 */
  runLengthHistogram: Record<number, number>;
  /** 最长连续沉默序列。 */
  maxRunLength: number;
  /** 平均连续沉默长度。 */
  meanRunLength: number;
  /** 序列数量。 */
  runCount: number;
}

// ═══════════════════════════════════════════════════════════════════════════
// 统计工具
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
// 分析函数
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 分析不行动（沉默）的质量。
 *
 * 从 silence_log 读取所有沉默记录，分析原因分布、VoI-deferred 效果、
 * 连续沉默序列特征。
 */
export function analyzeSilenceQuality(): SilenceQualityReport {
  const db = getDb();

  // ── 1. 沉默原因分布 ──────────────────────────────────────────────────
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

  // ── 2. VoI-deferred 后续行动延迟 ────────────────────────────────────
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
    // 找到 silence 之后最近的行动 tick
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

  // ── 3. 连续沉默序列分析 ─────────────────────────────────────────────
  // 合并 silence_log 和 action_log 的 tick，按时间排序
  // silence = 1, action = 0 → 统计连续 1 的 run length
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
