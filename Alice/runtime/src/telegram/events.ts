/**
 * Привязка событий mtcute Dispatcher.
 * Преобразует обновления Telegram в GraphPerturbation и помещает их в буфер событий.
 */

import type { Dispatcher } from "@mtcute/dispatcher";
import type { TelegramClient } from "@mtcute/node";
import { Chat, getMarkedPeerId, type tl, User } from "@mtcute/node";
import { and, desc, eq, isNotNull } from "drizzle-orm";
import { recordObservedGroupPhoto } from "../db/album.js";
import { writeCanonicalEvent, writeCanonicalEventOnce } from "../db/canonical-event-store.js";
import { getDb } from "../db/connection.js";
import { messageLog } from "../db/schema.js";
import { terminateConversation } from "../engine/conversation.js";
import { recordTyping } from "../engine/react/typing-tracker.js";
import { telegramChannelId, telegramContactId } from "../graph/constants.js";
import type { ChatType } from "../graph/entities.js";
import type { WorldModel } from "../graph/world-model.js";
import { getCachedDescription, getCachedOcrText } from "../llm/media-cache.js";
import { stableTransportMessageId } from "../platform/transport.js";
import { createLogger } from "../utils/logger.js";
import { fetchAndCacheBio, getCachedBio } from "./bio-cache.js";
import { canonicalFromPerturbation } from "./canonical-events.js";
import type { GraphPerturbation } from "./mapper.js";

const log = createLogger("events");

// WS-4: гейт ops-инцидента — двойной (канал работач + гараж-бот) + маркер. id в .env.
// Для этого (и только этого) случая инцидент трактуется как directed-сообщение,
// обходя bot-downweight, чтобы её любопытство его заметило. Сам контакт остаётся ботом.
const OPS_CHANNEL_ID = process.env.OPS_CHANNEL_ID;
const OPS_GARAGE_BOT_ID = process.env.OPS_GARAGE_BOT_ID;
const OPS_INCIDENT_MARKER = /🔴|🚨|👀|💬|INC-/;
function isGarageIncident(
  channelId: string,
  contactId: string | null,
  text: string | null | undefined,
): boolean {
  return (
    !!OPS_CHANNEL_ID &&
    !!OPS_GARAGE_BOT_ID &&
    channelId === OPS_CHANNEL_ID &&
    contactId === OPS_GARAGE_BOT_ID &&
    !!text &&
    OPS_INCIDENT_MARKER.test(text)
  );
}

/** ADR-64 I-1: Тип колбэка на получение directed-сообщения. */
export type DirectedCallback = (event: GraphPerturbation) => void;

/** ADR-248 W3: Побочная запись canonical_events в реальном времени. Сбой только логируется и не затрагивает основной путь EventBuffer. */
export function pushCanonicalPerturbation(
  buffer: EventBuffer,
  event: GraphPerturbation,
  sourceId?: string,
): void {
  try {
    if (sourceId) {
      writeCanonicalEventOnce(canonicalFromPerturbation(event), { source: "telegram", sourceId });
    } else {
      writeCanonicalEvent(canonicalFromPerturbation(event));
    }
  } catch (e) {
    log.warn("Failed to write canonical event side path", e);
  }
  buffer.push(event);
}

/**
 * Окно пробуждения для продолжения диалога (мс). Старое значение: 2 тика × 60с = 120с.
 * После реплики Alice в канале новые сообщения того же канала в пределах этого окна тоже запускают debounce-пробуждение.
 * Позволяет не ждать целый интервал тика, когда собеседник отвечает без reply в групповом чате.
 */
const CONTINUATION_WAKEUP_MS = 120_000;

function extractMediaUniqueFileId(media: unknown): string | null {
  if (!media || typeof media !== "object") return null;
  const record = media as { uniqueFileId?: unknown; fileUniqueId?: unknown };
  if (typeof record.uniqueFileId === "string" && record.uniqueFileId.trim()) {
    return record.uniqueFileId;
  }
  if (typeof record.fileUniqueId === "string" && record.fileUniqueId.trim()) {
    return record.fileUniqueId;
  }
  return null;
}

/** Буфер событий: накапливается каждый тик, потребляется evolve. */
export class EventBuffer {
  static readonly DEFAULT_MAX_SIZE = 1000;
  /** ADR-114 D4: Максимальный размер защищённого сегмента (защитная зона directed-событий). */
  static readonly MAX_PROTECTED = 100;

