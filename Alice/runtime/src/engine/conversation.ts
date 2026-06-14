/**
 * Управление жизненным циклом сущностей диалоговой сессии (ADR-26 §3).
 *
 * Conversation — четвёртый тип первичных сущностей графа (channel/contact/thread/conversation),
 * отслеживает состояние интерактивной сессии между Alice и контактом.
 *
 * Ортогонально Thread (тематическое измерение): Thread — это «помочь Bob с debug»,
 * Conversation — «этот DM-разговор с Bob сегодня днём».
 *
 * **Основной инвариант**: не более одного нетерминального (non-cooldown) диалога на канал.
 * Принудительно соблюдается через охранник создания — при нарушении старый диалог автоматически переходит в cooldown.
 *
 * Phase 1: чистые функции, без вызовов LLM, без записи в БД, потребляются только тестами.
 */

import { ALICE_SELF } from "../graph/constants.js";
import type { ChatType, ConversationState, TurnState } from "../graph/entities.js";
import { findActiveConversation, findClosingConversation } from "../graph/queries.js";
import type { WorldModel } from "../graph/world-model.js";
import { ChatTarget } from "../prompt/types.js";
import type { GraphPerturbation } from "../telegram/mapper.js";

// -- Константы -------------------------------------------------------------------

/** ADR-110: Таймаут состояния pending (секунды) — окно ожидания двойного рукопожатия в групповом чате. */
const N_PENDING_S = 300;
/** ADR-110: Время охлаждения closing → cooldown (секунды). */
const M_COOLDOWN_S = 600;
/** Таймаут closing для приватного чата (секунды): асинхронный IM-сценарий, 45 минут. */
const CLOSING_TIMEOUT_PRIVATE_S = 2700;
/** Таймаут closing для группового чата (секунды): быстрый темп группового диалога, 15 минут. */
const CLOSING_TIMEOUT_GROUP_S = 900;
/** Таймаут GC для диалога в cooldown (секунды): удаление сущности через 1 час. */
const COOLDOWN_GC_S = 3600;
/**
 * ADR-218 F3: TTL alice_turn (секунды).
 * Если alice_turn не получает новых сообщений дольше этого времени → истекает и переходит в open, рассеивая bypass isConversationContinuation.
 * 10 минут: если Alice так долго не отвечает, диалог больше не является срочным.
 */
const ALICE_TURN_TTL_S = 600;

// -- Внутренние утилиты ---------------------------------------------------------------

/**
 * Завершает все нетерминальные диалоги в указанном channel → cooldown.
 * Принудительно соблюдает инвариант «не более одного нетерминального диалога на channel».
 */
function terminateAllForChannel(G: WorldModel, channelId: string, _nowMs: number): void {
  for (const convId of G.getEntitiesByType("conversation")) {
    if (!G.has(convId)) continue;
    const attrs = G.getConversation(convId);
    if (attrs.channel !== channelId) continue;
    if (attrs.state === "cooldown") continue;
    G.updateConversation(convId, { state: "cooldown", turn_state: "closed" });
  }
}

// -- Создание -------------------------------------------------------------------

/**
 * Определяет, нужно ли создавать новую диалоговую сессию.
 *
 * Условие срабатывания: directed new_message в channel без активного диалога.
 * - Приватный чат: сразу переходит в opening, turnState=alice_turn
 * - Групповой чат: переходит в pending (двойное рукопожатие, ожидание подтверждения участия от Alice)
 *
 * **Охранник closing**: если в channel есть closing-диалог, directed-сообщение означает,
 * что собеседник снова привлекает Alice → переактивация вместо создания нового диалога.
 * Это предотвращает дефект F1 — тихое обходение обещания прощания leave.
 *
 * @returns ID созданного/переактивированного conversation, или null (не создавать)
 */
