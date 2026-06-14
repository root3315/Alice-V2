/**
 * Вспомогательные функции запросов к графу.
 * Чистый обход графа без зависимости от слоя engine/; свободно импортируется из pressure/, mods/, engine/.
 */
import type { ConversationState } from "./entities.js";
import type { WorldModel } from "./world-model.js";

/**
 * Находит активную диалоговую сессию в канале.
 * Активная = state ∈ {pending, opening, active}
 */
export function findActiveConversation(G: WorldModel, channelId: string): string | null {
  for (const convId of G.getEntitiesByType("conversation")) {
    const attrs = G.getConversation(convId);
    if (attrs.channel !== channelId) continue;
    const state = attrs.state;
    if (state === "pending" || state === "opening" || state === "active") {
      return convId;
    }
  }
  return null;
}

/**
 * Находит диалог в канале в состоянии closing.
 * После leave / таймаута диалог переходит в closing → входящее directed-сообщение может его переактивировать.
 */
export function findClosingConversation(G: WorldModel, channelId: string): string | null {
  for (const convId of G.getEntitiesByType("conversation")) {
    const attrs = G.getConversation(convId);
    if (attrs.channel === channelId && attrs.state === "closing") {
      return convId;
    }
  }
  return null;
}

/**
 * Находит диалог с наивысшим приоритетом в канале, не находящийся в конечном состоянии (cooldown исключён).
 * Приоритет: active > opening > pending > closing.
 *
 * В отличие от findActiveConversation: возвращает диалог в состоянии closing,
 * делая ветку closing gateConversationAware и gateClosingConversation достижимыми.
 *
 * При инварианте единственного активного диалога возвращает не более одного;
 * сортировка по приоритету — защитная мера.
 */
export function findConversationForChannel(G: WorldModel, channelId: string): string | null {
  const PRIORITY: Record<ConversationState, number> = {
    active: 5,
    opening: 4,
    pending: 3,
    closing: 2,
    cooldown: 1, // наименьший приоритет, но всё ещё обнаруживается (gateConversationAware должен видеть период охлаждения)
  };

  let best: string | null = null;
  let bestPriority = 0;

  for (const convId of G.getEntitiesByType("conversation")) {
    const attrs = G.getConversation(convId);
    if (attrs.channel !== channelId) continue;
    const p = PRIORITY[attrs.state];
    if (p > bestPriority) {
      best = convId;
      bestPriority = p;
    }
  }
  return best;
}
