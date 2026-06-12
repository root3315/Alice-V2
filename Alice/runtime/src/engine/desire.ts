/**
 * ADR-185 §1: Desire 中间层 — tension → 显式目标派生。
 *
 * 在压力信号和 IAUS 评分之间插入 Desire 层，将散落的 per-target 张力信号
 * 聚合为语义化目标（"我想联系小明"、"我该回复那个线程"）。
 *
 * Desire 作为 post-CF 乘法 boost（类似 ADR-182 D1 Momentum），不是 Consideration：
 * - urgency 从 tension 维度派生，与 specialist Considerations 共享数据源 → 作为 Consideration 会 double-count
 * - Post-CF boost 不改变 Consideration 数量 n → 无需 CF 重校准
 * - 非期望 target 不被惩罚（区别于 Consideration 方案的近否决效应）
 *
 * @see docs/adr/185-ecm-cross-pollination.md §1
 * @see docs/adr/182-v-maximizer-refactor.md D1 Momentum Bonus（先例）
 */

import { safeDisplayName } from "../graph/display.js";
import type { TensionVector } from "../graph/tension.js";
import type { WorldModel } from "../graph/world-model.js";
import { effectiveObligation } from "../pressure/signal-decay.js";

// ═══════════════════════════════════════════════════════════════════════════
// 类型
// ═══════════════════════════════════════════════════════════════════════════

export type DesireType =
  | "fulfill_duty" // P5 高
  | "reconnect" // P3 高
  | "resolve_thread" // P4 高
  | "reduce_backlog" // P1 高
  | "explore"; // P6 高

export interface Desire {
  type: DesireType;
  targetId: string;
  /** urgency ∈ (0, 1] — 越高越紧迫。 */
  urgency: number;
  /** 人类可读标签（如 "reply to 小明"）。 */
  label: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// 常量
// ═══════════════════════════════════════════════════════════════════════════

const MAX_DESIRES = 10;

/** 各维度产生 desire 的最低阈值。低于阈值 → 信号不够强，不构成显式目标。 */
const DESIRE_THRESHOLDS: Record<DesireType, number> = {
  fulfill_duty: 0.2,
  reconnect: 0.3,
  resolve_thread: 0.4,
  reduce_backlog: 0.5,
  explore: 0.3,
};

// ═══════════════════════════════════════════════════════════════════════════
// 核心函数
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 从 tensionMap 派生显式 Desire 列表。
 *
 * 遍历每个 channel 实体的张力向量，检查 5 个维度是否超过阈值。
 * 产生的 desires 按 urgency 降序排列，取 top MAX_DESIRES。
 *
 * 纯函数，无 DB/LLM 依赖。
 */
export function deriveDesires(
  tensionMap: Map<string, TensionVector>,
  G: WorldModel,
  nowMs: number,
): Desire[] {
  const desires: Desire[] = [];

  for (const [entityId, t] of tensionMap) {
    const name = safeDisplayName(G, entityId);

    // P5: 回应义务 — 使用 effectiveObligation（含衰减）
    const obligation = G.has(entityId) ? effectiveObligation(G, entityId, nowMs) : 0;
    if (obligation > DESIRE_THRESHOLDS.fulfill_duty) {
      desires.push({
        type: "fulfill_duty",
        targetId: entityId,
        urgency: Math.min(1, obligation),
        label: `reply to ${name}`,
      });
    }

    // P3: 关系冷却
    if (t.tau3 > DESIRE_THRESHOLDS.reconnect) {
      desires.push({
        type: "reconnect",
        targetId: entityId,
        urgency: Math.min(1, t.tau3),
        label: `reconnect with ${name}`,
      });
    }

    // P4: 线程分歧
    if (t.tau4 > DESIRE_THRESHOLDS.resolve_thread) {
      desires.push({
        type: "resolve_thread",
        targetId: entityId,
        urgency: Math.min(1, t.tau4),
        label: `resolve thread in ${name}`,
      });
    }

    // P1: 注意力积压
    if (t.tau1 > DESIRE_THRESHOLDS.reduce_backlog) {
      desires.push({
        type: "reduce_backlog",
        targetId: entityId,
        urgency: Math.min(1, t.tau1),
        label: `reduce backlog for ${name}`,
      });
    }

    // P6: 好奇心
    if (t.tau6 > DESIRE_THRESHOLDS.explore) {
      desires.push({
        type: "explore",
        targetId: entityId,
        urgency: Math.min(1, t.tau6),
        label: `explore ${name}`,
      });
    }
  }

  // 按 urgency 降序排列，截断到 MAX_DESIRES
  desires.sort((a, b) => b.urgency - a.urgency);
  return desires.slice(0, MAX_DESIRES);
}

/**
 * 在已排序的 desires 中查找指定 target 的最高 urgency desire。
 *
 * desires 已按 urgency 降序排列，find 返回第一个匹配 = 最高 urgency。
 */
export function findTopDesireForTarget(
  desires: readonly Desire[],
  targetId: string,
): Desire | undefined {
  return desires.find((d) => d.targetId === targetId);
}
