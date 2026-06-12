/**
 * Goldilocks Window — per-contact 最佳联络窗口。
 *
 * 将 P3 冷却阈值（θ_c）和 C_sat 冷却常数（τ_cool）统一为
 * per-tier 的时间窗口 [t_min, t_max]，在 V-max 决策层调制 ΔP。
 *
 * 核心公式（对数域 log-normal 钟形效用）：
 *   U(t) = exp(-0.5 × ((ln(t) - ln(t_peak)) / σ_ln)²)
 *
 * 纯函数模块——零副作用、零 IO、零外部依赖（仅导入类型和常量）。
 *
 * @see docs/adr/154-goldilocks-window/README.md
 * @see Fang et al. 2025 "The Goldilocks Time Window for Proactive Interventions"
 */

import { DUNBAR_TIER_THETA } from "../graph/constants.js";
import type { DunbarTier } from "../graph/entities.js";

// ═══════════════════════════════════════════════════════════════════════════
// 常量
// ═══════════════════════════════════════════════════════════════════════════

/**
 * θ_c → τ_cool 比例因子。
 *
 * 选择 α=0.15 使 t_min ≈ 0.35 × θ_c（冷却期约为 θ_c 的三分之一）。
 * 推导：t_min = 2.3 × τ_cool = 2.3 × α × θ_c ≈ 0.345 × θ_c。
 *
 * @see docs/adr/154-goldilocks-window/README.md §3.2
 */
const GOLDILOCKS_ALPHA = 0.15;

/**
 * σ_cool 衰减阈值（10%）的对数值 = ln(10) ≈ 2.302585。
 * t_min = τ_cool × ln(1/θ_low) = τ_cool × ln(10)。
 */
const LN_10 = Math.log(10);

// ═══════════════════════════════════════════════════════════════════════════
// 类型
// ═══════════════════════════════════════════════════════════════════════════

/** Goldilocks Window 参数。 */
export interface GoldilocksParams {
  /** 最早可联络时间（秒）。t < tMin → U = 0。 */
  tMin: number;
  /** 最晚应联络时间（秒）= θ_c。t > tMax → 渐进衰减。 */
  tMax: number;
  /** 效用峰值时间（秒）= √(tMin × tMax)。 */
  tPeak: number;
  /** 对数域标准差（窗口宽度）。 */
  sigmaLn: number;
  /** Per-tier proactive 冷却时间常数（秒）。 */
  tauCool: number;
}

// ═══════════════════════════════════════════════════════════════════════════
// 核心纯函数
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 从 Dunbar tier 推导 Goldilocks Window 参数。
 *
 * 推导链：
 *   τ_cool = α × θ_c
 *   t_min  = ln(10) × τ_cool  ≈ 2.3 × τ_cool
 *   t_max  = θ_c
 *   t_peak = √(t_min × t_max)   ← 对数域中点（几何均值）
 *   σ_ln   = (ln(t_max) - ln(t_min)) / 4  ← 使 t_min/t_max 落在 ±2σ 处
 *
 * @see docs/adr/154-goldilocks-window/README.md §2.2, §4.1
 */
export function goldilocksParams(tier: DunbarTier): GoldilocksParams {
  const thetaC = DUNBAR_TIER_THETA[tier];
  const tauCool = GOLDILOCKS_ALPHA * thetaC;
  const tMin = LN_10 * tauCool;
  const tMax = thetaC;
  const tPeak = Math.sqrt(tMin * tMax);
  const sigmaLn = (Math.log(tMax) - Math.log(tMin)) / 4;

  return { tMin, tMax, tPeak, sigmaLn, tauCool };
}

/**
 * 计算 Goldilocks 效用 U(t, c) ∈ [0, 1]。
 *
 * 三段分区：
 *   t < tMin    → 0（冷却期，不打扰）
 *   tMin ≤ t ≤ tMax → log-normal 钟形（窗口内，效用最高）
 *   t > tMax    → 渐进衰减（与 P3 接力，不骤降）
 *
 * 自适应修正（可选）：
 *   - emaIntervalS：历史交互频率 EMA → 高频联系人 tMin 缩短
 *   - sigma2Tier：tier 信念方差 → 不确定时窗口加宽
 *
 * @param silenceS - 自上次交互的经过时间（秒）
 * @param tier - 联系人的 Dunbar tier
 * @param emaIntervalS - 历史交互频率 EMA（秒），可选
 * @param sigma2Tier - tier 信念方差（0-1），可选
 * @returns 效用值 ∈ [0, 1]
 *
 * @see docs/adr/154-goldilocks-window/README.md §2.3, §4.4
 */
export function computeGoldilocksUtility(
  silenceS: number,
  tier: DunbarTier,
  emaIntervalS?: number,
  sigma2Tier?: number,
): number {
  if (silenceS <= 0) return 0;

  const params = goldilocksParams(tier);
  let { tMin, tMax, tPeak, sigmaLn } = params;

  // 自适应 1: 历史交互频率 EMA — 高频联系人窗口提前打开
  // 当 emaInterval 远小于 θ_c 时，tMin 按比例缩短
  if (emaIntervalS != null && emaIntervalS > 0) {
    const ratio = emaIntervalS / tMax;
    if (ratio < 0.5) {
      // 高频交互者：tMin 缩短，tPeak 提前
      const shrink = 0.5 + ratio; // ratio=0.1 → shrink=0.6, ratio=0.5 → shrink=1.0
      tMin *= shrink;
      tPeak = Math.sqrt(tMin * tMax);
      sigmaLn = (Math.log(tMax) - Math.log(tMin)) / 4;
    }
  }

  // 自适应 2: σ² 信念不确定性 — 不确定时窗口加宽
  // 钳位到 [0, 1] 防止 BeliefStore 的 σ² 溢出导致异常宽窗口
  if (sigma2Tier != null && sigma2Tier > 0.3) {
    sigmaLn *= 1 + Math.min(sigma2Tier, 1.0);
  }

  // 冷却期: t < tMin → 效用为 0
  if (silenceS < tMin) return 0;

  // 窗口内: log-normal 钟形
  // U(t) = exp(-0.5 × ((ln(t) - ln(tPeak)) / σ_ln)²)
  if (silenceS <= tMax) {
    const z = (Math.log(silenceS) - Math.log(tPeak)) / sigmaLn;
    return Math.exp(-0.5 * z * z);
  }

  // 窗口后: 渐进衰减（不骤降，与 P3 接力）
  // 在 tMax 处的效用作为起点，然后对数域衰减
  const zAtMax = (Math.log(tMax) - Math.log(tPeak)) / sigmaLn;
  const uAtMax = Math.exp(-0.5 * zAtMax * zAtMax);
  // 超出 tMax 后指数衰减：U × exp(-(t - tMax) / tMax)
  // 使用 tMax 作为衰减时间常数——关系越远衰减越慢（tMax=θ_c 自动标定）
  const overshoot = (silenceS - tMax) / tMax;
  return uAtMax * Math.exp(-overshoot);
}

/**
 * Per-tier proactive 冷却时间常数（秒）。
 *
 * τ_cool(tier) = α × DUNBAR_TIER_THETA[tier]
 *
 * 替代旧版全局固定的 proactive 冷却常数。
 *
 * @see docs/adr/154-goldilocks-window/README.md §3.2
 */
export function proactiveCooldownForTier(tier: DunbarTier): number {
  return GOLDILOCKS_ALPHA * DUNBAR_TIER_THETA[tier];
}
