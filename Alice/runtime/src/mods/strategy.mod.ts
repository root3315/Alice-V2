/**
 * Strategy Mod — 行为策略层（M4）。
 *
 * 纯被动观察 + 贡献，不产生副作用：
 * - listen DECLARE_ACTION / SEND_MESSAGE → 收集行为数据
 * - onTickEnd → 扫描图状态，生成策略提示
 * - contribute → 注入 strategy-hints + self-awareness section
 *
 * 设计哲学（叙事引擎 126 号提案）：
 * - 反应提示而非执行 — 系统提供信号，LLM 决定行为
 * - 结构即反馈 — 图的缺陷放进 Prefill，LLM 自然趋向填补
 *
 * 参考: narrative-engine/mods/npc.mod.ts (三支柱 NPC 自主性)
 * 参考: narrative-engine/docs/rpg/94-npc-agency-primitive-design.md
 */
import { desc, gt, sql } from "drizzle-orm";
import { z } from "zod";
import { createMod } from "../core/mod-builder.js";
import { PromptBuilder } from "../core/prompt-style.js";
import type { ContributionItem } from "../core/types.js";
import { readModState, section } from "../core/types.js";
import { getDb } from "../db/connection.js";
import { actionLog } from "../db/schema.js";
import { ensureChannelId, ensureContactId } from "../graph/constants.js";
import { safeDisplayName } from "../graph/display.js";
import {
  generateAttentionHints,
  generateBehaviorPatternHints,
  generateBotToolHints,
  generateCommitmentHints,
  generateCrisisHints,
  generateGroupAtmosphereHints,
  generateOpportunityHints,
  generateOvernightBriefingHints,
  generatePendingConversationHints,
  generateRelationshipHints,
  generateStaleThreadHints,
  syncParticipationToGraph,
  updateIncomingGroupState,
} from "./strategy/hint-generators.js";
import { auditPersonalityDrift } from "./strategy/personality-drift.js";
import {
  emptyGroupState,
  extractKeywords,
  MAX_RECENT_ACTIONS,
  MAX_RECENT_SPEAKERS,
  MAX_TOPIC_KEYWORDS,
  type StrategyHint,
  type StrategyState,
} from "./strategy/types.js";

// -- Mod 定义 -----------------------------------------------------------------

