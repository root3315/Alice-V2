/**
 * ADR-137: Pressure Field Ablation — трёхусловный ablation-эксперимент.
 *
 * Ключевой вопрос: поведение, управляемое полем давления, лучше, чем простые правила с тем же LLM?
 *
 * Три условия:
 * - Full: текущая система (situation lines + voice instinct + gold examples)
 * - No-Pressure: оставляем gold examples + persona, убираем situation lines + voice instinct
 * - Baseline: 3 правила в стиле airi + function manual + timeline
 *
 * Стратегия реализации:
 * - Full: делегируется реальному buildTickPrompt (срабатывает при TickDeps.buildPrompt = undefined)
 * - No-Pressure / Baseline: альтернативный построитель prompt внедряется через TickDeps.buildPrompt
 *
 * @see docs/adr/137-pressure-field-ablation.md
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { PromptBuilder } from "../core/prompt-style.js";
import { generateShellManual } from "../core/shell-manual.js";
import { classifyZone, renderContributionsByZone } from "../core/storyteller.js";
import { buildShellGuide } from "../engine/act/shell-guide.js";
import {
  buildTimeline,
  MessageTimelineSource,
  ObservationTimelineSource,
  renderTimeline,
} from "../engine/act/timeline.js";
import { buildCapabilityGuide, type TickPromptContext } from "../engine/tick/prompt-builder.js";
import type { Blackboard, UnifiedTool } from "../engine/tick/types.js";
import { ChatTarget } from "../prompt/types.js";
import type {
  AblationCondition,
  EvalRunnerConfig,
  EvalScenario,
  ScenarioAggregateResult,
} from "./types.js";

// ═══════════════════════════════════════════════════════════════════════════
// Шаблон Baseline Prompt (ADR-137 §D3)
// ═══════════════════════════════════════════════════════════════════════════

const BASELINE_SYSTEM_TEMPLATE = `You are Alice, a companion AI living in Telegram.

## Rules
- If someone sends you a private message, reply naturally.
- If someone @mentions you or directly asks you a question in a group, reply.
- If a question in a group goes unanswered for 30+ seconds, consider helping.
- Otherwise, stay silent.`;

// ═══════════════════════════════════════════════════════════════════════════
// buildAblationPrompt — построение prompt по условию
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Построение prompt для ablation-условия.
 *
 * - full: делегируется buildTickPrompt (обрабатывается на стороне вызывающего, эта функция не участвует)
 * - no_pressure: persona + gold examples + manual + timeline, без situation lines
 * - baseline: 3 правила + manual + timeline
 */
