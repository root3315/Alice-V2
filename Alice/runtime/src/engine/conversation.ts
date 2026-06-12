/**
 * 对话会话实体生命周期管理 (ADR-26 §3)。
 *
 * Conversation 是图的第四种一级实体（channel/contact/thread/conversation），
 * 追踪 Alice 与联系人之间的交互会话状态。
 *
 * 与 Thread（话题维度）正交: Thread 是"帮 Bob debug"，
 * Conversation 是"今天下午和 Bob 的这段 DM 对话"。
 *
 * **核心不变式**：每个 channel 至多一个非终态（non-cooldown）对话。
 * 通过创建守卫强制执行——违反时旧对话自动终结为 cooldown。
 *
 * Phase 1: 纯函数，不调用 LLM，不写数据库，只被测试消费。
 */

import { ALICE_SELF } from "../graph/constants.js";
import type { ChatType, ConversationState, TurnState } from "../graph/entities.js";
import { findActiveConversation, findClosingConversation } from "../graph/queries.js";
import type { WorldModel } from "../graph/world-model.js";
import { ChatTarget } from "../prompt/types.js";
import type { GraphPerturbation } from "../telegram/mapper.js";

// -- 常量 -------------------------------------------------------------------

/** ADR-110: pending 状态超时（秒）——群聊双握手等待窗口。 */
const N_PENDING_S = 300;
/** ADR-110: closing → cooldown 的冷却时间（秒）。 */
const M_COOLDOWN_S = 600;
/** 私聊 closing 超时（秒）：异步 IM 场景，45 分钟。 */
const CLOSING_TIMEOUT_PRIVATE_S = 2700;
/** 群聊 closing 超时（秒）：群聊对话节奏快，15 分钟。 */
const CLOSING_TIMEOUT_GROUP_S = 900;
/** cooldown 对话 GC 超时（秒）：1 小时后删除实体。 */
const COOLDOWN_GC_S = 3600;
/**
 * ADR-218 F3: alice_turn TTL（秒）。
 * alice_turn 无新消息超过此时长 → 过期转 open，消散 isConversationContinuation bypass。
 * 10 分钟：如果 Alice 这么久都没回复，这个对话不再紧急。
 */
const ALICE_TURN_TTL_S = 600;

// -- 内部工具 ---------------------------------------------------------------

/**
 * 终结指定 channel 上所有非终态对话 → cooldown。
 * 强制执行"每个 channel 至多一个非终态对话"不变式。
 */
function terminateAllForChannel(G: WorldModel, channelId: string, _nowMs: number): void {
  for (const convId of G.getEntitiesByType("conversation")) {
    if (!G.has(convId)) continue;
    const attrs = G.getConversation(convId);
    if (attrs.channel !== channelId) continue;
    if (attrs.state === "cooldown") continue;
    G.updateConversation(convId, { state: "cooldown", turn_state: "closed" });
  }
}

// -- 创建 -------------------------------------------------------------------

/**
 * 检测是否应创建新的对话会话。
 *
 * 触发条件: directed new_message 到无活跃 conv 的 channel。
 * - 私聊: 直接进入 opening, turnState=alice_turn
 * - 群聊: 进入 pending（双握手，等待 Alice 回复确认参与）
 *
 * **Closing 守卫**：如果 channel 有 closing 对话，directed 消息意味着
 * 对方重新拉回 Alice → 重新激活而非创建新对话。这阻止了 leave 告别承诺
 * 被静默击穿的 F1 缺陷。
 *
 * @returns 新创建/重新激活的 conversation ID，或 null（不创建）
 */
