/**
 * Проверка членства в группе в реальном времени.
 *
 * Предотвращает отправку сообщений Alice в группы, которые она покинула или из которых была исключена (может привести к блокировке Telegram-аккаунта).
 * Проверяется через getChatMember("me") в реальном времени; кэш в памяти снижает частоту вызовов API.
 *
 * Два потребителя:
 * - orchestrator (перехват до initSlot → экономия LLM-токенов)
 * - action-executor (единый перехват через executeTelegramAction → страховочная сеть)
 */

import { MtPeerNotFoundError, type TelegramClient, tl } from "@mtcute/node";
import type { WorldModel } from "../graph/world-model.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("membership-guard");

// ─── Кэш ────────────────────────────────────────────────────────────────

/** Запись кэша */
interface CacheEntry {
  isMember: boolean;
  checkedMs: number;
}

const cache = new Map<string | number, CacheEntry>();

/** Подтверждённое членство: кэш на 6 часов */
const TTL_MEMBER_MS = 6 * 3600_000;
/** Подтверждённое не-членство: кэш на 1 час (позволяет восстановить после повторного входа) */
const TTL_NON_MEMBER_MS = 1 * 3600_000;

/** Открыто для тестов */
export function _clearMembershipCache(): void {
  cache.clear();
}

// ─── Основное API ─────────────────────────────────────────────────────────────

/**
 * Проверяет, является ли Alice членом указанной группы.
 * Сначала проверяет кэш; при промахе вызывает getChatMember("me").
 *
 * @returns true = является членом или не удалось определить (пропускаем по умолчанию), false = точно не член
 */
export async function isGroupMember(
  client: TelegramClient,
  rawId: string | number,
): Promise<boolean> {
  const now = Date.now();
  const cached = cache.get(rawId);
  if (cached) {
    const ttl = cached.isMember ? TTL_MEMBER_MS : TTL_NON_MEMBER_MS;
    if (now - cached.checkedMs < ttl) return cached.isMember;
  }

  // mtcute требует числовой ID для корректного разрешения peer; строка воспринимается как username
  const numericId = typeof rawId === "string" ? Number(rawId) : rawId;
  if (typeof rawId === "string" && Number.isNaN(numericId)) {
    // Нечисловая строка (например, username) → не можем определить, пропускаем
    log.info("Non-numeric rawId, allowing send", { chatId: rawId });
    return true;
  }

  try {
    const member = await client.getChatMember({ chatId: numericId, userId: "me" });
    const isMember = member != null && member.status !== "left" && member.status !== "banned";
    cache.set(rawId, { isMember, checkedMs: now });
    if (!isMember) {
      log.info("Not a member", { chatId: rawId, status: member?.status ?? "null" });
    }
    return isMember;
  } catch (e) {
    // Структурированное сопоставление RPC-ошибок (без привязки к строке error.message)
    // @see docs/reference/mtcute/packages/core/src/highlevel/methods/chats/get-chat-member.ts
    if (
      tl.RpcError.is(e, "CHANNEL_PRIVATE") ||
      tl.RpcError.is(e, "USER_NOT_PARTICIPANT") ||
      tl.RpcError.is(e, "CHAT_FORBIDDEN") ||
      tl.RpcError.is(e, "PEER_ID_INVALID") ||
      tl.RpcError.is(e, "CHAT_ID_INVALID")
    ) {
      const rpc = e as tl.RpcError;
      cache.set(rawId, { isMember: false, checkedMs: now });
      log.info("RPC error indicates not a member", {
        chatId: rawId,
        rpc: rpc.text,
        code: rpc.code,
      });
      return false;
    }
    // Сбой разрешения peer в mtcute (числовой ID не найден в локальном кэше)
    if (e instanceof MtPeerNotFoundError) {
      cache.set(rawId, { isMember: false, checkedMs: now });
      log.info("Peer not found", { chatId: rawId });
      return false;
    }
    // Сетевая ошибка / рейт-лимит / неизвестный RPC → пропускаем по умолчанию
    const msg = e instanceof Error ? e.message : String(e);
    log.info("Check failed, allowing send", { chatId: rawId, error: msg });
    return true;
  }
}

/**
 * Защитный шлюз исходящих сообщений в группу: проверяет доступность группы по graphId.
 *
 * Двухуровневая проверка:
 * 1. Быстрая проверка состояния графа (failure_type / reachability_score) — без накладных расходов
 * 2. MTProto-проверка в реальном времени (getChatMember) — без накладных расходов при попадании в кэш
 *
 * Если не является членом — автоматически помечает граф как permanent unreachable.
 *
 * @returns true = заблокировано (отправка невозможна), false = разрешено
 */
export async function isGroupOutboundBlocked(
  client: TelegramClient,
  G: WorldModel,
  graphId: string,
  rawId: string | number,
): Promise<boolean> {
  if (!G.has(graphId)) return false;
  const attrs = G.getChannel(graphId);

  // Проверяем только группы и каналы — личные чаты не ограничены
  // ADR-206: каналы также требуют проверки членства (Alice может быть исключена из канала)
  if (
    attrs.chat_type !== "supergroup" &&
    attrs.chat_type !== "group" &&
    attrs.chat_type !== "channel"
  )
    return false;

  // L1: быстрая проверка состояния графа
  if (attrs.failure_type === "permanent") return true;
  if ((attrs.reachability_score ?? 1) <= 0) return true;

  // L2: MTProto-проверка в реальном времени
  const isMember = await isGroupMember(client, rawId);
  if (!isMember) {
    G.updateChannel(graphId, {
      reachability_score: 0,
      failure_type: "permanent",
      failure_subtype: "soft",
      pending_directed: 0,
      mentions_alice: false,
    });
    log.info("Outbound blocked — marked permanently unreachable", { chatId: graphId });
    return true;
  }
  return false;
}