export const strategyMod = createMod<StrategyState>("strategy", {
  category: "mechanic",
  description:
    "Слой поведенческих стратегий — поддержание отношений, баланс внимания, окна возможностей, детекция кризисов, атмосфера групповых чатов, паттерны поведения, ночные сводки, отслеживание обещаний",
  depends: ["observer", "threads"],
  initialState: {
    recentActions: [],
    activeHints: [],
    messageFrequency: {},
    crisisChannels: {},
    crisisChannelsMs: {},
    groupStates: {},
    personalityDrift: {
      lastAuditTick: 0,
      lastAuditMs: 0,
      previousWeights: null,
      drift: 0,
      velocity: 0,
      health: "healthy",
    },
  },
})
  /**
   * 监听 DECLARE_ACTION → 记录行动到 recentActions。
   * 注：联系人最后交互时间由 observer.mod 写到图属性 last_alice_action_ms，
   * 不在 strategy state 中冗余存储。
   */
  .listen("DECLARE_ACTION", (ctx, args) => {
    const target = args.target ? String(args.target) : null;
    ctx.state.recentActions.push({
      target,
      tick: ctx.tick,
      ms: ctx.nowMs,
      intent: args.intent ? String(args.intent) : "",
    });
    // 环形缓冲
    if (ctx.state.recentActions.length > MAX_RECENT_ACTIONS) {
      ctx.state.recentActions.shift();
    }
  })
  /**
   * 监听 SEND_MESSAGE → 更新发消息目标的最后交互 + M2 群聊状态。
   */
  .listen("SEND_MESSAGE", (ctx, args) => {
    const chatId = args.chatId ? String(args.chatId) : null;

    // M2: 群聊消息追踪
    if (chatId) {
      const channelId = ensureChannelId(chatId) ?? chatId;
      if (!ctx.state.groupStates[channelId]) {
        ctx.state.groupStates[channelId] = emptyGroupState();
      }
      const gs = ctx.state.groupStates[channelId];
      const senderName = args.senderName ? String(args.senderName) : null;
      const isAlice = args.isOutgoing === true || args.isOutgoing === "true";

      // 更新发言者列表
      if (senderName) {
        gs.recentSpeakers = gs.recentSpeakers.filter((s) => s !== senderName);
        gs.recentSpeakers.push(senderName);
        if (gs.recentSpeakers.length > MAX_RECENT_SPEAKERS) {
          gs.recentSpeakers.shift();
        }
      }

      // 更新话题关键词
      const text = args.text ? String(args.text) : "";
      if (text) {
        const newKeywords = extractKeywords(text);
        if (newKeywords.length > 0) {
          gs.topicKeywords.push(...newKeywords);
          if (gs.topicKeywords.length > MAX_TOPIC_KEYWORDS) {
            gs.topicKeywords = gs.topicKeywords.slice(-MAX_TOPIC_KEYWORDS);
          }
        }
      }

      // 更新参与率
      gs.totalMessages++;
      if (isAlice) gs.aliceMessages++;
      gs.participationRatio = gs.totalMessages > 0 ? gs.aliceMessages / gs.totalMessages : 0;
    }
  })
  .onTickEnd((ctx) => {
    // groupStates / messageFrequency 为无界 Record<string, ...>。
    // 增长上限 = Alice 社交圈内的独立频道数（Dunbar 数量级），KB 级，无需裁剪。

    // B2 修复: 从 message_log 更新入站消息的群聊状态
    updateIncomingGroupState(ctx);
    // G7: 暴露 participationRatio 到图属性
    syncParticipationToGraph(ctx);

    // 聚合所有 hint 生成器
    const hints: StrategyHint[] = [
      ...generateRelationshipHints(ctx),
      ...generateAttentionHints(ctx),
      ...generateOpportunityHints(ctx),
      ...generateStaleThreadHints(ctx),
      ...generatePendingConversationHints(ctx),
      ...generateCrisisHints(ctx),
      ...generateGroupAtmosphereHints(ctx),
      ...generateBehaviorPatternHints(ctx),
      ...generateOvernightBriefingHints(ctx),
      ...generateCommitmentHints(ctx),
      ...generateBotToolHints(ctx),
    ];

    // M4: 人格漂移审计
    const driftHint = auditPersonalityDrift(ctx);
    if (driftHint) hints.push(driftHint);

    ctx.state.activeHints = hints;
  })
  /**
   * ADR-47 G1: 返回当前活跃的危机频道列表。
   * 供 evolve.ts 危机门控使用。
   * @see docs/adr/47-gap-closure.md §G1
   */
  .query("crisis_channels", {
    params: z.object({}),
    description: "Возвращает список текущих активных кризисных каналов",
    returns: "string[]",
    impl(ctx) {
      return Object.keys(ctx.state.crisisChannels ?? {});
    },
  })
  .contribute((ctx): ContributionItem[] => {
    const items: ContributionItem[] = [];

    // ADR-47 G8: 承诺上下文关联触发 — 当前 actionTarget 有关联 thread 时注入 hint
    // 使用局部数组，不 mutate state（contribute 应为 read-only）
    const allHints = [...ctx.state.activeHints];
    const relState = readModState(ctx, "relationships");
    const actionTarget = relState?.targetNodeId ?? null;
    if (actionTarget) {
      // 从 actionTarget 推断关联的 contact ID（channel:XXX → contact:XXX）
      const targetIds: string[] = [actionTarget];
      const chId = ensureChannelId(actionTarget);
      const ctId = ensureContactId(actionTarget);
      if (chId && chId !== actionTarget) targetIds.push(chId);
      if (ctId && ctId !== actionTarget) targetIds.push(ctId);

      for (const threadId of ctx.graph.getEntitiesByType("thread")) {
        const tAttrs = ctx.graph.getThread(threadId);
        if (tAttrs.status === "resolved") continue;

        const involves = ctx.graph.getNeighbors(threadId, "involves");
        const involvesTarget = involves.some((n) => targetIds.includes(n));
        if (!involvesTarget) continue;

        const title = String(tAttrs.title ?? threadId);
        allHints.push({
          type: "contextual_commitment",
          message: `You have an active commitment related to this chat: "${title}". Consider naturally mentioning it.`,
        });
      }
    }

    // 策略提示 — 紧跟 pressure section 之后
    if (allHints.length > 0) {
      const mHints = new PromptBuilder();
      // 按类型分组，每类型最多 3 条（防止 context 膨胀）
      const byType: Record<string, StrategyHint[]> = {};
      for (const h of allHints) {
        if (!byType[h.type]) byType[h.type] = [];
        byType[h.type].push(h);
      }
      for (const [type, hints] of Object.entries(byType)) {
        if (type === "overnight_briefing") {
          // ADR-196 F10: overnight briefing 保留多行结构（list() 会压平 \n）
          for (const h of hints.slice(0, 1)) {
            for (const line of h.message.split("\n")) {
              mHints.line(line);
            }
          }
        } else {
          mHints.list(hints.slice(0, 3).map((h) => h.message));
        }
      }
      const hintLines = mHints.build();
      if (hintLines.length > 0) {
        items.push(section("strategy-hints", hintLines, "Strategic awareness", 12, 88));
      }
    }

    // ADR-72 W2: buildCapabilitySection 已移除——Capability Hints 统一到 declaration.ts。
    // @see docs/adr/72-tool-surface-phase2-intent-grouping.md §W2

    // 自我觉察 — 最近行动模式摘要
    if (ctx.state.recentActions.length >= 3) {
      const mSelf = new PromptBuilder();

      // 从 action_log 查询最近行动的声部分布
      try {
        const db = getDb();
        // ADR-110: 使用 createdAt 替代 tick 窗口查询（50 分钟 = 3_000_000 ms）
        const voiceDistribution = db
          .select({
            voice: actionLog.voice,
            count: sql<number>`count(*)`,
          })
          .from(actionLog)
          .where(gt(actionLog.createdAt, new Date(ctx.nowMs - 3_000_000)))
          .groupBy(actionLog.voice)
          .orderBy(desc(sql`count(*)`))
          .all();

        if (voiceDistribution.length > 0) {
          // EST: 语义标签替代原始计数——LLM 消费离散类别
          const dominant = voiceDistribution[0];
          const secondary = voiceDistribution[1];
          const voiceToFeeling: Record<string, string> = {
            diligence: "focused",
            curiosity: "curious",
            sociability: "social",
            caution: "cautious",
          };
          const domLabel = voiceToFeeling[dominant.voice] ?? dominant.voice;
          let pattern = `Lately, feeling mostly ${domLabel}`;
          if (secondary && secondary.count > dominant.count * 0.4) {
            const secLabel = voiceToFeeling[secondary.voice] ?? secondary.voice;
            pattern += `, sometimes ${secLabel}`;
          }
          mSelf.line(`${pattern}.`);
        }

        // ADR-109: 表达模态分布 — 行为自我模型第三维
        // @see docs/adr/109-expressive-palette/README.md
        // ADR-110: 使用 createdAt 替代 tick 窗口查询
        const modalityRows = db
          .select({
            actionType: actionLog.actionType,
            count: sql<number>`count(*)`,
          })
          .from(actionLog)
          .where(
            sql`${actionLog.createdAt} > ${Math.floor((ctx.nowMs - 3_000_000) / 1000)} AND ${actionLog.actionType} IN ('send_message','react','send_sticker','send_voice','send_media','forward_message','send_inline_result','send_poll')`,
          )
          .groupBy(actionLog.actionType)
          .all();

        const MODALITY: Record<string, string> = {
          send_message: "text",
          react: "reaction",
          send_sticker: "sticker",
          send_voice: "voice",
          send_media: "media",
          forward_message: "media",
          send_inline_result: "media",
          send_poll: "media",
        };
        const byModality: Record<string, number> = {};
        let modalityTotal = 0;
        for (const row of modalityRows) {
          const mod = MODALITY[row.actionType] ?? "other";
          byModality[mod] = (byModality[mod] ?? 0) + row.count;
          modalityTotal += row.count;
        }
        if (modalityTotal >= 8) {
          const rich =
            (byModality.sticker ?? 0) + (byModality.voice ?? 0) + (byModality.media ?? 0);
          // ADR-210: 降低门槛——不仅"完全没发过"才提醒，占比 < 10% 也提醒
          if (rich === 0) {
            mSelf.line("All text lately — no stickers or anything fun in a while.");
          } else if (modalityTotal >= 10 && rich / modalityTotal < 0.1) {
            mSelf.line("Mostly text lately — a sticker might say it better sometimes.");
          }
        }
      } catch {
        // DB 不可用时跳过
      }

      // 目标分散度 — 语义标签替代原始计数
      const targets = new Set(ctx.state.recentActions.map((a) => a.target).filter(Boolean));
      const targetDesc =
        targets.size <= 1
          ? "Attention focused on one person."
          : targets.size <= 3
            ? "Attention split between a few contacts."
            : "Attention spread across many people.";
      mSelf.line(targetDesc);

      const selfLines = mSelf.build();
      if (selfLines.length > 0) {
        items.push(section("self-awareness", selfLines, "Self-reflection", 38, 50));
      }
    }

    // M4: 人格漂移 — 审计结果仅内部监控，不注入 LLM 可见 prompt

    // M2: 频道动态注入
    // 有参与度的频道：独立 section（含 Active speakers + topic 等详情）
    // 零参与度（mostly listening）：折叠为单个汇总 section（节省 token）
    const listeningChannels: string[] = [];

    for (const [channelId, gs] of Object.entries(ctx.state.groupStates)) {
      if (gs.totalMessages < 3) continue; // 跳过低活跃

      // 零参与度 → 收集后统一折叠
      if (gs.participationRatio === 0) {
        if (!ctx.graph.has(channelId) || ctx.graph.getNodeType(channelId) !== "channel") continue;
        const chatType = ctx.graph.getChannel(channelId).chat_type;
        const channelName = safeDisplayName(ctx.graph, channelId);
        // 私聊附带对方名字，群聊显示群名
        const speakerHint =
          chatType === "private" && gs.recentSpeakers.length > 0
            ? gs.recentSpeakers[0]
            : channelName;
        listeningChannels.push(`${speakerHint} (${chatType})`);
        continue;
      }

      // 有参与度 → 独立 section
      const mGroup = new PromptBuilder();
      if (gs.recentSpeakers.length > 0) {
        mGroup.kv("Active speakers", gs.recentSpeakers.slice(-5).join(", "));
      }
      const partLabel =
        gs.participationRatio > 0.5
          ? "You've been quite active in this group."
          : gs.participationRatio > 0.2
            ? "You've been somewhat active."
            : "You haven't said much here.";
      mGroup.line(partLabel);
      // ADR-83 D7: 使用图中 LLM 生成的 topic 替代 raw TF keywords（宁缺毋滥）
      if (ctx.graph.has(channelId) && ctx.graph.getNodeType(channelId) === "channel") {
        const chAttrs = ctx.graph.getChannel(channelId);
        const topic = chAttrs.topic;
        if (topic) mGroup.kv("Current topic", topic);
      }
      if (!ctx.graph.has(channelId) || ctx.graph.getNodeType(channelId) !== "channel") continue;
      const chatType = ctx.graph.getChannel(channelId).chat_type;
      const channelName = safeDisplayName(ctx.graph, channelId);
      items.push(
        section(
          `group-dynamics-${channelId}`,
          mGroup.build(),
          `${channelName} (${chatType}):`,
          30,
          55,
        ),
      );
    }

    // 零参与度频道汇总（一行代替 N 个独立 section）
    if (listeningChannels.length > 0) {
      const summary = new PromptBuilder();
      summary.line(listeningChannels.slice(0, 10).join(", "));
      if (listeningChannels.length > 10) {
        summary.line(`... and ${listeningChannels.length - 10} more`);
      }
      items.push(
        section(
          "group-dynamics-listening",
          summary.build(),
          `Also listening in (${listeningChannels.length} chats):`,
          20,
          40,
        ),
      );
    }

    return items;
  })
  .build();
