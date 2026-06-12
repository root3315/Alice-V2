/**
 * ADR-137: 消融实验场景选集 — 从现有场景中挑选覆盖关键决策模式的子集。
 *
 * 选取原则（§D5）：
 * - 覆盖 7 种决策模式（私聊回复、群聊克制、共情、多步推理、工具使用、等待、群聊参与）
 * - 每种模式 2-3 个场景
 * - 场景的期望行为在三条件下应该产生可区分的差异
 *
 * @see docs/adr/137-pressure-field-ablation.md §D5
 */
import type { EvalScenario } from "../types.js";
import { APP_SCENARIOS } from "./apps.js";
import { BRANCH_SCENARIOS } from "./branches.js";

/**
 * 消融实验场景 ID 列表 — 按决策模式分组。
 *
 * | 决策模式          | 场景数 | 场景 ID                                            |
 * |-------------------|--------|----------------------------------------------------|
 * | 私聊直接回复       | 2      | branch.reply.direct, branch.baseline.greeting       |
 * | 群聊克制           | 3      | branch.silence.group_listen, branch.silence.group_debate, branch.observe_then_silence.already_answered |
 * | 共情回复           | 2      | branch.reply.emotional, branch.reply.burst_patience |
 * | 多步推理           | 2      | branch.observe.query_contact, branch.observe.query_topic |
 * | 工具使用           | 3      | branch.observe.calendar_app, app.weather.tomorrow, app.browser.search |
 * | 等待/沉默         | 2      | branch.wait.half_sentence, branch.stay.unfinished      |
 * | 群聊参与           | 2      | branch.reply.group_help, branch.reply.p5_high       |
 * | 合计              | 16     |                                                     |
 */
const ABLATION_SCENARIO_IDS: readonly string[] = [
  // 私聊直接回复（sanity check）
  "branch.reply.direct",
  "branch.baseline.greeting",
  // 群聊克制（Baseline 的 Rule 3 可能过度回复）
  "branch.silence.group_listen",
  "branch.silence.group_debate",
  "branch.observe_then_silence.already_answered",
  // 共情回复（voice instinct 是否提升情感适配）
  "branch.reply.emotional",
  "branch.reply.burst_patience",
  // 多步推理（gold examples 引导 observe 流程）
  "branch.observe.query_contact",
  "branch.observe.query_topic",
  // 工具使用（gold examples 对工具调用的引导效果）
  "branch.observe.calendar_app",
  "app.weather.tomorrow",
  "app.browser.search",
  // 等待/沉默（caution voice 是否提升克制能力）
  "branch.wait.half_sentence",
  "branch.stay.unfinished",
  // 群聊参与（situation lines 的群组上下文是否提升话题相关性）
  "branch.reply.group_help",
  "branch.reply.p5_high",
];

/** 从全量场景中筛选消融实验子集。 */
export function getAblationScenarios(): readonly EvalScenario[] {
  const idSet = new Set(ABLATION_SCENARIO_IDS);
  const all = [...BRANCH_SCENARIOS, ...APP_SCENARIOS];
  return all.filter((s) => idSet.has(s.id));
}

export const ABLATION_SCENARIOS = getAblationScenarios();
