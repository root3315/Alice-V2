/**
 * Фабрика значений по умолчанию для сущностей — чистые функции, выделенные из WorldModel.addEntity().
 *
 * Каждая фабричная функция:
 *   1. Устанавливает поле-дискриминатор entity_type
 *   2. Заполняет значения по умолчанию уровня Core (гарантирует наличие не-? полей)
 *   3. Принимает partial для переопределения значений по умолчанию
 *
 * Преимущества выделения из addEntity() в отдельные функции:
 *   - Можно тестировать изолированно (без экземпляра WorldModel)
 *   - Устраняет приведения типов через Record<string, unknown>
 *   - Вызывающая сторона получает точный тип возврата
 *
 * @see docs/adr/154-world-model-rewrite.md
 */

import { THREAD_WEIGHTS } from "./constants.js";
import type {
  AgentAttrs,
  ChannelAttrs,
  ChatType,
  ContactAttrs,
  ConversationAttrs,
  FactAttrs,
  ThreadAttrs,
  ThreadWeight,
} from "./entities.js";

/**
 * Атрибуты по умолчанию для узла Agent (собственный узел).
 *
 * Значения по умолчанию: mood_valence=0, mood_set_ms=0 (нейтральное настроение, ещё не задано).
 */
export function agentDefaults(partial?: Partial<Omit<AgentAttrs, "entity_type">>): AgentAttrs {
  return {
    mood_valence: 0,
    mood_set_ms: 0,
    ...partial,
    entity_type: "agent",
  };
}

/**
 * Атрибуты по умолчанию для узла контакта.
 *
 * Значения по умолчанию: tier=150 (круг знакомых), last_active_ms=0, auth_level=0, interaction_count=0.
 */
export function contactDefaults(
  partial?: Partial<Omit<ContactAttrs, "entity_type">>,
): ContactAttrs {
  return {
    tier: 150,
    last_active_ms: 0,
    auth_level: 0,
    interaction_count: 0,
    ...partial,
    entity_type: "contact",
  };
}

/**
 * Атрибуты по умолчанию для узла канала.
 *
 * Специальная логика: если unread > 0 и данные EWMS отсутствуют, автоматически инициализирует аккумулятор EWMS.
 * @see docs/adr/150-ewms-exact-unread-decay.md §D1
 */
export type ChannelDefaultsInput = Partial<Omit<ChannelAttrs, "entity_type" | "chat_type">> &
  Pick<ChannelAttrs, "chat_type">;

export function isChatType(value: unknown): value is ChatType {
  return value === "private" || value === "group" || value === "supergroup" || value === "channel";
}

export function requireChannelDefaultsInput(
  id: string,
  attrs: Record<string, unknown>,
): ChannelDefaultsInput {
  if (!isChatType(attrs.chat_type)) {
    throw new Error(`channel ${id} is missing explicit chat_type`);
  }
  return attrs as ChannelDefaultsInput;
}

export function channelDefaults(partial: ChannelDefaultsInput): ChannelAttrs {
  const unread = partial.unread ?? 0;

  // ADR-150: EWMS согласован с unread — при инициализации считаем, что все сообщения только что поступили.
  let unread_ewms = partial.unread_ewms;
  let unread_ewms_ms = partial.unread_ewms_ms;
  if (unread > 0 && unread_ewms == null) {
    unread_ewms = unread;
    // H2: при рестарте берём ВРЕМЯ последнего входящего (persisted), а не Date.now() — иначе
    // EWMS-часы сбрасываются и P1-свежесть прыгает в пик после ребута. Новый канал (нет
    // last_incoming_ms) → now, как и было.
    const lastIncoming = Number((partial as { last_incoming_ms?: number }).last_incoming_ms ?? 0);
    unread_ewms_ms = lastIncoming > 0 ? lastIncoming : Date.now();
  }

  return {
    unread,
    tier_contact: 150,
    pending_directed: 0,
    last_directed_ms: 0,
    last_outgoing_text: "",
    consecutive_outgoing: 0,
    last_directed_text: "",
    habituation: 0,
    habituation_ms: 0,
    ...partial,
    // Поля EWMS переопределяются после spread partial, чтобы логика автоинициализации вступила в силу
    unread_ewms,
    unread_ewms_ms,
    entity_type: "channel",
  };
}

/**
 * Атрибуты по умолчанию для узла потока.
 *
 * Автоматически вычисляет w = THREAD_WEIGHTS[weight] из weight.
 * Значения по умолчанию: status="open", weight="minor", created_ms=Date.now(), deadline=Infinity.
 */
export function threadDefaults(partial?: Partial<Omit<ThreadAttrs, "entity_type">>): ThreadAttrs {
  const weight: ThreadWeight = partial?.weight ?? "minor";
  const w = THREAD_WEIGHTS[weight] ?? 1.0;

  return {
    status: "open",
    created_ms: Date.now(),
    deadline: Infinity,
    ...partial,
    // weight и w переопределяются после spread, чтобы w оставался согласованным с weight
    weight,
    w,
    entity_type: "thread",
  };
}

/**
 * Атрибуты по умолчанию для узла факта.
 *
 * ADR-154: переименование info_item → fact; тики created/last_access → wall-clock мс created_ms/last_access_ms.
 *
 * Значения по умолчанию: importance=0.5, stability=1.0, volatility=0.5, novelty=1.0,
 *         tracked=false, created_ms=Date.now(), last_access_ms=Date.now().
 */
export function factDefaults(partial?: Partial<Omit<FactAttrs, "entity_type">>): FactAttrs {
  const now = Date.now();
  return {
    importance: 0.5,
    stability: 1.0,
    last_access_ms: now,
    volatility: 0.5,
    tracked: false,
    created_ms: now,
    novelty: 1.0,
    ...partial,
    entity_type: "fact",
  };
}

/**
 * Атрибуты по умолчанию для узла диалоговой сессии.
 *
 * Значения по умолчанию: channel="", participants=[], state="pending", turn_state="open",
 *         pace=0, message_count=0, alice_message_count=0,
 *         start_ms=0, last_activity_ms=0.
 */
export function conversationDefaults(
  partial?: Partial<Omit<ConversationAttrs, "entity_type">>,
): ConversationAttrs {
  return {
    channel: "",
    participants: [],
    state: "pending",
    start_ms: 0,
    last_activity_ms: 0,
    turn_state: "open",
    pace: 0,
    message_count: 0,
    alice_message_count: 0,
    ...partial,
    entity_type: "conversation",
  };
}