export async function buildAblationPrompt(
  condition: Exclude<AblationCondition, "full">,
  board: Blackboard,
  allTools: readonly UnifiedTool[],
  ctx: TickPromptContext,
): Promise<{ system: string; user: string }> {
  const { G, dispatcher, item, messages, observations, round } = ctx;

  const chatType =
    item.target && G.has(item.target)
      ? String(G.getDynamic(item.target, "chat_type") ?? "private")
      : "private";
  const isGroup = ChatTarget.isGroupChat(chatType);

  // ADR-237: упрощённое определение сценария (ablation не нуждается в разграничении bot/channel)
  const chatTargetType = isGroup ? "group" : ("private_person" as const);

  // Руководство по инструментам (честное сравнение: все условия сохраняют полное руководство)
  const manual = await generateShellManual(dispatcher.mods);
  const capGuide = buildCapabilityGuide(allTools, board.features);

  // ── system prompt ──
  let system: string;
  let renderedUser = "";

  if (condition === "baseline") {
    // Baseline: 3 правила + manual + capGuide
    const parts = [BASELINE_SYSTEM_TEMPLATE, manual];
    if (capGuide) parts.push(capGuide);
    system = parts.join("\n\n");
  } else {
    // No-Pressure: persona (mod contributions) + gold examples + manual, без situation lines
    // Собираем mod contributions, но фильтруем вклад situation lines
    const contributions = dispatcher.collectContributions();
    // Фильтр: убираем вклады зоны SITUATION (контент, создаваемый situation-lines)
    const filteredContributions = contributions.filter((c) => classifyZone(c) !== "situation");
    const rendered = renderContributionsByZone(filteredContributions, 8000);
    const renderedSystem = rendered.system;
    renderedUser = rendered.user;

    // Shell examples (сохраняются, учитывают контекст сценария)
    const scriptGuide = buildShellGuide({ chatTargetType });

    const parts = [renderedSystem, manual, scriptGuide];
    if (capGuide) parts.push(capGuide);
    system = parts.join("\n\n");
  }

  // ── user prompt ──
  // Условие no_pressure сохраняет user-часть вклада mod (например, содержимое зоны memory)
  const userParts: string[] = renderedUser ? [renderedUser] : [];

  // Переменные контекста
  if (board.contextVars && Object.keys(board.contextVars).length > 0) {
    const m = new PromptBuilder();
    m.blank();
    m.heading("Your Context");
    const chatName = String(board.contextVars.CHAT_NAME ?? "(unknown)");
    m.line(`TARGET_CHAT: ${chatName}`);
    userParts.push(...m.build());
  }

  // Учёт раунда (expect_reply/stay по-прежнему могут запускать несколько шагов)
  if (round > 0) {
    const maxSteps = board.budget.maxSteps;
    const remaining = maxSteps - round - 1;
    const rm = new PromptBuilder();
    rm.blank();
    if (remaining === 0) {
      rm.line(`[Step ${round + 1} of ${maxSteps} — final step. Make your decision now.]`);
    } else {
      rm.line(`[Step ${round + 1} of ${maxSteps} — continuation after expect_reply/stay.]`);
    }
    userParts.push(...rm.build());
  }

  // Хронология (честное сравнение: все условия сохраняют полную историю сообщений)
  {
    const nowMs = ctx.nowMs ?? Date.now();
    const TEN_MINUTES_MS = 10 * 60 * 1000;
    const sinceMs = nowMs - TEN_MINUTES_MS;

    const sources = [
      new MessageTimelineSource(messages),
      ...(observations && observations.length > 0
        ? [new ObservationTimelineSource(observations)]
        : []),
    ];

    const timeline = buildTimeline(sources, item.target ?? "", sinceMs, nowMs);
    if (timeline.length > 0) {
      const tm = new PromptBuilder();
      tm.blank();
      const metaParts: string[] = [];
      if (isGroup) metaParts.push("group");
      else metaParts.push("private chat — all directed at you");
      const metaStr = metaParts.length > 0 ? ` (${metaParts.join(", ")})` : "";
      tm.heading(`Recent activity${metaStr}`);
      for (const line of renderTimeline(timeline, nowMs)) {
        tm.line(line);
      }
      userParts.push(...tm.build());
    }
  }

  // Footer
  userParts.push("");
  if (condition === "baseline") {
    userParts.push("Decide what to do.");
  } else {
    // No-Pressure: универсальный instinct (без информации о голосе)
    userParts.push("Your instinct: you received a message.");
    userParts.push("Decide what to do.");
  }

  const user = userParts.join("\n");
  return { system, user };
}

// ═══════════════════════════════════════════════════════════════════════════
// Ablation Suite Runner
// ═══════════════════════════════════════════════════════════════════════════

/** Ablation-отчёт сравнения (попарно по сценариям). */
export interface AblationPair {
  readonly scenarioId: string;
  readonly full: ScenarioAggregateResult;
  readonly noPressure: ScenarioAggregateResult;
  readonly baseline: ScenarioAggregateResult;
}

/** Полный отчёт ablation-эксперимента. */
export interface AblationReport {
  readonly model: string;
  readonly timestamp: string;
  readonly pairs: readonly AblationPair[];
  readonly summary: AblationSummary;
}

