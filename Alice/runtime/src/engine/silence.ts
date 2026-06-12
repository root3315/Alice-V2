/**
 * D5 沉默四级谱 + 工程安全阀 — 论文 Def 10。
 *
 * 沉默不是简单的"不行动"，而是一个有四个理论层级的决策谱：
 *
 * L1: LOW_PRESSURE    — API < floor，无事需做
 * L2: ACTIVE_COOLING  — 行动密度抑制，最近行动过多
 * L3: STRATEGIC       — V(a,n) <= 0，行动预期收益为负
 * L4: DEFERRED        — VoI(null) > max NSV，观望比行动好
 *
 * ADR-84: 论文 L5 是 Degraded Action（降级行动），由 V-maximizer 降级回退实现，
 * 不属于沉默谱。CRISIS_OVERRIDE 是工程安全阀，在 gate chain 中由 gateCrisisMode 处理。
 *
 * @see paper-five-dim/ Definition 10: Silence Spectrum
 * @see paper-pomdp/ Def 5.3: Value of Information
 * @see docs/adr/84-theory-code-final-alignment.md
 */
import type { BeliefStore } from "../belief/store.js";
import type { SilenceLevel } from "./gates.js";

// 从 gates.ts 重导出，使消费者无需同时导入两个文件
export type { SilenceLevel } from "./gates.js";

/**
 * VoI-based silence (Paper 3, Def 5.3) — Kalman 增益代理。
 *
 * 论文原始定义：VoI(a_probe, bel) = E_o[V*(τ(bel, a_probe, o))] - V*(bel)
 * 完整实现需要 V* 近似（计算量大）。
 *
 * 简化：使用 Kalman 增益 K = σ² / (σ² + σ²_obs) 作为 VoI 代理。
 * K 代表"下一次观测能减少多少不确定性"——K 越大（σ² >> σ²_obs），
 * 等待观测的信息收益越高。乘以 NSV_SCALE 使 VoI 与 NSV 在同一量级竞争。
 *
 * 旧实现用 sigma2 * 0.001，量纲比 NSV 低两个数量级，
 * 导致 L4 延迟沉默数学上不可能触发。
 *
 * @param focalEntities 当前焦点实体集合
 * @param beliefs BeliefStore
 * @param _tick 当前 tick 序数（预留）
 * @param sigma2Obs 观测噪声方差（paper-pomdp Remark 4.3，默认 0.1）
 * @param nsvScale NSV 典型量级缩放因子（使 VoI 与 NSV 可比）
 * @returns VoI(null) 值
 *
 * @see paper-pomdp/ Def 5.3: Value of Information
 * @see paper-pomdp/ Proposition 5: Kalman gain simplification
 */
export function computeVoINull(
  focalEntities: string[],
  beliefs: BeliefStore,
  _tick: number,
  sigma2Obs: number = 0.1,
  nsvScale: number = 0.05,
): number {
  if (focalEntities.length === 0) return 0;
  let voiSum = 0;
  for (const eid of focalEntities) {
    // Kalman gain proxy: K = σ² / (σ² + σ²_obs)
    // 高 σ² → K ≈ 1（观测能大幅降低不确定性）→ 等待价值高
    // 低 σ² → K ≈ 0（已经很确定，等不等差不多）→ 等待价值低
    const bTier = beliefs.getOrDefault(eid, "tier");
    voiSum += bTier.sigma2 / (bTier.sigma2 + sigma2Obs);
    const bMood = beliefs.getOrDefault(eid, "mood");
    voiSum += bMood.sigma2 / (bMood.sigma2 + sigma2Obs);
  }
  // 归一化到焦点实体数量，乘以 NSV_SCALE 使量级与 NSV 对齐
  return (voiSum / focalEntities.length) * nsvScale;
}

/**
 * 判定沉默层级。
 *
 * 入参是已经过 gate 链后的最终状态。
 * 这是一个总结性函数，将 gates.ts 中各 gate 的判定归类到四级谱。
 *
 * ADR-84: isCrisis 参数已移除——crisis 由 gateCrisisMode 在 gate chain 中处理，
 * 返回 CRISIS_OVERRIDE，不经过 classifySilence。
 *
 * 判定优先级（从高到低）：
 * 1. L4_DEFERRED      — VoI(null) > bestNSV 且 bestNSV > 0（观望优于行动）
 * 2. L3_STRATEGIC     — bestNSV <= 0（所有行动收益为负）
 * 3. L2_ACTIVE_COOLING — 行动密度抑制（近期行动过多）
 * 4. L1_LOW_PRESSURE  — 压力不足（默认兜底）
 *
 * @see paper-five-dim/ Definition 10
 * @see docs/adr/84-theory-code-final-alignment.md
 */
export function classifySilence(
  _apiValue: number,
  _effectiveFloor: number,
  bestNSV: number,
  voiNull: number,
  isActiveCooling: boolean,
): SilenceLevel {
  // L4: 延迟行动——观望的信息价值超过最佳行动的净社会价值
  if (voiNull > bestNSV && bestNSV > 0) return "L4_DEFERRED";
  // L3: 策略性沉默——所有行动的预期收益为负
  if (bestNSV <= 0) return "L3_STRATEGIC";
  // L2: 主动冷却——行动密度过高，指数衰减抑制
  if (isActiveCooling) return "L2_ACTIVE_COOLING";
  // L1: 低压力——系统整体压力不足，无需行动
  return "L1_LOW_PRESSURE";
}
