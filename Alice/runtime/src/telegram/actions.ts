/**
 * Слой выполнения действий Telegram: обёртки sendText, readHistory + глобальный rate-limiter.
 *
 * mtcute встроил автоматический откат FloodWait (middleware flood-waiter);
 * здесь rate-limiter — защита на уровне приложения: контролирует частоту запросов,
 * чтобы не провоцировать FloodWait.
 */

import { md } from "@mtcute/markdown-parser";
import type { Chat, ChatPreview, Message, StickerSet, TelegramClient } from "@mtcute/node";
import { InputMedia, Long, tl } from "@mtcute/node";
import { createLogger } from "../utils/logger.js";
import {
  rethrowTelegramActionFailure,
  TelegramActionError,
  type TelegramActionErrorCode,
} from "./errors.js";

const log = createLogger("actions");

/**
 * Ограничитель со скользящим окном.
 * Допускает не более maxRequests вызовов за windowMs.
 */
class SlidingWindowLimiter {
  private timestamps: number[] = [];
  /** Взаимное исключение через цепочку Promise: предотвращает гонку при конкурентном acquire. */
  private _queue: Promise<void> = Promise.resolve();

  constructor(
    private maxRequests: number,
    private windowMs: number,
  ) {}

  async acquire(): Promise<void> {
    // Сериализация: все acquire выстраиваются в очередь, исключая конкурентную гонку
    this._queue = this._queue.then(() => this._doAcquire());
    return this._queue;
  }

  private async _doAcquire(): Promise<void> {
    const now = Date.now();
    // Удаляем старые метки времени за пределами окна
    this.timestamps = this.timestamps.filter((t) => t > now - this.windowMs);

    if (this.timestamps.length >= this.maxRequests) {
      // Ждём, пока самая ранняя метка не выйдет за пределы окна
      const waitMs = this.timestamps[0] + this.windowMs - now;
      log.debug("Rate limit hit, waiting", { waitMs });
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      return this._doAcquire();
    }

    this.timestamps.push(now);
  }
}

// Глобальный rate-limiter: 30 запросов/минуту (консервативный безопасный предел для Telegram userbot)
const globalLimiter = new SlidingWindowLimiter(30, 60_000);

/**
 * Предобработка Markdown: покрывает шаблоны, не поддерживаемые mtcute md(), но генерируемые LLM.
 * - # Heading → **Heading** (заголовок → жирный)
 * - - item / * item → • item (список → символ)
 * - 1. item → • item (нумерованный список → символ)
 */
