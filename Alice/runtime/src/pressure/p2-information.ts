/**
 * P2 信息压力 (Information Pressure) — InfoItem 驱动。
 * 对应 Python pressure.py P2_information_pressure()。
 *
 * P2(n) = Σ_i [importance(i)·(1-R(i,n)) + volatility(i)·age(i,n)]
 * 其中 R(i,n) = (1 + (n - n_last(i)) / (9·S(i)))^d
 *
 * 连续稳定性频谱：所有 facts 统一走 SM-2 遗忘曲线，
 * 不同 fact_type 的初始 S₀ 不同（preference=40 → 3年半衰期，observation=1 → 27天）。
 * 不再区分 "semantic vs episodic" 分支。
 *
 * @see docs/adr/151-algorithm-audit/research-online-calibration.md
 */
import type { WorldModel } from "../graph/world-model.js";
import { elapsedS, readNodeMs } from "./clock.js";
import type { PressureResult } from "./p1-attention.js";

/** 一天的秒数。替代旧 FACT_TIME_SCALE（1440 ticks × 60s = 86400s）。 */
const SECONDS_PER_DAY = 86_400;

/**
 * ADR-166 §4.3: volatility 单位转换常量。
 * volatility 参数在"60s 间隔"下标定（旧制 per-tick）。
 * ageS / 60 = "等效旧制 tick 数"，保持参数数值语义不变。
 * 本质上 volatility 的单位是 "per-minute"。
 */
const VOLATILITY_UNIT_S = 60;
/** 未追踪事实只表达“需要重新验证”，不能随事实数量把全局 P2 永久垫高。 */
const UNTRACKED_MEMORY_TOTAL_CAP = 3.0;

export function p2InformationPressure(
  G: WorldModel,
  _n: number,
  nowMs: number,
  d: number = -0.5,
): PressureResult {
  const contributions: Record<string, number> = {};

  const untrackedIds: string[] = [];

  for (const iid of G.getEntitiesByType("fact")) {
    const attrs = G.getFact(iid);

    // 信息过期分量（仅 tracked 项）
    // ADR-166: 使用 readNodeMs（精确），缺失时跳过 staleness（Unknown ≠ Old）
    let stalenessTerm = 0.0;
    if (attrs.tracked) {
      const createdMs = readNodeMs(G, iid, "created_ms");
      if (createdMs > 0) {
        const volatility = attrs.volatility;
        const ageS = elapsedS(nowMs, createdMs);
        stalenessTerm = volatility * (ageS / VOLATILITY_UNIT_S);
      }
    }

    // 统一 SM-2 遗忘曲线 — 所有 fact_type 走同一条路径。
    // 差异仅在于 attrs.stability（由 remember() 设置为 factTypeInitialStability(factType)，
    // 重复提及时 × STABILITY_REINFORCE_FACTOR）。
    // preference (S=40) → 3年半衰期，observation (S=1) → 27天半衰期。
    const importance = attrs.importance;
    const stability = Math.max(attrs.stability, 0.1);

    // ADR-166: 使用 readNodeMs（精确），缺失时 gapDays=0 → R=1 → memoryTerm=0
    const lastAccessMs = readNodeMs(G, iid, "last_access_ms");
    const gapDays = lastAccessMs > 0 ? elapsedS(nowMs, lastAccessMs) / SECONDS_PER_DAY : 0;
    // R(gap) = (1 + gap_days / (9·S))^d
    const R = (1 + gapDays / (9 * stability)) ** d;

    const memoryTerm = importance * (1.0 - R);
    if (attrs.tracked) {
      contributions[iid] = memoryTerm + stalenessTerm;
    } else {
      contributions[iid] = memoryTerm;
      if (memoryTerm > 0) untrackedIds.push(iid);
    }
  }

  const untrackedTotal = untrackedIds.reduce((sum, id) => sum + (contributions[id] ?? 0), 0);
  if (untrackedTotal > UNTRACKED_MEMORY_TOTAL_CAP) {
    const scale = UNTRACKED_MEMORY_TOTAL_CAP / untrackedTotal;
    for (const id of untrackedIds) {
      contributions[id] *= scale;
    }
  }

  const total = Object.values(contributions).reduce((a, b) => a + b, 0);
  return { total, contributions };
}
