/**
 * Strategy Mod — hint 生成函数集合。
 *
 * 从 onTickEnd 中提取的 11 类 hint 生成逻辑（不含 personality_drift）。
 * 每个函数接收 ModContext<StrategyState>，返回 StrategyHint[]。
 */

function capitalizeFirst(s: string): string {
  return s.length > 0 ? s[0].toUpperCase() + s.slice(1) : s;
}

/**
 * EST 原则：LLM 消费离散类别，不消费连续标量。
 * 消息数 → 语义描述。
 */
function msgCountLabel(n: number): string {
  if (n >= 100) return "a flood of";
  if (n >= 30) return "many";
  if (n >= 10) return "several";
  if (n >= 3) return "a few";
  return "a couple of";
}

import { eq, sql } from "drizzle-orm";
import { PromptBuilder } from "../../core/prompt-style.js";
import type { ModContext } from "../../core/types.js";
import { getDb } from "../../db/connection.js";
import { messageLog, narrativeThreads } from "../../db/schema.js";
import { ensureChannelId, extractNumericId, tierLabel } from "../../graph/constants.js";
import { safeDisplayName } from "../../graph/display.js";
import { estimateAgeS, estimateEventMs, readNodeMs } from "../../pressure/clock.js";
import { effectiveObligation } from "../../pressure/signal-decay.js";
import { humanDuration } from "../../utils/time-format.js";
import {
  CRISIS_FREQUENCY_RATIO,
  CRISIS_MIN_BASELINE,
  CRISIS_RECOVERY_RATIO,
  CRISIS_RECOVERY_Z,
  CRISIS_Z_THRESHOLD,
  emptyGroupState,
  extractKeywords,
  getSilenceThresholdS,
  MAX_RECENT_SPEAKERS,
  MAX_TOPIC_KEYWORDS,
  type StrategyHint,
  type StrategyState,
} from "./types.js";

// -- B2 修复: 入站消息群聊状态补充 -------------------------------------------

/**
 * 从 message_log 更新入站消息的群聊状态。
 *
 * 问题: GroupChatState 只在 SEND_MESSAGE listener 中更新，入站消息被遗漏。
 * 修复: onTickEnd 读取近期入站消息，补充更新群聊状态。
 */
export function updateIncomingGroupState(ctx: ModContext<StrategyState>): void {
  try {
    const db = getDb();
    // ADR-110: 使用 createdAt 替代 tick 窗口查询（最近 60 秒）
    const recentIncoming = db
      .select({
        chatId: messageLog.chatId,
        senderId: messageLog.senderId,
        senderName: messageLog.senderName,
        text: messageLog.text,
      })
      .from(messageLog)
      .where(
        sql`${messageLog.createdAt} >= ${Math.floor((ctx.nowMs - 60_000) / 1000)} AND ${messageLog.isOutgoing} = 0`,
      )
      .all();

    for (const msg of recentIncoming) {
      const channelId = msg.chatId;
      if (!channelId) continue;
      if (!ctx.state.groupStates[channelId]) {
        ctx.state.groupStates[channelId] = emptyGroupState();
      }
      const gs = ctx.state.groupStates[channelId];

      // 更新发言者（IRC 风格：name ~senderId）
      if (msg.senderName) {
        // senderId 格式为 "contact:xxx" — 提取数字部分作为 ~id
        const numId = msg.senderId ? extractNumericId(msg.senderId) : null;
        const tag = numId != null ? `${msg.senderName} @${numId}` : msg.senderName;
        // 按 senderId 去重（避免改名后重复），无 senderId 时按 name 去重
        const dedup = numId != null ? ` @${numId}` : msg.senderName;
        gs.recentSpeakers = gs.recentSpeakers.filter(
          (s) => !s.endsWith(dedup) && s !== msg.senderName,
        );
        gs.recentSpeakers.push(tag);
        if (gs.recentSpeakers.length > MAX_RECENT_SPEAKERS) {
          gs.recentSpeakers.shift();
        }
      }

      // 更新关键词
      if (msg.text) {
        const kw = extractKeywords(msg.text);
        gs.topicKeywords.push(...kw);
        if (gs.topicKeywords.length > MAX_TOPIC_KEYWORDS) {
          gs.topicKeywords = gs.topicKeywords.slice(-MAX_TOPIC_KEYWORDS);
        }
      }

      // 更新消息计数（非 Alice 消息）
      gs.totalMessages++;
    }
  } catch {
    // DB 不可用时跳过
  }
}