export function detectConversationStart(G: WorldModel, event: GraphPerturbation): string | null {
  // Обрабатываем только directed new_message
  if (event.type !== "new_message" || !event.isDirected) return null;
  if (!event.channelId) return null;

  // Уже есть активная сессия → не создавать
  if (findActiveConversation(G, event.channelId)) return null;

  const channelId = event.channelId;
  const nowMs = event.nowMs ?? Date.now();

  // Охранник closing: directed-сообщение от собеседника возвращает Alice → переактивируем старый диалог
  const closingConvId = findClosingConversation(G, channelId);
  if (closingConvId && G.has(closingConvId)) {
    G.updateConversation(closingConvId, {
      state: "active",
      turn_state: "alice_turn",
      last_activity_ms: nowMs,
      closing_since_ms: undefined,
      message_count: (G.getConversation(closingConvId).message_count ?? 0) + 1,
    });
    // Добавляем нового участника
    if (event.contactId) {
      const participants = G.getConversation(closingConvId).participants ?? [];
      if (!participants.includes(event.contactId)) {
        G.updateConversation(closingConvId, { participants: [...participants, event.contactId] });
        if (G.has(event.contactId)) {
          G.addRelation(event.contactId, "participates", closingConvId);
        }
      }
    }
    return closingConvId;
  }

  // Нет ни активного, ни closing → очищаем старые терминальные диалоги и создаём новый
  terminateAllForChannel(G, channelId, nowMs);

  const tick = event.tick;
  const convId = `conversation:${channelId}_${tick}`;
  const chatType = event.chatType;
  if (!chatType) {
    throw new Error(`conversation event for ${channelId} is missing explicit chatType`);
  }
  const isPrivate = chatType === "private";

  const initialState: ConversationState = isPrivate ? "opening" : "pending";
  const turnState: TurnState = isPrivate ? "alice_turn" : "open";

  const participants: string[] = [];
  if (event.contactId) participants.push(event.contactId);

  G.addConversation(convId, {
    channel: channelId,
    participants,
    state: initialState,
    start_ms: nowMs,
    last_activity_ms: nowMs,
    turn_state: turnState,
    pace: 0,
    message_count: 1,
    alice_message_count: 0,
  });

  // Рёбра отношений
  G.addRelation(convId, "happens_in", channelId);
  if (event.contactId && G.has(event.contactId)) {
    G.addRelation(event.contactId, "participates", convId);
  }

  return convId;
}

// -- Неявное создание диалога -----------------------------------------------------------

/**
 * Создаёт неявный диалог: собеседник продолжает общение без reply после недавнего сообщения Alice.
 *
 * Отличие от detectConversationStart:
 * - detectConversationStart требует isDirected=true (reply / @mention / приватный чат)
 * - createImplicitConversation срабатывает при isContinuation=true (канал, где Alice недавно говорила)
 *
 * **Охранник closing**: Alice уже попрощалась (closing) — неявного, не-directed сообщения
 * недостаточно для отмены обещания прощания → отказываем в создании. Только directed-сообщение может вернуть Alice.
 *
 * @returns ID созданного conversation, или null (не создавать)
 */
export function createImplicitConversation(G: WorldModel, event: GraphPerturbation): string | null {
  if (!event.channelId) return null;
  // Уже есть активная сессия → не создавать
  if (findActiveConversation(G, event.channelId)) return null;
  // Охранник closing: Alice уже попрощалась, отказываем в неявной переактивации (ключевое исправление F1)
  if (findClosingConversation(G, event.channelId)) return null;

  const channelId = event.channelId;
  const nowMs = event.nowMs ?? Date.now();

  // Очищаем старые терминальные диалоги
  terminateAllForChannel(G, channelId, nowMs);

  const tick = event.tick;
  const convId = `conversation:${channelId}_${tick}`;

  const participants: string[] = [];
  if (event.contactId) participants.push(event.contactId);

  // Неявный диалог сразу переходит в opening + alice_turn
  G.addConversation(convId, {
    channel: channelId,
    participants,
    state: "opening",
    start_ms: nowMs,
    last_activity_ms: nowMs,
    turn_state: "alice_turn",
    pace: 0,
    message_count: 1,
    alice_message_count: 0,
  });

  // Рёбра отношений
  G.addRelation(convId, "happens_in", channelId);
  if (event.contactId && G.has(event.contactId)) {
    G.addRelation(event.contactId, "participates", convId);
  }

  return convId;
}

// -- Внешнее завершение ---------------------------------------------------------------

/**
 * Завершает активный диалог в указанном channel (вызывается при kick/leave/permanent failure).
 * Напрямую переходит в cooldown + очищает pending_directed, минуя переходное состояние closing.
 */
export function terminateConversation(G: WorldModel, channelId: string): void {
  for (const convId of G.getEntitiesByType("conversation")) {
    if (!G.has(convId)) continue;
    const attrs = G.getConversation(convId);
    if (attrs.channel !== channelId) continue;
    if (attrs.state === "cooldown") continue;
    G.updateConversation(convId, { state: "cooldown", turn_state: "closed" });
  }
  if (G.has(channelId)) {
    G.updateChannel(channelId, { pending_directed: 0 });
  }
}

// -- Обновление -------------------------------------------------------------------

/**
 * Обновляет состояние существующей диалоговой сессии.
 *
 * Правила переходов состояний:
 * - pending + ответ Alice → opening (двойное рукопожатие завершено)
 * - opening + ответ собеседника → active
 * - active: обновление pace / turnState / activity tick
 */
