/**
 * 群组成员资格实时校验。
 *
 * 防止 Alice 向已离开/被踢的群发送消息（可触发 Telegram 封号）。
 * 通过 getChatMember("me") 实时验证，内存缓存避免频繁 API 调用。
 *
 * 两个消费者：
 * - orchestrator（initSlot 前拦截 → 省 LLM token）
 * - action-executor（executeTelegramAction 统一拦截 → 兜底安全网）
 */

import { MtPeerNotFoundError, type TelegramClient, tl } from "@mtcute/node";
import type { WorldModel } from "../graph/world-model.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("membership-guard");

// ─── 缓存 ────────────────────────────────────────────────────────────────

/** 缓存条目 */
interface CacheEntry {
  isMember: boolean;
  checkedMs: number;
}

const cache = new Map<string | number, CacheEntry>();

/** 已确认是成员：缓存 6 小时 */
const TTL_MEMBER_MS = 6 * 3600_000;
/** 确认不是成员：缓存 1 小时（允许重新加入后恢复） */
const TTL_NON_MEMBER_MS = 1 * 3600_000;

/** 暴露给测试 */
export function _clearMembershipCache(): void {
  cache.clear();
}

// ─── 核心 API ─────────────────────────────────────────────────────────────

/**
 * 检查 Alice 是否是指定群组的成员。
 * 先查缓存，miss 时调用 getChatMember("me")。
 *
 * @returns true = 是成员或无法确定（保守放行），false = 确定不是成员
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

  // mtcute 需要数字 ID 才能正确解析 peer，字符串会被当 username 查
  const numericId = typeof rawId === "string" ? Number(rawId) : rawId;
  if (typeof rawId === "string" && Number.isNaN(numericId)) {
    // 非数字字符串（如 username）→ 无法判定，放行
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
    // 结构化 RPC 错误匹配（不依赖 error.message 字符串）
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
    // mtcute peer 解析失败（数字 ID 在本地缓存中找不到对应 peer）
    if (e instanceof MtPeerNotFoundError) {
      cache.set(rawId, { isMember: false, checkedMs: now });
      log.info("Peer not found", { chatId: rawId });
      return false;
    }
    // 网络错误/限流/未知 RPC → 保守放行
    const msg = e instanceof Error ? e.message : String(e);
    log.info("Check failed, allowing send", { chatId: rawId, error: msg });
    return true;
  }
}

/**
 * 群组外发安全门：检查 graphId 对应的群组是否可达。
 *
 * 两层检查：
 * 1. 图状态快检（failure_type / reachability_score）— 零开销
 * 2. MTProto 实时校验（getChatMember）— 缓存命中时零开销
 *
 * 不是成员时自动标记 graph 为 permanent unreachable。
 *
 * @returns true = 已拦截（不可发送），false = 放行
 */
export async function isGroupOutboundBlocked(
  client: TelegramClient,
  G: WorldModel,
  graphId: string,
  rawId: string | number,
): Promise<boolean> {
  if (!G.has(graphId)) return false;
  const attrs = G.getChannel(graphId);

  // 仅检查群组和频道——私聊不受此限制
  // ADR-206: 频道也需要成员资格校验（Alice 可能被踢出频道）
  if (
    attrs.chat_type !== "supergroup" &&
    attrs.chat_type !== "group" &&
    attrs.chat_type !== "channel"
  )
    return false;

  // L1: 图状态快检
  if (attrs.failure_type === "permanent") return true;
  if ((attrs.reachability_score ?? 1) <= 0) return true;

  // L2: MTProto 实时校验
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
