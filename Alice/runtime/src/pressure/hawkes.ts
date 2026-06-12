/**
 * Per-contact Hawkes 自激过程 — 环境预测模型。
 *
 * 对每个联系人独立建模入站消息的自激动力学：
 *   λ(t) = μ + λ_carry · exp(-β · Δt)
 *
 * 递归 O(1) 在线更新，按 Dunbar tier 标定初始参数。
 * 纯函数模块——零副作用、零 IO。
 *
 * 认知架构定位：
 *   - signal-decay.ts = 感觉寄存器（Alice 侧信号衰减）
 *   - hawkes.ts = 环境预测模型（对方的行为模式预测）
 *   两者正交，不替换。
 *
 * @see docs/adr/153-per-contact-hawkes/README.md
 * @see Masuda et al. 2013: Self-exciting point process modeling of conversation
 * @see Hawkes (1971): Spectra of some self-exciting and mutually exciting point processes
 */

import type { DunbarTier } from "../graph/entities.js";

// ═══════════════════════════════════════════════════════════════════════════
// 类型定义
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Per-contact Hawkes 过程参数。
 * 每个联系人独立一组；初始值从 tier 查表，可选在线校准。
 *
 * 稳定性条件：α/β < 1（分枝比 < 1），否则过程爆炸。
 *
 * @see docs/adr/153-per-contact-hawkes/README.md §3
 */
export interface HawkesParams {
  /** 基线强度 μ (events/s)。"对方在无刺激时的消息率"。 */
  readonly mu: number;
  /** 自激强度 α。事件到达时 λ 的跳升量。 */
  readonly alpha: number;
  /** 衰减速率 β (1/s)。自激效应的消退速度。halfLife = ln2/β。 */
  readonly beta: number;
}

/**
 * Per-contact Hawkes 运行时状态。
 * 仅需两个数即可 O(1) 在线更新。
 *
 * 持久化策略：存储在图节点属性 (ContactAttrs) 中，
 * 随 graph snapshot 一起持久化到 SQLite。
 */
export interface HawkesState {
  /** 累积激发量（递归更新中间变量）。 */
  lambdaCarry: number;
  /** 上次事件的墙钟时间 (ms)。0 = 无历史事件。 */
  lastEventMs: number;
}

/**
 * Hawkes 强度查询结果。
 */
export interface HawkesIntensity {
  /** 瞬时强度 λ(t) = μ + carry_decayed。 */
  lambda: number;
  /** 基线强度 μ（供归一化使用）。 */
  mu: number;
  /** 自激分量 λ(t) - μ（对话热度的纯增量）。 */
  excitation: number;
  /** 归一化热度 excitation / (α/β)，clamp [0, 1]。 */
  normalizedHeat: number;
}

// ═══════════════════════════════════════════════════════════════════════════
// 默认参数表
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Dunbar tier → 默认 Hawkes 参数。
 *
 * 设计依据：
 * - μ ≈ 4 / DUNBAR_TIER_THETA — 基线消息率（1/μ ≈ θ_c/4）。
 *   含义："冷却阈值 θ_c 约为典型消息间隔的 4 倍"——超过 4 倍间隔才开始积累关系冷却压力。
 * - α: 保守设定，分枝比 α/β ∈ [0.36, 0.91]
 * - β: 亲密朋友余热持续更久（半衰期 ~3.5min），疏远联系人更快消退（~21min）
 *
 * @see docs/adr/153-per-contact-hawkes/README.md §3.1
 * @see docs/adr/151-algorithm-audit/research-online-calibration.md §2.1
 */
export const HAWKES_TIER_DEFAULTS: Record<DunbarTier, HawkesParams> = {
  5: { mu: 5.6e-4, alpha: 0.003, beta: 3.3e-3 },
  15: { mu: 2.8e-4, alpha: 0.002, beta: 2.8e-3 },
  50: { mu: 9.3e-5, alpha: 0.001, beta: 1.1e-3 },
  150: { mu: 2.3e-5, alpha: 0.0005, beta: 8.3e-4 },
  500: { mu: 5.8e-6, alpha: 0.0002, beta: 5.6e-4 },
};