  private readonly maxRegularSize: number;
  private readonly maxProtectedSize: number;
  /** ADR-114 D4: Защитная зона directed-событий. @mention/reply не тонут в потоке офлайн-сообщений из активных групп. */
  private protectedBuffer: GraphPerturbation[] = [];
  /** Обычный буфер для non-directed событий. */
  private regularBuffer: GraphPerturbation[] = [];
  /** Число событий, сброшенных при переполнении обычного сегмента с момента последнего drain. Для обнаружения потерь в evolve. */
  private _droppedCount = 0;
  /** ADR-114 D4: Счётчик сбросов при переполнении защищённого сегмента. */
  private _droppedDirectedCount = 0;
  /** ADR-147 D1: Накопленный счётчик переполнений (не сбрасывается при drain, используется для аудита). */
  totalDroppedSinceBoot = 0;
  totalDroppedDirectedSinceBoot = 0;
  /** ADR-147 D4: Флаг восстановления после переподключения mtcute. True в период `updating`. */
  private _isRecovering = false;
  /** ADR-64 I-1: Колбэк при получении directed-сообщения, используется для пробуждения цикла evolve. */
  private _onDirected: DirectedCallback | null = null;
  /** Низкоприоритетный колбэк пробуждения при любом событии (быстрый отклик в conversation mode). */
  private _onAnyEvent: (() => void) | null = null;

  // ADR-107: Колбэки прослушивания событий. Используются engagement session для отслеживания ответов и событий вытеснения в целевом чате.
  // watcher одноразовый — автоматически удаляется после resolve.
  private _watchers: Array<{
    filter: (event: GraphPerturbation) => boolean;
    resolve: (event: GraphPerturbation) => void;
  }> = [];

  constructor(maxSize?: number) {
    const total = maxSize ?? EventBuffer.DEFAULT_MAX_SIZE;
    // Маленький буфер (для тестов): protected не превышает половины общей ёмкости, regular минимум 1
    this.maxProtectedSize = Math.min(EventBuffer.MAX_PROTECTED, Math.floor(total / 2));
    this.maxRegularSize = Math.max(1, total - this.maxProtectedSize);
  }

  /** ADR-147 D4: Флаг восстановления после переподключения mtcute (true в период `updating`). */
  set isRecovering(v: boolean) {
    this._isRecovering = v;
  }
  get isRecovering(): boolean {
    return this._isRecovering;
  }

  /** Регистрация колбэка на получение directed-сообщения (вызывается циклом evolve). */
  set onDirected(cb: DirectedCallback | null) {
    this._onDirected = cb;
  }

  /** Регистрация колбэка на любое событие (низкоприоритетное пробуждение). */
  set onAnyEvent(cb: (() => void) | null) {
    this._onAnyEvent = cb;
  }

  /**
   * ADR-107: Регистрация наблюдателя события. Возвращает promise (первое совпавшее событие) и функцию cancel.
   * Событие по-прежнему нормально попадает в buffer (drain не затрагивается), watcher лишь дополнительно уведомляется.
   * @see docs/adr/107-engagement-session/README.md
   */
  watch(filter: (event: GraphPerturbation) => boolean): {
    promise: Promise<GraphPerturbation>;
    cancel: () => void;
  } {
    let resolve!: (event: GraphPerturbation) => void;
    const promise = new Promise<GraphPerturbation>((r) => {
      resolve = r;
    });
    const watcher = { filter, resolve };
    this._watchers.push(watcher);
    return {
      promise,
      cancel: () => {
        const idx = this._watchers.indexOf(watcher);
        if (idx >= 0) this._watchers.splice(idx, 1);
      },
    };
  }

