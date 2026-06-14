/**
 * ADR-199 W3: Модуль отложенной обратной связи — системная отсроченная оценка внешней реакции после отправки сообщений.
 *
 * Решает разрыв контура Decision→Outcome:
 * - Внешняя обратная связь после реплики (ответили / проигнорировали) не записывалась с системной задержкой
 * - computeExternalFeedback вызывался только внутри rate_outcome
 *
 * Этот модуль периодически сканирует в evolveTick:
 * 1. Находит channel, где Alice недавно писала, но outcome ещё не оценён
 * 2. Вызывает computeExternalFeedback для вывода внешней обратной связи
 * 3. Записывает last_outcome_quality / last_outcome_ms / rv_trust
 *
 * @see docs/adr/199-closure-feedback-structural-upgrade.md
 */
import { getDb } from "../db/connection.js";
import { deferredOutcomeLog } from "../db/schema.js";
import { resolveContactAndChannel } from "../graph/constants.js";
import type { WorldModel } from "../graph/world-model.js";
import { computeExternalFeedback } from "../mods/observer/external-feedback.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("deferred-outcome");

/** Минимальное время ожидания перед отложенной оценкой (мс) — даём собеседнику достаточное окно для ответа. */
const MIN_DELAY_MS = 3 * 60 * 1000; // 3 минуты
/** Максимальное окно отложенной оценки (мс) — после этого времени оценка не производится. */
const MAX_DELAY_MS = 30 * 60 * 1000; // 30 минут
/** Порог достоверности внешней обратной связи — ниже этого значения не записываем (сигнал недостаточен). */
const MIN_CONFIDENCE = 0.2;

export interface PendingOutcome {
  channelId: string;
  contactId: string | null;
  actionMs: number;
  lastOutcomeMs: number;
}

export interface DeferredFeedbackResult {
  channelId: string;
  score: number;
  confidence: number;
  signals: string[];
  delayMs: number;
}

/**
 * Сканирует все channel и находит цели, где Alice недавно писала, но outcome ещё не оценён.
 *
 * Условия:
 * - last_alice_action_ms > last_outcome_ms (есть действие, но нет оценки)
 * - nowMs - last_alice_action_ms > MIN_DELAY_MS (минимальное время ожидания прошло)
 * - nowMs - last_alice_action_ms < MAX_DELAY_MS (максимальное окно не превышено)
 */
export function scanPendingOutcomes(G: WorldModel, nowMs: number): PendingOutcome[] {
  const pendings: PendingOutcome[] = [];
  for (const channelId of G.getEntitiesByType("channel")) {
    const ch = G.getChannel(channelId);
    const actionMs = ch.last_alice_action_ms ?? 0;
    const outcomeMs = ch.last_outcome_ms ?? 0;
    if (actionMs <= 0 || actionMs <= outcomeMs) continue;

    const elapsed = nowMs - actionMs;
    if (elapsed < MIN_DELAY_MS || elapsed > MAX_DELAY_MS) continue;

    const { contactId } = resolveContactAndChannel(channelId, (id) => G.has(id));
    pendings.push({ channelId, contactId, actionMs, lastOutcomeMs: outcomeMs });
  }
  return pendings;
}

/**
 * Выполняет отложенную оценку одного pending outcome:
 * 1. Вызывает computeExternalFeedback для вывода внешней обратной связи
 * 2. Записывает channel.last_outcome_quality / last_outcome_ms
 * 3. Опционально: тонкая корректировка contact.rv_trust
 * 4. Записывает в аудиторскую таблицу deferred_outcome_log
 */
export function evaluateDeferredOutcome(
  G: WorldModel,
  pending: PendingOutcome,
  nowMs: number,
  tick: number,
): DeferredFeedbackResult | null {
  const ext = computeExternalFeedback(G, pending.channelId, pending.actionMs, nowMs);

  // Достоверность слишком низкая (сигнал недостаточен) → пропускаем
  if (ext.confidence < MIN_CONFIDENCE) return null;

  const delayMs = nowMs - pending.actionMs;

  // Записываем в channel
  G.updateChannel(pending.channelId, {
    last_outcome_quality: ext.score,
    last_outcome_ms: nowMs,
  });

  // Записываем в contact (если существует и сигнал достаточен)
  // ADR-199: Отложенная обратная связь → тонкая корректировка вектора отношений — позволяем «последствиям мира» реально формировать отношения
  // trust: положительная обратная связь увеличивает доверие («мои слова восприняли серьёзно»), отрицательная снижает
  // respect: постоянное игнорирование → снижение respect («собеседник не воспринимает мои слова»)
  if (pending.contactId && G.has(pending.contactId)) {
    const contact = G.getContact(pending.contactId);
    const trustDelta = ext.score * 0.05;
    const currentTrust = contact.rv_trust ?? 0.5;
    // respect снижается только при отрицательной обратной связи (положительная не должна поднимать respect — «получить ответ» ≠ «быть уважаемым»)
    const respectDelta = ext.score < -0.2 ? ext.score * 0.03 : 0;
    const currentRespect = contact.rv_respect ?? 0.5;
    G.updateContact(pending.contactId, {
      last_outcome_quality: ext.score,
      last_outcome_ms: nowMs,
      rv_trust: Math.max(0, Math.min(1, currentTrust + trustDelta)),
      rv_trust_ms: nowMs,
      rv_respect: Math.max(0, Math.min(1, currentRespect + respectDelta)),
      rv_respect_ms: nowMs,
    });
  }

  // Записываем в журнал аудита
  try {
    getDb()
      .insert(deferredOutcomeLog)
      .values({
        tick,
        channelId: pending.channelId,
        actionMs: pending.actionMs,
        evaluationMs: nowMs,
        delayMs,
        score: ext.score,
        confidence: ext.confidence,
        signals: JSON.stringify(ext.signals),
      })
      .run();
  } catch (e) {
    log.warn("Failed to write deferred outcome log", e);
  }

  log.info("Deferred outcome evaluated", {
    channelId: pending.channelId,
    score: ext.score,
    confidence: ext.confidence,
    signals: ext.signals,
    delayMs,
  });

  return {
    channelId: pending.channelId,
    score: ext.score,
    confidence: ext.confidence,
    signals: ext.signals,
    delayMs,
  };
}
