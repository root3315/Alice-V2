/**
 * Bio 缓存：按需获取 Telegram 实体的 bio/description。
 *
 * 设计：
 * - DB 持久化（bio_cache 表），TTL 3 天
 * - 同步读取（getCachedBio）—— snapshot 构建时调用，不阻塞
 * - 异步获取（fetchAndCacheBio）—— cache miss 时 fire-and-forget
 * - 使用 globalLimiter 共享 Telegram API 速率限制
 *
 * 获取时机：
 * - events.ts 中新联系人/新频道首次出现时 fire-and-forget
 * - snapshot 构建时 cache miss 也触发异步获取（下次 tick 生效）
 */

import type { TelegramClient } from "@mtcute/node";
import { Long, type tl } from "@mtcute/node";
import { eq } from "drizzle-orm";
import { getDb } from "../db/connection.js";
import { bioCache } from "../db/schema.js";
import { CONTACT_PREFIX } from "../graph/constants.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("bio-cache");

/** TTL: 3 天。 */
const BIO_CACHE_TTL_MS = 3 * 24 * 3600_000;

export interface BioCacheEntry {
  bio: string | null;
  personalChannelId: number | null;
}

/**
 * 从 cache 同步读取 bio。命中且未过期 → 返回；miss 或过期 → 返回 null。
 * 调用者在 null 时应触发异步 fetchAndCacheBio。
 */
export function getCachedBio(entityId: string): BioCacheEntry | null {
  try {
    const db = getDb();
    const row = db.select().from(bioCache).where(eq(bioCache.entityId, entityId)).get();
    if (!row) return null;
    if (Date.now() - row.fetchedAt.getTime() > BIO_CACHE_TTL_MS) return null;
    return { bio: row.bio, personalChannelId: row.personalChannelId };
  } catch {
    return null;
  }
}

/**
 * 写入 cache（UPSERT）。
 */
export function setCachedBio(
  entityId: string,
  bio: string | null,
  personalChannelId?: number | null,
): void {
  try {
    const db = getDb();
    db.insert(bioCache)
      .values({
        entityId,
        bio,
        personalChannelId: personalChannelId ?? null,
        fetchedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: bioCache.entityId,
        set: { bio, personalChannelId: personalChannelId ?? null, fetchedAt: new Date() },
      })
      .run();
  } catch {
    // 静默失败——cache miss 不阻塞
  }
}

// ── 进行中的获取去重 ──
// 防止同一实体被并发 fetch 多次（events + snapshot 同时触发）
const pendingFetches = new Set<string>();

/**
 * 异步获取并缓存实体 bio（fire-and-forget）。
 *
 * - contact:XXX → users.getFullUser（获取 about + personalChannelId）
 * - channel:XXX → channels.getFullChannel（获取 about）
 *
 * 共享 Telegram API globalLimiter，不会超速。
 * 获取失败静默跳过——下次 cache miss 重试。
 */
export async function fetchAndCacheBio(client: TelegramClient, entityId: string): Promise<void> {
  if (pendingFetches.has(entityId)) return;
  pendingFetches.add(entityId);

  try {
    if (entityId.startsWith(CONTACT_PREFIX)) {
      const numericPart = entityId.slice(CONTACT_PREFIX.length);
      const numId = Number(numericPart);
      if (Number.isNaN(numId)) return;

      const peer = await client.resolvePeer(numId);
      if (peer._ !== "inputPeerUser") return;
      const inputUser: tl.TypeInputUser = {
        _: "inputUser",
        userId: peer.userId,
        accessHash: peer.accessHash ?? Long.ZERO,
      };
      const res = await client.call({ _: "users.getFullUser", id: inputUser });
      const bio = res.fullUser.about ?? null;
      const personalChannelId =
        (res.fullUser as { personalChannelId?: number }).personalChannelId ?? null;
      setCachedBio(entityId, bio, personalChannelId);
      log.debug("Fetched user bio", { entityId, hasBio: !!bio });
    } else if (entityId.startsWith("channel:")) {
      const numericPart = entityId.slice("channel:".length);
      const numId = Number(numericPart);
      if (Number.isNaN(numId)) return;

      const peer = await client.resolvePeer(numId);
      if (peer._ !== "inputPeerChannel") return;
      const inputChannel: tl.TypeInputChannel = {
        _: "inputChannel",
        channelId: peer.channelId,
        accessHash: peer.accessHash ?? Long.ZERO,
      };
      const res = await client.call({ _: "channels.getFullChannel", channel: inputChannel });
      const fullChat = res.fullChat;
      const bio = "about" in fullChat ? ((fullChat.about as string) ?? null) : null;
      setCachedBio(entityId, bio);
      log.debug("Fetched channel bio", { entityId, hasBio: !!bio });
    }
  } catch (e) {
    // API 失败 → 不缓存，下次重试
    log.debug("Failed to fetch bio", { entityId, error: e instanceof Error ? e.message : e });
  } finally {
    pendingFetches.delete(entityId);
  }
}