function preprocessMarkdown(text: string): string {
  return text
    .replace(/^#{1,6}\s+(.+)$/gm, "**$1**")
    .replace(/^[-*+]\s+/gm, "• ")
    .replace(/^\d+\.\s+/gm, "• ");
}

/**
 * Пытается разобрать текст как markdown в TextWithEntities.
 * Если entities присутствуют — возвращает результат разбора, иначе null (fallback на plain text).
 */
function tryParseMarkdown(text: string): { text: string; entities: tl.TypeMessageEntity[] } | null {
  try {
    const preprocessed = preprocessMarkdown(text);
    const parsed = md(preprocessed);
    if (parsed.entities && parsed.entities.length > 0) {
      return parsed as { text: string; entities: tl.TypeMessageEntity[] };
    }
  } catch {
    // Ошибка разбора → fallback на plain text
  }
  return null;
}

/**
 * Отправляет текстовое сообщение. Поддерживает опциональный mention entity
 * (настоящее @ упоминание, а не просто текст @username).
 * Автоматически определяет форматирование markdown (**bold**, `code`, [link](url) и т.д.),
 * если entities найдены — рендерит их.
 */
export async function sendText(
  client: TelegramClient,
  chatId: string | number,
  text: string,
  options: {
    replyToMsgId?: number;
    /** Forum: id топика (его корневого сообщения) — ответ уйдёт в этот топик, не в General. */
    topicId?: number;
    mentions?: Array<{ offset: number; length: number; userId: number }>;
  } = {},
): Promise<number | undefined> {
  await globalLimiter.acquire();

  const mdParsed = tryParseMarkdown(text);

  let sent: Message | undefined;
  try {
    if (options.mentions?.length) {
      const entities: tl.TypeMessageEntity[] = mdParsed ? [...mdParsed.entities] : [];
      for (const m of options.mentions) {
        // Используем messageEntityMentionName (userId: number); mtcute _normalizeInputText
        // автоматически конвертирует в inputMessageEntityMentionName + resolvePeer внутри sendText.
        // @see docs/reference/mtcute/ packages/core/src/highlevel/methods/misc/normalize-text.ts
        entities.push({
          _: "messageEntityMentionName",
          offset: m.offset,
          length: m.length,
          userId: m.userId,
        });
      }
      sent = await client.sendText(
        chatId,
        { text: mdParsed ? mdParsed.text : text, entities },
        { replyTo: options.replyToMsgId ?? options.topicId },
      );
    } else if (mdParsed) {
      sent = await client.sendText(chatId, mdParsed, { replyTo: options.replyToMsgId ?? options.topicId });
    } else {
      sent = await client.sendText(chatId, text, { replyTo: options.replyToMsgId ?? options.topicId });
    }
  } catch (err) {
    rethrowTelegramActionFailure(err, "send_text", { chatId: String(chatId) });
  }
  return sent?.id;
}

/**
 * Помечает канал как прочитанный (сообщения + mention + reaction).
 */
export async function markRead(client: TelegramClient, chatId: string | number): Promise<void> {
  await globalLimiter.acquire();
  // ADR-114 D3: одновременно сбрасываем счётчик непрочитанных mention, чтобы не накапливался badge
  await client.readHistory(chatId, { clearMentions: true });
  // Сбрасываем бейдж непрочитанных reaction — по той же логике: «увидел = прочитал»
  // Повторно используем тот же limiter acquire — readHistory и readReactions имеют одно намерение («пометить прочитанным»)
  try {
    await client.readReactions(chatId);
  } catch {
    // Ошибка readReactions не блокирует основной поток
  }
}

/**
 * Получает историю сообщений канала.
 */
export async function getHistory(
  client: TelegramClient,
  chatId: string | number,
  limit: number = 20,
): Promise<Message[]> {
  await globalLimiter.acquire();
  return client.getHistory(chatId, { limit });
}

/**
 * Добавляет emoji-реакцию на сообщение.
 */
export async function sendReaction(
  client: TelegramClient,
  chatId: string | number,
  msgId: number,
  emoji: string,
): Promise<void> {
  await globalLimiter.acquire();
  try {
    await client.sendReaction({
      chatId,
      message: msgId,
      emoji,
    });
  } catch (err) {
    rethrowTelegramActionFailure(err, "send_reaction", { chatId: String(chatId), msgId, emoji });
  }
}

// ── M2: Расширение пространства действий ─────────────────────────────────────────────────────

/**
 * Редактирует отправленное сообщение.
 */
export async function editMessage(
  client: TelegramClient,
  chatId: string | number,
  msgId: number,
  text: string,
): Promise<void> {
  await globalLimiter.acquire();
  try {
    const mdParsed = tryParseMarkdown(text);
    if (mdParsed) {
      await client.editMessage({
        chatId,
        message: msgId,
        text: { text: mdParsed.text, entities: mdParsed.entities },
      });
    } else {
      await client.editMessage({ chatId, message: msgId, text });
    }
  } catch (err) {
    // M8: классифицируем сбой как и другие действия (кик/forbidden → канал unreachable),
    // иначе сырой error мог привести к опасному ретраю в чат, откуда выгнали → риск бана.
    rethrowTelegramActionFailure(err, "edit_message", { chatId: String(chatId), msgId });
  }
}

/**
 * Пересылает сообщение в другой чат.
 */
export async function forwardMessage(
  client: TelegramClient,
  fromChatId: string | number,
  msgId: number,
  toChatId: string | number,
  options: { noAuthor?: boolean; noCaption?: boolean } = {},
): Promise<number | undefined> {
  await globalLimiter.acquire();
  let sent: Message[];
  try {
    sent = await client.forwardMessagesById({
      fromChatId,
      messages: [msgId],
      toChatId,
      noAuthor: options.noAuthor,
      noCaption: options.noCaption,
    });
  } catch (err) {
    rethrowTelegramActionFailure(err, "forward_message", {
      fromChatId: String(fromChatId),
      toChatId: String(toChatId),
      msgId,
    });
  }
  return sent[0]?.id;
}

export function classifyAlbumSourceError(error: unknown): TelegramActionErrorCode | null {
  if (tl.RpcError.is(error, "MESSAGE_ID_INVALID") || tl.RpcError.is(error, "MSG_ID_INVALID")) {
    return "album_source_missing";
  }
  if (
    tl.RpcError.is(error, "CHANNEL_PRIVATE") ||
    tl.RpcError.is(error, "CHAT_FORBIDDEN") ||
    tl.RpcError.is(error, "PEER_ID_INVALID") ||
    tl.RpcError.is(error, "CHAT_ID_INVALID") ||
    tl.RpcError.is(error, "USER_NOT_PARTICIPANT")
  ) {
    return "album_source_inaccessible";
  }
  if (tl.RpcError.is(error, "CHAT_FORWARDS_RESTRICTED")) {
    return "album_forward_restricted";
  }
  return null;
}

export async function uploadMessageMediaCopy(
  client: TelegramClient,
  fromChatId: string | number,
  msgId: number,
  toChatId: string | number,
  options: { caption?: string; replyToMsgId?: number } = {},
): Promise<number | undefined> {
  await globalLimiter.acquire();
  const msgs = await client.getMessages(fromChatId, [msgId]);
  const msg = msgs[0];
  if (!msg) {
    throw new TelegramActionError(
      "album_source_missing",
      `album source message ${msgId} not found`,
    );
  }
  const media = msg.media;
  if (!media) {
    throw new TelegramActionError(
      "album_source_missing",
      `album source message ${msgId} has no media`,
    );
  }
  const buffer = Buffer.from(
    await client.downloadAsBuffer(media as Parameters<typeof client.downloadAsBuffer>[0]),
  );
  const inputMedia = InputMedia.auto(buffer, { fileName: `album-${msgId}.jpg` });
  let sent: Message | undefined;
  try {
    sent = await client.sendMedia(toChatId, inputMedia, {
      caption: options.caption,
      replyTo: options.replyToMsgId,
    });
  } catch (err) {
    rethrowTelegramActionFailure(err, "upload_media_copy", {
      fromChatId: String(fromChatId),
      toChatId: String(toChatId),
      msgId,
    });
  }
  return sent?.id;
}

/**
 * Отправляет стикер (по file ID).
 */
export async function sendSticker(
  client: TelegramClient,
  chatId: string | number,
  fileId: string,
  options: { replyToMsgId?: number } = {},
): Promise<number | undefined> {
  await globalLimiter.acquire();
  let sent: Message | undefined;
  try {
    sent = await client.sendMedia(chatId, fileId, {
      replyTo: options.replyToMsgId,
    });
  } catch (err) {
    rethrowTelegramActionFailure(err, "send_sticker", { chatId: String(chatId), fileId });
  }
  return sent?.id;
}

/**
 * Закрепляет сообщение.
 */
export async function pinMessage(
  client: TelegramClient,
  chatId: string | number,
  msgId: number,
): Promise<void> {
  await globalLimiter.acquire();
  await client.pinMessage({ chatId, message: msgId });
}

/**
 * Отправляет/отменяет индикатор набора текста.
 * Не проходит через globalLimiter (не создаёт сообщений, не ограничен по частоте).
 */
export async function setTyping(
  client: TelegramClient,
  chatId: string | number,
  cancel = false,
): Promise<void> {
  await client.setTyping({
    peerId: chatId,
    status: cancel ? "cancel" : "typing",
  });
}

// ── M5: Полное расширение пространства действий ─────────────────────────────────────────────────

// ── Поиск ──

/**
 * Поиск сообщений внутри чата.
 */
export async function searchMessages(
  client: TelegramClient,
  chatId: string | number,
  query: string,
  limit = 20,
): Promise<Message[]> {
  await globalLimiter.acquire();
  const result = await client.searchMessages({ chatId, query, limit });
  return [...result];
}

/**
 * Глобальный поиск сообщений (по всем чатам).
 */
export async function searchGlobal(
  client: TelegramClient,
  query: string,
  limit = 20,
  onlyChannels = false,
): Promise<Message[]> {
  await globalLimiter.acquire();
  const result = await client.searchGlobal({ query, limit, onlyChannels });
  return [...result];
}

// ── Bot / Inline ──

/**
 * Получает список установленных наборов стикеров (только метаданные, без самих стикеров).
 */
export async function getInstalledStickers(client: TelegramClient): Promise<StickerSet[]> {
  await globalLimiter.acquire();
  return client.getInstalledStickers();
}

/**
 * Получает детали набора стикеров (включая список стикеров).
 * @param setId короткое имя или ID набора стикеров
 */
export async function getStickerSet(client: TelegramClient, setId: string): Promise<StickerSet> {
  await globalLimiter.acquire();
  return client.getStickerSet(setId);
}

/**
 * Нажимает кнопку inline keyboard бота (получает callback-ответ).
 */
export async function getCallbackAnswer(
  client: TelegramClient,
  chatId: string | number,
  msgId: number,
  data: string,
): Promise<{ message?: string; url?: string; alert?: boolean }> {
  await globalLimiter.acquire();
  const res = await client.getCallbackAnswer({ chatId, message: msgId, data });
  return {
    message: res.message,
    url: res.url,
    alert: res.alert,
  };
}

/**
 * Запрашивает результаты inline-бота.
 * Использует Raw TL вызов messages.getInlineBotResults.
 */
export async function getInlineBotResults(
  client: TelegramClient,
  botUsername: string,
  chatId: string | number,
  query: string,
): Promise<{
  queryId: Long;
  results: Array<{ id: string; title?: string; description?: string; type: string }>;
}> {
  await globalLimiter.acquire();
  const botPeer = await client.resolvePeer(botUsername);
  if (botPeer._ !== "inputPeerUser") throw new Error(`Bot ${botUsername} is not a user`);
  const bot: tl.TypeInputUser = {
    _: "inputUser",
    userId: botPeer.userId,
    accessHash: botPeer.accessHash,
  };
  const peer = await client.resolvePeer(chatId);
  const result = await client.call({
    _: "messages.getInlineBotResults",
    bot,
    peer,
    query,
    offset: "",
  });
  return {
    queryId: result.queryId,
    results: result.results.map((r: tl.TypeBotInlineResult) => ({
      id: r.id,
      title: "title" in r ? r.title : undefined,
      description: "description" in r ? r.description : undefined,
      type: r.type,
    })),
  };
}

/**
 * Отправляет результат запроса inline-бота.
 * Использует Raw TL вызов messages.sendInlineBotResult.
 */
export async function sendInlineBotResult(
  client: TelegramClient,
  chatId: string | number,
  queryId: Long,
  resultId: string,
): Promise<void> {
  await globalLimiter.acquire();
  const peer = await client.resolvePeer(chatId);
  await client.call({
    _: "messages.sendInlineBotResult",
    peer,
    queryId,
    id: resultId,
    randomId: new Long(
      Math.floor(Math.random() * 0xffffffff),
      Math.floor(Math.random() * 0x7fffffff),
    ),
  });
}

// ── Медиа / управление сообщениями ──

/**
 * Отправляет медиафайл (по file ID, с опциональным caption).
 */
export async function sendMedia(
  client: TelegramClient,
  chatId: string | number,
  fileId: string,
  options: { caption?: string; replyTo?: number } = {},
): Promise<Message> {
  await globalLimiter.acquire();
  return client.sendMedia(chatId, fileId, {
    caption: options.caption,
    replyTo: options.replyTo,
  });
}

/**
 * Отправляет опрос. Доступно только в группах/каналах (userbot в личке получит MEDIA_INVALID).
 */
export async function sendPoll(
  client: TelegramClient,
  chatId: string | number,
  question: string,
  answers: string[],
): Promise<Message> {
  await globalLimiter.acquire();
  return client.sendMedia(chatId, InputMedia.poll({ question, answers }));
}

/**
 * Удаляет сообщения (двусторонний отзыв).
 */
export async function deleteMessages(
  client: TelegramClient,
  chatId: string | number,
  ids: number[],
): Promise<void> {
  await globalLimiter.acquire();
  await client.deleteMessagesById(chatId, ids, { revoke: true });
}

/**
 * Получает конкретные сообщения по ID.
 */
export async function getMessages(
  client: TelegramClient,
  chatId: string | number,
  ids: number[],
): Promise<(Message | null)[]> {
  await globalLimiter.acquire();
  return client.getMessages(chatId, ids);
}

// ── Обнаружение групп ──

/**
 * Вступает в канал/группу. Поддерживает invite link, @username, числовой ID.
 * Если требуется одобрение администратора, возвращает { pending: true }.
 */
export async function joinChat(
  client: TelegramClient,
  chatIdOrLink: string | number,
): Promise<{ chat?: Chat; pending: boolean }> {
  await globalLimiter.acquire();
  // mtcute 0.30: client.joinChat возвращает результат {status, chat?}, а не сам Chat.
  // status "ok" → вступили (есть chat); иначе требуется одобрение админа → pending.
  const result = await client.joinChat(chatIdOrLink);
  return result.status === "ok" ? { chat: result.chat, pending: false } : { pending: true };
}

/**
 * Покидает канал/группу.
 */
export async function leaveChat(client: TelegramClient, chatId: string | number): Promise<void> {
  await globalLimiter.acquire();
  await client.leaveChat(chatId);
}

/**
 * Ищет публичные чаты (группы/каналы/пользователи).
 * Использует Raw TL вызов contacts.search.
 */
export async function searchPublicChats(
  client: TelegramClient,
  query: string,
  limit = 20,
): Promise<{
  users: Array<{ id: number; name: string }>;
  chats: Array<{ id: number; title: string }>;
}> {
  await globalLimiter.acquire();
  const res = await client.call({
    _: "contacts.search",
    q: query,
    limit,
  });
  return {
    users: res.users.map((u: tl.TypeUser) => ({
      id: "id" in u ? u.id : 0,
      name:
        "firstName" in u
          ? `${u.firstName ?? ""}${u.lastName ? ` ${u.lastName}` : ""}`.trim()
          : "Unknown",
    })),
    chats: res.chats.map((c: tl.TypeChat) => ({
      id: "id" in c ? c.id : 0,
      title: "title" in c ? (c.title ?? "") : "",
    })),
  };
}

/**
 * Предпросмотр информации о приватной группе (по invite link).
 */
export async function getChatPreview(
  client: TelegramClient,
  inviteLink: string,
): Promise<ChatPreview> {
  await globalLimiter.acquire();
  return client.getChatPreview(inviteLink);
}

/**
 * Получает рекомендации похожих каналов.
 */
export async function getSimilarChannels(
  client: TelegramClient,
  chatId: string | number,
): Promise<Chat[]> {
  await globalLimiter.acquire();
  const result = await client.getSimilarChannels(chatId);
  return [...result];
}

// ── Обнаружение команд бота ──

/**
 * Получает список команд указанного бота.
 * Использует users.getFullUser для получения botInfo.commands (работает для любого бота, не только собственного).
 */
export async function getBotCommands(
  client: TelegramClient,
  botId: string | number,
): Promise<Array<{ command: string; description: string }>> {
  await globalLimiter.acquire();
  const peer = await client.resolvePeer(botId);
  if (peer._ !== "inputPeerUser") throw new Error(`${botId} is not a user`);
  const inputUser: tl.TypeInputUser = {
    _: "inputUser",
    userId: peer.userId,
    accessHash: peer.accessHash,
  };
  const res = await client.call({ _: "users.getFullUser", id: inputUser });
  const botInfo = res.fullUser.botInfo;
  if (!botInfo?.commands) return [];
  return botInfo.commands.map((c: tl.RawBotCommand) => ({
    command: c.command,
    description: c.description,
  }));
}

// ── Управление аккаунтом ──

/**
 * Изменяет профиль Алисы (имя, фамилия, подпись/биография).
 * Поля с undefined не изменяются, пустая строка — очищает поле.
 */
export async function updateProfile(
  client: TelegramClient,
  opts: { firstName?: string; lastName?: string; about?: string },
): Promise<void> {
  await globalLimiter.acquire();
  await client.call({
    _: "account.updateProfile",
    ...(opts.firstName !== undefined && { firstName: opts.firstName }),
    ...(opts.lastName !== undefined && { lastName: opts.lastName }),
    ...(opts.about !== undefined && { about: opts.about }),
  });
}

/**
 * Читает последние сообщения из избранного (Saved Messages).
 */
export async function readSavedMessages(client: TelegramClient, limit = 10): Promise<Message[]> {
  await globalLimiter.acquire();
  return client.getHistory("me", { limit });
}

/**
 * Создаёт пригласительную ссылку для группы/канала.
 */
export async function createInviteLink(
  client: TelegramClient,
  chatId: number,
): Promise<{ link: string }> {
  await globalLimiter.acquire();
  const invite = await client.createInviteLink(chatId);
  return { link: invite.link };
}

// ── Голосовые сообщения ──

/**
 * ADR-88: Отправляет голосовое сообщение (OGG/Opus Buffer).
 * @param audioBuffer аудио Buffer в формате OGG/Opus
 */
export async function sendVoice(
  client: TelegramClient,
  chatId: string | number,
  audioBuffer: Buffer,
  options: { replyToMsgId?: number; duration?: number; topicId?: number } = {},
): Promise<number | undefined> {
  await globalLimiter.acquire();
  let sent: Message | undefined;
  try {
    sent = await client.sendMedia(
      chatId,
      InputMedia.voice(audioBuffer, {
        duration: options.duration,
        // Telegram требует OGG/Opus для отображения формы волны (стиль voice message)
        fileMime: "audio/ogg",
        fileName: "voice.ogg",
      }),
      { replyTo: options.replyToMsgId ?? options.topicId },
    );
  } catch (err) {
    rethrowTelegramActionFailure(err, "send_voice", { chatId: String(chatId) });
  }
  return sent?.id;
}

// ── Социальные инструменты ──

/**
 * Переводит текст сообщения.
 * @param toLang целевой язык (двухбуквенный код ISO 639-1, например "en", "ru")
 */
export async function translateMessage(
  client: TelegramClient,
  chatId: string | number,
  msgId: number,
  toLang: string,
): Promise<{ text: string }> {
  await globalLimiter.acquire();
  const res = await client.translateMessage({ chatId, message: msgId, toLanguage: toLang });
  return { text: res.text };
}

/**
 * Получает общие группы с указанным пользователем.
 */
export async function getCommonChats(
  client: TelegramClient,
  userId: string | number,
): Promise<Chat[]> {
  await globalLimiter.acquire();
  return client.getCommonChats(userId);
}

/**
 * Открепляет сообщение.
 */
export async function unpinMessage(
  client: TelegramClient,
  chatId: string | number,
  msgId: number,
): Promise<void> {
  await globalLimiter.acquire();
  await client.unpinMessage({ chatId, message: msgId });
}

// ── ADR-117 D7: Exa Browse ────────────────────────────────────────────────

/**
 * ADR-117 D7: Обёртка над Exa Search API.
 * @see https://docs.exa.ai/reference/search
 */
export async function exaFetch(
  query: string,
  apiKey: string,
): Promise<Array<{ title: string; url: string; text: string }>> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const resp = await fetch("https://api.exa.ai/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        query,
        type: "auto",
        numResults: 3,
        contents: { text: { maxCharacters: 3000 } },
      }),
      signal: controller.signal,
    });
    if (!resp.ok) {
      throw new Error(`Exa API error: ${resp.status} ${resp.statusText}`);
    }
    const data = (await resp.json()) as {
      results: Array<{ title: string; url: string; text: string }>;
    };
    return (data.results ?? []).map((r) => ({
      title: r.title ?? "",
      url: r.url ?? "",
      text: r.text ?? "",
    }));
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Обёртка над Exa Contents API для извлечения содержимого URL.
 * По списку URL возвращает заголовки страниц + исходный текст.
 * @see https://docs.exa.ai/reference/contents
 */
