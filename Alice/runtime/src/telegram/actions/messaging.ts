/**
 * Действия категории messaging: send_message, mark_read, edit_message, forward_message, publish_channel, send_dm.
 *
 * @see docs/adr/149-define-action-builder.md
 */

import { tl } from "@mtcute/node";
import { z } from "zod";
import { sanitizeOutgoingText } from "../../core/sandbox-schemas.js";
import {
  ensureChannelId,
  ensureContactId,
  extractNumericId,
  telegramChannelId,
  telegramContactId,
} from "../../graph/constants.js";
import { recordForwardShare } from "../../graph/dynamic-props.js";
import { defineAction } from "../action-builder.js";
import type { TelegramActionDef } from "../action-types.js";
import {
  editMessage,
  forwardMessage,
  markRead,
  sendChecklist,
  sendTable,
  sendText,
  setTyping,
} from "../actions.js";
import { cacheOutgoingMsg } from "../events.js";
import { getExplorationGuard } from "./shared.js";

export const messagingActions: TelegramActionDef[] = [
  defineAction({
    name: "send_message",
    category: "messaging",
    description: ["Send a text message to a chat."],
    usageHint:
      "For shell-native chat flows prefer `irc say --text ...` in the script path. Supports @mentions via mentions parameter.",
    params: z.object({
      chatId: z.number().describe("Target chat"),
      text: z.string().describe("Message text"),
      replyTo: z.number().optional().describe("Message ID to reply to"),
      topicId: z.number().optional().describe("Forum: id топика (по умолчанию — активный топик чата)"),
      mentions: z
        .array(z.object({ offset: z.number(), length: z.number(), userId: z.number() }))
        .optional()
        .describe("Array of {offset, length, userId} for @mention entities"),
    }),
    inject: { chatId: "TARGET_CHAT" },
    affordance: {
      whenToUse: "Send a text message to someone",
      whenNotToUse: "When you want to stay silent or just react",
      priority: "core",
    },
    async impl(ctx, args) {
      // S-1: Очистка утечек аннотаций + лимит сообщений Telegram 4096 символов
      const text = sanitizeOutgoingText(args.text ?? "");
      if (!args.chatId || !text) return false;

      const rawId = ctx.parseChatId(args.chatId);
      const graphId = ctx.ensureGraphId(args.chatId);

      // Проверка окна наблюдения: новые каналы требуют режима молчания/ученика
      if (ctx.G.has(graphId)) {
        const channelAttrs = ctx.G.getChannel(graphId);
        const joinMs = channelAttrs.join_ms ?? 0;
        if (joinMs > 0) {
          const nowMs = Date.now();
          const guard = getExplorationGuard();
          const phase = guard.getObservationPhase(joinMs, nowMs);
          if (phase === "silent") {
            ctx.log.info("send blocked: observation window silent phase", { chatId: graphId });
            return false;
          }
          if (phase === "apprentice") {
            const msgCount = channelAttrs.apprentice_msg_count ?? 0;
            if (msgCount >= guard.config.apprenticeMaxMessages) {
              ctx.log.info("send throttled: apprentice limit", { chatId: graphId, msgCount });
              return false;
            }
            ctx.G.setDynamic(graphId, "apprentice_msg_count", msgCount + 1);
          }
        }
      }

      // Forum #8: маршрутизация топика по приоритету, чтобы исходящий ответ не уходил в
      // ЧУЖОЙ топик в активном форуме (баг: current_topic_id хранит топик ПОСЛЕДНЕГО входящего,
      // т.е. может указывать на топик, на который пользователь только что переключился, а не тот,
      // куда Alice отвечает).
      //
      // Порядок приоритета:
      //   1. args.topicId          — явный топик от вызывающего (наивысший приоритет).
      //   2. args.replyTo          — если это reply, сам Telegram привяжет сообщение к топику
      //      исходного сообщения (см. actions.ts sendText: replyToMsgId имеет приоритет над topicId).
      //      Поэтому при наличии replyTo НЕ подставляем stale current_topic_id — это могло бы
      //      переопределить корректный топик reply на устаревший. Передаём topicId=undefined и
      //      позволяем reply-маршрутизации определить топик.
      //   3. current_topic_id      — только как последнее средство (bare send без явного топика и
      //      без reply): лучший доступный ориентир для активного форум-чата.
      //
      // ОГРАНИЧЕНИЕ (#8): для bare-send (без replyTo) точный топик конкретного сообщения, на которое
      // Alice реагирует, недоступен в памяти — message_log/граф не хранят topic per-msgId, а трекается
      // только current_topic_id (последний входящий). Полное per-message решение требует хранить thread_id
      // на сообщение (миграция схемы + запись в events.ts + lookup здесь) — крупное cross-file изменение,
      // намеренно отложенное. Текущая эвристика устраняет распространённый случай (reply + явный топик).
      const explicitTopicId = args.topicId as number | undefined;
      const replyTo = args.replyTo as number | undefined;
      const topicId =
        explicitTopicId ??
        (replyTo != null
          ? undefined // reply сам определяет топик — не навязываем устаревший current_topic_id
          : ctx.G.has(graphId)
            ? (ctx.G.getChannel(graphId) as { current_topic_id?: number }).current_topic_id
            : undefined);
      const msgId = await sendText(ctx.client, rawId, text, {
        replyToMsgId: replyTo,
        topicId,
        mentions: args.mentions,
      });

      // Активно кэшировать исходящий msg_id (без зависимости от пассивного получения через onNewMessage)
      if (msgId != null) {
        cacheOutgoingMsg(graphId, msgId);
      }

      if (ctx.G.has(graphId)) {
        // @see paper-five-dim/ Axiom 1: Structure as Feedback
        // m2 fix: обрезать по code point, чтобы не разрывать surrogate pair emoji
        ctx.G.setDynamic(graphId, "last_outgoing_text", [...text].slice(0, 150).join(""));
      }

      ctx.dispatcher.dispatch("SEND_MESSAGE", { chatId: graphId, text, msgId });
      ctx.dispatcher.dispatch("DECLARE_ACTION", { target: graphId });

      ctx.log.info("send_message executed", { chatId: args.chatId, textLen: text.length });
      return { success: true, msgId: msgId ?? undefined, obligationsConsumed: 1 };
    },
  }),

  defineAction({
    name: "send_checklist",
    category: "messaging",
    description: [
      "Send a NATIVE Telegram checklist (real tappable checkboxes, not bullet text).",
      "Use when asked to make/send a checklist, to-do list, or шаг-за-шагом план with checkable items.",
    ],
    usageHint:
      "Items are rendered as real Telegram todo checkboxes (mtcute rich-message). One short line per item. Title is optional.",
    params: z.object({
      chatId: z.number().describe("Target chat"),
      items: z.array(z.string()).describe("Checklist items, one short line each"),
      title: z.string().optional().describe("Optional heading shown above the checklist"),
      topicId: z
        .number()
        .optional()
        .describe("Forum: id топика (по умолчанию — активный топик чата)"),
    }),
    inject: { chatId: "TARGET_CHAT" },
    affordance: {
      whenToUse: "When someone asks you to make or send a checklist / to-do list with tickable items",
      whenNotToUse: "For plain prose or a single line — use send_message instead",
      priority: "core",
    },
    async impl(ctx, args) {
      const rawItems = Array.isArray(args.items) ? args.items : [];
      const items = rawItems
        .map((s) => sanitizeOutgoingText(String(s ?? "")))
        .filter((s) => s.trim().length > 0);
      if (!args.chatId || items.length === 0) return false;
      const title = args.title ? sanitizeOutgoingText(String(args.title)) : undefined;

      const rawId = ctx.parseChatId(args.chatId);
      const graphId = ctx.ensureGraphId(args.chatId);

      // Окно наблюдения: новые каналы требуют режима молчания/ученика (как send_message).
      if (ctx.G.has(graphId)) {
        const channelAttrs = ctx.G.getChannel(graphId);
        const joinMs = channelAttrs.join_ms ?? 0;
        if (joinMs > 0) {
          const guard = getExplorationGuard();
          const phase = guard.getObservationPhase(joinMs, Date.now());
          if (phase === "silent") {
            ctx.log.info("send_checklist blocked: observation window silent phase", {
              chatId: graphId,
            });
            return false;
          }
          if (phase === "apprentice") {
            const msgCount = channelAttrs.apprentice_msg_count ?? 0;
            if (msgCount >= guard.config.apprenticeMaxMessages) {
              ctx.log.info("send_checklist throttled: apprentice limit", {
                chatId: graphId,
                msgCount,
              });
              return false;
            }
            ctx.G.setDynamic(graphId, "apprentice_msg_count", msgCount + 1);
          }
        }
      }

      // Forum #8: bare-send маршрутизируется в current_topic_id (см. send_message).
      const explicitTopicId = args.topicId as number | undefined;
      const topicId =
        explicitTopicId ??
        (ctx.G.has(graphId)
          ? (ctx.G.getChannel(graphId) as { current_topic_id?: number }).current_topic_id
          : undefined);

      const msgId = await sendChecklist(ctx.client, rawId, { title, items, topicId });

      if (msgId != null) cacheOutgoingMsg(graphId, msgId);
      if (ctx.G.has(graphId)) {
        const summary = title ?? items[0] ?? "checklist";
        ctx.G.setDynamic(graphId, "last_outgoing_text", [...summary].slice(0, 150).join(""));
      }

      ctx.dispatcher.dispatch("SEND_MESSAGE", {
        chatId: graphId,
        text: title ?? items.join("\n"),
        msgId,
      });
      ctx.dispatcher.dispatch("DECLARE_ACTION", { target: graphId });

      ctx.log.info("send_checklist executed", { chatId: args.chatId, items: items.length });
      return { success: true, msgId: msgId ?? undefined, obligationsConsumed: 1 };
    },
  }),

  defineAction({
    name: "send_table",
    category: "messaging",
    description: [
      "Send a NATIVE Telegram table (real document-grade table with header row, not ASCII art).",
      "Use when asked to make/send a table, compare options in columns, or show structured rows.",
    ],
    usageHint:
      "headers is the column header row; rows is an array of rows, each an array of cell strings (same column order). Title is optional.",
    params: z.object({
      chatId: z.number().describe("Target chat"),
      headers: z.array(z.string()).describe("Column header cells (the header row)"),
      rows: z
        .array(z.array(z.string()))
        .describe("Body rows: each row is an array of cell strings in column order"),
      title: z.string().optional().describe("Optional heading shown above the table"),
      topicId: z
        .number()
        .optional()
        .describe("Forum: id топика (по умолчанию — активный топик чата)"),
    }),
    inject: { chatId: "TARGET_CHAT" },
    affordance: {
      whenToUse: "When someone asks you to make or send a table / comparison / structured grid",
      whenNotToUse: "For free-form text or a checklist — use send_message or send_checklist",
      priority: "core",
    },
    async impl(ctx, args) {
      const rawHeaders = Array.isArray(args.headers) ? args.headers : [];
      const headers = rawHeaders.map((h) => sanitizeOutgoingText(String(h ?? "")));
      const rawRows = Array.isArray(args.rows) ? args.rows : [];
      const rows = rawRows.map((r) =>
        (Array.isArray(r) ? r : []).map((c) => sanitizeOutgoingText(String(c ?? ""))),
      );
      if (!args.chatId || (headers.length === 0 && rows.length === 0)) return false;
      const title = args.title ? sanitizeOutgoingText(String(args.title)) : undefined;

      const rawId = ctx.parseChatId(args.chatId);
      const graphId = ctx.ensureGraphId(args.chatId);

      // Окно наблюдения: новые каналы требуют режима молчания/ученика (как send_message).
      if (ctx.G.has(graphId)) {
        const channelAttrs = ctx.G.getChannel(graphId);
        const joinMs = channelAttrs.join_ms ?? 0;
        if (joinMs > 0) {
          const guard = getExplorationGuard();
          const phase = guard.getObservationPhase(joinMs, Date.now());
          if (phase === "silent") {
            ctx.log.info("send_table blocked: observation window silent phase", {
              chatId: graphId,
            });
            return false;
          }
          if (phase === "apprentice") {
            const msgCount = channelAttrs.apprentice_msg_count ?? 0;
            if (msgCount >= guard.config.apprenticeMaxMessages) {
              ctx.log.info("send_table throttled: apprentice limit", { chatId: graphId, msgCount });
              return false;
            }
            ctx.G.setDynamic(graphId, "apprentice_msg_count", msgCount + 1);
          }
        }
      }

      // Forum #8: bare-send маршрутизируется в current_topic_id (см. send_message).
      const explicitTopicId = args.topicId as number | undefined;
      const topicId =
        explicitTopicId ??
        (ctx.G.has(graphId)
          ? (ctx.G.getChannel(graphId) as { current_topic_id?: number }).current_topic_id
          : undefined);

      const msgId = await sendTable(ctx.client, rawId, { title, headers, rows, topicId });

      if (msgId != null) cacheOutgoingMsg(graphId, msgId);
      if (ctx.G.has(graphId)) {
        const summary = title ?? (headers.join(" | ") || "table");
        ctx.G.setDynamic(graphId, "last_outgoing_text", [...summary].slice(0, 150).join(""));
      }

      ctx.dispatcher.dispatch("SEND_MESSAGE", {
        chatId: graphId,
        text: title ?? headers.join(" | "),
        msgId,
      });
      ctx.dispatcher.dispatch("DECLARE_ACTION", { target: graphId });

      ctx.log.info("send_table executed", {
        chatId: args.chatId,
        cols: headers.length,
        rows: rows.length,
      });
      return { success: true, msgId: msgId ?? undefined, obligationsConsumed: 1 };
    },
  }),

  defineAction({
    name: "mark_read",
    category: "messaging",
    description: ["Mark a chat as read without responding."],
    // chatId намеренно остаётся видимым для LLM (без inject) — сценарии системных потоков требуют отметки прочитанного в разных чатах.
    params: z.object({
      chatId: z.number().describe("Chat ID"),
    }),
    affordance: {
      whenToUse: "Acknowledge a chat without responding",
      whenNotToUse: "When you intend to reply — sending a message implicitly marks as read",
      priority: "core",
    },
    async impl(ctx, args) {
      if (!args.chatId) return false;

      const rawId = ctx.parseChatId(args.chatId);
      const graphId = ctx.ensureGraphId(args.chatId);
      await markRead(ctx.client, rawId);

      if (ctx.G.has(graphId)) {
        ctx.G.setDynamic(graphId, "unread", 0);
        // @see paper-five-dim/ §4.2: directed obligation decrement semantics
        ctx.G.setDynamic(graphId, "mentions_alice", false);
        // ADR-158 Fix 6: согласованность с System 1 mark_read (evolve.ts:1069) —
        // записывать временную метку очистки, чтобы демпфирование diligence в focus.ts корректно подавляло только что очищенные сущности.
        // @see docs/adr/158-outbound-feedback-gap.md
        ctx.G.setDynamic(graphId, "recently_cleared_ms", Date.now());
      }

      ctx.log.info("mark_read executed", { chatId: args.chatId });
      return true;
    },
  }),

  defineAction({
    name: "edit_message",
    category: "messaging",
    description: ["Edit a previously sent message. Only works on your own messages."],
    params: z.object({
      chatId: z.number().describe("Target chat"),
      msgId: z.number().describe("Message ID to edit"),
      text: z.string().describe("New message text"),
    }),
    inject: { chatId: "TARGET_CHAT" },
    affordance: {
      whenToUse: "Fix a typo or update your own previously sent message",
      whenNotToUse: "When rewriting would confuse the conversation context",
      priority: "core",
    },
    async impl(ctx, args) {
      if (!args.chatId || !args.msgId || !args.text) return false;

      const rawId = ctx.parseChatId(args.chatId);
      await editMessage(ctx.client, rawId, args.msgId, sanitizeOutgoingText(args.text));

      const graphId = ctx.ensureGraphId(args.chatId);
      ctx.dispatcher.dispatch("DECLARE_ACTION", { target: graphId });

      ctx.log.info("edit_message executed", { chatId: args.chatId, msgId: args.msgId });
      return true;
    },
  }),

  defineAction({
    name: "forward_message",
    category: "messaging",
    description: ["Forward a message from another chat into this conversation."],
    params: z.object({
      fromChatId: z.number().describe("Source chat ID"),
      msgId: z.number().describe("Message ID to forward"),
      toChatId: z.number().describe("Destination chat"),
    }),
    inject: { toChatId: "TARGET_CHAT" },
    affordance: {
      whenToUse: "Share a message from one chat into another",
      whenNotToUse: "When quoting or paraphrasing would be more appropriate",
      priority: "core",
    },
    async impl(ctx, args) {
      if (!args.fromChatId || !args.msgId || !args.toChatId) return false;

      const rawFromId = ctx.parseChatId(args.fromChatId);
      const rawToId = ctx.parseChatId(args.toChatId);
      const toGraphId = ctx.ensureGraphId(args.toChatId);

      let fwdMsgId: number | null | undefined;
      try {
        fwdMsgId = await forwardMessage(ctx.client, rawFromId, args.msgId, rawToId);
      } catch (err) {
        // ADR-156: Обнаружение блокировки — пометить граф при блокировке/ограничении приватности для последующей глобальной фильтрации
        if (
          tl.RpcError.is(err, "USER_PRIVACY_RESTRICTED") ||
          tl.RpcError.is(err, "PEER_ID_BLOCKED") ||
          tl.RpcError.is(err, "USER_IS_BLOCKED")
        ) {
          const contactId = ensureContactId(toGraphId);
          if (contactId && ctx.G.has(contactId)) {
            ctx.G.setDynamic(contactId, "blocked_alice", true);
            ctx.log.warn("Contact blocked Alice — marked in graph", { contactId });
          }
        }
        throw err;
      }

      // Активно кэшировать исходящий msg_id — необходимо для определения directed reply
      if (fwdMsgId != null) {
        cacheOutgoingMsg(toGraphId, fwdMsgId);
      }
      ctx.dispatcher.dispatch("DECLARE_ACTION", { target: toGraphId });

      const fromGraphId = ctx.ensureGraphId(args.fromChatId);
      const toName =
        ctx.G.has(toGraphId) && ctx.G.getDynamic(toGraphId, "display_name")
          ? String(ctx.G.getDynamic(toGraphId, "display_name"))
          : String(args.toChatId);
      if (fwdMsgId != null) {
        recordForwardShare(ctx.G, {
          fromGraphId,
          msgId: args.msgId,
          toGraphId,
          targetName: toName,
        });
      }

      ctx.log.info("forward_message executed", {
        fromChatId: args.fromChatId,
        msgId: args.msgId,
        toChatId: args.toChatId,
      });
      return { success: true, obligationsConsumed: 1 };
    },
  }),

  // ── ADR-206 W7: Поведение публикации в канале ────────────────────────────

  defineAction({
    name: "publish_channel",
    category: "messaging",
    description: [
      "Publish a post to a channel where you are admin or owner.",
      "Use this to share your thoughts, curated content, or announcements on your channel.",
    ],
    usageHint:
      "Only works on channels where you have admin/owner role. Has a 2-hour cooldown between posts.",
    params: z.object({
      channelId: z.number().describe("Target channel ID (must be a channel you admin)"),
      text: z.string().describe("Post content"),
    }),
    affordance: {
      whenToUse:
        "Share original content, curated findings, or announcements on a channel you manage",
      whenNotToUse:
        "When you are not admin/owner of the channel, or when you published recently (< 2h)",
      priority: "core",
    },
    async impl(ctx, args) {
      // S-1: Очистка утечек аннотаций + лимит сообщений Telegram 4096 символов
      const text = sanitizeOutgoingText(args.text ?? "");
      if (!args.channelId || !text) return false;

      const graphId = ctx.ensureGraphId(args.channelId);

      // ADR-206 C4 Gate 1: жёсткая проверка alice_role
      // Примечание: окно наблюдения не нужно (в отличие от send_message) —
      // роль admin/owner сама по себе является сильным сигналом доверия, семантики «молчания при новом вступлении» нет.
      if (!ctx.G.has(graphId)) return { success: false, error: "unknown channel" };
      const attrs = ctx.G.getChannel(graphId);
      const role = String(attrs.alice_role ?? "");
      if (role !== "owner" && role !== "admin") {
        ctx.log.warn("publish_channel blocked: not admin/owner", { channelId: graphId, role });
        return { success: false, error: "not admin or owner" };
      }

      // ADR-206 C4 Gate 2: кулдаун публикации 2 часа
      const PUBLISH_COOLDOWN_MS = 2 * 60 * 60_000; // 2h
      const lastPublishMs = Number(attrs.last_publish_ms ?? 0);
      if (lastPublishMs > 0 && Date.now() - lastPublishMs < PUBLISH_COOLDOWN_MS) {
        ctx.log.info("publish_channel throttled: cooldown", { channelId: graphId });
        return { success: false, error: "publish cooldown (2h)" };
      }

      // ADR-206 C4 Gate 3: chat_type должен быть channel
      if (attrs.chat_type !== "channel") {
        return { success: false, error: "not a channel" };
      }

      const rawId = ctx.parseChatId(args.channelId);
      const msgId = await sendText(ctx.client, rawId, text);

      // Обновить состояние графа
      if (msgId != null) {
        cacheOutgoingMsg(graphId, msgId);
      }
      ctx.G.setDynamic(graphId, "last_publish_ms", Date.now());
      ctx.G.setDynamic(graphId, "last_outgoing_text", [...text].slice(0, 150).join(""));

      ctx.dispatcher.dispatch("SEND_MESSAGE", { chatId: graphId, text, msgId });
      ctx.dispatcher.dispatch("DECLARE_ACTION", { target: graphId });

      ctx.log.info("publish_channel executed", { channelId: args.channelId, textLen: text.length });
      // Публикация в канале не расходует directed-обязательства
      return { success: true, msgId: msgId ?? undefined, obligationsConsumed: 0 };
    },
  }),

  defineAction({
    name: "send_dm",
    category: "messaging",
    description: [
      "Send a private message to a contact. Use when you want to DM someone you saw in a group.",
    ],
    usageHint: "Only works for contacts you've talked to before. Use ~senderId from chat log.",
    params: z.object({
      who: z.string().describe("Contact to DM (use ~senderId from chat log)"),
      text: z.string().describe("Message text"),
    }),
    // Без inject — who явно передаётся LLM (по аналогии с mark_read)
    affordance: {
      whenToUse:
        "Privately reach out to someone you saw in a group — follow up, check in, or share something personal",
      whenNotToUse:
        "When you should reply publicly in the group, or when you don't know the person",
      priority: "core",
    },
    async impl(ctx, args) {
      // S-1: Очистка утечек аннотаций + лимит сообщений Telegram 4096 символов
      const text = sanitizeOutgoingText(args.text ?? "");
      if (!text) return false;

      const who = args.who ?? "";
      const telegramNativeId = extractNumericId(who);

      // Guard 2: разрешение contact
      const contactId =
        telegramNativeId != null ? telegramContactId(telegramNativeId) : ensureContactId(who);
      if (!contactId) return { success: false, error: "invalid contact" };

      // Guard 3: наличие в графе
      if (!ctx.G.has(contactId)) return { success: false, error: "unknown contact" };

      // Guard 4: было взаимодействие
      const contactAttrs = ctx.G.getContact(contactId);
      if (contactAttrs.interaction_count <= 0) return { success: false, error: "never interacted" };

      // Guard 5: не незнакомец (tier < 500)
      if (contactAttrs.tier >= 500) return { success: false, error: "too distant" };

      // Guard 6: разрешение DM channel
      const dmChannelId =
        telegramNativeId != null ? telegramChannelId(telegramNativeId) : ensureChannelId(who);
      if (!dmChannelId) return { success: false, error: "cannot resolve" };

      // Guard 7: если узел channel присутствует в графе — убедиться, что это личный чат
      if (ctx.G.has(dmChannelId)) {
        const channelAttrs = ctx.G.getChannel(dmChannelId);
        if (channelAttrs.chat_type && channelAttrs.chat_type !== "private") {
          return { success: false, error: "not private" };
        }
      }

      // Задержка typing (обрабатывается внутри impl, минуя задержку набора executor)
      const rawId = extractNumericId(dmChannelId);
      if (rawId == null) return { success: false, error: "cannot resolve" };
      try {
        await setTyping(ctx.client, rawId);
        const delayMs = Math.min(Math.max(text.length * 80, 800), 8000);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      } catch {
        // ошибка typing не блокирует отправку
      }

      const msgId = await sendText(ctx.client, rawId, text);

      // Отменить typing
      try {
        await setTyping(ctx.client, rawId, true);
      } catch {
        // ignore
      }

      // Обновление графа + диспетчеризация событий (в соответствии с send_message)
      if (msgId != null) {
        cacheOutgoingMsg(dmChannelId, msgId);
      }

      if (ctx.G.has(dmChannelId)) {
        ctx.G.setDynamic(dmChannelId, "last_outgoing_text", [...text].slice(0, 150).join(""));
      }

      ctx.dispatcher.dispatch("SEND_MESSAGE", { chatId: dmChannelId, text, msgId });
      ctx.dispatcher.dispatch("DECLARE_ACTION", { target: dmChannelId });

      ctx.log.info("send_dm executed", { who: args.who, textLen: text.length });
      // DM не расходует obligation группового чата
      return { success: true, msgId: msgId ?? undefined, obligationsConsumed: 0 };
    },
  }),
];
