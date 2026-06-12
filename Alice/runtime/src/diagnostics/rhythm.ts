/**
 * A1 行动/沉默节律分析 — ADR-76 自动化行为验证。
 *
 * - 行动间隔分布（中位数 / P90 / 按目标分组对比）→ 验证 V3 Tier 差异化节律
 * - 锯齿波周期检测 → 验证 V1 压力轨迹
 * - Circadian 调制验证（UTC 小时 × 行动频率热图）
 *
 * 对标基线：人类私聊回复 5-30s，群聊发言间隔 30s-5min
 *
 * @see docs/adr/76-naturalness-validation-methodology.md
 * @see docs/adr/63-theory-validation-checklist.md §V1, §V3
 */

import { asc } from "drizzle-orm";
import { getDb } from "../db/connection.js";
import { actionLog, tickLog } from "../db/schema.js";

// ═══════════════════════════════════════════════════════════════════════════
// 类型
// ═══════════════════════════════════════════════════════════════════════════

export interface IntervalStats {
  median: number;
  p90: number;
  count: number;
}

export interface SawtoothDetection {
  /** 检测到的锯齿波周期数。 */
  cycleCount: number;
  /** 周期长度中位数（tick）。 */
  medianCycleLength: number;
  /** 符合锯齿模式的 tick 占比。 */
  sawtoothRatio: number;
}

export interface RhythmReport {
  actionIntervals: IntervalStats & {
    /** 按目标实体分组的间隔统计（目标作为 tier 代理）。 */
    byTarget: Record<string, IntervalStats>;
  };
  sawtoothDetection: SawtoothDetection;
  /** UTC 小时 (0-23) → 该小时内的行动数。 */
  circadianHeatmap: Record<number, number>;
}

// ═══════════════════════════════════════════════════════════════════════════
// 统计工具
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
// 分析函数
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 分析行动/沉默节律。
 *
 * 从 tick_log + action_log 读取数据，计算：
 * 1. 行动间隔分布 → V3 Tier 差异化节律验证
 * 2. P1 锯齿波周期检测 → V1 压力轨迹验证
 * 3. Circadian 热图 → 日内节律验证
 */
export function analyzeRhythm(): RhythmReport {
  const db = getDb();

  // ── 1. 行动间隔分布 ───────────────────────────────────────────────────
  const actions = db
    .select({ tick: actionLog.tick, target: actionLog.target })
    .from(actionLog)
    .orderBy(asc(actionLog.tick))
    .all();

  const allIntervals: number[] = [];
  const intervalsByTarget: Record<string, number[]> = {};

  // 按目标分组计算间隔——同一目标的连续行动间隔
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

  // ── 2. 锯齿波检测（V1）──────────────────────────────────────────────
  // P1 idle growth: 行动后骤降，idle 期间递增
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
      // P1 递增 — 符合锯齿上升沿
      sawtoothTicks++;
    }

    if (hasAction && ticks[i].p1 < ticks[i - 1].p1) {
      // 行动后压力骤降 — 锯齿下降沿
      cycleCount++;
      sawtoothTicks++;
      if (lastDropIdx >= 0) {
        cycleLengths.push(i - lastDropIdx);
      }
      lastDropIdx = i;
    }
  }

  // ── 3. Circadian 热图 ─────────────────────────────────────────────────
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