// -- G7: participation_ratio 图属性暴露 --------------------------------------

/** 暴露 participationRatio 到图属性（供 system1 动态频率控制）。 */
export function syncParticipationToGraph(ctx: ModContext<StrategyState>): void {
  for (const [channelId, gs] of Object.entries(ctx.state.groupStates)) {
    if (ctx.graph.has(channelId)) {
      ctx.graph.updateChannel(channelId, { participation_ratio: gs.participationRatio });
    }
  }
}

// -- Hint 生成函数 -----------------------------------------------------------

/** 1. 关系维护扫描 — 检查亲密联系人的沉默时间。 */
export function generateRelationshipHints(ctx: ModContext<StrategyState>): StrategyHint[] {
  const hints: StrategyHint[] = [];
  for (const nodeId of ctx.graph.getEntitiesByType("contact")) {
    const attrs = ctx.graph.getContact(nodeId);
    const tier = Number(attrs.tier ?? 50);
    // ADR-110: 阈值现在是秒
    const thresholdS = getSilenceThresholdS(tier);

    // last_alice_action_ms 由 observer.mod 写到 channel:xxx 节点（DECLARE_ACTION target = ensureGraphId）。
    // 这里遍历 contact:xxx 节点，需同时查对应的 channel:xxx 变体。
    const chVariant = ensureChannelId(nodeId) ?? "";
    const lastInteractionMs = Math.max(
      readNodeMs(ctx.graph, nodeId, "last_alice_action_ms"),
      readNodeMs(ctx.graph, chVariant, "last_alice_action_ms"),
    );

    const silenceS = (ctx.nowMs - lastInteractionMs) / 1000;
    if (lastInteractionMs > 0 && silenceS > thresholdS) {
      const displayName = safeDisplayName(ctx.graph, nodeId);
      const label = tierLabel(tier);
      hints.push({
        type: "relationship_cooling",
        message: `Haven't talked to ${displayName} (${label}) in ${humanDuration(silenceS)}.`,
      });
    }
  }
  return hints;
}

/** 2. 注意力不平衡检测 — 最近行动是否过度集中。 */
export function generateAttentionHints(ctx: ModContext<StrategyState>): StrategyHint[] {
  const hints: StrategyHint[] = [];
  const recent = ctx.state.recentActions.slice(-10);
  if (recent.length >= 5) {
    const targetCounts: Record<string, number> = {};
    for (const a of recent) {
      if (a.target) {
        targetCounts[a.target] = (targetCounts[a.target] ?? 0) + 1;
      }
    }
    for (const [target, count] of Object.entries(targetCounts)) {
      const proportion = count / recent.length;
      if (proportion > 0.6) {
        const desc = proportion > 0.8 ? "almost all" : "most";
        const displayName = safeDisplayName(ctx.graph, target);
        hints.push({
          type: "attention_imbalance",
          message: `${capitalizeFirst(desc)} of recent actions directed at ${displayName}. Attention concentrated on one contact.`,
        });
      }
    }
  }
  return hints;
}

/** 3. 机会窗口 — 检测刚上线的联系人。 */
export function generateOpportunityHints(ctx: ModContext<StrategyState>): StrategyHint[] {
  const hints: StrategyHint[] = [];
  for (const nodeId of ctx.graph.getEntitiesByType("contact")) {
    // ADR-110: 使用 readNodeMs 获取 returning 时间
    const returningMs = readNodeMs(ctx.graph, nodeId, "returning_ms");
    // ADR-110: 5 ticks × 60 = 300 秒
    if (returningMs > 0 && (ctx.nowMs - returningMs) / 1000 <= 300) {
      const displayName = safeDisplayName(ctx.graph, nodeId);
      hints.push({
        type: "opportunity",
        message: `${displayName} just came back online — good moment to reconnect.`,
      });
    }
  }
  return hints;
}

