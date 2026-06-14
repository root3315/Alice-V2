/**
 * Memory Mod — память сообщений + контекст истории диалога.
 *
 * Ответственность:
 * - Вносить недавнюю историю диалога для Storyteller (секция-бакет)
 * - Предоставлять запрос recentChat
 * - Слушать SEND_MESSAGE и записывать отправленные сообщения
 *
 * Будущие расширения:
 * - Извлекаемость R_N (статья Eq.12: кривая забывания)
 * - Консолидация памяти (stability update, Eq.13)
 *
 * Ссылка: narrative-engine/mods/memory/index.ts
 * Ссылка: narrative-framework-paper §6b (Retrievability)
 */
import { and, desc, eq, gte } from "drizzle-orm";
import { z } from "zod";
import { createMod } from "../core/mod-builder.js";
import { PromptBuilder, type PromptLine } from "../core/prompt-style.js";
import type { ContributionItem } from "../core/types.js";
import { section } from "../core/types.js";
import { getDb } from "../db/connection.js";
import { messageLog } from "../db/schema.js";
import { extractNumericId } from "../graph/constants.js";
import { parseTransportTargetId, stableTransportMessageId } from "../platform/transport.js";
import { estimateAgeS } from "../pressure/clock.js";
import { humanDuration, humanDurationAgo } from "../utils/time-format.js";

// -- Состояние мода -----------------------------------------------------------

interface MemoryState {
  /** Целевой chatId текущего брифинга (устанавливается в act.ts). */
  targetChatId: string | null;
  /** ADR-83 D3: число сообщений в live window (внедряется из act.ts). При > 0 пропускать секцию conversation во избежание дублирования. */
  liveMessageCount: number;
}

// -- Определение мода ---------------------------------------------------------