export function updateConversation(G: WorldModel, convId: string, event: GraphPerturbation): void {
  if (!G.has(convId)) return;

  const attrs = G.getConversation(convId);
  const state = attrs.state;
  const _tick = event.tick;
  const nowMs = event.nowMs ?? Date.now();
  const isAlice = event.contactId === ALICE_SELF;

  // Обновляем время активности и счётчик сообщений
  const msgCount = attrs.message_count + 1;
  G.updateConversation(convId, { last_activity_ms: nowMs, message_count: msgCount });

  if (isAlice) {
    G.updateConversation(convId, { alice_message_count: attrs.alice_message_count + 1 });
  }

  // Добавляем нового участника (иммутабельное обновление, чтобы избежать случайной мутации на месте)
  const participants = attrs.participants ?? [];
  if (event.contactId && !participants.includes(event.contactId)) {
    G.updateConversation(convId, { participants: [...participants, event.contactId] });
    if (G.has(event.contactId)) {
      G.addRelation(event.contactId, "participates", convId);
    }
  }

  // ADR-110: pace (частота сообщений: messages / elapsed seconds)
  const startMs = Number(attrs.start_ms ?? nowMs);
  const elapsedS = Math.max(1, (nowMs - startMs) / 1000);
  G.updateConversation(convId, { pace: msgCount / elapsedS });

  // Переходы состояний
  if (state === "pending" && isAlice) {
    // Двойное рукопожатие: Alice ответила → opening
    G.updateConversation(convId, { state: "opening", turn_state: "other_turn" });
  } else if (state === "opening" && !isAlice) {
    // Собеседник ответил → active
    G.updateConversation(convId, { state: "active", turn_state: "alice_turn" });
  } else {
    // active / opening: обновляем turnState
    // Учёт группового чата: не-directed сообщение → open (нейтральное), без обязательства alice_turn.
    // Исправление: бинарная turn-модель в групповом чате заставляла Alice отвечать на каждое сообщение.
    // Только directed сообщения (reply/@mention) должны устанавливать alice_turn и обязательство отвечать.
    if (isAlice) {
      G.updateConversation(convId, { turn_state: "other_turn" });
    } else {
      const chatType = getChannelChatType(G, attrs.channel);
      const isGroupChat = ChatTarget.isGroupChat(chatType);
      const turnState = isGroupChat && !event.isDirected ? "open" : "alice_turn";
      G.updateConversation(convId, { turn_state: turnState });
    }
  }
}

// -- Динамика диалога ---------------------------------------------------------------

/**
 * ADR-110: Динамика диалога — инерция участия, производная от атрибутов существующего диалога.
 *
 * После того как pending_directed убывает до 0, Alice всё ещё должна сохранять вовлечённость
 * в активном диалоге, а не резко терять весь приоритет. Динамика естественно затухает:
 * - диалог простаивает → idleDecay стремится к 0
 * - диалог переходит в closing/cooldown → фильтр по состоянию сразу возвращает 0
 *
 * @param G граф-компаньон
 * @param channelId ID целевого канала
 * @param tick текущий tick
 * @param nowMs текущее настенное время (мс)
 * @returns значение динамики от 0 до 1. 0 = нет активного диалога или диалог остыл, 1 = интенсивный обмен.
 *
 * @see paper-five-dim/ Open Question 6: Conversation-Mode Pressure Accumulation
 */
export function conversationMomentum(
  G: WorldModel,
  channelId: string,
  _tick: number,
  nowMs: number = Date.now(),
): number {
  const convId = findActiveConversation(G, channelId);
  if (!convId || !G.has(convId)) return 0;

  const attrs = G.getConversation(convId);
  // Динамика есть только в состоянии opening/active (в pending участие ещё не подтверждено)
  if (attrs.state !== "active" && attrs.state !== "opening") return 0;

  // Взаимность: доля сообщений Alice, оптимум 0.5 (50/50 обмен)
  // ADR-158 Fix 4: totalMessages должен включать сообщения Alice.
  // message_count считает только входящие (incrementing в perceive updateConversation),
  // alice_message_count считает исходящие (incrementing в DECLARE_ACTION).
  // Старая формула totalMessages=message_count → aliceRate>1 → reciprocity становится отрицательной.
  const totalMessages = Math.max(1, (attrs.message_count ?? 0) + (attrs.alice_message_count ?? 0));
  const aliceRate = (attrs.alice_message_count ?? 0) / totalMessages;
  // Симметричный колокол: 0.5 → 1.0 (оптимальная взаимность), 0.0/1.0 → 0.0 (односторонняя доминация)
  const reciprocity = 1 - (2 * aliceRate - 1) ** 2;

  // ADR-110: Затухание при простое — период полураспада 600 секунд (10 минут)
  const lastActivityMs = Number(attrs.last_activity_ms ?? 0);
  const idleS = lastActivityMs > 0 ? Math.max(0, (nowMs - lastActivityMs) / 1000) : 0;
  const idleDecay = 0.5 ** (idleS / 600);

  // Дополнительный буст динамики в ход Alice (собеседник ждёт ответа)
  const turnBoost = attrs.turn_state === "alice_turn" ? 1.5 : 1.0;

  return Math.min(1, reciprocity * idleDecay * turnBoost);
}

