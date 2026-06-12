/**
 * 实体默认值工厂 — 从 WorldModel.addEntity() 提取的纯函数。
 *
 * 每个工厂函数：
 *   1. 设置 entity_type 判别字段
 *   2. 填充 Core 层默认值（保证非 ? 字段存在）
 *   3. 接受 partial 覆盖默认值
 *
 * 从 addEntity() 提取为独立函数的好处：
 *   - 可独立单测（不依赖 WorldModel 实例）
 *   - 消除 Record<string, unknown> 类型转换
 *   - 调用侧得到精确类型返回值
 *
 * @see docs/adr/154-world-model-rewrite.md
 */

import { THREAD_WEIGHTS } from "./constants.js";
import type {
  AgentAttrs,
  ChannelAttrs,
  ChatType,
  ContactAttrs,
  ConversationAttrs,
  FactAttrs,
  ThreadAttrs,
  ThreadWeight,
} from "./entities.js";

/**
 * Agent（自身）节点默认属性。
 *
 * 默认值：mood_valence=0, mood_set_ms=0（中性情绪，尚未设置）。
 */
export function agentDefaults(partial?: Partial<Omit<AgentAttrs, "entity_type">>): AgentAttrs {
  return {
    mood_valence: 0,
    mood_set_ms: 0,
    ...partial,
    entity_type: "agent",
  };
}

/**
 * 联系人节点默认属性。
 *
 * 默认值：tier=150（熟人圈）, last_active_ms=0, auth_level=0, interaction_count=0。
 */
export function contactDefaults(
  partial?: Partial<Omit<ContactAttrs, "entity_type">>,
): ContactAttrs {
  return {
    tier: 150,
    last_active_ms: 0,
    auth_level: 0,
    interaction_count: 0,
    ...partial,
    entity_type: "contact",
  };
}

/**
 * 频道节点默认属性。
 *
 * 特殊逻辑：当 unread > 0 且无 EWMS 数据时，自动初始化 EWMS 累加器。
 * @see docs/adr/150-ewms-exact-unread-decay.md §D1
 */
export type ChannelDefaultsInput = Partial<Omit<ChannelAttrs, "entity_type" | "chat_type">> &
  Pick<ChannelAttrs, "chat_type">;

export function isChatType(value: unknown): value is ChatType {
  return value === "private" || value === "group" || value === "supergroup" || value === "channel";
}

export function requireChannelDefaultsInput(
  id: string,
  attrs: Record<string, unknown>,
): ChannelDefaultsInput {
  if (!isChatType(attrs.chat_type)) {
    throw new Error(`channel ${id} is missing explicit chat_type`);
  }
  return attrs as ChannelDefaultsInput;
}

export function channelDefaults(partial: ChannelDefaultsInput): ChannelAttrs {
  const unread = partial.unread ?? 0;

  // ADR-150: EWMS 与 unread 保持一致——初始化时视为所有消息刚到达。
  let unread_ewms = partial.unread_ewms;
  let unread_ewms_ms = partial.unread_ewms_ms;
  if (unread > 0 && unread_ewms == null) {
    unread_ewms = unread;
    unread_ewms_ms = Date.now();
  }

  return {
    unread,
    tier_contact: 150,
    pending_directed: 0,
    last_directed_ms: 0,
    last_outgoing_text: "",
    consecutive_outgoing: 0,
    last_directed_text: "",
    habituation: 0,
    habituation_ms: 0,
    ...partial,
    // EWMS 字段在 partial spread 之后覆盖，确保自动初始化逻辑生效
    unread_ewms,
    unread_ewms_ms,
    entity_type: "channel",
  };
}

/**
 * 线程节点默认属性。
 *
 * 自动从 weight 计算 w = THREAD_WEIGHTS[weight]。
 * 默认值：status="open", weight="minor", created_ms=Date.now(), deadline=Infinity。
 */
export function threadDefaults(partial?: Partial<Omit<ThreadAttrs, "entity_type">>): ThreadAttrs {
  const weight: ThreadWeight = partial?.weight ?? "minor";
  const w = THREAD_WEIGHTS[weight] ?? 1.0;

  return {
    status: "open",
    created_ms: Date.now(),
    deadline: Infinity,
    ...partial,
    // weight 和 w 在 spread 之后覆盖，确保 w 与 weight 一致
    weight,
    w,
    entity_type: "thread",
  };
}

/**
 * 事实节点默认属性。
 *
 * ADR-154: info_item → fact 重命名；created/last_access tick → created_ms/last_access_ms wall-clock ms。
 *
 * 默认值：importance=0.5, stability=1.0, volatility=0.5, novelty=1.0,
 *         tracked=false, created_ms=Date.now(), last_access_ms=Date.now()。
 */
export function factDefaults(partial?: Partial<Omit<FactAttrs, "entity_type">>): FactAttrs {
  const now = Date.now();
  return {
    importance: 0.5,
    stability: 1.0,
    last_access_ms: now,
    volatility: 0.5,
    tracked: false,
    created_ms: now,
    novelty: 1.0,
    ...partial,
    entity_type: "fact",
  };
}

/**
 * 对话会话节点默认属性。
 *
 * 默认值：channel="", participants=[], state="pending", turn_state="open",
 *         pace=0, message_count=0, alice_message_count=0,
 *         start_ms=0, last_activity_ms=0。
 */
export function conversationDefaults(
  partial?: Partial<Omit<ConversationAttrs, "entity_type">>,
): ConversationAttrs {
  return {
    channel: "",
    participants: [],
    state: "pending",
    start_ms: 0,
    last_activity_ms: 0,
    turn_state: "open",
    pace: 0,
    message_count: 0,
    alice_message_count: 0,
    ...partial,
    entity_type: "conversation",
  };
}