export async function exaExtract(
  urls: string[],
  apiKey: string,
): Promise<Array<{ title: string; url: string; text: string }>> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const resp = await fetch("https://api.exa.ai/contents", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
      },
      body: JSON.stringify({
        urls,
        text: { maxCharacters: 6000 },
        livecrawl: "fallback",
      }),
      signal: controller.signal,
    });
    if (!resp.ok) {
      throw new Error(`Exa Contents API error: ${resp.status} ${resp.statusText}`);
    }
    const data = (await resp.json()) as {
      results: Array<{ title: string; url: string; text: string }>;
    };
    return (data.results ?? []).map((r) => ({
      title: r.title ?? "",
      url: r.url ?? "",
      text: r.text ?? "",
    }));
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Sub-ReAct: подзапрос LLM для направленного реферирования.
 * Сжимает исходный текст URL в сфокусированное резюме, предотвращая переполнение контекста.
 *
 * @param content  исходный текст, извлечённый Exa
 * @param url      исходный URL
 * @param focus    опциональная точка фокуса (зачем Алисе читать эту страницу)
 * @returns сжатый текст резюме (~500 символов)
 */
export async function summarizeWebContent(
  content: string,
  url: string,
  focus?: string,
): Promise<string> {
  return llmSummarize({
    systemPrompt: [
      "You are a reading assistant. Summarize the web page content concisely.",
      "Rules:",
      "- Write in the SAME language as the page content (if Chinese, reply in Chinese; if English, reply in English).",
      "- Keep your summary under 500 characters.",
      "- Focus on facts, key findings, and concrete details — not meta-commentary.",
      "- If a focus question is provided, prioritize answering that question.",
      "- Do NOT start with 'This article...' or 'This page...' — just state the information.",
    ].join("\n"),
    userPrompt: [
      focus ? `Focus: ${focus}` : "",
      `URL: ${url}`,
      "",
      "--- Page Content ---",
      content.slice(0, 5000),
    ]
      .filter(Boolean)
      .join("\n"),
    fallback: content.slice(0, 800),
    caller: "summarizeWebContent",
  });
}

