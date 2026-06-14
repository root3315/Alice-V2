/**
 * ADR-137: Подборка сценариев для абляционных экспериментов — подмножество существующих сценариев, охватывающее ключевые паттерны принятия решений.
 *
 * Принципы отбора (§D5):
 * - Охватывает 7 паттернов принятия решений (личный чат — ответ, групповой чат — сдержанность, эмпатия, многошаговые рассуждения, использование инструментов, ожидание, участие в группе)
 * - 2-3 сценария на каждый паттерн
 * - Ожидаемое поведение сценария должно давать различимые результаты при трёх условиях
 *
 * @see docs/adr/137-pressure-field-ablation.md §D5
 */
import type { EvalScenario } from "../types.js";
import { APP_SCENARIOS } from "./apps.js";
import { BRANCH_SCENARIOS } from "./branches.js";

/**
 * Список ID сценариев для абляционных экспериментов — сгруппирован по паттернам принятия решений.
 *
 * | Паттерн решений           | Кол-во | ID сценариев                                       |
 * |---------------------------|--------|----------------------------------------------------|
 * | Прямой ответ в личном чате | 2      | branch.reply.direct, branch.baseline.greeting       |
 * | Сдержанность в группе      | 3      | branch.silence.group_listen, branch.silence.group_debate, branch.observe_then_silence.already_answered |
 * | Эмпатичный ответ           | 2      | branch.reply.emotional, branch.reply.burst_patience |
 * | Многошаговые рассуждения   | 2      | branch.observe.query_contact, branch.observe.query_topic |
 * | Использование инструментов | 3      | branch.observe.calendar_app, app.weather.tomorrow, app.browser.search |
 * | Ожидание/молчание          | 2      | branch.wait.half_sentence, branch.stay.unfinished      |
 * | Участие в группе           | 2      | branch.reply.group_help, branch.reply.p5_high       |
 * | Итого                      | 16     |                                                     |
 */
const ABLATION_SCENARIO_IDS: readonly string[] = [
  // Прямой ответ в личном чате (sanity check)
  "branch.reply.direct",
  "branch.baseline.greeting",
  // Сдержанность в группе (Baseline Rule 3 может давать избыточные ответы)
  "branch.silence.group_listen",
  "branch.silence.group_debate",
  "branch.observe_then_silence.already_answered",
  // Эмпатичный ответ (улучшает ли voice instinct эмоциональное соответствие)
  "branch.reply.emotional",
  "branch.reply.burst_patience",
  // Многошаговые рассуждения (направляют ли gold examples процесс observe)
  "branch.observe.query_contact",
  "branch.observe.query_topic",
  // Использование инструментов (эффективность gold examples при вызовах инструментов)
  "branch.observe.calendar_app",
  "app.weather.tomorrow",
  "app.browser.search",
  // Ожидание/молчание (повышает ли caution voice способность к сдержанности)
  "branch.wait.half_sentence",
  "branch.stay.unfinished",
  // Участие в группе (улучшает ли групповой контекст situation lines тематическую релевантность)
  "branch.reply.group_help",
  "branch.reply.p5_high",
];

/** Выбирает подмножество для абляционных экспериментов из полного набора сценариев. */
export function getAblationScenarios(): readonly EvalScenario[] {
  const idSet = new Set(ABLATION_SCENARIO_IDS);
  const all = [...BRANCH_SCENARIOS, ...APP_SCENARIOS];
  return all.filter((s) => idSet.has(s.id));
}

export const ABLATION_SCENARIOS = getAblationScenarios();