/** 4. 陈旧线程 — 有 open thread 但长时间无 beat。 */
export function generateStaleThreadHints(ctx: ModContext<StrategyState>): StrategyHint[] {
  const hints: StrategyHint[] = [];
  try {
    const db = getDb();
    const staleThreads = db
      .select({
        id: narrativeThreads.id,
        title: narrativeThreads.title,
        lastBeatTick: narrativeThreads.lastBeatTick,
        createdTick: narrativeThreads.createdTick,
        createdAt: narrativeThreads.createdAt,
      })
      .from(narrativeThreads)
      .where(eq(narrativeThreads.status, "open"))
      .all();

    for (const t of staleThreads) {
      // ADR-110/166: 统一使用 estimateAgeS（墙钟优先，tick × 60 兜底）
      const lastBeatTick = t.lastBeatTick ?? t.createdTick;
      const staleDurationS = estimateAgeS(
        { createdAt: t.createdAt, tick: lastBeatTick },
        ctx.nowMs,
        ctx.tick,
      );
      // 20 ticks × 60 = 1200 秒
      if (staleDurationS > 1200) {
        hints.push({
          type: "thread_stale",
          message: `Thread #${t.id} "${t.title}" has been inactive for ${humanDuration(staleDurationS)} without progress.`,
        });
      }
    }
  } catch {
    // DB 不可用时跳过
  }
  return hints;
}

/** 5. 待回复对话 — 轮到 Alice 的 conversation。 */
export function generatePendingConversationHints(ctx: ModContext<StrategyState>): StrategyHint[] {
  const hints: StrategyHint[] = [];
  for (const convId of ctx.graph.getEntitiesByType("conversation")) {
    const conv = ctx.graph.getConversation(convId);
    if (conv.turn_state === "alice_turn" && conv.state !== "cooldown") {
      const participantId = conv.participants[0];
      // 无障碍：用 display_name 替代 raw graph ID
      const participantName =
        participantId && ctx.graph.has(participantId)
          ? String(ctx.graph.getDynamic(participantId, "display_name") ?? participantId)
          : participantId;
      const convLabel = participantName ?? "someone";
      hints.push({
        type: "conversation_pending",
        message: `Conversation with ${convLabel} waiting for a response.`,
      });
    }
  }
  return hints;
}

/**
 * 6. 危机检测 — 频道消息频率突增（GOAL.md 场景 6）。
 *
 * Z-score 检测（替代旧频率比）：Z = (unread - μ) / σ，Z > 2.5 → 危机候选。
 * 统计显著性更强——正常活跃时段不会误触发（旧 4× 比率在低基线时极易误报）。
 *
 * 检测的是**消息洪水**（统计异常突增），不是语义层的霸凌/攻击。
 * 生成的 hint 是情境感知（告诉 LLM 频道在发生什么），
 * gateCrisisMode 提供行为约束（别在洪水里刷屏）——两者互补而非矛盾。
 * Alice 被个人攻击的行为反应走涌现管线：feel() + mood + persona。
 *
 * @see evolve.ts spikeContribs — ADR-191: 相同的 EMA + Z-score 方法，通过 tauSpike → rCaution 直接结构路径
 */
