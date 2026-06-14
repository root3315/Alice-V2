/**
 * Построение и drain Blackboard — управление общим состоянием цикла tick.
 *
 * @see docs/adr/142-action-space-architecture/README.md
 */

import {
  emptyScriptExecutionResult,
  mergeScriptExecutionResults,
  type ScriptExecutionResult,
} from "../../core/script-execution.js";
import type { Blackboard, FeatureFlags, TickOutcome, TickResult, ToolCategory } from "./types.js";

/** Максимальное количество шагов по умолчанию. */
const DEFAULT_MAX_STEPS = 3;

/**
 * Создание Blackboard.
 */
export function createBlackboard(opts: {
  pressures: [number, number, number, number, number, number];
  voice: string;
  target: string | null;
  features: FeatureFlags;
  contextVars: Record<string, unknown>;
  maxSteps?: number;
}): Blackboard {
  return {
    pressures: opts.pressures,
    voice: opts.voice,
    target: opts.target,
    features: opts.features,
    contextVars: opts.contextVars,
    observations: [],
    execution: emptyScriptExecutionResult(),
    preparedCategories: new Set<ToolCategory>(),
    budget: {
      maxSteps: opts.maxSteps ?? DEFAULT_MAX_STEPS,
      usedSteps: 0,
    },
  };
}

/**
 * Обновление Blackboard — объединяет результат одного выполнения скрипта.
 */
export function updateBoard(board: Blackboard, result: ScriptExecutionResult): void {
  board.execution = mergeScriptExecutionResults([board.execution, result]);
  board.budget.usedSteps++;
}

/**
 * Определяет, должен ли цикл tick завершиться.
 * Возвращает null если можно продолжать, иначе возвращает причину выхода.
 */
export function isTerminal(board: Blackboard): TickOutcome | null {
  // бюджет исчерпан — возвращаем "terminal", а не "empty".
  // исчерпание бюджета = LLM использовал все раунды (обычно host непрерывно возобновляет из-за local follow-up / самокоррекции),
  // это не означает отсутствие вывода LLM. "empty" маппируется orchestrator в llm_failed,
  // вызывает экспоненциальную задержку + принудительное молчание, создавая мёртвую петлю в решениях о молчании.
  if (board.budget.usedSteps >= board.budget.maxSteps) {
    return "terminal";
  }

  return null;
}

/**
 * Drain Blackboard — преобразует состояние Blackboard в TickResult.
 * После вызова Blackboard не должен использоваться.
 *
 * @param episodeRounds ADR-232: количество возобновлений block внутри episode (дополнительные раунды, инициированные host).
 */
export function drainBoard(
  board: Blackboard,
  outcome: TickOutcome,
  durationMs: number,
  episodeRounds = 0,
): TickResult {
  return {
    outcome,
    observations: board.observations,
    execution: board.execution,
    stepsUsed: board.budget.usedSteps,
    preparedCategories: [...board.preparedCategories],
    duration: durationMs,
    episodeRounds,
    failureKind: board.failureKind,
  };
}