/**
 * 群组 Hawkes 参数修正系数。
 *
 * 群组消息大多不针对 Alice，自激效应弱、衰减快。
 * 事件定义：仅 directed / mentions_alice 消息计入。
 *
 * @see docs/adr/153-per-contact-hawkes/README.md §3.3
 */
export const HAWKES_GROUP_MODIFIERS = {
  /** α 折扣——群组自激弱于私聊。 */
  alphaDiscount: 0.3,
  /** β 加速——群组对话切换更快。 */
  betaMultiplier: 1.5,
} as const;

// ═══════════════════════════════════════════════════════════════════════════
// 核心纯函数
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 查询联系人的瞬时 Hawkes 强度 λ(t)。O(1)。
 * 纯函数——不修改 state。
 *
 * λ(t) = μ + λ_carry · exp(-β · Δt_s)
 *
 * 冷启动（lastEventMs = 0）退化为纯基线 μ。
 *
 * @param params - 联系人的 Hawkes 参数
 * @param state - 联系人的 Hawkes 运行时状态
 * @param nowMs - 当前墙钟时间 (ms)
 */
export function queryIntensity(
  params: HawkesParams,
  state: HawkesState,
  nowMs: number,
): HawkesIntensity {
  const { mu, alpha, beta } = params;

  // 冷启动：无历史事件 → 纯基线
  if (state.lastEventMs <= 0 || state.lambdaCarry <= 0) {
    return { lambda: mu, mu, excitation: 0, normalizedHeat: 0 };
  }

  const dtS = Math.max(0, (nowMs - state.lastEventMs) / 1000);
  const carryDecayed = state.lambdaCarry * Math.exp(-beta * dtS);
  const lambda = mu + carryDecayed;
  const excitation = carryDecayed;

  // 归一化热度：excitation / theoreticalMax，clamp [0, 1]。
  //
  // 审计修复: 旧归一化 excitation/(α/β) 使用分枝比作为参照量，
  // 但连续几条消息的 excitation 就超过 α/β（α/β ≈ 0.9），
  // 导致所有活跃对话的 normalizedHeat 都 clamp 到 1.0（二值开关）。
  //
  // 新参照量: α/(1 - α/β) = α·β/(β-α) — 无限快连续事件时 excitation 的理论极限。
  // 对参数表 α/β ∈ [0.36, 0.91]，此值比 α/β 大 1.6~11 倍，
  // 使 normalizedHeat 在 2~20 条消息的范围内保持连续敏感性。
  const branchRatio = beta > 0 ? alpha / beta : 0;
  const theoreticalMax = branchRatio < 1 && beta > alpha ? (alpha * beta) / (beta - alpha) : alpha;
  const normalizedHeat = Math.min(1, theoreticalMax > 0 ? excitation / theoreticalMax : 0);

  return { lambda, mu, excitation, normalizedHeat };
}

/**
 * 更新联系人的 Hawkes 状态（事件到达时调用）。O(1)。
 * 返回新状态（不可变更新）。
 *
 * λ_carry_new = λ_carry_old · exp(-β · Δt_s) + α
 *
 * 先衰减旧 carry，再叠加新激发——保证递归精确性。
 *
 * @param params - 联系人的 Hawkes 参数
 * @param state - 旧状态
 * @param eventMs - 事件到达时间 (ms)
 */
export function updateOnEvent(
  params: HawkesParams,
  state: HawkesState,
  eventMs: number,
): HawkesState {
  const { alpha, beta } = params;

  // 首次事件或时间倒流守卫
  if (state.lastEventMs <= 0 || eventMs <= state.lastEventMs) {
    return { lambdaCarry: alpha, lastEventMs: eventMs };
  }

  const dtS = (eventMs - state.lastEventMs) / 1000;
  const decayedCarry = state.lambdaCarry * Math.exp(-beta * dtS);
  return {
    lambdaCarry: decayedCarry + alpha,
    lastEventMs: eventMs,
  };
}