  push(event: GraphPerturbation): void {
    // ADR-114 D4: directed-события идут в protected-сегмент, остальные — в regular
    if (event.isDirected) {
      this.protectedBuffer.push(event);
      if (this.protectedBuffer.length > this.maxProtectedSize) {
        this.protectedBuffer.shift();
        this._droppedDirectedCount++;
        this.totalDroppedDirectedSinceBoot++;
        log.warn("EventBuffer protected overflow, oldest directed event dropped", {
          protectedSize: this.protectedBuffer.length,
          totalDroppedDirected: this._droppedDirectedCount,
        });
      }
    } else {
      if (this.regularBuffer.length >= this.maxRegularSize) {
        this.regularBuffer.shift();
        this._droppedCount++;
        this.totalDroppedSinceBoot++;
        log.warn("EventBuffer overflow, oldest event dropped", {
          regularSize: this.regularBuffer.length,
          totalDropped: this._droppedCount,
        });
      }
      this.regularBuffer.push(event);
    }

    // ADR-107: Уведомление совпавших watchers (обход с конца, т.к. resolve вызывает splice на себе)
    for (let i = this._watchers.length - 1; i >= 0; i--) {
      if (this._watchers[i].filter(event)) {
        this._watchers[i].resolve(event);
        this._watchers.splice(i, 1);
      }
    }

    // ADR-64 I-1: При получении directed-сообщения уведомляем цикл evolve о досрочном пробуждении
    // ADR-66 F1: Окно продолжения диалога — non-directed сообщения из канала, где Alice недавно отвечала, тоже будят evolve
    if ((event.isDirected || event.isContinuation) && this._onDirected) {
      this._onDirected(event);
    }

    // Низкоприоритетное пробуждение: уведомление при любом событии (в conversation mode non-directed события тоже требуют реакции).
    // Примечание: вызывается даже если onDirected уже сработал — вызывающая сторона должна самостоятельно делать debounce.
    if (this._onAnyEvent) {
      this._onAnyEvent();
    }
  }

  /** Извлекает и очищает текущий буфер. Возвращает список событий (отсортированный по tick) и счётчики сбросов. */
  drain(): { events: GraphPerturbation[]; droppedCount: number; droppedDirectedCount: number } {
    // ADR-114 D4: Объединяем два сегмента и сортируем по tick для обеспечения хронологической последовательности
    const events = [...this.protectedBuffer, ...this.regularBuffer].sort(
      (a, b) => (a.tick ?? 0) - (b.tick ?? 0),
    );
    const droppedCount = this._droppedCount;
    const droppedDirectedCount = this._droppedDirectedCount;
    this.protectedBuffer = [];
    this.regularBuffer = [];
    this._droppedCount = 0;
    this._droppedDirectedCount = 0;
    return { events, droppedCount, droppedDirectedCount };
  }

  get length(): number {
    return this.protectedBuffer.length + this.regularBuffer.length;
  }
}

/**
 * Привязывает события Dispatcher к EventBuffer.
 *
 * Привязываемые события:
 * - onNewMessage → new_message
 * - onEditMessage → new_message (рассматривается как обновление)
 * - onHistoryRead → read_history
 * - onUserStatusUpdate → user_status
 */
// ADR-77 B2: Кеш в памяти исходящих сообщений Alice для определения directed-ответов в том же чате (same_chat reply).
// mtcute RepliedMessageInfo при same_chat origin имеет sender=null, из-за чего нельзя определить отправителя исходного сообщения.
// Кешируем outgoing message ID Alice, по которому проверяем при детектировании reply.
// key = `${channelId}_${msgId}`, LRU-вытеснение удерживает лимит в 2000 записей.
const OUTGOING_CACHE_LIMIT = 2000;
// Порядок итерации Map — порядок вставки, что естественно реализует LRU (O(1) вытеснение самой старой записи).
const outgoingMsgCache = new Map<string, true>();

export function cacheOutgoingMsg(channelId: string, msgId: number): void {
  const key = `${channelId}_${msgId}`;
  if (outgoingMsgCache.has(key)) return;
  outgoingMsgCache.set(key, true);
  if (outgoingMsgCache.size > OUTGOING_CACHE_LIMIT) {
    // Map.keys().next() возвращает самый ранний вставленный ключ (LRU-вытеснение)
    const oldest = outgoingMsgCache.keys().next().value;
    if (oldest != null) outgoingMsgCache.delete(oldest);
  }
}

function isOutgoingMsg(channelId: string, msgId: number): boolean {
  return outgoingMsgCache.has(`${channelId}_${msgId}`);
}

/**
 * ADR-90 W1: Прогрев кеша исходящих сообщений из БД при запуске.
 * После перезапуска Set в памяти очищается → детектирование directed по reply перестаёт работать.
 * Восстанавливает последние N записей через индекс idx_message_log_chat_msg таблицы message_log.
 *
 * @returns Количество прогретых записей
 */
