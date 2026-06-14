/**
 * Strategy Mod — слой поведенческих стратегий (M4).
 *
 * Чисто пассивное наблюдение + вклад, без побочных эффектов:
 * - listen DECLARE_ACTION / SEND_MESSAGE → сбор поведенческих данных
 * - onTickEnd → сканирование состояния графа, генерация стратегических подсказок
 * - contribute → инжекция strategy-hints + секции self-awareness
 *
 * Философия дизайна (нарративный движок, предложение №126):
 * - Реактивные подсказки, не исполнение — система предоставляет сигналы, LLM принимает решения
 * - Структура как обратная связь — дефекты графа помещаются в Prefill, LLM естественно стремится их заполнить
 *
 * Ссылка: narrative-engine/mods/npc.mod.ts (три столпа автономии NPC)
 * Ссылка: narrative-engine/docs/rpg/94-npc-agency-primitive-design.md
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

// -- Определение Mod -----------------------------------------------------------------

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
   * Слушает DECLARE_ACTION → записывает действие в recentActions.
   * Примечание: время последнего взаимодействия с контактом записывается в graph-атрибут last_alice_action_ms через observer.mod,
   * избыточное хранение в strategy state не ведётся.
   */
  .listen("DECLARE_ACTION", (ctx, args) => {
    const target = args.target ? String(args.target) : null;
    ctx.state.recentActions.push({
      target,
      tick: ctx.tick,
      ms: ctx.nowMs,
      intent: args.intent ? String(args.intent) : "",
    });
    // Кольцевой буфер
    if (ctx.state.recentActions.length > MAX_RECENT_ACTIONS) {
      ctx.state.recentActions.shift();
    }
  })
  /**
   * Слушает SEND_MESSAGE → обновляет последнее взаимодействие с получателем + M2 состояние группового чата.
   */
  .listen("SEND_MESSAGE", (ctx, args) => {
    const chatId = args.chatId ? String(args.chatId) : null;

    // M2: отслеживание сообщений группового чата
    if (chatId) {
      const channelId = ensureChannelId(chatId) ?? chatId;
      if (!ctx.state.groupStates[channelId]) {
        ctx.state.groupStates[channelId] = emptyGroupState();
      }
      const gs = ctx.state.groupStates[channelId];
      const senderName = args.senderName ? String(args.senderName) : null;
      const isAlice = args.isOutgoing === true || args.isOutgoing === "true";

      // Обновление списка говорящих
      if (senderName) {
        gs.recentSpeakers = gs.recentSpeakers.filter((s) => s !== senderName);
        gs.recentSpeakers.push(senderName);
        if (gs.recentSpeakers.length > MAX_RECENT_SPEAKERS) {
          gs.recentSpeakers.shift();
        }
      }

      // Обновление ключевых слов темы
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

      // Обновление доли участия
      gs.totalMessages++;
      if (isAlice) gs.aliceMessages++;
      gs.participationRatio = gs.totalMessages > 0 ? gs.aliceMessages / gs.totalMessages : 0;
    }
  })
  .onTickEnd((ctx) => {
    // groupStates / messageFrequency — неограниченные Record<string, ...>.
    // Верхний предел роста = число уникальных каналов в социальном круге Alice (порядок Данбара), уровень КБ, обрезка не нужна.

    // B2 fix: обновление состояния группового чата из message_log для входящих сообщений
    updateIncomingGroupState(ctx);
    // G7: экспорт participationRatio в graph-атрибут
    syncParticipationToGraph(ctx);

    // Агрегация всех генераторов подсказок
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

    // M4: аудит дрейфа личности
    const driftHint = auditPersonalityDrift(ctx);
    if (driftHint) hints.push(driftHint);

    ctx.state.activeHints = hints;
  })
  /**
   * ADR-47 G1: возвращает список текущих активных кризисных каналов.
   * Используется в evolve.ts для кризисного гейтинга.
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

    // ADR-47 G8: триггер контекстной привязки обязательств — инжектировать hint, если у текущего actionTarget есть связанный thread.
    // Используется локальный массив, state не мутируется (contribute должен быть read-only).
    const allHints = [...ctx.state.activeHints];
    const relState = readModState(ctx, "relationships");
    const actionTarget = relState?.targetNodeId ?? null;
    if (actionTarget) {
      // Вывод связанного contact ID из actionTarget (channel:XXX → contact:XXX)
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

    // Стратегические подсказки — сразу после секции давления
    if (allHints.length > 0) {
      const mHints = new PromptBuilder();
      // Группировка по типу, не более 3 на тип (предотвращение разбухания контекста)
      const byType: Record<string, StrategyHint[]> = {};
      for (const h of allHints) {
        if (!byType[h.type]) byType[h.type] = [];
        byType[h.type].push(h);
      }
      for (const [type, hints] of Object.entries(byType)) {
        if (type === "overnight_briefing") {
          // ADR-196 F10: overnight briefing сохраняет многострочную структуру (list() сплющивает \n)
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

    // ADR-72 W2: buildCapabilitySection удалён — Capability Hints унифицированы в declaration.ts.
    // @see docs/adr/72-tool-surface-phase2-intent-grouping.md §W2

    // Самоосознание — сводка по паттернам недавних действий
    if (ctx.state.recentActions.length >= 3) {
      const mSelf = new PromptBuilder();

      // Запрос распределения голосов по недавним действиям из action_log
      try {
        const db = getDb();
        // ADR-110: используем createdAt вместо запроса по tick-окну (50 минут = 3_000_000 ms)
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
          // EST: семантические метки вместо сырых счётчиков — LLM потребляет дискретные категории
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

        // ADR-109: распределение экспрессивных модальностей — третье измерение поведенческой самомодели
        // @see docs/adr/109-expressive-palette/README.md
        // ADR-110: используем createdAt вместо запроса по tick-окну
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
          // ADR-210: снижение порога — напоминать не только при полном отсутствии, но и при доле < 10%
          if (rich === 0) {
            mSelf.line("All text lately — no stickers or anything fun in a while.");
          } else if (modalityTotal >= 10 && rich / modalityTotal < 0.1) {
            mSelf.line("Mostly text lately — a sticker might say it better sometimes.");
          }
        }
      } catch {
        // Пропускаем, если БД недоступна
      }

      // Рассредоточенность целей — семантические метки вместо сырых счётчиков
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

    // M4: дрейф личности — результаты аудита только для внутреннего мониторинга, не инжектируются в LLM-видимый prompt

    // M2: инжекция динамики каналов
    // Каналы с участием: отдельная section (с деталями Active speakers + topic и др.)
    // Нулевое участие (mostly listening): свёртывается в единую сводную section (экономия токенов)
    const listeningChannels: string[] = [];

    for (const [channelId, gs] of Object.entries(ctx.state.groupStates)) {
      if (gs.totalMessages < 3) continue; // Пропускаем малоактивные

      // Нулевое участие → собрать и свернуть вместе
      if (gs.participationRatio === 0) {
        if (!ctx.graph.has(channelId) || ctx.graph.getNodeType(channelId) !== "channel") continue;
        const chatType = ctx.graph.getChannel(channelId).chat_type;
        const channelName = safeDisplayName(ctx.graph, channelId);
        // Личный чат — имя собеседника, групповой — название группы
        const speakerHint =
          chatType === "private" && gs.recentSpeakers.length > 0
            ? gs.recentSpeakers[0]
            : channelName;
        listeningChannels.push(`${speakerHint} (${chatType})`);
        continue;
      }

      // С участием → отдельная section
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
      // ADR-83 D7: использовать сгенерированную LLM topic из графа вместо сырых TF-ключевых слов (лучше ничего, чем мусор)
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

    // Сводка каналов с нулевым участием (одна строка вместо N отдельных section)
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
