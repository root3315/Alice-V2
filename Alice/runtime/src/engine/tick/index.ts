/**
 * Blackboard Tick — публичный API ADR-142.
 * @see docs/adr/142-action-space-architecture/README.md
 */

// Filter
export { collectAllTools } from "./affordance-filter.js";
// Blackboard
export {
  createBlackboard,
  drainBoard,
  isTerminal,
  updateBoard,
} from "./blackboard.js";
// Bridge — адаптер для интерфейса оркестратора
export { runTickSubcycle } from "./bridge.js";
// Вызов LLM
export { callTickLLM } from "./callLLM.js";
// Построение Prompt
export {
  buildActionFooter,
  buildCapabilityGuide,
  buildTickPrompt,
  resolveWhisper,
  type TickPromptContext,
} from "./prompt-builder.js";
// Разрешение цели
export { buildContextVars, type ResolvedTarget, resolveTarget } from "./target.js";
// Tick-цикл
export { type TickDeps, tick } from "./tick.js";
// Типы
export type {
  AffordanceDeclaration,
  AffordancePriority,
  Blackboard,
  FeatureFlags,
  TickBudget,
  TickOutcome,
  TickResult,
  TickStepOutput,
  ToolCategory,
  UnifiedTool,
} from "./types.js";
export {
  hasAffordance,
  registerToolCategory,
  TOOL_CATEGORIES,
  unregisterToolCategory,
} from "./types.js";
