/**
 * ADR-136: Eval 场景注册表 — 所有场景的统一导出。
 *
 * 新增场景文件后在此注册，runner 通过 ALL_SCENARIOS 获取。
 *
 * 场景分类：
 * - Category A (branches): ReAct 决策树分支覆盖
 * - Category B (apps): App Toolkit 调用正确性
 * - Category C (proactive): 主动联系决策质量
 * - Category D (ablation): ADR-137 消融实验子集
 * - Category E (boundary): BIBO 边界稳定性
 */
import type { EvalScenario } from "../types.js";
import { APP_SCENARIOS } from "./apps.js";
import { BOUNDARY_SCENARIOS } from "./boundary.js";
import { BRANCH_SCENARIOS } from "./branches.js";
import { PROACTIVE_SCENARIOS } from "./proactive.js";

export { ABLATION_SCENARIOS } from "./ablation.js";
export { APP_SCENARIOS } from "./apps.js";
export { BOUNDARY_SCENARIOS } from "./boundary.js";
export { BRANCH_SCENARIOS } from "./branches.js";
export { PROACTIVE_SCENARIOS } from "./proactive.js";

/** 全部评估场景。 */
export const ALL_SCENARIOS: readonly EvalScenario[] = [
  ...BRANCH_SCENARIOS,
  ...APP_SCENARIOS,
  ...PROACTIVE_SCENARIOS,
  ...BOUNDARY_SCENARIOS,
];
