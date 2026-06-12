/**
 * DeliberationState — evolve 管线的工作记忆（中间时间尺度）。
 *
 * 填补三时间尺度缺口：
 * - 慢（天-周）：WorldModel（社交图、记忆、关系）
 * - 中（多 tick，交互片段内）：DeliberationState（声部疲劳、沉默积累、冲动保留）← 本模块
 * - 快（单 tick）：computeTickPlan 纯函数
 *
 * 设计约束：
 * - 不破坏 computeTickPlan 的纯函数契约——DeliberationState 是输入的一部分
 * - 所有状态更新在 applyPlan 中执行——副作用边界不变
 * - 不持久化到 DB——仅存活于进程生命周期（重启时归零，符合"工作记忆"语义）
 *
 * @see docs/adr/75-deliberation-state/75-deliberation-state.md
 * @see paper-five-dim/ Eq. voice-fatigue: φ_v(n) = min(1, (n - n_v^last) / K_v)
 * @see paper-pomdp/ Def 5.3: VoI(null)
 */

import type { VoiceAction } from "../voices/personality.js";

// ═══════════════════════════════════════════════════════════════════════════
// 类型
// ═══════════════════════════════════════════════════════════════════════════

/** 被压制但仍有价值的行动冲动（跨 tick 携带）。 */
export interface PendingImpulse {
  /** 声部行动类型。 */
  action: VoiceAction;
  /** 目标实体 ID。 */
  target: string;
  /** 创建时的 Net Social Value。 */
  netValue: number;
  /** 冲动产生的 tick。 */
  originTick: number;
  /** ADR-110: 冲动产生的墙钟时间（ms）。 */
  originMs: number;
  /** 每 tick 的 netValue 衰减乘子（0, 1）。 */
  decay: number;
  /**
   * 情感显著性 [0, 1]。
   * 高 salience 冲动衰减更慢（decay = 0.7 + 0.15 × salience）。
   * 默认 0（退化为 IMPULSE_DEFAULT_DECAY）。
   * @see docs/adr/151-algorithm-audit/priority-ranking.md #3
   */
  salience: number;
}

/**
 * DeliberationState — evolve 管线的跨 tick 工作记忆。
 *
 * 生命周期：进程内（不持久化）。重启归零。
 */
export interface DeliberationState {
  // ── 声部疲劳 — 论文 Eq. voice-fatigue ──
  /** ADR-110: 每个声部上次获胜的墙钟时间（ms）。 */
  voiceLastWon: Record<VoiceAction, number>;

  // ── 冲动保留 — Inner Thoughts retention ──
  /** 高 V 但被 VoI/gate 压制的候选，跨 tick 携带。 */
  pendingImpulses: PendingImpulse[];

  // ── 沉默追踪 ──
  /** 最近一次沉默的原因（gate reason string）。 */
  lastSilenceReason: string | null;

  // ── 行动谱系 — 上一个行动的决策上下文 ──
  /** 上一个实际执行的行动的审议快照。 */
  lastDeliberation: {
    voice: VoiceAction;
    target: string | null;
    netValue: number;
    tick: number;
  } | null;
}

// ═══════════════════════════════════════════════════════════════════════════
// 常量
// ═══════════════════════════════════════════════════════════════════════════

/**
 * ADR-110: 声部冷却窗口（秒）。
 *
 * 声部获胜后需要 K_v 秒才能完全恢复响度。
 * 默认 300 秒（5 分钟）——约一个短对话的长度。
 *
 * @see paper-five-dim/ Eq. voice-fatigue: φ_v = min(1, elapsedS / K_v)
 */
export const DEFAULT_VOICE_COOLDOWN = 300;

/**
 * ADR-110: 冲动保留的最大 TTL（毫秒）。
 * 超过此期限的冲动自动淘汰。300_000 ms = 5 分钟。
 */
export const IMPULSE_MAX_TTL_MS = 300_000;

/**
 * 冲动保留的最大数量。
 * 防止无限积累。
 */
export const IMPULSE_MAX_COUNT = 3;

/**
 * 冲动进入队列的最低 V 阈值。
 * V 低于此值的候选不值得跨 tick 携带。
 */
export const IMPULSE_MIN_VALUE = 0.05;

/**
 * 冲动每 tick 的默认衰减乘子。
 * 0.7 意味着 3 tick 后 V 衰减到 34%。
 */
export const IMPULSE_DEFAULT_DECAY = 0.7;

/**
 * Salience 对衰减乘子的最大提升量。
 * decay = IMPULSE_DEFAULT_DECAY + IMPULSE_SALIENCE_DECAY_BOOST × salience
 * salience=0 → decay=0.7, salience=1 → decay=0.85（半衰期 ~4.3 tick）。
 * @see docs/adr/151-algorithm-audit/priority-ranking.md #3
 */
export const IMPULSE_SALIENCE_DECAY_BOOST = 0.15;

/**
 * ADR-189: VoI(null) 墙钟衰减速率（per second）。
 *
 * VoI_effective = VoI_raw / (1 + silenceDurationS × rate)
 *
 * 校准：0.15 per patrol tick / 60s per patrol tick = 0.0025 per second。
 * 含义：60s 沉默后衰减 ~0.87，300s 后 ~0.57。
 * 与旧行为在 patrol 模式下等效，但 conversation 模式（3s tick）不再过快衰减。
 *
 * @see paper-pomdp/ Def 5.3: VoI(null)
 */
