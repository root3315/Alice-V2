/**
 * Blackboard Tick — ADR-142 公共 API。
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
// Bridge — 适配 orchestrator 接口
export { runTickSubcycle } from "./bridge.js";
// LLM 调用
export { callTickLLM } from "./callLLM.js";
// Prompt 构建
export {
  buildActionFooter,
  buildCapabilityGuide,
  buildTickPrompt,
  resolveWhisper,
  type TickPromptContext,
} from "./prompt-builder.js";
// 目标解析
export { buildContextVars, type ResolvedTarget, resolveTarget } from "./target.js";
// Tick 循环
export { type TickDeps, tick } from "./tick.js";
// 类型
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
