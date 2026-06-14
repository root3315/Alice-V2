/**
 * Общие функции запросов к базе данных.
 *
 * Универсальные запросы, не привязанные к конкретному Mod, собраны здесь,
 * чтобы не дублировать их в каждом отдельном Mod.
 */
import { and, between, desc, eq, gt } from "drizzle-orm";
import { getDb } from "./connection.js";
import { actionLog, messageLog } from "./schema.js";

export function getRecentMessagesByChat(
  chatId: string,
  limit = 20,
): Array<{
  platform: string;
  msgId: number | null;
  nativeChatId: string | null;
  nativeMsgId: string | null;
  stableMessageId: string | null;
  senderName: string | null;
  senderId: string | null;
  text: string | null;
  isOutgoing: boolean;
  isDirected: boolean;
  mediaType: string | null;
  createdAt: Date;
}> {
  const db = getDb();
  return db
    .select({
      platform: messageLog.platform,
      msgId: messageLog.msgId,
      nativeChatId: messageLog.nativeChatId,
      nativeMsgId: messageLog.nativeMsgId,
      stableMessageId: messageLog.stableMessageId,
      senderName: messageLog.senderName,
      senderId: messageLog.senderId,
      text: messageLog.text,
      isOutgoing: messageLog.isOutgoing,
      isDirected: messageLog.isDirected,
      mediaType: messageLog.mediaType,
      createdAt: messageLog.createdAt,
    })
    .from(messageLog)
    .where(eq(messageLog.chatId, chatId))
    .orderBy(desc(messageLog.id))
    .limit(limit)
    .all()
    .reverse();
}

/**
 * Запрос последних сообщений определённого контакта по всем чатам (для Formative Memories).
 *
 * Выборка из message_log по senderId, сортировка по tick DESC, берём последние N записей.
 * Исключаются исходящие сообщения Alice (isOutgoing = true).
 *
 * @param senderId ID контакта (например "contact:telegram:123")
 * @param limit Максимальное число возвращаемых записей, по умолчанию 15
 * @returns Список сообщений в порядке убывания tick
 *
 * @see docs/adr/86-voyager-concordia-cross-analysis.md §C5 Formative Memories
 */
export function getRecentMessagesBySender(
  senderId: string,
  limit = 15,
): Array<{ chatId: string; senderName: string | null; text: string | null; tick: number }> {
  const db = getDb();
  return db
    .select({
      chatId: messageLog.chatId,
      senderName: messageLog.senderName,
      text: messageLog.text,
      tick: messageLog.tick,
    })
    .from(messageLog)
    .where(and(eq(messageLog.senderId, senderId), eq(messageLog.isOutgoing, false)))
    .orderBy(desc(messageLog.tick))
    .limit(limit)
    .all();
}

// ── ADR-97: Запрос контекста диффузии цепочки ответов ──────────────────────────────────────────

/**
 * Облегчённая проекция записи messageLog для диффузии цепочки ответов.
 * @see docs/adr/97-reply-chain-diffusion-context.md
 */
export interface DbMessageRecord {
  platform: string;
  /** UI-local visible reference number. Some platforms/rows may not have one. */
  msgId: number | null;
  /** Нативный ID чата на платформе. */
  nativeChatId: string | null;
  /** Нативный ID сообщения на платформе. */
  nativeMsgId: string | null;
  /** Кроссплатформенный стабильный ID сообщения: message:<platform>:<nativeChatId>:<nativeMsgId>. */
  stableMessageId: string | null;
  tick: number;
  senderId: string | null;
  senderName: string | null;
  text: string | null;
  /** ADR-119: Тип медиа (sticker/photo/voice/video/document). Для текстовых сообщений — null. */
  mediaType: string | null;
  isOutgoing: boolean;
  replyToMsgId: number | null;
  createdAt: Date;
}

/** SELECT-проекция — соответствует полям DbMessageRecord. */
const MESSAGE_RECORD_COLUMNS = {
  platform: messageLog.platform,
  msgId: messageLog.msgId,
  nativeChatId: messageLog.nativeChatId,
  nativeMsgId: messageLog.nativeMsgId,
  stableMessageId: messageLog.stableMessageId,
  tick: messageLog.tick,
  senderId: messageLog.senderId,
  senderName: messageLog.senderName,
  text: messageLog.text,
  mediaType: messageLog.mediaType,
  isOutgoing: messageLog.isOutgoing,
  replyToMsgId: messageLog.replyToMsgId,
  createdAt: messageLog.createdAt,
} as const;

/**
 * Получение одного сообщения по видимому в текущем чате msgId.
 * Использует составной индекс idx_message_log_chat_msg.
 *
 * @see docs/adr/97-reply-chain-diffusion-context.md
 */