/**
 * Sub-ReAct: ответ на вопрос по результатам поиска.
 * Шаг синтеза действия google — сжимает несколько поисковых фрагментов в один прямой ответ.
 *
 * @param question  вопрос пользователя
 * @param sources   результаты поиска (title + url + text)
 * @returns текст синтезированного ответа (~500 символов)
 */
export async function synthesizeAnswer(
  question: string,
  sources: Array<{ title: string; url: string; text: string }>,
): Promise<string> {
  const sourcesText = sources
    .map((s, i) => `[${i + 1}] ${s.title}\n${s.url}\n${s.text}`)
    .join("\n\n");
  return llmSummarize({
    systemPrompt: [
      "You are a research assistant. Answer the question based ONLY on the provided sources.",
      "Rules:",
      "- Write in the SAME language as the question.",
      "- Keep your answer under 500 characters.",
      "- State facts directly — no meta-commentary like 'Based on the sources...'.",
      "- If sources conflict, note the disagreement briefly.",
      "- If sources don't contain the answer, say so honestly.",
    ].join("\n"),
    userPrompt: `Question: ${question}\n\n--- Sources ---\n${sourcesText}`,
    fallback: sources[0]?.text.slice(0, 800) ?? "",
    caller: "synthesizeAnswer",
    maxOutputTokens: 800,
  });
}

