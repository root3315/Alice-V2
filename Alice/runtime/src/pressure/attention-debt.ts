/**
 * ADR-100: 注意力负债 — 群组注意力饥饿的结构性解决方案。
 *
 * 压力场缺少时间积分维度，导致纯贪婪选择 + 有限资源 = 系统性饥饿。
 * Attention debt 作为 stored pressure（MCT 储存效应）叠加到 NSV 上，
 * 使被持续忽略的有压力 channel 逐渐积累竞争优势。
 *
 * 递推公式:
 *   D_h(n) = D_h(n-1) × (1 - δ) + 1[target ≠ h] × API_h(n)
 *
 * NSV 加成:
 *   NSV_debt(a, h, n) = NSV(a, h, n) + μ_D × tanh(D_h / κ_D)
 *
 * 纯函数 API，不持有状态。
 *
 * @see docs/adr/100-attention-debt.md §9
 * @see paper-pomdp/ §7 Discussion: Multi-Channel Attention Allocation as Fair RMAB
 */

/** dt 缩放基准（秒）。衰减公式 (1-δ)^(dt/BASE) 保持与 60s tick 间隔的数值一致。 */
const DT_BASE_S = 60;

export interface AttentionDebtConfig {
  /** 衰减率，防止无穷累积。 */
  delta: number;
  // ADR-218 Phase 2: muD/kappaD 已删除（computeDebtBonus 已移除）。
  // 保留 delta 供 updateAttentionDebt 使用。
}

export const DEFAULT_ATTENTION_DEBT_CONFIG: AttentionDebtConfig = {
  delta: 0.05,
};

/** 频道超过此时长无新消息 → 仅衰减 debt，不累积。 */
const STALE_THRESHOLD_MS = 7 * 24 * 3600 * 1000; // 7 天

/**
 * 更新 debt map：每个 channel 的 attention debt。
 *
 * D_h(n) = D_h(n-1) × (1 - δ) + 1[target(n-1) ≠ h] × API_h(n)
 *
 * - 被选中的 channel：debt 仅衰减（不累积）
 * - 未被选中但有压力的 channel：debt 增长
 * - 无压力（API_h=0）的 channel：debt 仅衰减（死群不累积）
 * - 超过 STALE_THRESHOLD 无新消息的 channel：仅衰减（冷频道不累积）
 *
 * @param prevDebt - 上一 tick 的 debt map
 * @param channelPressures - channel → 该 channel 的压力贡献（API_h(n)）
 * @param selectedTarget - 上一 tick 选中的目标（null = 沉默）
 * @param config - 衰减参数
 * @param dt - 本 tick 时间步长（秒）。用于 (1-δ)^(dt/60) 缩放衰减。
 * @param lastIncomingMs - channel → 最后收到消息的墙钟时间（ms）。
 *   超过 STALE_THRESHOLD 无新消息的频道仅衰减不累积，
 *   新消息到达时自动恢复累积——消息驱动而非时间累积。
 * @param nowMs - 当前墙钟时间（ms）。
 * @returns 新的 debt map（不修改原 map）
 */
export function updateAttentionDebt(
  prevDebt: Map<string, number>,
  channelPressures: Map<string, number>,
  selectedTarget: string | null,
  config: AttentionDebtConfig,
  dt: number = DT_BASE_S,
  lastIncomingMs?: Map<string, number>,
  nowMs?: number,
): Map<string, number> {
  const now = nowMs ?? Date.now();
  const newDebt = new Map<string, number>();
  // 合并所有已知 channel：prevDebt 中有的 + channelPressures 中有的
  const allChannels = new Set([...prevDebt.keys(), ...channelPressures.keys()]);

  for (const ch of allChannels) {
    const prev = prevDebt.get(ch) ?? 0;
    const pressure = channelPressures.get(ch) ?? 0;
    const wasSelected = ch === selectedTarget;

    // 冷频道检测：超过 7 天无新消息 → 仅衰减，不累积 debt。
    // 新消息到达时 last_incoming_ms 刷新 → isStale=false → 恢复正常累积。
    const lastMsg = lastIncomingMs?.get(ch);
    const isStale = lastMsg != null && lastMsg > 0 && now - lastMsg > STALE_THRESHOLD_MS;

    // D_h(n) = D_h(n-1) × (1-δ)^(dt/60) + 1[target ≠ h] × API_h(n)
    // dt=60s 时退化为旧行为 (1-δ)^1
    const decayed = prev * (1 - config.delta) ** (dt / DT_BASE_S);
    const accumulated = wasSelected || isStale ? 0 : pressure;
    const debt = decayed + accumulated;

    // 只保留有意义的 debt（避免 map 无限膨胀）
    if (debt > 1e-6) {
      newDebt.set(ch, debt);
    }
  }

  return newDebt;
}

// ADR-218 Phase 2: computeDebtBonus 已删除。
// U_coverage 被 U_fairness 取代（iaus-scorer.ts post-scoring pass）。
// updateAttentionDebt 保留——debt 累积仍用于压力监控和 channelPressures 输入。
