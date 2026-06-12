/**
 * 目标解析 + 上下文变量构建 — 从 act/prompt.ts 迁移。
 *
 * 被多个管线共享的叶子函数：
 * - resolveTarget — 从图中解析目标的社交上下文
 * - buildContextVars — 构建 脚本执行所需的上下文变量
 *
 * @see docs/adr/142-action-space-architecture/README.md
 */
import { typedQuery } from "../../core/query-helpers.js";
import {
  ensureChannelId,
  extractNumericId,
  resolveContactAndChannel,
} from "../../graph/constants.js";
import { readDisplayLabel } from "../../graph/dynamic-props.js";
import type { ChannelNodeId, ContactNodeId, TelegramId } from "../../graph/entities.js";
import type { WorldModel } from "../../graph/world-model.js";
import type { ActionQueueItem } from "../action-queue.js";
import type { ActContext } from "../react/orchestrator.js";

/**
 * ADR-155: 沙箱上下文变量的具体接口（替代 Record<string, unknown>）。
 * @see docs/adr/155-branded-graph-id.md
 */
export interface ContextVars {
  [key: string]: unknown;
  TARGET_CHAT?: TelegramId;
  /** 内部使用：deriveParams 自动注入 contactId。不渲染到 prompt。 */
  TARGET_CONTACT?: ContactNodeId;
  CHAT_NAME?: string;
  CONTACT_NAME?: string;
  ACTIVE_THREADS?: Array<{ id: string; title: string }>;
}

/**
 * ADR-172: 清理线程标题中的 raw graph ID。
 * 将 `anomaly_channel:-100xxx` / `evaluate_channel:-100xxx` 中的 graph ID 替换为泛称。
 */
function sanitizeThreadTitle(title: string): string {
  // 替换 channel:xxx 和 contact:xxx 格式的 ID
  return title.replace(/(?:channel|contact):[+-]?\d+/g, "(chat)");
}

/** 从图中解析目标的社交上下文（合并 resolveDisplayName + buildActionFooter 的共享查找）。 */
export interface ResolvedTarget {
  displayName: string;
  contactId: ContactNodeId | null;
  channelId: ChannelNodeId | null;
  relationType: string;
  tier: string;
}

export function resolveTarget(G: WorldModel, target: string): ResolvedTarget {
  const { contactId, channelId } = resolveContactAndChannel(target, (id) => G.has(id));
  if (contactId) {
    const attrs = G.getContact(contactId);
    return {
      displayName: String(attrs.display_name ?? "(someone)"),
      contactId,
      channelId,
      relationType: String(attrs.relation_type ?? ""),
      tier: String(attrs.tier ?? ""),
    };
  }
  const fallbackChannel = ensureChannelId(target);
  if (G.has(target)) {
    return {
      displayName: readDisplayLabel(G, target),
      contactId: null,
      channelId: fallbackChannel,
      relationType: "",
      tier: "",
    };
  }
  return {
    displayName: "(unknown chat)",
    contactId: null,
    channelId: fallbackChannel,
    relationType: "",
    tier: "",
  };
}

/**
 * ADR-70 P0.3: 构建完整上下文变量。
 * 所有 ID 通过此函数注入，LLM 不需要猜。
 * @see docs/adr/155-branded-graph-id.md — ContextVars 接口
 */
export function buildContextVars(
  ctx: ActContext,
  item: ActionQueueItem,
  resolved: ResolvedTarget,
): ContextVars {
  // ADR-152: TARGET_CHAT 使用 Telegram 原生数字 ID（TelegramId），
  // graph ID 前缀系统保持为纯内部实现细节。
  const targetChat = item.target != null ? (extractNumericId(item.target) ?? undefined) : undefined;

  const vars: ContextVars = {
    TARGET_CHAT: targetChat,
    TARGET_CONTACT: resolved.contactId ?? undefined,
    CHAT_NAME: resolved.displayName,
    CONTACT_NAME: resolved.contactId ? resolved.displayName : undefined,
    ACTIVE_THREADS: undefined,
  };

  // 活跃线程（供 self_topic_advance() 调用使用）
  // ADR-172: 过滤标题中残留的 raw graph ID（channel:xxx / contact:xxx）
  // ADR-190: 过滤 system thread，防止 anomaly/evaluate 占满 ACTIVE_THREADS 槽位
  const threads = typedQuery(ctx.dispatcher, "open_topics");
  if (threads && threads.length > 0) {
    vars.ACTIVE_THREADS = threads
      .filter((t) => t.source !== "system")
      .slice(0, 5)
      .map((t) => ({
        id: String(t.id),
        title: sanitizeThreadTitle(t.title),
      }));
  }

  return vars;
}