export function warmOutgoingCache(): number {
  try {
    const db = getDb();
    const rows = db
      .select({ chatId: messageLog.chatId, msgId: messageLog.msgId })
      .from(messageLog)
      .where(and(eq(messageLog.isOutgoing, true), isNotNull(messageLog.msgId)))
      .orderBy(desc(messageLog.tick))
      .limit(OUTGOING_CACHE_LIMIT)
      .all();
    for (const row of rows) {
      if (row.msgId != null) {
        cacheOutgoingMsg(row.chatId, row.msgId);
      }
    }
    return rows.length;
  } catch (e) {
    log.warn("Failed to warm outgoing cache from DB", e);
    return 0;
  }
}

export function bindEvents(
  dp: Dispatcher,
  G: WorldModel,
  buffer: EventBuffer,
  getSelfId: () => string,
  getCurrentTick: () => number,
  getSelfUsername?: () => string | undefined,
  client?: TelegramClient,
  getFocusWhitelist?: () => ReadonlySet<string> | null,
  getAdminId?: () => string | undefined,
): void {
  // Новое сообщение
  dp.onNewMessage(async (ctx) => {
    const chatId = String(ctx.chat.id);
    const channelId = telegramChannelId(chatId);
    const senderId = ctx.sender ? String(ctx.sender.id) : null;
    const selfId = getSelfId();
    const tick = getCurrentTick();

    // ПОЛИТИКА ДОСТУПА:
    //  • группы/каналы — любые (без ограничений);
    //  • приватные чаты — ТОЛЬКО личка админа (тебя);
    //  • чужие ЛС и собственное «Избранное» (Saved Messages, там запрещёнка) — игнор.
    // Приватный чат = ctx.chat это User; id чата = id собеседника (для Saved Messages —
    // её собственный id, который ≠ admin → отсекается).
    const adminId = getAdminId?.();
    if (ctx.chat instanceof User && adminId && String(ctx.chat.id) !== adminId) return;

    // Доп. ограничение, если задан focus whitelist (сейчас пуст → не действует).
    const focusWhitelist = getFocusWhitelist?.();
    if (focusWhitelist && !focusWhitelist.has(channelId)) return;

    // Пропускаем собственные сообщения — но сначала кешируем message ID для детектирования directed по reply
    if (senderId === selfId) {
      cacheOutgoingMsg(channelId, ctx.id);
      return;
    }

    // Пропускаем системную сущность Telegram "Replies" (ID 1271266957).
    // Кросс-чат ответы между связанными группами/каналами доставляются от имени Replies,
    // создавая фантомные каналы + ложные обязательства P5 + потерю идентификатора отправителя.
    // Alice уже видит настоящее сообщение в исходном канале — здесь дубликат нужно отбросить.
    if (senderId === "1271266957") return;

    const contactId = senderId ? telegramContactId(senderId) : null;
    // WS-4: инцидент гараж-бота в работач → ниже трактуем как directed (не как бот).
    const opsIncident = isGarageIncident(channelId, contactId, ctx.text);

    // Определяем, является ли сообщение directed (reply, личка или @mention)
    const isPrivate = ctx.chat instanceof User;
    // Исправление B1 + ADR-77 B2: детектирование directed по reply
    // RepliedMessageInfo при same_chat origin имеет sender=null (так устроен mtcute).
    // Патч B2: когда sender недоступен, но replyToMessage.id есть — проверяем кеш в памяти,
    // было ли это сообщение отправлено Alice.
    let isReply = false;
    if (ctx.replyToMessage) {
      if (ctx.replyToMessage.sender) {
        // other_chat / private origin: sender доступен, проверяем напрямую
        const replySender = ctx.replyToMessage.sender;
        if ("id" in replySender && String(replySender.id) === selfId) {
          isReply = true;
        }
      } else if (ctx.replyToMessage.id != null) {
        // same_chat origin: sender=null, проверяем кеш в памяти по outgoing message ID
        isReply = isOutgoingMsg(channelId, ctx.replyToMessage.id);
      }
    }
    // Проверяем, есть ли в сущностях сообщения @mention на себя
    let isMentioned = false;
    const selfUsername = getSelfUsername?.();
    if (selfUsername && ctx.entities) {
      for (const entity of ctx.entities) {
        if (entity.kind === "mention") {
          // mention в формате @username
          const mentionText = entity.text;
          if (mentionText.toLowerCase() === `@${selfUsername.toLowerCase()}`) {
            isMentioned = true;
            break;
          }
        }
        if (entity.is("text_mention") && String(entity.params.userId) === selfId) {
          // Встроенный mention пользователя без username
          isMentioned = true;
          break;
        }
      }
    }
    const isDirected = isPrivate || isReply || isMentioned || opsIncident;

    // G3: Детектирование бота — объект mtcute User имеет свойство isBot
    const senderIsBot = ctx.sender instanceof User && ctx.sender.isBot;

    // Извлекаем chatType и displayName для автоматического создания узлов маппером
    let chatType: ChatType = "private";
    if (ctx.chat instanceof Chat) {
      const ct = ctx.chat.chatType;
      chatType = ct === "channel" ? "channel" : ct === "supergroup" ? "supergroup" : "group";
    }
    const displayName = ctx.sender?.displayName;
    // ADR-220: Имя канала/группы (используется для channel.display_name).
    // ADR-221: В личном чате ctx.chat это User (без displayName), имя отправителя используется как имя чата.
    const chatDisplayName =
      ctx.chat instanceof Chat ? ctx.chat.displayName : ctx.sender?.displayName; // Личный чат: chat name = sender name

    // Текст сообщения (обрезается до 4096 символов)
    const msgText = ctx.text ? ctx.text.slice(0, 4096) : undefined;
    const sName = displayName ?? (senderId ? `User ${senderId}` : undefined);

    // L3: Определяем тип содержимого сообщения
    let contentType: "text" | "sticker" | "photo" | "voice" | "video" | "document" = "text";
    let mediaUniqueFileId: string | null = null;
    const media = ctx.media;
    if (media) {
      const mediaType = media.type;
      if (mediaType === "sticker") contentType = "sticker";
      else if (mediaType === "photo") contentType = "photo";
      else if (mediaType === "voice" || mediaType === "audio") contentType = "voice";
      else if (mediaType === "video") contentType = "video";
      else if (mediaType === "document") contentType = "document";
      mediaUniqueFileId = extractMediaUniqueFileId(media);
    }

    // ADR-66 F1: Окно продолжения диалога — Alice недавно отвечала в этом канале → non-directed сообщения тоже будят evolve
    // Сообщения ботов не запускают продолжение — ответ бота не является сигналом «Alice ходит».
    let isContinuation = false;
    if (!isDirected && !senderIsBot && G.has(channelId)) {
      const lastAliceActionMs = Number(G.getChannel(channelId).last_alice_action_ms ?? 0);
      if (lastAliceActionMs > 0 && Date.now() - lastAliceActionMs <= CONTINUATION_WAKEUP_MS) {
        isContinuation = true;
      }
    }

    // Forum: трекаем топик входящего сообщения, чтобы отвечать в него, а не в General.
    // threadId = id топика (null в General / вне топиков / в не-форумах → отправка по умолчанию).
    const incomingTopicId = ctx.replyToMessage?.threadId ?? undefined;
    if (G.has(channelId) && G.getChannel(channelId).current_topic_id !== incomingTopicId) {
      G.updateChannel(channelId, { current_topic_id: incomingTopicId });
    }

    // ADR-206 W5: Извлекаем канал-источник пересылки
    let forwardFromChannelId: string | undefined;
    let forwardFromChannelName: string | undefined;
    if (ctx.forward) {
      try {
        const fwdSender = ctx.forward.sender;
        if (fwdSender && "id" in fwdSender) {
          forwardFromChannelId = telegramChannelId(fwdSender.id);
          forwardFromChannelName =
            "displayName" in fwdSender ? (fwdSender.displayName as string) : undefined;
        }
      } catch {
        // forward.sender может бросить исключение (если нет ни fromId, ни fromName)
      }
    }

    // ADR-206 W5: Извлекаем t.me-ссылки из сообщения (подсказки для обнаружения каналов)
    // ADR-206 W5: Из текста сообщения извлекаем имена пользователей из t.me-ссылок
    // Правила Telegram username: 5-32 символа, начинается с [a-zA-Z_], состоит из [a-zA-Z0-9_]
    let tmeLinks: string[] | undefined;
    if (msgText) {
      const re = /(?:^|[\s(])(?:https?:\/\/)?t\.me\/([a-zA-Z_][\w]{4,31})(?=[\s).,!?]|$)/g;
      const usernames: string[] = [];
      for (let m = re.exec(msgText); m !== null; m = re.exec(msgText)) {
        usernames.push(m[1]); // Захватывающая группа [1] = чистое имя пользователя
      }
      if (usernames.length > 0) {
        tmeLinks = [...new Set(usernames)].slice(0, 5); // Дедупликация, не более 5 записей
      }
    }

    pushCanonicalPerturbation(
      buffer,
      {
        type: "new_message",
        channelId,
        contactId: contactId ?? undefined,
        isDirected,
        isContinuation,
        tick,
        // ADR-147 D5: Исходное время отправки сообщения (Unix-timestamp сервера Telegram).
        // nowMs для накопившихся сообщений использует исходное время → затухание effectiveUnread работает корректно.
        nowMs: ctx.date.getTime(),
        novelty: 0.5,
        displayName,
        chatDisplayName,
        chatType,
        messageText: msgText,
        senderName: sName,
        contentType,
        // WS-4: для ops-инцидента senderIsBot=false → mapper засчитает его как
        // directed (pending_directed++) и она ответит. Контакт остаётся ботом.
        senderIsBot: (senderIsBot && !opsIncident) || undefined,
        forwardFromChannelId,
        forwardFromChannelName,
        tmeLinks,
      },
      `message:${channelId}:${ctx.id}`,
    );

    // Запись в message_log (синхронизация FTS выполняется автоматически через триггеры SQLite).
    // ADR-119: Медиасообщения тоже сохраняются (sticker/voice/photo и т.д.), не только сообщения с текстом.
    // @see runtime/drizzle/0017_fts5_triggers.sql
    if (msgText || contentType !== "text") {
      try {
        getDb()
          .insert(messageLog)
          .values({
            tick,
            platform: "telegram",
            chatId: channelId,
            msgId: ctx.id,
            nativeChatId: chatId,
            nativeMsgId: String(ctx.id),
            stableMessageId: stableTransportMessageId("telegram", chatId, ctx.id),
            replyToMsgId: ctx.replyToMessage?.id ?? undefined,
            senderId: contactId ?? undefined,
            senderName: sName,
            text: msgText ?? null,
            isOutgoing: false,
            isDirected,
            mediaType: contentType === "text" ? undefined : contentType,
          })
          .run();
      } catch (e) {
        log.warn("Failed to write message_log", e);
      }
    }

    // ADR-260: Проекция фотоальбома группы.
    // Принимаем только фото из группы/супергруппы; фото из личных чатов в альбом не попадают.
    if (
      contentType === "photo" &&
      mediaUniqueFileId &&
      (chatType === "group" || chatType === "supergroup")
    ) {
      try {
        recordObservedGroupPhoto({
          fileUniqueId: mediaUniqueFileId,
          sourceChatId: Number(chatId),
          sourceMsgId: ctx.id,
          captionText: msgText ?? null,
          description: getCachedDescription(mediaUniqueFileId) ?? null,
          ocrText: getCachedOcrText(mediaUniqueFileId) ?? null,
          observedAtMs: ctx.date.getTime(),
        });
      } catch (e) {
        log.warn("Failed to index group photo album asset", e);
      }
    }

    // Bio cache: fire-and-forget получение bio для контактов/каналов, которых нет в кеше
    if (client) {
      if (contactId && !getCachedBio(contactId)) {
        fetchAndCacheBio(client, contactId).catch(() => {});
      }
      if (channelId && chatType !== "private" && !getCachedBio(channelId)) {
        fetchAndCacheBio(client, channelId).catch(() => {});
      }
    }
  });

  // Редактирование сообщения (рассматривается как обновление содержимого)
  // Исправление аудита: добавляем поля contactId/isDirected/messageText и т.д.,
  // чтобы детектирование safety_flag и обновление контактов в маппере работали корректно.
  dp.onEditMessage(async (ctx) => {
    // T-6: Фильтруем собственные отредактированные сообщения (аналогично onNewMessage)
    const senderId = ctx.sender ? String(ctx.sender.id) : null;
    if (senderId === getSelfId()) return;
    // Пропускаем системную сущность Telegram Replies (аналогично onNewMessage)
    if (senderId === "1271266957") return;

    const chatId = String(ctx.chat.id);
    const channelId = telegramChannelId(chatId);
    const contactId = senderId ? telegramContactId(senderId) : null;
    const tick = getCurrentTick();

    // Детектирование directed (аналогично onNewMessage)
    const isPrivate = ctx.chat instanceof User;
    let isReply = false;
    if (ctx.replyToMessage) {
      if (ctx.replyToMessage.sender) {
        const replySender = ctx.replyToMessage.sender;
        if ("id" in replySender && String(replySender.id) === getSelfId()) {
          isReply = true;
        }
      } else if (ctx.replyToMessage.id != null) {
        isReply = isOutgoingMsg(channelId, ctx.replyToMessage.id);
      }
    }
    let isMentioned = false;
    const selfUsername = getSelfUsername?.();
    if (selfUsername && ctx.entities) {
      for (const entity of ctx.entities) {
        if (entity.kind === "mention") {
          if (entity.text.toLowerCase() === `@${selfUsername.toLowerCase()}`) {
            isMentioned = true;
            break;
          }
        }
        if (entity.is("text_mention") && String(entity.params.userId) === getSelfId()) {
          isMentioned = true;
          break;
        }
      }
    }
    const isDirected = isPrivate || isReply || isMentioned;

    // chatType и displayName
    let chatType: ChatType = "private";
    if (ctx.chat instanceof Chat) {
      const ct = ctx.chat.chatType;
      chatType = ct === "channel" ? "channel" : ct === "supergroup" ? "supergroup" : "group";
    }
    const displayName = ctx.sender?.displayName;
    const msgText = ctx.text ? ctx.text.slice(0, 4096) : undefined;
    // H7: без senderIsBot правки ботов поднимали pending_directed → AI-AI реплай-луп.
    const senderIsBot = ctx.sender instanceof User && ctx.sender.isBot;

    pushCanonicalPerturbation(
      buffer,
      {
        type: "new_message",
        channelId,
        contactId: contactId ?? undefined,
        isDirected,
        senderIsBot,
        tick,
        novelty: 0.3, // Новизна редактирования ниже
        nowMs: ctx.date.getTime(),
        displayName,
        chatType,
        messageText: msgText, // Исправление аудита: детектирование safety_flag распространяется на отредактированные сообщения
      },
      `edit:${channelId}:${ctx.id}`,
    );
  });

  // История прочтения
  dp.onHistoryRead(async (ctx) => {
    const chatId = String(ctx.chatId);
    const channelId = telegramChannelId(chatId);
    const tick = getCurrentTick();

    pushCanonicalPerturbation(
      buffer,
      {
        type: "read_history",
        channelId,
        tick,
      },
      `read_history:${channelId}:${tick}`,
    );
  });

  // Статус онлайн пользователя
  dp.onUserStatusUpdate(async (ctx) => {
    const userId = String(ctx.userId);
    const contactId = telegramContactId(userId);
    const tick = getCurrentTick();

    pushCanonicalPerturbation(
      buffer,
      {
        type: "user_status",
        contactId,
        tick,
      },
      `user_status:${contactId}:${tick}`,
    );
  });

  // Реакция (кто-то лайкнул/отреагировал на сообщение)
  // Userbot получает updateMessageReactions (не updateBotMessageReaction, предназначенный только для ботов).
  // mtcute в parse-update.ts не разбирает это событие (default → null),
  // поэтому используем onRawUpdate для прямого захвата TL-объекта.
  dp.onRawUpdate(
    (_, upd) => upd._ === "updateMessageReactions",
    async (_client, upd, _peers) => {
      const raw = upd as tl.RawUpdateMessageReactions;
      const chatId = String(getMarkedPeerId(raw.peer));
      const channelId = telegramChannelId(chatId);
      const selfId = getSelfId();
      const tick = getCurrentTick();

      // Определяем actor (последнего отреагировавшего) по recentReactions.
      // updateMessageReactions не даёт actor напрямую, как Bot API —
      // предоставляются только агрегированные reactions + список последних отреагировавших.
      const recent = raw.reactions.recentReactions ?? [];
      // Берём последнюю непрочитанную запись как триггер (наиболее близко к реальному actor)
      const trigger = recent.find((r) => r.unread) ?? recent[0];
      const actorPeerId = trigger?.peerId;
      const actorId = actorPeerId ? String(getMarkedPeerId(actorPeerId)) : null;

      // Пропускаем собственную реакцию
      if (actorId === selfId) return;

      const contactId = actorId ? telegramContactId(actorId) : null;

      // Извлекаем emoji — берём первую валидную реакцию из агрегированных результатов
      const firstResult = raw.reactions.results[0];
      let emoji = "";
      if (trigger) {
        // Предпочитаем реакцию триггера
        const r = trigger.reaction;
        emoji = r._ === "reactionEmoji" ? r.emoticon : r._ === "reactionPaid" ? "⭐" : "custom";
      } else if (firstResult) {
        const r = firstResult.reaction;
        emoji = r._ === "reactionEmoji" ? r.emoticon : r._ === "reactionPaid" ? "⭐" : "custom";
      }

      if (emoji) {
        // ADR-78 F1: Reaction continuation — немедленная реакция после реплики Alice тоже будит evolve
        let isContinuation = false;
        if (channelId && G.has(channelId)) {
          const lastAliceActionMs = Number(G.getChannel(channelId).last_alice_action_ms ?? 0);
          if (lastAliceActionMs > 0 && Date.now() - lastAliceActionMs <= CONTINUATION_WAKEUP_MS) {
            isContinuation = true;
          }
        }

        pushCanonicalPerturbation(
          buffer,
          {
            type: "reaction",
            channelId,
            contactId: contactId ?? undefined,
            tick,
            emoji,
            messageId: raw.msgId,
            isContinuation,
            // ADR-147 D11: TL updateMessageReactions не имеет поля date,
            // поэтому исходное время реакции недоступно. Накопленные сценарии покрываются D4 isRecovering + D7 P1 cap.
          },
          `reaction:${channelId}:${raw.msgId}:${contactId ?? "unknown"}:${emoji}`,
        );
        log.debug("Reaction received (userbot raw)", {
          channelId,
          contactId,
          emoji,
          isContinuation,
        });
      }
    },
  );

  // M4: Изменение состава группы (вступление, выход, бан и т.д.)
  dp.onChatMemberUpdate(async (ctx) => {
    const chatId = String(ctx.chat.id);
    const channelId = telegramChannelId(chatId);
    const userId = String(ctx.user.id);
    const contactId = telegramContactId(userId);
    const tick = getCurrentTick();

    const updateType = ctx.type; // joined | left | kicked | added | ...

    // Детектирование self-kick/left: Alice сама кикнута или вышла → активно помечаем permanent unreachable
    const selfId = getSelfId();
    if (userId === selfId && (updateType === "kicked" || updateType === "left")) {
      if (G.has(channelId)) {
        G.setDynamic(channelId, "reachability_score", 0);
        G.setDynamic(channelId, "failure_type", "permanent");
        G.setDynamic(channelId, "pending_directed", 0);
        G.setDynamic(channelId, "mentions_alice", false);
        // F5: При кике/выходе немедленно завершаем активный диалог — предотвращаем зависание conversation-сущности на 45 минут
        terminateConversation(G, channelId);
        log.info("Self-kick/left detected — marked permanent unreachable", {
          channelId,
          updateType,
        });
      }
    }

    pushCanonicalPerturbation(
      buffer,
      {
        type: "chat_member_update",
        channelId,
        contactId,
        tick,
      },
      `chat_member_update:${channelId}:${contactId}:${updateType}:${tick}`,
    );

    log.debug("Chat member update", { channelId, contactId, updateType });
  });

  // Индикатор набора текста — пользователь печатает
  dp.onUserTyping(async (ctx) => {
    const chatId = String(ctx.chatId);
    const channelId = telegramChannelId(chatId);
    const userId = ctx.userId ? String(ctx.userId) : null;
    const contactId = userId ? telegramContactId(userId) : undefined;
    const tick = getCurrentTick();

    // Пропускаем собственный typing Alice
    if (userId === getSelfId()) return;

    // Typing-aware burst settle: фиксируем ТОЛЬКО реальный набор текста (status "typing" в mtcute
    // соответствует TL sendMessageTypingAction / sendMessageTextDraftAction; upload/record/sticker и
    // прочее сюда не попадают). chatId уже маркирован mtcute, поэтому channelId совпадает с
    // targetChannelId в orchestrator. Эфемерно, не персистится; обёрнуто — никогда не роняет хендлер.
    if (ctx.status === "typing") {
      try {
        recordTyping(channelId, contactId ?? null, Date.now());
      } catch (e) {
        log.warn("recordTyping failed (ignored)", e);
      }
    }

    pushCanonicalPerturbation(
      buffer,
      {
        type: "typing",
        channelId,
        contactId,
        tick,
        novelty: 0.05, // Крайне низкая новизна — typing не запускает perceive
      },
      `typing:${channelId}:${contactId ?? "unknown"}:${tick}`,
    );
  });
}