/** Внутренний: универсальный LLM-вызов для реферирования. */
async function llmSummarize(opts: {
  systemPrompt: string;
  userPrompt: string;
  fallback: string;
  caller: string;
  maxOutputTokens?: number;
}): Promise<string> {
  const { generateText } = await import("ai");
  const { selectProviderForFirstPass } = await import("../llm/client.js");

  const { provider, model } = selectProviderForFirstPass();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const { text } = await generateText({
      model: provider(model),
      system: opts.systemPrompt,
      prompt: opts.userPrompt,
      maxOutputTokens: opts.maxOutputTokens ?? 400,
      temperature: 0.3,
      abortSignal: controller.signal,
    });
    return text.trim();
  } catch (e) {
    log.warn(`${opts.caller} failed, returning fallback`, {
      error: e instanceof Error ? e.message : String(e),
    });
    return opts.fallback;
  } finally {
    clearTimeout(timeout);
  }
}

// ── ADR-114 D2: Распространение Mention ─────────────────────────────────────────────

/**
 * Получает список ID непрочитанных @mention сообщений.
 * Использует Raw TL messages.getUnreadMentions. Должен вызываться до markRead({ clearMentions }).
 *
 * Возвращает массив message ID (вызывающий использует getMessages или getMessageCluster для получения полных сообщений).
 * @see docs/adr/114-context-assembly-rehabilitation.md — D2
 */
export async function getUnreadMentionIds(
  client: TelegramClient,
  chatId: string | number,
  limit = 20,
): Promise<number[]> {
  await globalLimiter.acquire();
  try {
    const peer = await client.resolvePeer(chatId);
    const res = await client.call({
      _: "messages.getUnreadMentions",
      peer,
      offsetId: 0,
      addOffset: 0,
      limit,
      maxId: 0,
      minId: 0,
    });
    // Вариант messagesNotModified в tl.messages.TypeMessages не содержит поле messages
    if (res._ === "messages.messagesNotModified") return [];
    // Все остальные варианты (messages/messagesSlice/channelMessages) содержат messages: TypeMessage[]
    // Все варианты TypeMessage (message/messageEmpty/messageService) содержат id: number
    return res.messages.map((m) => m.id).filter((id) => id > 0);
  } catch (e) {
    log.warn("Failed to get unread mentions", e);
    return [];
  }
}
