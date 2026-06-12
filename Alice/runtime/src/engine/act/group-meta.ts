/**
 * 群组元信息 — 管理员角色 + 成员数 + 媒体限制。
 * 持久化到 group-cache.db（SQLite），重启不丢失。
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
 * 获取群聊管理员映射（SQLite 持久缓存 + API fallback）。
 * 私聊（chatId > 0）直接返回空 Map。
 */
export async function getAdminMap(
  client: TelegramClient,
  chatId: number,
): Promise<Map<number, AdminInfo>> {
  if (chatId > 0) return new Map();

  // 持久缓存命中
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
 * 获取群聊元信息（成员数 + 媒体限制，SQLite 持久缓存 + API fallback）。
 * 使用轻量 getChat（batched API），不需要 getFullChat。
 */
export async function fetchChatInfo(
  client: TelegramClient,
  chatId: number,
): Promise<ChatInfo | null> {
  if (chatId > 0) return null;

  // 持久缓存命中
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