// -- Жизненный цикл по tick ----------------------------------------------------------

/**
 * Запрашивает chat_type канала из графа.
 */
function getChannelChatType(G: WorldModel, channelId: string): ChatType | undefined {
  if (!G.has(channelId)) return undefined;
  return G.getChannel(channelId).chat_type;
}

/**
 * ADR-110: Проверяет таймауты диалоговых сессий каждый tick и продвигает автомат состояний.
 *
 * - pending + более N_PENDING_S секунд → cooldown (не установившаяся сессия истекла)
 * - active + более nClosingS секунд без сообщений → closing (записывается closing_since_ms)
 * - closing + более M_COOLDOWN_S секунд → cooldown
 * - cooldown + более COOLDOWN_GC_S секунд → удаление сущности (F7 GC)
 *
 * nClosingS динамически: max(baseTimeout, ceil(3 / pace_per_second))
 * baseTimeout: групповой чат 900s / приватный 2700s (F6, учёт типа чата)
 */
export function tickConversations(G: WorldModel, _tick: number, nowMs: number = Date.now()): void {
  for (const convId of G.getEntitiesByType("conversation")) {
    if (!G.has(convId)) continue;
    const attrs = G.getConversation(convId);
    const state = attrs.state;
    const lastActivityMs = Number(attrs.last_activity_ms ?? 0);
    const idleS = lastActivityMs > 0 ? Math.max(0, (nowMs - lastActivityMs) / 1000) : 0;

    if (state === "cooldown") {
      // F7: cooldown GC — удаляем терминальные диалоги старше 1 часа, чтобы граф не рос бесконечно
      if (idleS >= COOLDOWN_GC_S) {
        G.removeEntity(convId);
      }
      continue;
    }

    if (state === "pending") {
      if (idleS >= N_PENDING_S) {
        // ADR-90 W3: Очищаем остатки обязательств при закрытии — предотвращаем зависание turn_state в alice_turn
        G.updateConversation(convId, { state: "cooldown", turn_state: "closed" });
        // F9: Очищаем остатки pending_directed
        if (attrs.channel && G.has(attrs.channel)) {
          G.updateChannel(attrs.channel, { pending_directed: 0 });
        }
      }
    } else if (state === "opening" || state === "active") {
      // ADR-218 F3: TTL alice_turn — по истечении переходит в open, рассеивая bypass-сигнал.
      // Используем last_activity_ms как базу TTL: при установке alice_turn last_activity_ms синхронно обновляется,
      // при поступлении нового сообщения last_activity_ms обновляется → TTL автоматически сбрасывается.
      if (attrs.turn_state === "alice_turn" && idleS >= ALICE_TURN_TTL_S) {
        G.updateConversation(convId, { turn_state: "open" });
      }

      // pace: messages/second (основан на активном периоде, без учёта простоя)
      const startMs = Number(attrs.start_ms ?? 0);
      const lastActMs = Number(attrs.last_activity_ms ?? startMs);
      const msgCount = attrs.message_count ?? 0;
      const activePeriodS = startMs > 0 ? Math.max(1, (lastActMs - startMs) / 1000) : 1;
      const pacePerS = msgCount / activePeriodS;
      // F6: таймаут с учётом типа чата — групповой 15 минут, приватный 45 минут
      const chatType = getChannelChatType(G, attrs.channel);
      const baseTimeout = ChatTarget.isGroupChat(chatType)
        ? CLOSING_TIMEOUT_GROUP_S
        : CLOSING_TIMEOUT_PRIVATE_S;
      const nClosingS = Math.max(baseTimeout, pacePerS > 0 ? Math.ceil(3 / pacePerS) : 3600);
      if (idleS >= nClosingS) {
        // ADR-90 W3: При переходе в closing очищаем turn_state, обрывая сигнал isConversationContinuation
        G.updateConversation(convId, {
          state: "closing",
          turn_state: "closed",
          closing_since_ms: nowMs,
        });
        // F9: При переходе в closing очищаем остатки pending_directed
        if (attrs.channel && G.has(attrs.channel)) {
          G.updateChannel(attrs.channel, { pending_directed: 0 });
        }
      }
    } else if (state === "closing") {
      if (idleS >= M_COOLDOWN_S) {
        G.updateConversation(convId, { state: "cooldown" });
      }
    }
  }
}
