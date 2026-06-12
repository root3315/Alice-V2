/**
 * D5: Net Social Value + Social Value Gate。
 *
 * V(a, n) = ΔP(a, n) - λ · C_social(a, n)
 *
 * 行动必须 V > 0 才执行，否则沉默（Axiom 4）。
 * λ ≥ 1 确保社交失误的代价大于等量的压力缓解。
 *
 * @see paper/ Definition 9: Net Social Value
 * @see paper/ Axiom 4: Social Value Gate
 */

import { PRESSURE_SPECS } from "../graph/constants.js";
import type { PressureDims } from "../utils/math.js";

/** P1-P6 维度名称（从 PRESSURE_SPECS 派生，与 kappa 索引对齐）。 */
const STD_DIMS = Object.keys(PRESSURE_SPECS) as (keyof typeof PRESSURE_SPECS)[];

/**
 * 估算行动后预期压力降低量 ΔP(a, n)。
 *
 * P2-2 fix: 当提供 kappa 时，对每个维度的贡献做 tanh(raw/κ_k)
 * 归一化到 [0, 1) 后再求和，防止量纲差异导致某个维度独占 ΔP。
 * 例：P4 thread 压力可达 400+ 而 P6 只有 0.1，不归一化时 P4 完全主导。
 *
 * @param contributions - 各维度的实体贡献 { P1: { entityId: value }, ... }
 * @param targetId - 目标实体 ID
 * @param kappa - API 归一化 κ（可选，提供时做 tanh 归一化）
 * @returns 预期压力降低量（≥ 0）
 */
export function estimateDeltaP(
  contributions: Record<string, Record<string, number>>,
  targetId: string,
  kappa?: PressureDims,
): number {
  let total = 0;

  // 标准维度 P1-P6：可选 tanh 归一化
  for (let i = 0; i < STD_DIMS.length; i++) {
    const dimContribs = contributions[STD_DIMS[i]];
    if (!dimContribs) continue;
    const raw = dimContribs[targetId] ?? 0;
    total += kappa ? Math.tanh(raw / kappa[i]) : raw;
  }

  // 非标准维度（P_prospect 等）：直接累加
  for (const [dim, dimContribs] of Object.entries(contributions)) {
    if ((STD_DIMS as readonly string[]).includes(dim)) continue;
    total += dimContribs[targetId] ?? 0;
  }

  // ΔP 不应为负（行动不会增加压力）
  return Math.max(0, total);
}

/**
 * 计算 Net Social Value。
 *
 * V(a, n) = ΔP - λ · C_social
 *
 * @param deltaP - 预期压力降低量
 * @param socialCost - 社交成本
 * @param lambda - 损失厌恶系数（≥ 1）
 * @returns Net Social Value（可正可负）
 *
 * @see paper/ Definition 9
 */
export function computeNetSocialValue(deltaP: number, socialCost: number, lambda: number): number {
  return deltaP - lambda * socialCost;
}

/**
 * 计算带不确定性惩罚 + VoI 信息增益的 Net Social Value。
 *
 * NSV(a, n) = ΔP - λ·C_social - β·H(bel) + γ·VoI(a, n)
 *
 * β·H 项将不确定性视为惩罚（保守），γ·VoI 项将不确定性视为探索奖励。
 * 两者共同构成 Active Inference 风格的 Expected Free Energy 近似。
 *
 * @param deltaP - 预期压力降低量
 * @param socialCost - 社交成本
 * @param lambda - 损失厌恶系数（≥ 1）
 * @param beliefEntropy - 目标信念的 Shannon entropy H(bel)
 * @param beta - 不确定性惩罚系数（≥ 0）
 * @param gamma - VoI 信息增益系数（≥ 0）
 * @param voiValue - VoI 信息增益值（Kalman 信息比率，[0,1)）
 * @returns NSV 值（可正可负）
 *
 * @see paper-pomdp/ Def 5.2
 * @see docs/adr/151-algorithm-audit/ #1 VoI 信息增益项
 */
export function computeNSVBeta(
  deltaP: number,
  socialCost: number,
  lambda: number,
  beliefEntropy: number,
  beta: number,
  gamma: number,
  voiValue: number,
): number {
  return deltaP - lambda * socialCost - beta * beliefEntropy + gamma * voiValue;
}

/**
 * VoI（Value of Information）信息增益——Kalman 信息比率。
 *
 * VoI = σ² / (σ² + σ²_obs)
 *
 * σ² 大 → VoI ≈ 1（不确定性高，行动能带来大量信息增益）
 * σ² 小 → VoI ≈ 0（已经足够确定，行动带来的信息增益可忽略）
 *
 * @param sigma2 - 当前信念方差（可从多维度求和）
 * @param sigma2Obs - 观测噪声方差（常数，控制收敛速度）
 * @returns VoI 值 ∈ [0, 1)
 *
 * @see docs/adr/151-algorithm-audit/ #1 VoI 信息增益项
 */
export function computeVoI(sigma2: number, sigma2Obs: number): number {
  return sigma2 / (sigma2 + sigma2Obs);
}