export function generateCrisisHints(ctx: ModContext<StrategyState>): StrategyHint[] {
  const hints: StrategyHint[] = [];
  const EMA_ALPHA = 0.1;

  for (const channelId of ctx.graph.getEntitiesByType("channel")) {
    const attrs = ctx.graph.getChannel(channelId);
    const unread = attrs.unread ?? 0;

    // 初始化频率窗口
    if (!ctx.state.messageFrequency[channelId]) {
      ctx.state.messageFrequency[channelId] = {
        recentCount: unread,
        baseline: unread,
        variance: 0,
        lastTick: ctx.tick,
        lastMs: ctx.nowMs,
      };
      continue;
    }

    const window = ctx.state.messageFrequency[channelId];
    // ADR-110: 使用 ms 判断时间流逝
    const msDelta = ctx.nowMs - (window.lastMs ?? 0);
    if (msDelta <= 0) continue;

    // EMA 均值 + 方差更新（Welford 在线算法，与 generators.ts 一致）
    const diff = unread - window.baseline;
    window.baseline = window.baseline + EMA_ALPHA * diff;
    const prevVariance = window.variance ?? 0;
    window.variance = (1 - EMA_ALPHA) * (prevVariance + EMA_ALPHA * diff * diff);
    window.recentCount = unread;
    window.lastTick = ctx.tick;
    window.lastMs = ctx.nowMs;

    const isCrisis = !!ctx.state.crisisChannels[channelId];
    const hasVariance = (window.variance ?? 0) >= 1.0;

    // Z-score 计算（方差充足时使用，否则回退到旧频率比）
    // biome-ignore lint/style/noNonNullAssertion: hasVariance guards non-null
    const z = hasVariance ? (unread - window.baseline) / Math.sqrt(window.variance!) : 0;

    if (!isCrisis) {
      // 危机检测
      const isCrisisCandidate = hasVariance
        ? z > CRISIS_Z_THRESHOLD
        : // 回退：旧频率比（variance 数据积累不足时）
          unread > CRISIS_MIN_BASELINE &&
          window.baseline > 0 &&
          unread / Math.max(window.baseline, 1) >= CRISIS_FREQUENCY_RATIO;

      if (isCrisisCandidate) {
        ctx.state.crisisChannels[channelId] = ctx.tick;
        if (ctx.state.crisisChannelsMs) ctx.state.crisisChannelsMs[channelId] = ctx.nowMs;
        const displayName = safeDisplayName(ctx.graph, channelId);
        hints.push({
          type: "crisis_detected",
          message: `Unusual activity spike in ${displayName} (${unread > 50 ? "a flood of" : "many"} unread messages). Someone may need support.`,
        });
      }
    } else {
      // 危机恢复
      const isRecovered = hasVariance
        ? z < CRISIS_RECOVERY_Z
        : unread <= 0 || unread / Math.max(window.baseline, 1) < CRISIS_RECOVERY_RATIO;

      if (isRecovered) {
        const detectedMs = ctx.state.crisisChannelsMs?.[channelId] ?? 0;
        delete ctx.state.crisisChannels[channelId];
        if (ctx.state.crisisChannelsMs) delete ctx.state.crisisChannelsMs[channelId];
        const displayName = safeDisplayName(ctx.graph, channelId);
        const durationS = detectedMs > 0 ? (ctx.nowMs - detectedMs) / 1000 : 0;
        hints.push({
          type: "crisis_detected",
          message: `Activity in ${displayName} has calmed down (the spike lasted ${humanDuration(durationS)}).`,
        });
      }
    }
  }
  return hints;
}

/** 7. 群聊氛围感知（场景 4）— 检测活跃群聊 + M2 话题漂移窗口轮转。 */
export function generateGroupAtmosphereHints(ctx: ModContext<StrategyState>): StrategyHint[] {
  const hints: StrategyHint[] = [];
  for (const channelId of ctx.graph.getEntitiesByType("channel")) {
    const attrs = ctx.graph.getChannel(channelId);
    if (attrs.chat_type !== "group" && attrs.chat_type !== "supergroup") continue;

    const unread = attrs.unread ?? 0;
    if (unread < 5) continue; // 只关注活跃群聊

    const displayName = safeDisplayName(ctx.graph, channelId);
    // ADR-110: 使用 readNodeMs 获取 last_alice_action 时间
    const lastAliceActionMs = readNodeMs(ctx.graph, channelId, "last_alice_action_ms");
    const silenceSinceAliceS = (ctx.nowMs - lastAliceActionMs) / 1000;

    // ADR-110: 15 ticks × 60 = 900 秒
    if (lastAliceActionMs > 0 && silenceSinceAliceS > 900 && unread >= 10) {
      hints.push({
        type: "group_atmosphere",
        message: `${displayName} is lively (${unread > 50 ? "a flood of" : "many"} new messages) and you haven't participated for ${humanDuration(silenceSinceAliceS)}.`,
      });
    }

    // M2: 话题关键词窗口 FIFO 轮转（与 listener/updateIncomingGroupState 的 MAX_TOPIC_KEYWORDS 一致）
    const gs = ctx.state.groupStates[channelId];
    if (gs && gs.topicKeywords.length > MAX_TOPIC_KEYWORDS) {
      gs.topicKeywords = gs.topicKeywords.slice(-MAX_TOPIC_KEYWORDS);
    }
  }
  return hints;
}

