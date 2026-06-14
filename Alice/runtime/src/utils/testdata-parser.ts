/**
 * JSON-парсер экспорта Telegram Desktop (версия TS).
 *
 * Преобразует result.json в нормализованную последовательность TelegramEvent для воспроизводящих интеграционных тестов.
 * Соответствует основной логике разбора Python simulation/telegram_parser.py.
 *
 * @see simulation/telegram_parser.py
 */

import { readFileSync } from "node:fs";
import type { ChatType } from "../graph/entities.js";
import { WorldModel } from "../graph/world-model.js";

// ---------------------------------------------------------------------------
// Определения типов
// ---------------------------------------------------------------------------

export interface TelegramEvent {
  timestamp: number; // Unix epoch seconds
  kind: "message" | "service";
  channelId: string;
  senderId: string;
  senderName: string;
  messageId: number;
  replyTo: number | null;
  textLength: number;
}

export interface ParsedChat {
  chatName: string;
  chatType: string; // "personal_chat" | "private_supergroup" | "public_supergroup"
  chatId: string;
  events: TelegramEvent[];
  participants: Map<string, string>; // senderId -> senderName
}

// ---------------------------------------------------------------------------
// Извлечение поля text
// ---------------------------------------------------------------------------

/**
 * Извлекает длину текста из поля text в Telegram.
 * text может быть чистой строкой или массивом (string | {text: string})[].
 */
function extractTextLength(textField: unknown): number {
  if (typeof textField === "string") {
    return textField.length;
  }
  if (Array.isArray(textField)) {
    let total = 0;
    for (const part of textField) {
      if (typeof part === "string") {
        total += part.length;
      } else if (part && typeof part === "object" && "text" in part) {
        total += String(part.text).length;
      }
    }
    return total;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Маппинг chat_type
// ---------------------------------------------------------------------------

/** Отображает поле type из экспорта Telegram Desktop в ChatType WorldModel. */
function mapChatType(exportType: string): ChatType {
  switch (exportType) {
    case "personal_chat":
      return "private";
    case "private_supergroup":
      return "supergroup";
    case "public_supergroup":
      return "supergroup";
    case "private_group":
      return "group";
    default:
      return "group";
  }
}

// ---------------------------------------------------------------------------
// Основная функция разбора
// ---------------------------------------------------------------------------

export function parseTelegramExport(jsonPath: string): ParsedChat {
  const raw = readFileSync(jsonPath, "utf-8");
  const data = JSON.parse(raw);

  const chatName = data.name ?? "unknown";
  const chatType = data.type ?? "unknown";
  const chatId = String(data.id ?? 0);

  const events: TelegramEvent[] = [];
  const participants = new Map<string, string>();

  const messages = data.messages ?? [];
  for (const msg of messages) {
    const msgType = msg.type ?? "";
    let senderId = msg.from_id ?? "";
    let senderName = msg.from ?? "";

    // обрабатываем отсутствующую информацию об отправителе
    if (!senderId) {
      senderId = `unknown_${msg.id ?? 0}`;
    }
    if (!senderName) {
      senderName = senderId;
    }

    const timestamp = Number(msg.date_unixtime ?? "0");

    if (msgType === "message") {
      const textLength = extractTextLength(msg.text ?? "");
      const replyTo: number | null = msg.reply_to_message_id ?? null;

      events.push({
        timestamp,
        kind: "message",
        channelId: chatId,
        senderId,
        senderName,
        messageId: msg.id ?? 0,
        replyTo,
        textLength,
      });

      participants.set(senderId, senderName);
    } else if (msgType === "service") {
      events.push({
        timestamp,
        kind: "service",
        channelId: chatId,
        senderId,
        senderName,
        messageId: msg.id ?? 0,
        replyTo: null,
        textLength: 0,
      });
    }
  }

  // сортируем по timestamp
  events.sort((a, b) => a.timestamp - b.timestamp);

  return {
    chatName,
    chatType,
    chatId,
    events,
    participants,
  };
}

// ---------------------------------------------------------------------------
// Построение графа
// ---------------------------------------------------------------------------

/**
 * Строит WorldModel из ParsedChat.
 *
 * - Создаёт узел contact для каждого участника (начальное значение tier=150)
 * - Создаёт узел channel
 * - Создаёт рёбра отношения "joined" от каждого contact к channel
 * - Добавляет узел агента "self"
 */
export function buildGraphFromParsedChat(parsed: ParsedChat): WorldModel {
  const G = new WorldModel();

  // узел агента
  G.addAgent("self");

  // узел channel
  const chatType = mapChatType(parsed.chatType);
  G.addChannel(parsed.chatId, {
    unread: 0,
    tier_contact: 150,
    chat_type: chatType,
    pending_directed: 0,
    last_directed_ms: 0,
    display_name: parsed.chatName,
  });

  // узлы contact + рёбра отношений
  for (const [senderId, senderName] of parsed.participants) {
    G.addContact(senderId, {
      tier: 150,
      last_active_ms: 0,
      display_name: senderName,
      interaction_count: 0,
    });
    // отношение contact → channel
    G.addRelation(senderId, "joined", parsed.chatId);
    // m5: ребро социального отношения self → contact (обеспечивает связность графа, корректную работу Laplacian-распространения)
    G.addRelation("self", "stranger", senderId);
  }

  return G;
}
