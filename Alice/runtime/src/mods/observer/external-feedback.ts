import { resolveContactAndChannel } from "../../graph/constants.js";
import type { WorldModel } from "../../graph/world-model.js";
import { hasObligation, OBLIGATION_THRESHOLDS } from "../../pressure/signal-decay.js";

// -- V-1: якорь внешней обратной связи ----------------------------------------
// @see docs/adr/64-runtime-theory-alignment-audit.md §V-1
// Самооценка LLM — источник самоусиления в цикле запись-чтение. Внешние поведенческие сигналы служат якорем истины, калибруя rate_outcome.

export interface ExternalFeedback {
  score: number; // [-1, 1]
  confidence: number; // [0, 1] на основе числа доступных сигналов
  signals: string[];
}

/**
 * Вычисляет оценку внешней поведенческой обратной связи.
 *
 * Извлекает из атрибутов графа внешние поведенческие сигналы после actionMs:
 * 1. Ответил ли собеседник (last_active_ms > actionMs)
 * 2. Поставил ли собеседник reaction (last_reaction_ms > actionMs)
 * 3. Продолжился ли разговор (conversation state ∈ {opening, active})
 * 4. Написал ли собеседник Алисе первым (pending_directed > 0)
 *
 * Возвращает взвешенную среднюю оценку ∈ [-1, 1]; confidence основан на числе доступных сигналов.
 */
export function computeExternalFeedback(
  G: WorldModel,
  target: string,
  actionMs: number,
  nowMs: number,
): ExternalFeedback {
  const signals: string[] = [];
  let weightedSum = 0;
  let totalWeight = 0;

  // Разрешаем contact ID и channel ID
  const { contactId, channelId } = resolveContactAndChannel(target, (id) => G.has(id));

  // Сигнал 1: ответил ли собеседник после действия Алисы (вес 0.4 — сильнейший сигнал)
  if (contactId && G.has(contactId)) {
    const attrs = G.getContact(contactId);
    const lastActiveMs = attrs.last_active_ms ?? 0;
    if (lastActiveMs > actionMs) {
      // Собеседник ответил → положительная обратная связь
      signals.push("replied");
      weightedSum += 0.4 * 0.7;
      totalWeight += 0.4;
    } else if ((nowMs - actionMs) / 1000 > 600) {
      // Прошло более 600 секунд (10 ticks × 60 с) без ответа → слабая отрицательная обратная связь
      signals.push("no_reply");
      weightedSum += 0.4 * -0.3;
      totalWeight += 0.4;
    }
    // Менее 600 секунд после actionMs → ещё ждём, не учитываем
  }

  // Сигнал 2: поставил ли собеседник reaction (вес 0.2 — дешёвый, но однозначный)
  if (contactId && G.has(contactId)) {
    const attrs = G.getContact(contactId);
    const reactionMs = attrs.last_reaction_ms ?? 0;
    if (reactionMs > actionMs) {
      signals.push("reaction");
      weightedSum += 0.2 * 0.6;
      totalWeight += 0.2;
    }
  }

  // Сигнал 3: продолжился ли разговор (вес 0.25 — состояние разговора является важным контекстным сигналом)
  // Примечание: не используем findActiveConversation (возвращает только pending/opening/active);
  // нам нужно определять состояния closing/cooldown как отрицательные сигналы.
  if (channelId && G.has(channelId)) {
    // Отдаём приоритет наиболее активному разговору (active > opening > closing > cooldown)
    let bestConvState: string | null = null;
    const statePriority: Record<string, number> = {
      active: 4,
      opening: 3,
      closing: 2,
      cooldown: 1,
    };
    let bestPriority = 0;
    for (const convId of G.getEntitiesByType("conversation")) {
      const convAttrs = G.getConversation(convId);
      if (convAttrs.channel !== channelId) continue;
      const p = statePriority[convAttrs.state] ?? 0;
      if (p > bestPriority) {
        bestPriority = p;
        bestConvState = convAttrs.state;
      }
    }
    if (bestConvState === "active" || bestConvState === "opening") {
      signals.push("conversation_active");
      weightedSum += 0.25 * 0.5;
      totalWeight += 0.25;
    } else if (bestConvState === "closing" || bestConvState === "cooldown") {
      signals.push("conversation_ending");
      weightedSum += 0.25 * -0.4;
      totalWeight += 0.25;
    }
  }

  // Сигнал 4: написал ли собеседник Алисе первым (вес 0.15 — инициатива является сильным положительным сигналом)
  // ADR-124: используем hasObligation вместо pending_directed > 0
  // @see docs/adr/126-obligation-field-decay.md §D6
  if (channelId && G.has(channelId)) {
    if (hasObligation(G, channelId, nowMs, OBLIGATION_THRESHOLDS.signal)) {
      signals.push("directed_message");
      weightedSum += 0.15 * 0.8;
      totalWeight += 0.15;
    }
  }

  // Вычисляем итоговую оценку и уверенность
  const score = totalWeight > 0 ? Math.max(-1, Math.min(1, weightedSum / totalWeight)) : 0;
  // confidence = число доступных сигналов / 4 (максимальное число сигналов)
  const confidence = Math.min(1, signals.length / 4);

  return { score, confidence, signals };
}
