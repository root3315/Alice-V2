/**
 * Bio-кэш: получение bio/description Telegram-сущностей по требованию.
 *
 * Дизайн:
 * - Персистентность в БД (таблица bio_cache), TTL 3 дня
 * - Синхронное чтение (getCachedBio) — вызывается при построении snapshot, не блокирует
 * - Асинхронное получение (fetchAndCacheBio) — fire-and-forget при cache miss
 * - Использует globalLimiter для ограничения скорости запросов к Telegram API
 *
 * Когда происходит получение:
 * - Fire-and-forget при первом появлении нового контакта/канала в events.ts
 * - Cache miss при построении snapshot тоже запускает асинхронное получение (вступает в силу на следующем тике)
 */

import type { TelegramClient } from "@mtcute/node";
import { Long, type tl } from "@mtcute/node";
import { eq } from "drizzle-orm";
import { getDb } from "../db/connection.js";
import { bioCache } from "../db/schema.js";
import { CONTACT_PREFIX } from "../graph/constants.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("bio-cache");

/** TTL: 3 дня. */
const BIO_CACHE_TTL_MS = 3 * 24 * 3600_000;

export interface BioCacheEntry {
  bio: string | null;
  personalChannelId: number | null;
}

/**
 * Синхронно читает bio из кэша. Попадание и не истёк TTL → возвращает; промах или истёк → возвращает null.
 * Вызывающая сторона при null должна запустить асинхронный fetchAndCacheBio.
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
 * Записывает в кэш (UPSERT).
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
    // Тихая ошибка — cache miss не блокирует
  }
}

// ── Дедупликация активных запросов ──
// Предотвращает одновременный fetch одной и той же сущности несколько раз (events + snapshot запускаются одновременно)
const pendingFetches = new Set<string>();

/**
 * Асинхронно получает и кэширует bio сущности (fire-and-forget).
 *
 * - contact:XXX → users.getFullUser (получаем about + personalChannelId)
 * - channel:XXX → channels.getFullChannel (получаем about)
 *
 * Использует общий globalLimiter для Telegram API, не превышает лимиты.
 * При ошибке получения — тихо пропускает, повторит при следующем cache miss.
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
    // Ошибка API → не кэшируем, повторим при следующем запросе
    log.debug("Failed to fetch bio", { entityId, error: e instanceof Error ? e.message : e });
  } finally {
    pendingFetches.delete(entityId);
  }
}