/** Сводная статистика ablation-эксперимента. */
export interface AblationSummary {
  /** Разница в структурном pass rate между Full и Baseline */
  readonly deltaStructural: number;
  /** Разница в среднем качестве между Full и Baseline (если есть L2) */
  readonly deltaQuality: number | null;
  /** (Full - NoPressure) / (Full - Baseline): доля независимого вклада поля давления */
  readonly pressureLift: number | null;
  /** Количество сценариев */
  readonly scenarioCount: number;
  /** Размер эффекта Cohen's d (структурные оценки Full vs Baseline) */
  readonly effectSize: number | null;
}

/**
 * Запуск набора ablation-экспериментов.
 *
 * Для каждого сценария создаёт 3 варианта условий, запускает eval и выводит попарный отчёт сравнения.
 */
export async function runAblationSuite(
  scenarios: readonly EvalScenario[],
  config: EvalRunnerConfig,
  options?: {
    onPairComplete?: (pair: AblationPair) => void;
    dumpDir?: string;
  },
): Promise<AblationReport> {
  const { runEvalSuite } = await import("./runner.js");

  // Инициализация provider выполняется внутри runEvalSuite, здесь не дублируем

  if (options?.dumpDir) {
    mkdirSync(options.dumpDir, { recursive: true });
  }

  const conditions: AblationCondition[] = ["full", "no_pressure", "baseline"];
  const pairs: AblationPair[] = [];

  for (const scenario of scenarios) {
    const conditionResults: Partial<Record<AblationCondition, ScenarioAggregateResult>> = {};

    for (const condition of conditions) {
      // Создаём помеченный сценарий для каждого условия
      const condScenario: EvalScenario = {
        ...scenario,
        id: `${scenario.id}__${condition}`,
        tags: [...scenario.tags, "ablation"] as EvalScenario["tags"],
        // Передаём ablation-условие через contextOverrides (runner прочитает его)
        contextOverrides: {
          ...scenario.contextOverrides,
          __ablation_condition: condition,
        },
      };

      const report = await runEvalSuite(config, {
        scenarios: [condScenario],
        dumpDir: options?.dumpDir ? `${options.dumpDir}/${scenario.id}/${condition}` : undefined,
        // Ablation-эксперимент требует: не пропускать кеш (каждое условие оценивается независимо) + не fail-fast (нужны данные по всем трём условиям)
        skipPassed: false,
        runAll: true,
      });

      if (report.scenarios.length > 0) {
        conditionResults[condition] = report.scenarios[0];
      }
    }

    if (conditionResults.full && conditionResults.no_pressure && conditionResults.baseline) {
      const pair: AblationPair = {
        scenarioId: scenario.id,
        full: conditionResults.full,
        noPressure: conditionResults.no_pressure,
        baseline: conditionResults.baseline,
      };
      pairs.push(pair);
      options?.onPairComplete?.(pair);
    }
  }

  const summary = computeAblationSummary(pairs);

  const report: AblationReport = {
    model: config.providerName ?? "unknown",
    timestamp: new Date().toISOString(),
    pairs,
    summary,
  };

  // Вывод JSON-отчёта
  if (options?.dumpDir) {
    writeFileSync(
      `${options.dumpDir}/ablation-report.json`,
      JSON.stringify(report, null, 2),
      "utf-8",
    );
  }

  return report;
}

// ═══════════════════════════════════════════════════════════════════════════
// Статистическая сводка
// ═══════════════════════════════════════════════════════════════════════════