export function detectConversationStart(G: WorldModel, event: GraphPerturbation): string | null {
  // 只处理 directed new_message
  if (event.type !== "new_message" || !event.isDirected) return null;
  if (!event.channelId) return null;

  // 已有活跃会话 → 不创建
  if (findActiveConversation(G, event.channelId)) return null;

  const channelId = event.channelId;
  const nowMs = event.nowMs ?? Date.now();

  // Closing 守卫：对方 directed 消息拉回 Alice → 重新激活旧对话
  const closingConvId = findClosingConversation(G, channelId);
  if (closingConvId && G.has(closingConvId)) {
    G.updateConversation(closingConvId, {
      state: "active",
      turn_state: "alice_turn",
      last_activity_ms: nowMs,
      closing_since_ms: undefined,
      message_count: (G.getConversation(closingConvId).message_count ?? 0) + 1,
    });
    // 添加新参与者
    if (event.contactId) {
      const participants = G.getConversation(closingConvId).participants ?? [];
      if (!participants.includes(event.contactId)) {
        G.updateConversation(closingConvId, { participants: [...participants, event.contactId] });
        if (G.has(event.contactId)) {
          G.addRelation(event.contactId, "participates", closingConvId);
        }
      }
    }
    return closingConvId;
  }

  // 无活跃也无 closing → 清理旧终态对话，创建新对话
  terminateAllForChannel(G, channelId, nowMs);

  const tick = event.tick;
  const convId = `conversation:${channelId}_${tick}`;
  const chatType = event.chatType;
  if (!chatType) {
    throw new Error(`conversation event for ${channelId} is missing explicit chatType`);
  }
  const isPrivate = chatType === "private";

  const initialState: ConversationState = isPrivate ? "opening" : "pending";
  const turnState: TurnState = isPrivate ? "alice_turn" : "open";

  const participants: string[] = [];
  if (event.contactId) participants.push(event.contactId);

  G.addConversation(convId, {
    channel: channelId,
    participants,
    state: initialState,
    start_ms: nowMs,
    last_activity_ms: nowMs,
    turn_state: turnState,
    pace: 0,
    message_count: 1,
    alice_message_count: 0,
  });

  // 关系边
  G.addRelation(convId, "happens_in", channelId);
  if (event.contactId && G.has(event.contactId)) {
    G.addRelation(event.contactId, "participates", convId);
  }

  return convId;
}

// -- 隐式对话创建 -----------------------------------------------------------

/**
 * 创建隐式对话：Alice 近期发言后，对方不用 reply 直接跟进。
 *
 * 与 detectConversationStart 的区别：
 * - detectConversationStart 要求 isDirected=true（reply / @mention / 私聊）
 * - createImplicitConversation 由 isContinuation=true 触发（Alice 近期发言的频道）
 *
 * **Closing 守卫**：Alice 已告别（closing），非 directed 的隐式消息
 * 不足以推翻告别承诺 → 拒绝创建。只有 directed 消息才能重新拉回 Alice。
 *
 * @returns 新创建的 conversation ID，或 null（不创建）
 */
export function createImplicitConversation(G: WorldModel, event: GraphPerturbation): string | null {
  if (!event.channelId) return null;
  // 已有活跃会话 → 不创建
  if (findActiveConversation(G, event.channelId)) return null;
  // Closing 守卫：Alice 已告别，拒绝隐式重新激活（F1 修复核心）
  if (findClosingConversation(G, event.channelId)) return null;

  const channelId = event.channelId;
  const nowMs = event.nowMs ?? Date.now();

  // 清理旧终态对话
  terminateAllForChannel(G, channelId, nowMs);

  const tick = event.tick;
  const convId = `conversation:${channelId}_${tick}`;

  const participants: string[] = [];
  if (event.contactId) participants.push(event.contactId);

  // 隐式对话直接进入 opening + alice_turn
  G.addConversation(convId, {
    channel: channelId,
    participants,
    state: "opening",
    start_ms: nowMs,
    last_activity_ms: nowMs,
    turn_state: "alice_turn",
    pace: 0,
    message_count: 1,
    alice_message_count: 0,
  });

  // 关系边
  G.addRelation(convId, "happens_in", channelId);
  if (event.contactId && G.has(event.contactId)) {
    G.addRelation(event.contactId, "participates", convId);
  }

  return convId;
}

// -- 外部终结 ---------------------------------------------------------------

/**
 * 终结指定 channel 的活跃对话（kick/leave/permanent failure 时调用）。
 * 直接转 cooldown + 清理 pending_directed，不经过 closing 过渡。
 */
export function terminateConversation(G: WorldModel, channelId: string): void {
  for (const convId of G.getEntitiesByType("conversation")) {
    if (!G.has(convId)) continue;
    const attrs = G.getConversation(convId);
    if (attrs.channel !== channelId) continue;
    if (attrs.state === "cooldown") continue;
    G.updateConversation(convId, { state: "cooldown", turn_state: "closed" });
  }
  if (G.has(channelId)) {
    G.updateChannel(channelId, { pending_directed: 0 });
  }
}

// -- 更新 -------------------------------------------------------------------

/**
 * 更新已有对话会话的状态。
 *
 * 状态转移规则:
 * - pending + Alice 回复 → opening（双握手完成）
 * - opening + 对方回复 → active
 * - active: 更新 pace / turnState / activity tick
 */