export const SILENCE_VOI_DECAY_RATE = 0.0025;

// ═══════════════════════════════════════════════════════════════════════════
// 工厂
// ═══════════════════════════════════════════════════════════════════════════

/** 创建一个空白的 DeliberationState（进程启动时使用）。 */
export function createDeliberationState(): DeliberationState {
  const voiceLastWon: Record<VoiceAction, number> = {
    diligence: -Infinity,
    curiosity: -Infinity,
    sociability: -Infinity,
    caution: -Infinity,
  };
  return {
    voiceLastWon,
    pendingImpulses: [],
    lastSilenceReason: null,
    lastDeliberation: null,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// 更新函数（在 applyPlan 中调用）
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 在行动入队时更新 deliberation 状态。
 *
 * - 记录获胜声部的 tick（声部疲劳）
 * - 清零连续沉默计数
 * - 记录行动谱系
 * - 清空 pendingImpulses 中与该 target 匹配的冲动（已满足）
 */
export function onActionEnqueued(
  state: DeliberationState,
  tick: number,
  voice: VoiceAction,
  target: string | null,
  netValue: number,
  nowMs: number = Date.now(),
): void {
  state.voiceLastWon[voice] = nowMs;
  state.lastSilenceReason = null;
  state.lastDeliberation = { voice, target, netValue, tick };
  // 清除已满足的冲动（同 target 或同 voice+target）
  state.pendingImpulses = state.pendingImpulses.filter(
    (imp) => !(imp.target === target && imp.action === voice),
  );
}

/**
 * 在沉默时更新 deliberation 状态。
 *
 * - 递增连续沉默计数
 * - 记录沉默原因
 * - 衰减 pendingImpulses 中的 netValue，淘汰过期冲动
 */
export function onSilence(
  state: DeliberationState,
  _tick: number,
  reason: string,
  nowMs: number = Date.now(),
): void {
  state.lastSilenceReason = reason;
  // ADR-110: 衰减 + 淘汰（使用墙钟 TTL）
  state.pendingImpulses = state.pendingImpulses
    .map((imp) => ({ ...imp, netValue: imp.netValue * imp.decay }))
    .filter(
      (imp) => imp.netValue >= IMPULSE_MIN_VALUE && nowMs - imp.originMs < IMPULSE_MAX_TTL_MS,
    );
}

/**
 * 将一个被压制的高价值候选加入冲动保留队列。
 *
 * 调用时机：VoI-deferred 或 gate-rejected 但 V > IMPULSE_MIN_VALUE。
 *
 * salience 调制：decay = 0.7 + 0.15 × (salience ?? 0)。
 * 高情感显著性的冲动衰减更慢，在工作记忆中保持更久。
 * @see docs/adr/151-algorithm-audit/priority-ranking.md #3
 */
export function addImpulse(
  state: DeliberationState,
  impulse: Omit<PendingImpulse, "decay" | "salience" | "originMs"> & {
    originMs?: number;
    salience?: number;
  },
): void {
  if (impulse.netValue < IMPULSE_MIN_VALUE) return;
  const salience = Math.max(0, Math.min(1, impulse.salience ?? 0));
  const decay = IMPULSE_DEFAULT_DECAY + IMPULSE_SALIENCE_DECAY_BOOST * salience;
  // 去重：同 action+target 只保留最新
  state.pendingImpulses = state.pendingImpulses.filter(
    (imp) => !(imp.action === impulse.action && imp.target === impulse.target),
  );
  state.pendingImpulses.push({
    ...impulse,
    originMs: impulse.originMs ?? Date.now(),
    salience,
    decay,
  });
  // 容量限制：保留 V 最高的
  if (state.pendingImpulses.length > IMPULSE_MAX_COUNT) {
    state.pendingImpulses.sort((a, b) => b.netValue - a.netValue);
    state.pendingImpulses = state.pendingImpulses.slice(0, IMPULSE_MAX_COUNT);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 声部疲劳计算（供 loudness.ts 使用）
// ═══════════════════════════════════════════════════════════════════════════

/**
 * ADR-110: 计算声部疲劳因子 φ_v（墙钟时间版）。
 *
 * φ_v = min(1, elapsedS / K_v)
 *
 * - φ_v = 0: 刚获胜，完全疲劳
 * - φ_v = 1: 已恢复，无疲劳
 *
 * @param nowMs - 当前墙钟时间（ms）
 * @param voiceLastWonMs - 该声部上次获胜的墙钟时间（ms）
 * @param cooldown - 冷却窗口 K_v（秒）
 * @returns [0, 1] 范围的疲劳因子
 *
 * @see paper-five-dim/ Eq. voice-fatigue
 */
export function voiceFatigue(
  nowMs: number,
  voiceLastWonMs: number,
  cooldown: number = DEFAULT_VOICE_COOLDOWN,
): number {
  if (voiceLastWonMs === -Infinity) return 1; // 无历史 → 无疲劳
  const elapsedS = (nowMs - voiceLastWonMs) / 1000;
  if (elapsedS <= 0) return 0; // 同时刻 → 完全疲劳
  return Math.min(1, elapsedS / Math.max(cooldown, 1));
}