function computeAblationSummary(pairs: readonly AblationPair[]): AblationSummary {
  if (pairs.length === 0) {
    return {
      deltaStructural: 0,
      deltaQuality: null,
      pressureLift: null,
      scenarioCount: 0,
      effectSize: null,
    };
  }

  const fullRates = pairs.map((p) => p.full.passRate);
  const baselineRates = pairs.map((p) => p.baseline.passRate);
  const noPressureRates = pairs.map((p) => p.noPressure.passRate);

  const meanFull = mean(fullRates);
  const meanBaseline = mean(baselineRates);
  const meanNoPressure = mean(noPressureRates);

  const deltaStructural = meanFull - meanBaseline;

  // Pressure Lift: (Full - NoPressure) / (Full - Baseline) — вклад поля давления
  const denominator = meanFull - meanBaseline;
  const pressureLift =
    Math.abs(denominator) > 0.001 ? (meanFull - meanNoPressure) / denominator : null;

  // Cohen's d: Δ / pooled SD
  const effectSize = cohensD(fullRates, baselineRates);

  return {
    deltaStructural,
    deltaQuality: null, // L2 ещё не реализован
    pressureLift,
    scenarioCount: pairs.length,
    effectSize,
  };
}

function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function variance(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return xs.reduce((acc, x) => acc + (x - m) ** 2, 0) / (xs.length - 1);
}

function cohensD(group1: number[], group2: number[]): number | null {
  if (group1.length < 2 || group2.length < 2) return null;
  const m1 = mean(group1);
  const m2 = mean(group2);
  const v1 = variance(group1);
  const v2 = variance(group2);
  const pooledVar =
    ((group1.length - 1) * v1 + (group2.length - 1) * v2) / (group1.length + group2.length - 2);
  const pooledSD = Math.sqrt(pooledVar);
  if (pooledSD < 1e-10) return null;
  return (m1 - m2) / pooledSD;
}

// ═══════════════════════════════════════════════════════════════════════════
// Вывод отчёта в терминал
// ═══════════════════════════════════════════════════════════════════════════

/** Вывод отчёта ablation-эксперимента в терминал. */
export function printAblationReport(report: AblationReport): void {
  console.log("\n═══════════════════════════════════════════════════");
  console.log("  ADR-137: Pressure Field Ablation Report");
  console.log("═══════════════════════════════════════════════════");
  console.log(`Model: ${report.model}`);
  console.log(`Scenarios: ${report.summary.scenarioCount}`);
  console.log();

  // Таблица сравнения по каждому сценарию
  console.log("┌────────────────────────────────────────┬──────┬───────────┬──────────┐");
  console.log("│ Scenario                               │ Full │ NoPressure│ Baseline │");
  console.log("├────────────────────────────────────────┼──────┼───────────┼──────────┤");
  for (const pair of report.pairs) {
    const id = pair.scenarioId.padEnd(40).slice(0, 40);
    const f = formatRate(pair.full.passRate);
    const np = formatRate(pair.noPressure.passRate);
    const b = formatRate(pair.baseline.passRate);
    console.log(`│ ${id}│ ${f} │ ${np}     │ ${b}    │`);
  }
  console.log("└────────────────────────────────────────┴──────┴───────────┴──────────┘");
  console.log();

  // Сводка
  const s = report.summary;
  console.log("Summary:");
  console.log(`  Δ_structural (Full - Baseline): ${(s.deltaStructural * 100).toFixed(1)}%`);
  if (s.pressureLift != null) {
    console.log(`  Pressure Lift:                  ${(s.pressureLift * 100).toFixed(1)}%`);
  }
  if (s.effectSize != null) {
    console.log(`  Cohen's d:                      ${s.effectSize.toFixed(2)}`);
  }
  console.log();

  // Интерпретация
  if (s.deltaStructural < 0.05) {
    console.log("⚠️  Δ_structural < 5% — поле давления не даёт значимого эффекта на принятие решений, ROI требует серьёзного пересмотра");
  } else if (s.deltaStructural < 0.15) {
    console.log("📊 Δ_structural 5-15% — умеренный эффект, поле давления вносит вклад, но может быть не единственным фактором");
  } else {
    console.log("✅ Δ_structural > 15% — поле давления значительно улучшает принятие решений");
  }
}

function formatRate(rate: number): string {
  return `${(rate * 100).toFixed(0)}%`.padStart(4);
}
