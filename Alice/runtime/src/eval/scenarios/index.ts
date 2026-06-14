/**
 * ADR-136: Реестр eval-сценариев — единый экспорт всех сценариев.
 *
 * После добавления нового файла сценариев зарегистрировать здесь; runner получает через ALL_SCENARIOS.
 *
 * Категории сценариев:
 * - Category A (branches): покрытие ветвей дерева решений ReAct
 * - Category B (apps): корректность вызовов App Toolkit
 * - Category C (proactive): качество решений о проактивном контакте
 * - Category D (ablation): подмножество аблационных экспериментов ADR-137
 * - Category E (boundary): стабильность границ BIBO
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

/** Все оценочные сценарии. */
export const ALL_SCENARIOS: readonly EvalScenario[] = [
  ...BRANCH_SCENARIOS,
  ...APP_SCENARIOS,
  ...PROACTIVE_SCENARIOS,
  ...BOUNDARY_SCENARIOS,
];
