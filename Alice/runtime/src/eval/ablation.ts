/**
 * ADR-137: Pressure Field Ablation — 三条件消融实验。
 *
 * 核心问题：压力场驱动的行为比简单规则 + 同样的 LLM 更好吗？
 *
 * 三条件：
 * - Full: 当前系统（situation lines + voice instinct + gold examples）
 * - No-Pressure: 保留 gold examples + persona，移除 situation lines + voice instinct
 * - Baseline: 3 条 airi 风格规则 + function manual + timeline
 *
 * 实现策略：
 * - Full: 委托给真实 buildTickPrompt（由 TickDeps.buildPrompt = undefined 触发）
 * - No-Pressure / Baseline: 通过 TickDeps.buildPrompt 注入替代 prompt 构建器
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
// Baseline Prompt 模板（ADR-137 §D3）
// ═══════════════════════════════════════════════════════════════════════════

const BASELINE_SYSTEM_TEMPLATE = `You are Alice, a companion AI living in Telegram.

## Rules
- If someone sends you a private message, reply naturally.
- If someone @mentions you or directly asks you a question in a group, reply.
- If a question in a group goes unanswered for 30+ seconds, consider helping.
- Otherwise, stay silent.`;

// ═══════════════════════════════════════════════════════════════════════════
// buildAblationPrompt — 按条件构建 prompt
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 构建消融条件 prompt。
 *
 * - full: 委托 buildTickPrompt（在调用方处理，此函数不涉及）
 * - no_pressure: persona + gold examples + manual + timeline，无 situation lines
 * - baseline: 3 条规则 + manual + timeline
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

  // ADR-237: 简化场景判定（ablation 不需要 bot/channel 区分）
  const chatTargetType = isGroup ? "group" : ("private_person" as const);

  // 工具手册（公平对比：所有条件都保留完整手册）
  const manual = await generateShellManual(dispatcher.mods);
  const capGuide = buildCapabilityGuide(allTools, board.features);

  // ── system prompt ──
  let system: string;
  let renderedUser = "";

  if (condition === "baseline") {
    // Baseline: 3 条规则 + manual + capGuide
    const parts = [BASELINE_SYSTEM_TEMPLATE, manual];
    if (capGuide) parts.push(capGuide);
    system = parts.join("\n\n");
  } else {
    // No-Pressure: persona（mod contributions）+ gold examples + manual，无 situation lines
    // 收集 mod contributions 但过滤掉 situation lines 的贡献
    const contributions = dispatcher.collectContributions();
    // 过滤：移除 SITUATION zone 的贡献（situation-lines 产出的内容）
    const filteredContributions = contributions.filter((c) => classifyZone(c) !== "situation");
    const rendered = renderContributionsByZone(filteredContributions, 8000);
    const renderedSystem = rendered.system;
    renderedUser = rendered.user;

    // Shell examples（保留，场景感知）
    const scriptGuide = buildShellGuide({ chatTargetType });

    const parts = [renderedSystem, manual, scriptGuide];
    if (capGuide) parts.push(capGuide);
    system = parts.join("\n\n");
  }

  // ── user prompt ──
  // no_pressure 条件保留 mod 贡献的 user-part（如 memory zone 内容）
  const userParts: string[] = renderedUser ? [renderedUser] : [];

  // 上下文变量
  if (board.contextVars && Object.keys(board.contextVars).length > 0) {
    const m = new PromptBuilder();
    m.blank();
    m.heading("Your Context");
    const chatName = String(board.contextVars.CHAT_NAME ?? "(unknown)");
    m.line(`TARGET_CHAT: ${chatName}`);
    userParts.push(...m.build());
  }

  // 轮次感知（expect_reply/stay 仍可触发多步）
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

  // 时间线（公平对比：所有条件都保留完整消息历史）
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
    // No-Pressure: 通用 instinct（不含声部信息）
    userParts.push("Your instinct: you received a message.");
    userParts.push("Decide what to do.");
  }

  const user = userParts.join("\n");
  return { system, user };
}

// ═══════════════════════════════════════════════════════════════════════════
// Ablation Suite Runner
// ═══════════════════════════════════════════════════════════════════════════

/** 消融对比报告（按场景配对）。 */
export interface AblationPair {
  readonly scenarioId: string;
  readonly full: ScenarioAggregateResult;
  readonly noPressure: ScenarioAggregateResult;
  readonly baseline: ScenarioAggregateResult;
}