export function getMessageByMsgId(chatId: string, msgId: number): DbMessageRecord | null {
  const db = getDb();
  const rows = db
    .select(MESSAGE_RECORD_COLUMNS)
    .from(messageLog)
    .where(and(eq(messageLog.chatId, chatId), eq(messageLog.msgId, msgId)))
    .limit(1)
    .all();
  const r = rows[0];
  if (!r || r.msgId == null) return null;
  return {
    platform: r.platform,
    msgId: r.msgId,
    nativeChatId: r.nativeChatId,
    nativeMsgId: r.nativeMsgId,
    stableMessageId: r.stableMessageId,
    tick: r.tick,
    senderId: r.senderId,
    senderName: r.senderName,
    text: r.text,
    mediaType: r.mediaType,
    isOutgoing: r.isOutgoing,
    replyToMsgId: r.replyToMsgId,
    createdAt: r.createdAt,
  };
}

/**
 * Получение ±radius сообщений вокруг msgId (в рамках одного chatId).
 * ORDER BY msgId ASC, диапазонный запрос через BETWEEN.
 *
 * Функция обслуживает только платформенные пути с числовым текущим номером ссылки;
 * строки без msgId в результат не попадают.
 *
 * @see docs/adr/97-reply-chain-diffusion-context.md
 */
export function getMessageCluster(
  chatId: string,
  centerMsgId: number,
  radius: number,
): DbMessageRecord[] {
  const db = getDb();
  const rows = db
    .select(MESSAGE_RECORD_COLUMNS)
    .from(messageLog)
    .where(
      and(
        eq(messageLog.chatId, chatId),
        between(messageLog.msgId, centerMsgId - radius, centerMsgId + radius),
      ),
    )
    .all();
  return rows
    .filter((r): r is typeof r & { msgId: number } => r.msgId != null)
    .map((r) => ({
      platform: r.platform,
      msgId: r.msgId,
      nativeChatId: r.nativeChatId,
      nativeMsgId: r.nativeMsgId,
      stableMessageId: r.stableMessageId,
      tick: r.tick,
      senderId: r.senderId,
      senderName: r.senderName,
      text: r.text,
      mediaType: r.mediaType,
      isOutgoing: r.isOutgoing,
      replyToMsgId: r.replyToMsgId,
      createdAt: r.createdAt,
    }))
    .sort((a, b) => a.msgId - b.msgId);
}

// ── ADR-121: Запрос социального периферийного зрения ────────────────────────────────────────────────────

/**
 * Запрос социального периферийного зрения: недавние сообщения контакта (по всем каналам).
 *
 * Использует индекс idx_message_log_sender для поиска по senderId;
 * фильтрация sharedChats + excludeChat выполняется на уровне приложения
 * (во избежание динамического IN в SQL).
 * Выборка с превышением 3x limit для компенсации потерь при фильтрации.
 *
 * @param senderId    ID контакта (например "contact:telegram:123")
 * @param sinceMs     Начало временного окна (временная метка в мс)
 * @param excludeChat ID текущего канала, который нужно исключить
 * @param limit       Максимальное число возвращаемых записей
 *
 * @see docs/adr/121-social-peripheral-vision/README.md §3.6
 */
export function getPeripheralMessages(
  senderId: string,
  sinceMs: number,
  excludeChat: string,
  limit: number,
): Array<{
  chatId: string;
  text: string | null;
  msgId: number;
  createdAt: Date;
  senderName: string | null;
}> {
  const db = getDb();
  const since = new Date(sinceMs);
  const overFetch = limit * 3;
  const rows = db
    .select({
      chatId: messageLog.chatId,
      text: messageLog.text,
      msgId: messageLog.msgId,
      createdAt: messageLog.createdAt,
      senderName: messageLog.senderName,
    })
    .from(messageLog)
    .where(
      and(
        eq(messageLog.senderId, senderId),
        gt(messageLog.createdAt, since),
        eq(messageLog.isOutgoing, false),
      ),
    )
    .orderBy(desc(messageLog.createdAt))
    .limit(overFetch)
    .all();
  // Фильтрация на уровне приложения: исключить текущий канал, msgId должен присутствовать
  return rows
    .filter((r): r is typeof r & { msgId: number } => r.msgId != null && r.chatId !== excludeChat)
    .slice(0, limit);
}

// ── ADR-117 D1: IRC-style инъекция рассуждений ─────────────────────────────────────────

/**
 * Запрос последних действий в чате (для IRC-style инъекции рассуждений).
 * Использует существующий индекс idx_action_log_chat_tick.
 *
 * @see docs/adr/117-*.md — D1: Непрерывность между тиками
 */
export function getRecentActionsByChat(
  chatId: string,
  sinceMs: number,
  limit = 3,
): Array<{ tick: number; reasoning: string | null; actionType: string; createdAt: Date }> {
  const db = getDb();
  const since = new Date(sinceMs);
  return db
    .select({
      tick: actionLog.tick,
      reasoning: actionLog.reasoning,
      actionType: actionLog.actionType,
      createdAt: actionLog.createdAt,
    })
    .from(actionLog)
    .where(and(eq(actionLog.chatId, chatId), gt(actionLog.createdAt, since)))
    .orderBy(desc(actionLog.createdAt))
    .limit(limit)
    .all();
}
