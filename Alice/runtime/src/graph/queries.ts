/**
 * 图查询工具函数。
 * 纯图遍历，不依赖 engine/ 层，供 pressure/、mods/、engine/ 自由导入。
 */
import type { ConversationState } from "./entities.js";
import type { WorldModel } from "./world-model.js";

/**
 * 查找频道中处于活跃状态的对话会话。
 * 活跃 = state ∈ {pending, opening, active}
 */
export function findActiveConversation(G: WorldModel, channelId: string): string | null {
  for (const convId of G.getEntitiesByType("conversation")) {
    const attrs = G.getConversation(convId);
    if (attrs.channel !== channelId) continue;
    const state = attrs.state;
    if (state === "pending" || state === "opening" || state === "active") {
      return convId;
    }
  }
  return null;
}

/**
 * 查找频道中处于 closing 状态的对话。
 * leave / 超时后对话进入 closing → 对方 directed 消息可重新激活。
 */
export function findClosingConversation(G: WorldModel, channelId: string): string | null {
  for (const convId of G.getEntitiesByType("conversation")) {
    const attrs = G.getConversation(convId);
    if (attrs.channel === channelId && attrs.state === "closing") {
      return convId;
    }
  }
  return null;
}

/**
 * 查找频道中优先级最高的非终态对话（排除 cooldown）。
 * 优先级：active > opening > pending > closing。
 *
 * 与 findActiveConversation 不同：返回 closing 状态对话，
 * 使 gateConversationAware 的 closing 分支和 gateClosingConversation 可达。
 *
 * 单活跃对话不变式下至多返回一个，优先级排序是防御性措施。
 */
export function findConversationForChannel(G: WorldModel, channelId: string): string | null {
  const PRIORITY: Record<ConversationState, number> = {
    active: 5,
    opening: 4,
    pending: 3,
    closing: 2,
    cooldown: 1, // 最低优先级但仍可被发现（gateConversationAware 需要感知冷却期）
  };

  let best: string | null = null;
  let bestPriority = 0;

  for (const convId of G.getEntitiesByType("conversation")) {
    const attrs = G.getConversation(convId);
    if (attrs.channel !== channelId) continue;
    const p = PRIORITY[attrs.state];
    if (p > bestPriority) {
      best = convId;
      bestPriority = p;
    }
  }
  return best;
}