/** 8. 行为模式识别（M4 三层增强）— 多维行为模式检测。 */
export function generateBehaviorPatternHints(ctx: ModContext<StrategyState>): StrategyHint[] {
  const hints: StrategyHint[] = [];
  if (ctx.state.recentActions.length < 10) return hints;

  const last10 = ctx.state.recentActions.slice(-10);

  // 8a. 声部单调性（同一 intent 重复出现）
  const intentCounts: Record<string, number> = {};
  for (const a of last10) {
    if (a.intent) {
      intentCounts[a.intent] = (intentCounts[a.intent] ?? 0) + 1;
    }
  }
  for (const [intent, count] of Object.entries(intentCounts)) {
    if (count >= 6) {
      const proportion = count >= 8 ? "almost all" : "most";
      hints.push({
        type: "behavior_pattern",
        message: `"${intent}" has been ${proportion} of recent actions. Messages following a similar pattern.`,
      });
    }
  }

  // 8b. 节奏模式检测 — 行动间隔的规律性
  // 参考: Buzsáki (2006) Rhythms of the Brain — 周期性模式即节律
  if (last10.length >= 5) {
    // ADR-110/166: 统一使用 estimateEventMs 计算间隔
    const gaps: number[] = [];
    for (let i = 1; i < last10.length; i++) {
      const msI = estimateEventMs(last10[i], ctx.nowMs, ctx.tick);
      const msIPrev = estimateEventMs(last10[i - 1], ctx.nowMs, ctx.tick);
      const gapS = msI > 0 && msIPrev > 0 ? (msI - msIPrev) / 1000 : 0;
      gaps.push(gapS);
    }
    const meanGap = gaps.reduce((s, g) => s + g, 0) / gaps.length;
    const variance = gaps.reduce((s, g) => s + (g - meanGap) ** 2, 0) / gaps.length;
    const stdGap = Math.sqrt(variance);
    // CV (变异系数) < 0.3 → 高度规律
    const cv = meanGap > 0 ? stdGap / meanGap : 0;
    if (cv < 0.3 && meanGap > 0) {
      hints.push({
        type: "behavior_pattern",
        message: `Rhythmic pattern: acting at very regular intervals (roughly every ${humanDuration(Math.round(meanGap))}).`,
      });
    }
  }

  // 8c. 跨联系人重复检测 — 同一 intent 对 3+ 不同目标
  // 参考: Goffman (1959) "表演的自我" — 对不同人用相同策略 = "公式化"
  const intentTargets: Record<string, Set<string>> = {};
  for (const a of last10) {
    if (a.intent && a.target) {
      if (!intentTargets[a.intent]) intentTargets[a.intent] = new Set();
      intentTargets[a.intent].add(a.target);
    }
  }
  for (const [intent, targets] of Object.entries(intentTargets)) {
    if (targets.size >= 3) {
      hints.push({
        type: "behavior_pattern",
        message: `Same approach ("${intent}") used with ${targets.size} different contacts recently.`,
      });
    }
  }

  return hints;
}

/**
 * 9. 守夜人简报（场景 1 增强）— 结构化分频道摘要。
 *
 * 当 Alice 长时间不活跃后恢复时，生成按频道分组的简报：
 * - 按紧急度排序：directed (私聊/回复) > mention (群聊@) > background
 * - 每频道标注消息数、directed/mention 数量
 * - 从 message_log 获取详细信息，图属性兜底
 *
 * @see docs/adr/53-audit-gap-closure.md
 */