/**
 * 从 Dunbar tier 获取默认 Hawkes 参数，可选群组修正。
 *
 * 群组修正：α × alphaDiscount (0.3), β × betaMultiplier (1.5)。
 * μ 保持不变（群组事件定义已过滤为 directed 消息，基线率语义相同）。
 *
 * @param tier - Dunbar tier
 * @param isGroup - 是否为群组场景
 */
export function getDefaultParams(tier: DunbarTier, isGroup?: boolean): HawkesParams {
  const base = HAWKES_TIER_DEFAULTS[tier] ?? HAWKES_TIER_DEFAULTS[50];
  if (!isGroup) return base;
  return {
    mu: base.mu,
    alpha: base.alpha * HAWKES_GROUP_MODIFIERS.alphaDiscount,
    beta: base.beta * HAWKES_GROUP_MODIFIERS.betaMultiplier,
  };
}

/**
 * 初始化零状态（新联系人/无历史）。
 */
export function initialState(): HawkesState {
  return { lambdaCarry: 0, lastEventMs: 0 };
}

/**
 * 计算 Hawkes λ discount 用于 V-maximizer 的 per-candidate λ 调制。
 *
 * 对话热度高（normalizedHeat → 1）→ discount 低 → 社交成本降低 → 更愿意回复。
 * 对话冷淡（normalizedHeat → 0）→ discount = 1.0 → 不影响。
 *
 * discount = 1 - 0.3 × normalizedHeat，clamp [0.7, 1.0]
 *
 * @param intensity - queryIntensity 的返回值
 * @returns ∈ [0.7, 1.0]
 */
export function computeHawkesLambdaDiscount(intensity: HawkesIntensity): number {
  return Math.max(0.7, 1 - 0.3 * intensity.normalizedHeat);
}

// ═══════════════════════════════════════════════════════════════════════════
// Phase 2: μ 在线校准 + 昼夜调制
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 贝叶斯在线校准阈值：需要 30 个事件才完全信任观测值。
 * w = min(1, event_count / N_threshold)
 *
 * @see docs/adr/153-per-contact-hawkes/README.md §3.2
 */
export const MU_CALIBRATION_THRESHOLD = 30;

/**
 * 计算有效基线率 μ_eff——整合在线校准和昼夜调制。
 *
 * 两种修正可独立使用也可组合：
 * 1. 在线校准: μ_eff = prior_μ × (1-w) + observed_μ × w
 * 2. 昼夜调制: μ_eff × (circadianFactor / 1.5)
 *
 * circadianMultiplier 范围 [0.5, 2.5]，24h 均值 1.5。
 * 除以 1.5 归一化使 24h 平均 μ_eff = μ_tier。
 *
 * @param tierMu - tier 默认 μ (events/s)
 * @param eventCount - 累积事件计数（可选）
 * @param firstEventMs - 首次事件时间 ms（可选）
 * @param nowMs - 当前时间 ms（可选）
 * @param circadianFactor - circadianMultiplier 返回值（可选）
 *
 * @see docs/adr/153-per-contact-hawkes/README.md §3.2
 * @see simulation/experiments/exp_hawkes_phase2_validation.py 验证 4/5
 */
export function effectiveMu(
  tierMu: number,
  eventCount?: number,
  firstEventMs?: number,
  nowMs?: number,
  circadianFactor?: number,
): number {
  let mu = tierMu;

  // 在线校准: 累积率 = event_count / duration
  if (
    eventCount != null &&
    eventCount > 0 &&
    firstEventMs != null &&
    firstEventMs > 0 &&
    nowMs != null
  ) {
    const durationS = (nowMs - firstEventMs) / 1000;
    if (durationS > 60) {
      const observedMu = eventCount / durationS;
      const w = Math.min(1, eventCount / MU_CALIBRATION_THRESHOLD);
      mu = tierMu * (1 - w) + observedMu * w;
    }
  }

  // 昼夜调制: circadianMultiplier ∈ [0.5, 2.5], mean=1.5
  if (circadianFactor != null) {
    mu *= circadianFactor / 1.5;
  }

  return Math.max(mu, 1e-8);
}
