/**
 * Поток ACT: берёт действие из ActionQueue → LLM генерирует shell-скрипт → shell-native executor выполняет.
 *
 * ADR-142: основной цикл перенесён в engine/tick/ (Blackboard Tick + SAA).
 * Данный файл сохранён как агрегирующий слой экспортов.
 *
 * @see docs/adr/142-action-space-architecture/README.md
 * @see docs/adr/140-react-efficiency-architecture.md
 */

// ── Основная точка входа ──────────────────────────────────────────────────────────────

export { type ActContext, startReActLoop as startActLoop } from "../react/orchestrator.js";

// ── Tick-конвейер (добавлен в ADR-142) ─────────────────────────────────────────────

export { runTickSubcycle } from "../tick/bridge.js";
export type { TickResult } from "../tick/types.js";

// ── Общие модули ──────────────────────────────────────────────────────────────

export { formatQueryObservations } from "../../telegram/query-observations.js";
export {
  type AdaptiveCooldownOpts,
  adaptiveGamma,
  classifyFailure,
  computeAdaptiveCooldown,
  computeEAProxy,
  type EngagementMetrics,
  type FailureSubtype,
  type FailureType,
  logPersonalityEvolution,
} from "../react/feedback-arc.js";
export { extractRuntimeConfig } from "./runtime-config.js";

// ── Листовые модули act/ ────────────────────────────────────────────────────────

export { buildActionFooter } from "../tick/prompt-builder.js";
export { EngagementSession } from "./engagement.js";
export { diffuseReplyChain } from "./messages.js";
export {
  type ActiveWatcher,
  type DeferredTurnOutcome,
  type EngagementSlot,
  MAX_CONCURRENT_ENGAGEMENTS,
  SWITCH_COST_MS,
  type WatchPlan,
} from "./scheduler.js";
