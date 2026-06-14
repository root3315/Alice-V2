/**
 * Разрешение цели + построение контекстных переменных — перенесено из act/prompt.ts.
 *
 * Листовые функции, разделяемые несколькими конвейерами:
 * - resolveTarget — разрешить социальный контекст цели из графа
 * - buildContextVars — построить контекстные переменные для выполнения скрипта
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
 * ADR-155: Конкретный интерфейс контекстных переменных песочницы (заменяет Record<string, unknown>).
 * @see docs/adr/155-branded-graph-id.md
 */
export interface ContextVars {
  [key: string]: unknown;
  TARGET_CHAT?: TelegramId;
  /** Только для внутреннего использования: deriveParams автоматически инжектирует contactId. В prompt не рендерится. */
  TARGET_CONTACT?: ContactNodeId;
  CHAT_NAME?: string;
  CONTACT_NAME?: string;
  ACTIVE_THREADS?: Array<{ id: string; title: string }>;
}

/**
 * ADR-172: Очистка raw graph ID из заголовков тредов.
 * Заменяет graph ID вида `anomaly_channel:-100xxx` / `evaluate_channel:-100xxx` на обобщённое обозначение.
 */
function sanitizeThreadTitle(title: string): string {
  // Заменяем ID формата channel:xxx и contact:xxx
  return title.replace(/(?:channel|contact):[+-]?\d+/g, "(chat)");
}

/** Разрешить социальный контекст цели из графа (объединяет общий поиск resolveDisplayName + buildActionFooter). */
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
 * ADR-70 P0.3: Построить полный набор контекстных переменных.
 * Все ID инжектируются через эту функцию — LLM не должен их угадывать.
 * @see docs/adr/155-branded-graph-id.md — интерфейс ContextVars
 */
export function buildContextVars(
  ctx: ActContext,
  item: ActionQueueItem,
  resolved: ResolvedTarget,
): ContextVars {
  // ADR-152: TARGET_CHAT использует нативный числовой ID Telegram (TelegramId),
  // система префиксов graph ID остаётся сугубо внутренней деталью реализации.
  const targetChat = item.target != null ? (extractNumericId(item.target) ?? undefined) : undefined;

  const vars: ContextVars = {
    TARGET_CHAT: targetChat,
    TARGET_CONTACT: resolved.contactId ?? undefined,
    CHAT_NAME: resolved.displayName,
    CONTACT_NAME: resolved.contactId ? resolved.displayName : undefined,
    ACTIVE_THREADS: undefined,
  };

  // Активные треды (используются вызовами self_topic_advance())
  // ADR-172: фильтруем оставшиеся raw graph ID в заголовках (channel:xxx / contact:xxx)
  // ADR-190: фильтруем системные треды, чтобы anomaly/evaluate не заняли все слоты ACTIVE_THREADS
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
