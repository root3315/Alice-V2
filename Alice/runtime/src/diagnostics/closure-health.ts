/**
 * ADR-199 W4: Диагностика здоровья замкнутого цикла.
 *
 * Периодический аудит показателей структуры обратной связи:
 * - доля closure_depth≥1 (замкнутый цикл Action→State)
 * - покрытие feel() (включая auto-inject)
 * - покрытие отложенной оценки (замкнутый цикл Decision→Outcome)
 * - покрытие внешней обратной связи
 *
 * @see docs/adr/199-closure-feedback-structural-upgrade.md
 */
import { sql } from "drizzle-orm";

export interface ClosureHealthReport {
  /** Доля message-действий с closure_depth>0 [0,1]. */
  actionStateRatio: number;
  /** Покрытие feel() (включая auto-inject) [0,1]. */
  feelCoverage: number;
  /** Количество выполненных отложенных оценок. */
  deferredEvalCount: number;
  /** Доля действий с внешней обратной связью [0,1]. */
  externalFeedbackCoverage: number;
  /** Доля ненулевых auto_writeback [0,1]. */
  autoWritebackRatio: number;
  /** Общее состояние здоровья. */
  overallHealth: "healthy" | "degraded" | "broken";
  /** Список конкретных проблем. */
  issues: string[];
  /** Общее число message-действий в статистическом окне. */
  totalMessages: number;
}

/**
 * Вычисляет отчёт о здоровье замкнутого цикла.
 *
 * Подсчитывает показатели за последние windowTicks из action_log и deferred_outcome_log.
 */
export function computeClosureHealth(
  db: { all: <T>(query: ReturnType<typeof sql>) => T[] },
  windowTicks = 100,
): ClosureHealthReport {
  const issues: string[] = [];

  // Запрос message-действий за последние windowTicks
  const stats = db.all<{
    total: number;
    closed: number;
    feel_closed: number;
    has_auto: number;
  }>(sql`
    SELECT
      count(*) as total,
      sum(case when closure_depth > 0 then 1 else 0 end) as closed,
      sum(case
        when observation_gap = 0 or observation_gap is null then 1
        when json_valid(auto_writeback)
          and json_extract(auto_writeback, '$.feel') is not null then 1
        else 0
      end) as feel_closed,
      sum(case when auto_writeback is not null then 1 else 0 end) as has_auto
    FROM action_log
    WHERE action_type = 'message'
      AND tick > (SELECT coalesce(max(tick), 0) - ${windowTicks} FROM action_log)
  `);

  const row = stats[0] ?? { total: 0, closed: 0, feel_closed: 0, has_auto: 0 };
  const total = Number(row.total);

  if (total === 0) {
    return {
      actionStateRatio: 1,
      feelCoverage: 1,
      deferredEvalCount: 0,
      externalFeedbackCoverage: 0,
      autoWritebackRatio: 0,
      overallHealth: "healthy",
      issues: [],
      totalMessages: 0,
    };
  }

  const actionStateRatio = Number(row.closed) / total;
  const feelCoverage = Number(row.feel_closed) / total;
  const autoWritebackRatio = Number(row.has_auto) / total;

  // Статистика отложенной оценки
  const deferredStats = db.all<{ cnt: number }>(sql`
    SELECT count(*) as cnt
    FROM deferred_outcome_log
    WHERE tick > (SELECT coalesce(max(tick), 0) - ${windowTicks} FROM action_log)
  `);
  const deferredEvalCount = Number(deferredStats[0]?.cnt ?? 0);

  // Покрытие внешней обратной связи: доля message-действий с last_outcome_ms > last_alice_action_ms
  // Используем deferred_outcome_log count / total как приближение
  const externalFeedbackCoverage = Math.min(1, deferredEvalCount / total);

  // Определение состояния здоровья
  if (actionStateRatio < 0.5)
    issues.push(`closure_depth≥1 ratio critically low: ${(actionStateRatio * 100).toFixed(0)}%`);
  else if (actionStateRatio < 0.9)
    issues.push(
      `closure_depth≥1 ratio below target: ${(actionStateRatio * 100).toFixed(0)}% (target: 90%)`,
    );

  if (feelCoverage < 0.7)
    issues.push(`feel coverage critically low: ${(feelCoverage * 100).toFixed(0)}%`);
  else if (feelCoverage < 0.95)
    issues.push(`feel coverage below target: ${(feelCoverage * 100).toFixed(0)}% (target: 95%)`);

  const overallHealth: ClosureHealthReport["overallHealth"] =
    issues.length === 0
      ? "healthy"
      : issues.some((i) => i.includes("critically"))
        ? "broken"
        : "degraded";

  return {
    actionStateRatio,
    feelCoverage,
    deferredEvalCount,
    externalFeedbackCoverage,
    autoWritebackRatio,
    overallHealth,
    issues,
    totalMessages: total,
  };
}
