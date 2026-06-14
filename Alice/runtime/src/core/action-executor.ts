/**
 * Исполнитель действий — типы конфигурации среды выполнения + обнаружение разрывов обратной связи.
 *
 * ADR-214 Wave B: удалены мёртвые пайплайны RecordedAction / ExecutableResult / executeRecordedActions.
 * В shell-native архитектуре действия Telegram выполняются напрямую через Engine API HTTP внутри контейнера,
 * результаты выполнения отслеживаются строками completedActions (формат: "sent:chatId=X:msgId=Y" и т.п.).
 *
 * Сохранены:
 * - ActionRuntimeConfig (нужна тик-пайплайну)
 * - FeedbackGap + checkFeedbackGap (переписаны на основе completedActions)
 */

import type { ScriptExecutionResult } from "./script-execution.js";
import { hasCompletedSend } from "./script-execution.js";

// ═══════════════════════════════════════════════════════════════════════════
// ActionRuntimeConfig — конфигурация среды выполнения тик-пайплайна
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Подмножество конфигурации, необходимое impl-функциям в среде выполнения.
 * Извлечено из полного Config, чтобы action-executor не зависел от полного типа конфигурации.
 * @see src/telegram/action-types.ts — инжектируемые поля конфигурации ActionImplContext
 */
export interface ActionRuntimeConfig {
  ttsConfig: import("../telegram/action-types.js").TtsConfig;
  exaApiKey: string;
  musicApiBaseUrl: string;
  youtubeApiKey: string;
  timezoneOffset: number;
}

// ═══════════════════════════════════════════════════════════════════════════
// FeedbackGap — обнаружение разрыва петли обратной связи (на основе completedActions)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * ADR-43 P0: Проверяет, содержит ли результат выполнения скрипта необходимые директивы обратной связи.
 */
export interface FeedbackGap {
  hasSendMessage: boolean;
  hasObserveMood: boolean;
  hasRateOutcome: boolean;
  isMissing: boolean;
}

/**
 * ADR-43 P0: Обнаруживает разрыв петли обратной связи.
 *
 * ADR-214 Wave B: hasSendMessage определяется из completedActions (префикс "sent:"),
 * hasObserveMood/hasRateOutcome разбирается из dispatch-действий в completedActions.
 *
 * В shell-native архитектуре feel/rate_outcome выполняются через dispatch Engine API,
 * но не выводят управляющие строки __ALICE_ACTION__ — они являются внутренними обновлениями состояния, а не действиями Telegram.
 * Поэтому hasObserveMood/hasRateOutcome в текущей архитектуре всегда false.
 * Петля обратной связи подстраховывается автоматическим инжектом self_feel в processResult (ADR-199 W1.1).
 */
export function checkFeedbackGap(result: ScriptExecutionResult): FeedbackGap {
  const hasSendMessage = hasCompletedSend(result);
  // shell-native: dispatch-действия не выводят __ALICE_ACTION__, их нельзя обнаружить через completedActions.
  // Консервативная оценка: всегда считаем отсутствующими, подстраховка — автоинжект в processResult.
  const hasObserveMood = false;
  const hasRateOutcome = false;
  const isMissing = hasSendMessage && !hasObserveMood;

  return { hasSendMessage, hasObserveMood, hasRateOutcome, isMissing };
}
