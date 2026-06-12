/**
 * ReAct Pipeline — Clean-room 实现（ADR-140）。
 *
 * 替代 act/ 目录的核心循环、prompt 构建、结果处理。
 * 叶子模块（timeline, messages, presence, group-meta）
 * 仍从 act/ 导入。
 *
 * @see docs/adr/140-react-efficiency-architecture.md
 */

export { formatQueryObservations } from "../../telegram/query-observations.js";
export { extractRuntimeConfig } from "../act/runtime-config.js";
// 修正
// 反馈闭环
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
// 核心循环
export { type ActContext, startReActLoop } from "./orchestrator.js";
// Prompt — buildLayeredPrompt / callLLM 已迁入 tick 管线，不再从此处导出
// 类型
export type { SubcycleResult } from "./types.js";