/** 消融实验完整报告。 */
export interface AblationReport {
  readonly model: string;
  readonly timestamp: string;
  readonly pairs: readonly AblationPair[];
  readonly summary: AblationSummary;
}

/** 消融实验汇总统计。 */
export interface AblationSummary {
  /** Full vs Baseline 结构性通过率差异 */
  readonly deltaStructural: number;
  /** Full vs Baseline 平均质量差异（如有 L2） */
  readonly deltaQuality: number | null;
  /** (Full - NoPressure) / (Full - Baseline)：压力场独立贡献占比 */
  readonly pressureLift: number | null;
  /** 场景数 */
  readonly scenarioCount: number;
  /** Cohen's d 效应量（Full vs Baseline 结构性分数） */
  readonly effectSize: number | null;
}

/**
 * 运行消融实验套件。
 *
 * 对每个场景创建 3 个条件变体，运行 eval，输出配对比较报告。
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

  // provider 初始化由 runEvalSuite 内部完成，此处不重复

  if (options?.dumpDir) {
    mkdirSync(options.dumpDir, { recursive: true });
  }

  const conditions: AblationCondition[] = ["full", "no_pressure", "baseline"];
  const pairs: AblationPair[] = [];

  for (const scenario of scenarios) {
    const conditionResults: Partial<Record<AblationCondition, ScenarioAggregateResult>> = {};

    for (const condition of conditions) {
      // 为每个条件创建带标记的场景
      const condScenario: EvalScenario = {
        ...scenario,
        id: `${scenario.id}__${condition}`,
        tags: [...scenario.tags, "ablation"] as EvalScenario["tags"],
        // 通过 contextOverrides 传递消融条件（runner 会读取）
        contextOverrides: {
          ...scenario.contextOverrides,
          __ablation_condition: condition,
        },
      };

      const report = await runEvalSuite(config, {
        scenarios: [condScenario],
        dumpDir: options?.dumpDir ? `${options.dumpDir}/${scenario.id}/${condition}` : undefined,
        // 消融实验必须：不跳过缓存（每个条件独立评估）+ 不 fail-fast（需三条件完整数据）
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

  // 输出 JSON 报告
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
// 统计汇总
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

  // Pressure Lift: (Full - NoPressure) / (Full - Baseline)
  const denominator = meanFull - meanBaseline;
  const pressureLift =
    Math.abs(denominator) > 0.001 ? (meanFull - meanNoPressure) / denominator : null;

  // Cohen's d: Δ / pooled SD
  const effectSize = cohensD(fullRates, baselineRates);

  return {
    deltaStructural,
    deltaQuality: null, // L2 待实现
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
// 终端报告
// ═══════════════════════════════════════════════════════════════════════════

/** 打印消融实验报告到终端。 */
export function printAblationReport(report: AblationReport): void {
  console.log("\n═══════════════════════════════════════════════════");
  console.log("  ADR-137: Pressure Field Ablation Report");
  console.log("═══════════════════════════════════════════════════");
  console.log(`Model: ${report.model}`);
  console.log(`Scenarios: ${report.summary.scenarioCount}`);
  console.log();

  // 逐场景对比表
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

  // 汇总
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

  // 解读
  if (s.deltaStructural < 0.05) {
    console.log("⚠️  Δ_structural < 5% — 压力场对决策帮助不显著，需严肃审视 ROI");
  } else if (s.deltaStructural < 0.15) {
    console.log("📊 Δ_structural 5-15% — 中等效果，压力场有贡献但可能不是唯一因素");
  } else {
    console.log("✅ Δ_structural > 15% — 压力场对决策有显著帮助");
  }
}

function formatRate(rate: number): string {
  return `${(rate * 100).toFixed(0)}%`.padStart(4);
}
