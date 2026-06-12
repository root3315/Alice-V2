/**
 * ADR-136: Eval Report — 终端报告输出 + JSON 导出。
 *
 * 报告由可组合的渲染函数构成，CLI 可按需组装：
 * - renderScenarioLine — 单场景一行（流式输出时逐行调用）
 * - renderReport — 完整报告（批量输出时一次调用）
 *
 * @see docs/adr/136-model-eval-suite.md
 */
import { writeFileSync } from "node:fs";

import type { AggregatedStat, EvalReport, ScenarioAggregateResult } from "./types.js";

// ── 列宽常量 ──────────────────────────────────────────────────────────────

/** 场景表列宽。命名常量消除魔法数字。 */
const COL = {
  id: 40,
  rate: 12,
  status: 8,
  duration: 10,
} as const;

/** 统计表列宽。 */
const STAT_COL = {
  label: 28,
  tagLabel: 20,
  value: 8,
} as const;

const RULE_WIDTH = 63;

// ── 基础格式化 ────────────────────────────────────────────────────────────

/** 右填充字符串到指定宽度。 */
function pad(str: string, width: number): string {
  return str.length >= width ? str : str + " ".repeat(width - str.length);
}

/** 格式化通过率为百分比字符串。 */
function pct(rate: number): string {
  return `${(rate * 100).toFixed(0)}%`;
}

/** 根据通过状态返回终端标记。 */
function mark(pass: boolean, cached?: boolean): string {
  if (cached) return "SKIP";
  return pass ? "PASS" : "FAIL";
}

// ── 可组合渲染函数 ─────────────────────────────────────────────────────────

/** 渲染场景表头 + 分隔线。 */
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
 * 渲染单个场景行 + 失败详情（如有）。
 *
 * 可在 onScenarioComplete 回调中单独调用，实现流式输出。
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

  // 失败详情
  if (!s.passAtK) {
    for (const run of s.runs) {
      if (!run.structural.pass) {
        for (const c of run.structural.checks) {
          if (!c.pass) {
            // process tier 只是诊断信息，标为 [diag] 而非失败
            const prefix = c.tier === "process" ? "[diag]" : "FAIL";
            lines.push(`    └─ ${prefix} ${c.name}: expected=${c.expected}, actual=${c.actual}`);
          }
        }
      }
    }
  }

  return lines.join("\n");
}

/** 渲染 AggregatedStat 表格（Branch Stats / Tag Stats）。 */
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

/** 渲染 Summary 段。 */
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

// ── 完整报告 ──────────────────────────────────────────────────────────────

/**
 * 渲染完整终端报告。
 *
 * 由可组合函数拼接而成——如需流式输出，可拆开单独调用子函数。
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

// ── JSON 导出 ──────────────────────────────────────────────────────────────

/**
 * 将 EvalReport 导出为 JSON 文件。
 *
 * 路径格式：runtime/eval-report-{timestamp}.json
 */
export function exportReportJson(report: EvalReport, path?: string): string {
  const filePath = path ?? `eval-report-${report.timestamp.replace(/[:.]/g, "-")}.json`;
  writeFileSync(filePath, JSON.stringify(report, null, 2), "utf-8");
  return filePath;
}
