/**
 * Определения типов ReAct Pipeline — общие типы для всех модулей.
 *
 * @see docs/adr/140-react-efficiency-architecture.md
 */

// ── Типы, импортированные из старого кода + re-export (единственный источник истины) ──────────────────

export type { ScriptExecutionResult } from "../../core/script-execution.js";

import type { ScriptExecutionResult } from "../../core/script-execution.js";

export type { VoiceAction } from "../../voices/personality.js";
export type { ActionQueueItem } from "../action-queue.js";

// ── SubcycleResult: выходные данные подцикла ReAct ────────────────────────────────────

/**
 * Выходные данные подцикла ReAct. Поле outcome определяет ветку цикла engagement.
 *
 * ADR-214 Wave B: удалён re-export ExecutableResult/RecordedAction.
 */
export interface SubcycleResult {
  /** Причина выхода из подцикла — определяет следующую ветку в orchestrator. */
  outcome:
    | "waiting_reply"
    | "watching"
    | "terminal"
    | "empty"
    | "resting"
    | "fed_up"
    | "cooling_down"
    | "tc_budget_exhausted";
  /** Накопленные факты выполнения скриптов в рамках подцикла. */
  execution: ScriptExecutionResult;
  /** Общее время выполнения скриптов (миллисекунды). */
  duration: number;
  /** D5: фактически использованное количество раундов ReAct (счёт от 0). */
  roundsUsed: number;
  /** ADR-232: количество возобновлений TC внутри episode (дополнительные раунды вызовов LLM, инициированные host). */
  episodeRounds: number;
  /** ADR-235: метаданные наблюдаемости цикла TC. */
  tcMeta?: import("../tick/types.js").TickTcMeta;
  /** Классификация сбоя вызова LLM. */
  failureKind?: import("../tick/callLLM.js").TickFailureKind;
}
