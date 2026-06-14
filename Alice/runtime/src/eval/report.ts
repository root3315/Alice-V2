/**
 * ADR-136: Eval Report — вывод отчёта в терминал + экспорт в JSON.
 *
 * Отчёт строится из компонуемых функций рендеринга; CLI собирает их по потребности:
 * - renderScenarioLine — одна строка на сценарий (вызывается построчно при потоковом выводе)
 * - renderReport — полный отчёт (вызывается один раз при пакетном выводе)
 *
 * @see docs/adr/136-model-eval-suite.md
 */
import { writeFileSync } from "node:fs";

import type { AggregatedStat, EvalReport, ScenarioAggregateResult } from "./types.js";

// ── Константы ширины столбцов ──────────────────────────────────────────────────────────────

/** Ширина столбцов таблицы сценариев. Именованные константы устраняют магические числа. */
const COL = {
  id: 40,
  rate: 12,
  status: 8,
  duration: 10,
} as const;

/** Ширина столбцов таблицы статистики. */
const STAT_COL = {
  label: 28,
  tagLabel: 20,
  value: 8,
} as const;

const RULE_WIDTH = 63;

// ── Базовое форматирование ────────────────────────────────────────────────────────────

/** Дополняет строку пробелами справа до заданной ширины. */
function pad(str: string, width: number): string {
  return str.length >= width ? str : str + " ".repeat(width - str.length);
}

/** Форматирует долю прохождения как строку процентов. */
function pct(rate: number): string {
  return `${(rate * 100).toFixed(0)}%`;
}

/** Возвращает метку для терминала в зависимости от статуса прохождения. */
function mark(pass: boolean, cached?: boolean): string {
  if (cached) return "SKIP";
  return pass ? "PASS" : "FAIL";
}

// ── Компонуемые функции рендеринга ─────────────────────────────────────────────────────────

/** Рендерит заголовок таблицы сценариев + разделительную линию. */
export function renderScenarioTableHeader(): string {
  return [
    "── Scenarios ──────────────────────────────────────────────────",
    pad("  ID", COL.id) +
      pad("Pass Rate", COL.rate) +
      pad("Status", COL.status) +
      pad("Duration", COL.duration),
    `  ${"─".repeat(COL.id + COL.rate + COL.status + COL.duration - 4)}`,
  ].join("\n");
}

/**
 * Рендерит строку одного сценария + детали отказа (если есть).
 *
 * Может вызываться по отдельности в обратном вызове onScenarioComplete для потокового вывода.
 */
export function renderScenarioLine(s: ScenarioAggregateResult): string {
  const lines: string[] = [];

  const avgDuration =
    s.runs.length > 0 ? Math.round(s.runs.reduce((a, r) => a + r.duration, 0) / s.runs.length) : 0;

  lines.push(
    pad(`  ${s.scenarioId}`, COL.id) +
      pad(s.cached ? "—" : pct(s.passRate), COL.rate) +
      pad(mark(s.passAtK, s.cached), COL.status) +
      pad(s.cached ? "—" : `${avgDuration}ms`, COL.duration),
  );

  // Детали отказа
  if (!s.passAtK) {
    for (const run of s.runs) {
      if (!run.structural.pass) {
        for (const c of run.structural.checks) {
          if (!c.pass) {
            // process tier — только диагностическая информация, помечается как [diag], а не как сбой
            const prefix = c.tier === "process" ? "[diag]" : "FAIL";
            lines.push(`    └─ ${prefix} ${c.name}: expected=${c.expected}, actual=${c.actual}`);
          }
        }
      }
    }
  }

  return lines.join("\n");
}

/** Рендерит таблицу AggregatedStat (Branch Stats / Tag Stats). */
function renderStatTable(
  title: string,
  stats: Record<string, AggregatedStat>,
  labelWidth: number,
): string {
  const lines: string[] = [];
  const v = STAT_COL.value;

  lines.push(`── ${title} ${"─".repeat(RULE_WIDTH - title.length - 4)}`);
  lines.push(
    pad(`  ${title.split(" ")[0]}`, labelWidth) + pad("Pass", v) + pad("Total", v) + pad("Rate", v),
  );
  lines.push(`  ${"─".repeat(labelWidth + v * 3 - 4)}`);

  for (const [label, stat] of Object.entries(stats)) {
    lines.push(
      pad(`  ${label}`, labelWidth) +
        pad(String(stat.pass), v) +
        pad(String(stat.total), v) +
        pad(pct(stat.rate), v),
    );
  }

  return lines.join("\n");
}

/** Рендерит секцию Summary. */
function renderSummary(report: EvalReport): string {
  const testedScenarios = report.scenarios.filter((s) => !s.cached);
  const skippedScenarios = report.scenarios.filter((s) => s.cached);
  const totalRuns = testedScenarios.reduce((a, s) => a + s.runs.length, 0);
  const totalPass = testedScenarios.reduce(
    (a, s) => a + s.runs.filter((r) => r.structural.pass).length,
    0,
  );
  const overallRate = totalRuns > 0 ? totalPass / totalRuns : 0;
  const passAtKCount = report.scenarios.filter((s) => s.passAtK).length;

  const lines: string[] = [
    "═".repeat(RULE_WIDTH),
    `  Tested:   ${totalPass}/${totalRuns} runs passed (${pct(overallRate)})`,
  ];
  if (skippedScenarios.length > 0) {
    lines.push(`  Skipped:  ${skippedScenarios.length} scenarios (cached pass)`);
  }
  lines.push(`  pass@k:   ${passAtKCount}/${report.totalScenarios} scenarios`);
  lines.push("═".repeat(RULE_WIDTH));

  return lines.join("\n");
}

// ── Полный отчёт ──────────────────────────────────────────────────────────────

/**
 * Рендерит полный отчёт для терминала.
 *
 * Составляется из компонуемых функций — для потокового вывода можно вызывать подфункции по отдельности.
 */
export function renderReport(report: EvalReport): string {
  const sections: string[] = [];

  // Header
  sections.push(
    [
      "═".repeat(RULE_WIDTH),
      "  ADR-134 Model Eval Report",
      "═".repeat(RULE_WIDTH),
      `  Model:      ${report.model}`,
      `  Timestamp:  ${report.timestamp}`,
      `  Scenarios:  ${report.totalScenarios}`,
      `  Runs/each:  ${report.runsPerScenario}`,
    ].join("\n"),
  );

  // Scenario Table
  sections.push(renderScenarioTableHeader());
  for (const s of report.scenarios) {
    sections.push(renderScenarioLine(s));
  }

  // Intent Stats (ADR-138)
  sections.push(renderStatTable("Intent Stats", report.intentStats, STAT_COL.label));

  // Tag Stats
  sections.push(renderStatTable("Tag Stats", report.tagStats, STAT_COL.tagLabel));

  // Summary
  sections.push(renderSummary(report));

  return sections.join("\n\n");
}

// ── Экспорт в JSON ──────────────────────────────────────────────────────────────

/**
 * Экспортирует EvalReport в JSON-файл.
 *
 * Формат пути: runtime/eval-report-{timestamp}.json
 */
export function exportReportJson(report: EvalReport, path?: string): string {
  const filePath = path ?? `eval-report-${report.timestamp.replace(/[:.]/g, "-")}.json`;
  writeFileSync(filePath, JSON.stringify(report, null, 2), "utf-8");
  return filePath;
}