export function generateOvernightBriefingHints(ctx: ModContext<StrategyState>): StrategyHint[] {
  const allActions = ctx.state.recentActions;
  const lastAction = allActions.length > 0 ? allActions[allActions.length - 1] : null;
  // ADR-110: 使用 ms 计算静默时间
  const lastActionMs = lastAction?.ms ?? 0;
  const lastActionTick = lastAction?.tick ?? 0;
  const inactiveDurationS = estimateAgeS(
    { ms: lastActionMs, tick: lastActionTick },
    ctx.nowMs,
    ctx.tick,
  );

  // Alice 静默超过 3600 秒（1 小时）且有行动记录
  if (inactiveDurationS <= 3600 || lastActionTick === 0) return [];

  // 尝试从 message_log 获取详细分频道统计
  interface ChannelSummary {
    chatId: string;
    displayName: string;
    total: number;
    directed: number;
    chatType: string;
  }

  const channelSummaries: ChannelSummary[] = [];
  let usedDb = false;

  try {
    const db = getDb();
    // ADR-110: 使用 createdAt 替代 tick 窗口查询
    const cutoffMs = lastActionMs > 0 ? lastActionMs : ctx.nowMs - inactiveDurationS * 1000;
    const rows = db
      .select({
        chatId: messageLog.chatId,
        total: sql<number>`count(*)`,
        directed: sql<number>`sum(case when ${messageLog.isDirected} = 1 then 1 else 0 end)`,
      })
      .from(messageLog)
      .where(
        sql`${messageLog.createdAt} > ${Math.floor(cutoffMs / 1000)} AND ${messageLog.isOutgoing} = 0`,
      )
      .groupBy(messageLog.chatId)
      .all();

    for (const row of rows) {
      if (row.total === 0) continue;
      const chatId = row.chatId;
      const displayName = safeDisplayName(ctx.graph, chatId);
      const chatType = ctx.graph.has(chatId)
        ? String(ctx.graph.getDynamic(chatId, "chat_type") ?? "unknown")
        : "unknown";
      channelSummaries.push({
        chatId,
        displayName,
        total: row.total,
        directed: row.directed ?? 0,
        chatType,
      });
    }
    // 只有 DB 实际返回了数据才算成功，否则 fallback 到图属性
    usedDb = channelSummaries.length > 0;
  } catch {
    // DB 不可用，回退到图属性
  }

  // 回退：从图属性获取基础统计
  if (!usedDb) {
    for (const channelId of ctx.graph.getEntitiesByType("channel")) {
      const attrs = ctx.graph.getChannel(channelId);
      const unread = attrs.unread ?? 0;
      // ADR-124: 使用 effectiveObligation 替代 pending_directed
      // @see docs/adr/126-obligation-field-decay.md §D6
      const directed = effectiveObligation(ctx.graph, channelId, ctx.nowMs);
      if (unread > 0) {
        const displayName = safeDisplayName(ctx.graph, channelId);
        const chatType = String(attrs.chat_type ?? "unknown");
        channelSummaries.push({
          chatId: channelId,
          displayName,
          total: unread,
          directed,
          chatType,
        });
      }
    }
  }

  if (channelSummaries.length === 0) return [];

  const totalMessages = channelSummaries.reduce((s, c) => s + c.total, 0);
  const totalDirected = channelSummaries.reduce((s, c) => s + c.directed, 0);
  if (totalMessages <= 5 && totalDirected === 0) return [];

  // 分类：priority（有 directed 消息）vs background
  const priority = channelSummaries.filter((c) => c.directed > 0);
  const background = channelSummaries.filter((c) => c.directed === 0);

  // 排序：priority 按 directed 数量降序；background 按总数降序
  priority.sort((a, b) => b.directed - a.directed);
  background.sort((a, b) => b.total - a.total);

  // 构建结构化简报
  const m = new PromptBuilder();
  m.line(
    `OVERNIGHT BRIEFING (silent for ${humanDuration(inactiveDurationS)}, ${msgCountLabel(totalMessages)} messages accumulated):`,
  );

  if (priority.length > 0) {
    m.heading("Priority");
    m.list(
      priority.map((ch) => {
        // 私聊 → "directed messages"；群聊 → "@mention/reply"；未知 → "directed"
        const label =
          ch.chatType === "private"
            ? "directed messages"
            : ch.chatType === "group" || ch.chatType === "supergroup"
              ? "@mention/reply"
              : "directed";
        return `${ch.displayName}: ${msgCountLabel(ch.directed)} ${label}, ${msgCountLabel(ch.total)} messages total`;
      }),
    );
  }

  if (background.length > 0) {
    m.heading("Background");
    m.list(
      background.slice(0, 10).map((ch) => {
        // 限制 background 最多 10 条，防止 context 膨胀
        return `${ch.displayName}: ${msgCountLabel(ch.total)} messages, no directed`;
      }),
    );
    if (background.length > 10) {
      const overflow = background.slice(10).reduce((s, c) => s + c.total, 0);
      m.line(`... and ${background.length - 10} more chats (${overflow} messages)`);
    }
  }

  if (totalDirected > 0) {
    m.line(`There are ${totalDirected} directed messages and @mentions waiting.`);
  }

  return [
    {
      type: "overnight_briefing",
      message: m.build().join("\n"),
    },
  ];
}

