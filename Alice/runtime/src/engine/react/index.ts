/**
 * ReAct Pipeline — реализация с нуля (ADR-140).
 *
 * Заменяет основной цикл, построение prompt и обработку результата в директории act/.
 * Листовые модули (timeline, messages, presence, group-meta)
 * по-прежнему импортируются из act/.
 *
 * @see docs/adr/140-react-efficiency-architecture.md
 */

export { formatQueryObservations } from "../../telegram/query-observations.js";
export { extractRuntimeConfig } from "../act/runtime-config.js";
// Исправление
// Цикл обратной связи
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
  processResult,
  updateReachability,
} from "./feedback-arc.js";
// Основной цикл
export { type ActContext, startReActLoop } from "./orchestrator.js";
// Prompt — buildLayeredPrompt / callLLM перенесены в конвейер tick, больше не экспортируются отсюда
// Типы
export type { SubcycleResult } from "./types.js";
