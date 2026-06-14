/**
 * Метаданные группы — роли администраторов + число участников + ограничения медиа.
 * Сохраняется в group-cache.db (SQLite), переживает перезапуск.
 */
import type { TelegramClient } from "@mtcute/node";

import {
  type AdminInfo,
  type ChatInfo,
  getCachedAdmins,
  getCachedChatInfo,
  setCachedAdmins,
  setCachedChatInfo,
} from "../../llm/group-cache.js";

/**
 * Получает карту администраторов группы (постоянный кэш SQLite + API fallback).
 * Для личных чатов (chatId > 0) сразу возвращает пустой Map.
 */
export async function getAdminMap(
  client: TelegramClient,
  chatId: number,
): Promise<Map<number, AdminInfo>> {
  if (chatId > 0) return new Map();

  // Попадание в постоянный кэш
  const cached = getCachedAdmins(chatId);
  if (cached) return cached;

  try {
    const members = await client.getChatMembers(chatId, { type: "admins" });
    const admins = new Map<number, AdminInfo>();
    for (const m of members) {
      if (m.status === "creator" || m.status === "admin") {
        admins.set(m.user.id, { status: m.status, title: m.title });
      }
    }
    setCachedAdmins(chatId, admins);
    return admins;
  } catch {
    return cached ?? new Map();
  }
}

/**
 * Получает метаданные группы (число участников + ограничения медиа, постоянный кэш SQLite + API fallback).
 * Использует лёгкий getChat (batched API) без необходимости getFullChat.
 */
export async function fetchChatInfo(
  client: TelegramClient,
  chatId: number,
): Promise<ChatInfo | null> {
  if (chatId > 0) return null;

  // Попадание в постоянный кэш
  const cached = getCachedChatInfo(chatId);
  if (cached) return cached;

  try {
    const chat = await client.getChat(chatId);
    const membersCount = chat.membersCount;
    const restrictions: string[] = [];
    const perms = chat.defaultPermissions;
    if (perms) {
      if (!perms.canSendVoices) restrictions.push("voice");
      if (!perms.canSendAudios) restrictions.push("audio");
      if (!perms.canSendStickers) restrictions.push("stickers");
      if (!perms.canSendGifs) restrictions.push("gifs");
      if (!perms.canSendPhotos) restrictions.push("photos");
      if (!perms.canSendVideos) restrictions.push("videos");
      if (!perms.canSendFiles) restrictions.push("files");
      if (!perms.canSendPolls) restrictions.push("polls");
    }
    const info: ChatInfo = { membersCount, restrictions, isAliceAdmin: false };
    setCachedChatInfo(chatId, info);
    return info;
  } catch {
    return cached ?? null;
  }
}

/**
 * IRC-стиль префикса роли — `@name` означает admin/owner.
 * Кастомный титул компактно помечается «»: `@name«главный»`.
 * Экономит ~10 tokens/строку против суффикса `[admin: титул]`.
 */
export function annotateSenderRole(
  senderName: string,
  senderId: number | undefined,
  adminMap: Map<number, AdminInfo>,
): string {
  if (!senderId) return senderName;
  const info = adminMap.get(senderId);
  if (!info) return senderName;
  return info.title ? `@${senderName}«${info.title}»` : `@${senderName}`;
}