/** 10. 承诺到期提醒（场景 3）— 检查有 horizon 即将到期的 thread。 */
export function generateCommitmentHints(ctx: ModContext<StrategyState>): StrategyHint[] {
  const hints: StrategyHint[] = [];
  try {
    const db = getDb();
    const urgentThreads = db
      .select({
        id: narrativeThreads.id,
        title: narrativeThreads.title,
        horizon: narrativeThreads.horizon,
        createdTick: narrativeThreads.createdTick,
        createdAt: narrativeThreads.createdAt,
      })
      .from(narrativeThreads)
      .where(eq(narrativeThreads.status, "open"))
      .all();

    for (const t of urgentThreads) {
      if (!t.horizon) continue;
      // horizon 单位为 tick，1 tick ≈ 60s
      const horizonS = t.horizon * 60;
      const createdMs = estimateEventMs(
        { createdAt: t.createdAt, tick: t.createdTick },
        ctx.nowMs,
        ctx.tick,
      );
      const deadlineMs = createdMs + horizonS * 1000;
      const remainingS = (deadlineMs - ctx.nowMs) / 1000;
      // 即将到期（剩余 < 20% horizon 或 < 600 秒）
      if (remainingS > 0 && (remainingS < horizonS * 0.2 || remainingS < 600)) {
        hints.push({
          type: "commitment_due",
          message: `Thread #${t.id} "${t.title}" is approaching its deadline (${humanDuration(remainingS)} remaining).`,
        });
      }
    }
  } catch {
    // DB 不可用时跳过
  }
  return hints;
}

/**
 * Bot 工具感知 — 扫描有 is_bot 标记的联系人。
 *
 * ADR-196 F5: 仅包含近 7 天活跃的 bot，最多 3 条。
 * 群聊场景由 ENTITY_SCOPED visibility filter 按实体名自然过滤；
 * 私聊场景通过活跃度 + cap 减少无关 bot 噪音。
 */
export function generateBotToolHints(ctx: ModContext<StrategyState>): StrategyHint[] {
  const RECENCY_MS = 7 * 24 * 3600 * 1000;
  const cutoff = ctx.nowMs - RECENCY_MS;
  const hints: StrategyHint[] = [];
  for (const contactId of ctx.graph.getEntitiesByType("contact")) {
    const attrs = ctx.graph.getContact(contactId);
    if (attrs.is_bot !== true) continue;
    if ((attrs.last_active_ms ?? 0) < cutoff) continue;
    const displayName = safeDisplayName(ctx.graph, contactId);
    hints.push({
      type: "opportunity",
      message: `${displayName} is a bot — you can use it as a tool (send commands, read responses).`,
    });
    if (hints.length >= 3) break;
  }
  return hints;
}