export const memoryMod = createMod<MemoryState>("memory", {
  category: "core",
  description: "Память сообщений + контекст истории диалога",
  topics: ["memory"],
  initialState: { targetChatId: null, liveMessageCount: 0 },
})
  /** Установить текущий целевой канал (вызывается на фазе act). */
  .instruction("SET_CHAT_TARGET", {
    params: z.object({
      chatId: z.string().optional().describe("ID целевого канала"),
      liveMessageCount: z.number().default(0).describe("ADR-83 D3: число сообщений в live window"),
    }),
    description: "Установить текущую цель действия (канал)",
    impl(ctx, args) {
      ctx.state.targetChatId = args.chatId != null ? String(args.chatId) : null;
      ctx.state.liveMessageCount = Number(args.liveMessageCount ?? 0);
      return ctx.state.targetChatId;
    },
  })
  /** Записать отправленное сообщение. */
  .instruction("SEND_MESSAGE", {
    params: z.object({
      chatId: z.string().min(1).describe("ID канала"),
      text: z.string().min(1).describe("Текст сообщения"),
      msgId: z.number().optional().describe("Ссылочный номер сообщения, видимый в текущем чате"),
      mediaType: z.string().optional().describe("Тип медиа, например voice/photo/sticker"),
    }),
    description: "Записать отправленное сообщение в message_log",
    impl(ctx, args) {
      const text = String(args.text).slice(0, 4096);
      const chatId = String(args.chatId);
      const target = parseTransportTargetId(chatId);
      const nativeChatId = target?.nativeId;
      const nativeMsgId = args.msgId != null ? String(args.msgId) : undefined;
      // Синхронизация FTS выполняется автоматически триггерами SQLite.
      // @see runtime/drizzle/0017_fts5_triggers.sql
      getDb()
        .insert(messageLog)
        .values({
          tick: ctx.tick,
          platform: target?.platform ?? "telegram",
          chatId,
          msgId: args.msgId != null ? Number(args.msgId) : undefined,
          nativeChatId,
          nativeMsgId,
          stableMessageId:
            target && nativeMsgId != null
              ? stableTransportMessageId(target.platform, target.nativeId, nativeMsgId)
              : undefined,
          senderId: "self",
          senderName: "Alice",
          text,
          mediaType: args.mediaType ? String(args.mediaType) : undefined,
          isOutgoing: true,
          isDirected: false,
        })
        .run();
      return true;
    },
  })
  /** Получить недавние сообщения канала. */
  .query("recent_chat", {
    params: z.object({
      chatId: z.string().min(1).optional().describe("ID канала (если не указан — текущий чат)"),
      count: z
        .number()
        .int()
        .positive()
        .max(30)
        .default(20)
        .describe("Максимум сообщений (по умолчанию 20, верхний предел 30)"),
    }),
    deriveParams: {
      chatId: (cv: Record<string, unknown>) => cv.TARGET_CHAT,
    },
    description: "Получить недавние сообщения канала",
    affordance: {
      whenToUse: "Review recent conversation history in a channel",
      whenNotToUse: "When live messages are already visible in context",
      priority: "core",
    },
    returns:
      "Array<{ tick: number; chatId: string; senderName: string; text: string; isOutgoing: boolean; isDirected: boolean }>",
    returnHint: "[{senderName, text, timeAgo, isOutgoing, isDirected}]",
    impl(_ctx, args) {
      const db = getDb();
      const chatId = String(args.chatId);
      const limit = Number(args.count ?? 20);
      return db
        .select()
        .from(messageLog)
        .where(eq(messageLog.chatId, chatId))
        .orderBy(desc(messageLog.id))
        .limit(limit)
        .all()
        .reverse();
    },
    format(result) {
      const rows = result as Array<Record<string, unknown>>;
      if (rows.length === 0) return ["(no messages)"];
      const now = Date.now();
      const chatId = String(rows[0]?.chatId ?? "");
      const lines: string[] = [`--- ${rows.length} messages from ${chatId} ---`];
      for (const r of rows) {
        const tags: string[] = [];
        if (r.isOutgoing) tags.push("outgoing");
        if (r.isDirected) tags.push("directed");
        if (r.mediaType) tags.push(String(r.mediaType));
        const suffix = tags.length > 0 ? ` (${tags.join(", ")})` : "";
        const rawText = String(r.text ?? (r.mediaType ? `(${r.mediaType})` : "(empty)"));
        const text = rawText.length > 200 ? `${rawText.slice(0, 200)}...` : rawText;
        const agoS = estimateAgeS(
          {
            createdAt: r.createdAt instanceof Date ? r.createdAt : null,
            tick: Number(r.tick ?? 0),
          },
          now,
          0,
        );
        const ago = humanDurationAgo(agoS);
        lines.push(`[${ago}] ${r.senderName}: ${text}${suffix}`);
      }
      return lines;
    },
  })
  .contribute((ctx): ContributionItem[] => {
    const items: ContributionItem[] = [];
    const db = getDb();

    // 1. История диалога целевого чата
    // ADR-83 D3: live window (реалтайм-получение через Telegram API) — источник истины.
    // При liveMessageCount > 0 пропускать эту секцию, чтобы не дублировать live messages из act.ts.
    if (ctx.state.targetChatId && ctx.state.liveMessageCount === 0) {
      const messages = db
        .select()
        .from(messageLog)
        .where(eq(messageLog.chatId, ctx.state.targetChatId))
        .orderBy(desc(messageLog.id))
        .limit(20)
        .all()
        .reverse();

      if (messages.length > 0) {
        const mb = new PromptBuilder();
        for (const m of messages) {
          // IRC-стиль: display_name ~senderId (для не-Alice сообщений добавляется sender ID)
          let sender: string;
          if (m.isOutgoing) {
            sender = "Alice (you)";
          } else {
            const numId = m.senderId ? extractNumericId(m.senderId) : null;
            const senderTag = numId != null ? ` @${numId}` : "";
            sender = `${m.senderName ?? "Unknown"}${senderTag}`;
          }
          const preview = m.text
            ? m.text.length > 200
              ? `${m.text.slice(0, 200)}...`
              : m.text
            : "(no text)";
          // ADR-110/166: использовать estimateAgeS единообразно
          const agoS = estimateAgeS(m, ctx.nowMs, ctx.tick);
          const ago = humanDurationAgo(agoS);
          // ADR-219: передавать видимый msgId текущего чата, чтобы LLM мог ссылаться на сообщения через `irc forward --ref msgId`.
          mb.timeline(ago, sender, preview, m.msgId);
        }
        // Использовать display_name вместо raw chatId (для удобства LLM)
        let chatLabel = "(unknown chat)";
        if (ctx.state.targetChatId && ctx.graph.has(ctx.state.targetChatId)) {
          chatLabel = ctx.graph.getChannel(ctx.state.targetChatId).display_name ?? chatLabel;
        }
        items.push(
          section("conversation", mb.build(), `Recent conversation in ${chatLabel}:`, 20, 80),
        );
      }
    }

    // 2. Ретроспектива диалога — структурированный снимок временной шкалы (философия PageIndex: давать структуру, дать LLM рассуждать)
    //    Запрашивать последние 100 сообщений (исключая уже показанные 20), разбивать по промежуткам, резюме начала и конца
    if (ctx.state.targetChatId) {
      const olderMessages = db
        .select()
        .from(messageLog)
        .where(eq(messageLog.chatId, ctx.state.targetChatId))
        .orderBy(desc(messageLog.id))
        .limit(120) // Взять 120 записей, пропустить последние 20 (уже показаны в секции conversation)
        .all()
        .reverse();

      // Пропустить последние 20 (уже показаны в секции conversation)
      const older = olderMessages.slice(0, Math.max(0, olderMessages.length - 20));

      if (older.length >= 3) {
        // Разбить по промежуткам (gap > 10 тиков → новый сегмент)
        const segments: (typeof older)[] = [];
        let current: typeof older = [older[0]];
        for (let i = 1; i < older.length; i++) {
          if (older[i].tick - older[i - 1].tick > 10) {
            segments.push(current);
            current = [older[i]];
          } else {
            current.push(older[i]);
          }
        }
        segments.push(current);

        // Рендер: для каждого сегмента показывать только первое и последнее сообщение + количество
        const recapLines: PromptLine[] = [];
        for (const seg of segments.slice(-5)) {
          // Показывать не более 5 сегментов
          const first = seg[0];
          const last = seg[seg.length - 1];
          // ADR-210 F: Earlier conversation — это ретроспективное резюме; sender ID функциональной ценности не несёт, оставлять только имя
          const firstSender = first.isOutgoing ? "Alice" : (first.senderName ?? "someone");
          const lastSender = last.isOutgoing ? "Alice" : (last.senderName ?? "someone");
          const rawFirst = (first.text ?? "").replaceAll("\n", " ");
          const firstText = rawFirst
            ? rawFirst.length > 60
              ? `${rawFirst.slice(0, 60)}...`
              : rawFirst
            : "(no text)";
          const rawLast = (last.text ?? "").replaceAll("\n", " ");
          const lastText = rawLast
            ? rawLast.length > 60
              ? `${rawLast.slice(0, 60)}...`
              : rawLast
            : "(no text)";

          // ADR-110/166: использовать estimateAgeS единообразно
          const startAgoS = estimateAgeS(first, ctx.nowMs, ctx.tick);
          const endAgoS = estimateAgeS(last, ctx.nowMs, ctx.tick);
          const startAgo = humanDuration(startAgoS);
          const endAgo = humanDuration(endAgoS);
          recapLines.push(
            PromptBuilder.of(`[${startAgo} ago — ${endAgo} ago] ${seg.length} messages`),
          );
          recapLines.push(PromptBuilder.of(`First: ${firstSender}: ${firstText}`.replace(/\s*\n\s*/g, " ")));
          if (seg.length > 1) {
            recapLines.push(PromptBuilder.of(`Last: ${lastSender}: ${lastText}`.replace(/\s*\n\s*/g, " ")));
          }
        }

        if (recapLines.length > 0) {
          items.push(section("conversation-recap", recapLines, "Earlier conversation", 25, 65));
        }
      }
    }

    // 3. ADR-102: Action Echo — рефлексивный след действий.
    //    Модель себя у Alice содержит семантическую память (факты) и эмоциональную (дневник), но не содержит памяти действий.
    //    Когда сообщения вытесняются за пределы 30-сообщенного live window, у Alice пропадает ощущение того, «что она делала»,
    //    а неразрешённые эмоции из дневника продолжают накапливаться → петля усиления с положительной обратной связью → повторные расспросы по одной теме.
    //    Эта секция извлекает из messageLog недавние исходящие сообщения Alice, независимо от live window,
    //    восполняя пробел «памяти действий» в её модели себя.
    //    @see docs/adr/102-reflective-action-trace.md
    if (ctx.state.targetChatId) {
      const ECHO_LOOKBACK_S = 3600; // 1 час
      const ECHO_MAX_MESSAGES = 5;
      // ADR-110: использовать createdAt вместо tick для оконного запроса
      const outgoing = db
        .select({
          tick: messageLog.tick,
          text: messageLog.text,
          createdAt: messageLog.createdAt,
        })
        .from(messageLog)
        .where(
          and(
            eq(messageLog.chatId, ctx.state.targetChatId),
            eq(messageLog.isOutgoing, true),
            gte(messageLog.createdAt, new Date(ctx.nowMs - ECHO_LOOKBACK_S * 1000)),
          ),
        )
        .orderBy(desc(messageLog.tick))
        .limit(ECHO_MAX_MESSAGES)
        .all()
        .reverse();

      if (outgoing.length > 0) {
        const echoLines: PromptLine[] = [];
        for (const m of outgoing) {
          // ADR-110/166: использовать estimateAgeS единообразно
          const agoS = estimateAgeS(m, ctx.nowMs, ctx.tick);
          const ago = humanDurationAgo(agoS);
          // Сплющиваем переносы: .of() — однострочный (её код-ответы бывают многострочными).
          const flat = (m.text ?? "").replace(/\s*\n\s*/g, " ").trim();
          const preview = flat ? (flat.length > 80 ? `${flat.slice(0, 80)}...` : flat) : "(no text)";
          echoLines.push(PromptBuilder.of(`[${ago}] you: "${preview}"`));
        }
        items.push(
          // ADR-102: priority 68 — ниже threads(70)/self-mood(70), выше conversation-recap(65).
          // Должна выживать при жёстком бюджете группового чата: предотвращение повторений важнее contact-mood(55)/group-dynamics(55).
          section("action-echo", echoLines, "Said recently (this chat)", 15, 68),
        );
      }
    }

    // ADR-56 S4: cross-chat-activity удалена.
    // Показ активности других чатов в текущем чате приводит к утечке информации между чатами на стороне LLM.
    // @see docs/adr/56-behavioral-reciprocity-action-loop.md §S4

    return items;
  })
  .build();