export function updateConversation(G: WorldModel, convId: string, event: GraphPerturbation): void {
  if (!G.has(convId)) return;

  const attrs = G.getConversation(convId);
  const state = attrs.state;
  const _tick = event.tick;
  const nowMs = event.nowMs ?? Date.now();
  const isAlice = event.contactId === ALICE_SELF;

  // 更新活跃时间和消息计数
  const msgCount = attrs.message_count + 1;
  G.updateConversation(convId, { last_activity_ms: nowMs, message_count: msgCount });

  if (isAlice) {
    G.updateConversation(convId, { alice_message_count: attrs.alice_message_count + 1 });
  }

  // 添加新参与者（不可变更新，避免意外原地修改）
  const participants = attrs.participants ?? [];
  if (event.contactId && !participants.includes(event.contactId)) {
    G.updateConversation(convId, { participants: [...participants, event.contactId] });
    if (G.has(event.contactId)) {
      G.addRelation(event.contactId, "participates", convId);
    }
  }

  // ADR-110: pace（消息频率: messages / elapsed seconds）
  const startMs = Number(attrs.start_ms ?? nowMs);
  const elapsedS = Math.max(1, (nowMs - startMs) / 1000);
  G.updateConversation(convId, { pace: msgCount / elapsedS });

  // 状态转移
  if (state === "pending" && isAlice) {
    // 双握手: Alice 回复 → opening
    G.updateConversation(convId, { state: "opening", turn_state: "other_turn" });
  } else if (state === "opening" && !isAlice) {
    // 对方回复 → active
    G.updateConversation(convId, { state: "active", turn_state: "alice_turn" });
  } else {
    // active / opening: 更新 turnState
    // 群聊感知：非 directed 消息 → open（中性态），不产生 alice_turn 义务。
    // 修复：二值 turn 模型在群聊中导致 Alice 回复每条消息（穷追猛打）。
    // 只有 directed 消息（reply/@mention）才应设置 alice_turn 触发回复义务。
    if (isAlice) {
      G.updateConversation(convId, { turn_state: "other_turn" });
    } else {
      const chatType = getChannelChatType(G, attrs.channel);
      const isGroupChat = ChatTarget.isGroupChat(chatType);
      const turnState = isGroupChat && !event.isDirected ? "open" : "alice_turn";
      G.updateConversation(convId, { turn_state: turnState });
    }
  }
}

// -- 对话动量 ---------------------------------------------------------------

/**
 * ADR-110: 对话动量：从已有对话属性派生的对话参与惯性。
 *
 * 当 pending_directed 递减到 0 后，Alice 仍应在活跃对话中保持参与感，
 * 而非突然失去所有对话优先级。动量通过以下方式自然衰减：
 * - 对话空闲 → idleDecay 趋近 0
 * - 对话转为 closing/cooldown → 状态过滤直接返回 0
 *
 * @param G 伴侣图
 * @param channelId 目标频道 ID
 * @param tick 当前 tick
 * @param nowMs 当前墙钟时间（ms）
 * @returns 0-1 之间的动量值。0 = 无活跃对话或对话已冷却，1 = 高速往返中。
 *
 * @see paper-five-dim/ Open Question 6: Conversation-Mode Pressure Accumulation
 */
export function conversationMomentum(
  G: WorldModel,
  channelId: string,
  _tick: number,
  nowMs: number = Date.now(),
): number {
  const convId = findActiveConversation(G, channelId);
  if (!convId || !G.has(convId)) return 0;

  const attrs = G.getConversation(convId);
  // 只有 opening/active 状态有动量（pending 还未确认参与）
  if (attrs.state !== "active" && attrs.state !== "opening") return 0;

  // 互惠度：Alice 消息占比，0.5 最佳（50/50 往返）
  // ADR-158 Fix 4: totalMessages 必须包含 Alice 消息。
  // message_count 仅计入站（perceive updateConversation 递增），
  // alice_message_count 计出站（DECLARE_ACTION 递增）。
  // 旧公式 totalMessages=message_count → aliceRate>1 → reciprocity 变负。
  const totalMessages = Math.max(1, (attrs.message_count ?? 0) + (attrs.alice_message_count ?? 0));
  const aliceRate = (attrs.alice_message_count ?? 0) / totalMessages;
  // 对称钟形：0.5 → 1.0（最佳互惠），0.0/1.0 → 0.0（单方面主导）
  const reciprocity = 1 - (2 * aliceRate - 1) ** 2;

  // ADR-110: 空闲衰减 — 600 秒（10 分钟）半衰期
  const lastActivityMs = Number(attrs.last_activity_ms ?? 0);
  const idleS = lastActivityMs > 0 ? Math.max(0, (nowMs - lastActivityMs) / 1000) : 0;
  const idleDecay = 0.5 ** (idleS / 600);

  // Alice 轮次时动量额外提升（对方在等 Alice 回复）
  const turnBoost = attrs.turn_state === "alice_turn" ? 1.5 : 1.0;

  return Math.min(1, reciprocity * idleDecay * turnBoost);
}

