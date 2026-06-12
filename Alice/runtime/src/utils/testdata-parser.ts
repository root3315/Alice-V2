/**
 * Telegram Desktop 导出 JSON 解析器（TS 版）。
 *
 * 将 result.json 转为标准化 TelegramEvent 序列，用于回放集成测试。
 * 对应 Python simulation/telegram_parser.py 的核心解析逻辑。
 *
 * @see simulation/telegram_parser.py
 */

import { readFileSync } from "node:fs";
import type { ChatType } from "../graph/entities.js";
import { WorldModel } from "../graph/world-model.js";

// ---------------------------------------------------------------------------
// 类型定义
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
// text 字段提取
// ---------------------------------------------------------------------------

/**
 * 从 Telegram 的 text 字段提取文本长度。
 * text 可能是纯 string，也可能是 (string | {text: string})[]。
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
// chat_type 映射
// ---------------------------------------------------------------------------

/** 将 Telegram Desktop 导出的 type 字段映射到 WorldModel 的 ChatType。 */
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
// 主解析函数
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

    // 处理缺失的 sender 信息
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

  // 按 timestamp 排序
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
// 图构建
// ---------------------------------------------------------------------------

/**
 * 从 ParsedChat 构建 WorldModel。
 *
 * - 为每个 participant 创建 contact 节点（tier=150 初始值）
 * - 创建 channel 节点
 * - 为每个 contact 创建到 channel 的 "joined" 关系边
 * - 添加 "self" agent 节点
 */
export function buildGraphFromParsedChat(parsed: ParsedChat): WorldModel {
  const G = new WorldModel();

  // agent 节点
  G.addAgent("self");

  // channel 节点
  const chatType = mapChatType(parsed.chatType);
  G.addChannel(parsed.chatId, {
    unread: 0,
    tier_contact: 150,
    chat_type: chatType,
    pending_directed: 0,
    last_directed_ms: 0,
    display_name: parsed.chatName,
  });

  // contact 节点 + 关系边
  for (const [senderId, senderName] of parsed.participants) {
    G.addContact(senderId, {
      tier: 150,
      last_active_ms: 0,
      display_name: senderName,
      interaction_count: 0,
    });
    // contact → channel 关系
    G.addRelation(senderId, "joined", parsed.chatId);
    // m5: self → contact 社交关系边（确保图连通性，Laplacian 传播正常工作）
    G.addRelation("self", "stranger", senderId);
  }

  return G;
}