// -- Tick 生命周期 ----------------------------------------------------------

/**
 * 从图中查询 channel 的 chat_type。
 */
function getChannelChatType(G: WorldModel, channelId: string): ChatType | undefined {
  if (!G.has(channelId)) return undefined;
  return G.getChannel(channelId).chat_type;
}

/**
 * ADR-110: 每 tick 检查对话会话超时，推进状态机。
 *
 * - pending + 超过 N_PENDING_S 秒 → cooldown（未建立的会话过期）
 * - active + 超过 nClosingS 秒无消息 → closing（记录 closing_since_ms）
 * - closing + 超过 M_COOLDOWN_S 秒 → cooldown
 * - cooldown + 超过 COOLDOWN_GC_S 秒 → 删除实体（F7 GC）
 *
 * nClosingS 动态: max(baseTimeout, ceil(3 / pace_per_second))
 * baseTimeout: 群聊 900s / 私聊 2700s（F6 chat-type 感知）
 */
export function tickConversations(G: WorldModel, _tick: number, nowMs: number = Date.now()): void {
  for (const convId of G.getEntitiesByType("conversation")) {
    if (!G.has(convId)) continue;
    const attrs = G.getConversation(convId);
    const state = attrs.state;
    const lastActivityMs = Number(attrs.last_activity_ms ?? 0);
    const idleS = lastActivityMs > 0 ? Math.max(0, (nowMs - lastActivityMs) / 1000) : 0;

    if (state === "cooldown") {
      // F7: cooldown GC — 超过 1 小时的终态对话删除实体，防止图无限增长
      if (idleS >= COOLDOWN_GC_S) {
        G.removeEntity(convId);
      }
      continue;
    }

    if (state === "pending") {
      if (idleS >= N_PENDING_S) {
        // ADR-90 W3: 关闭时清理义务残留——防止 turn_state 卡在 alice_turn
        G.updateConversation(convId, { state: "cooldown", turn_state: "closed" });
        // F9: 清理 pending_directed 残留
        if (attrs.channel && G.has(attrs.channel)) {
          G.updateChannel(attrs.channel, { pending_directed: 0 });
        }
      }
    } else if (state === "opening" || state === "active") {
      // ADR-218 F3: alice_turn TTL — 超时后过期转 open，消散 bypass 信号。
      // 使用 last_activity_ms 作为 TTL 基准：alice_turn 设置时 last_activity_ms 同步更新，
      // 新消息到达时 last_activity_ms 刷新 → TTL 自动重置。
      if (attrs.turn_state === "alice_turn" && idleS >= ALICE_TURN_TTL_S) {
        G.updateConversation(convId, { turn_state: "open" });
      }

      // pace: messages/second（基于活跃期，不含空闲时间）
      const startMs = Number(attrs.start_ms ?? 0);
      const lastActMs = Number(attrs.last_activity_ms ?? startMs);
      const msgCount = attrs.message_count ?? 0;
      const activePeriodS = startMs > 0 ? Math.max(1, (lastActMs - startMs) / 1000) : 1;
      const pacePerS = msgCount / activePeriodS;
      // F6: chat-type 感知超时——群聊 15 分钟，私聊 45 分钟
      const chatType = getChannelChatType(G, attrs.channel);
      const baseTimeout = ChatTarget.isGroupChat(chatType)
        ? CLOSING_TIMEOUT_GROUP_S
        : CLOSING_TIMEOUT_PRIVATE_S;
      const nClosingS = Math.max(baseTimeout, pacePerS > 0 ? Math.ceil(3 / pacePerS) : 3600);
      if (idleS >= nClosingS) {
        // ADR-90 W3: 进入 closing 时清理 turn_state，斩断 isConversationContinuation 信号
        G.updateConversation(convId, {
          state: "closing",
          turn_state: "closed",
          closing_since_ms: nowMs,
        });
        // F9: 进入 closing 时清理 pending_directed 残留
        if (attrs.channel && G.has(attrs.channel)) {
          G.updateChannel(attrs.channel, { pending_directed: 0 });
        }
      }
    } else if (state === "closing") {
      if (idleS >= M_COOLDOWN_S) {
        G.updateConversation(convId, { state: "cooldown" });
      }
    }
  }
}
