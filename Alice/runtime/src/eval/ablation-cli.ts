/**
 * ADR-137: Ablation CLI — 消融实验命令行入口。
 *
 * 用法：
 *   pnpm eval:ablation                          # 默认：1 run, temperature=0
 *   pnpm eval:ablation -- --runs 3              # 3 runs
 *   pnpm eval:ablation -- --dump                # 失败场景导出 prompt dump
 *   pnpm eval:ablation -- --json                # 额外导出 JSON 报告
 *   pnpm eval:ablation -- --filter group_debate # 只跑匹配的场景（substring）
 *
 * @see docs/adr/137-pressure-field-ablation.md
 */
import { parseArgs } from "node:util";
import { printAblationReport, runAblationSuite } from "./ablation.js";
import { ABLATION_SCENARIOS } from "./scenarios/index.js";
import type { EvalRunnerConfig } from "./types.js";

// pnpm 有时会在 script args 前注入一个多余的 "--"
const rawArgs = process.argv.slice(2);
if (rawArgs[0] === "--") rawArgs.shift();

const { values } = parseArgs({
  args: rawArgs,
  options: {
    runs: { type: "string", short: "n", default: "1" },
    temperature: { type: "string", short: "t", default: "0" },
    timeout: { type: "string", default: "180000" },
    json: { type: "boolean", default: false },
    dump: { type: "boolean", default: false },
    filter: { type: "string", short: "f" },
    provider: { type: "string" },
  },
  strict: false,
  allowPositionals: true,
});

const config: EvalRunnerConfig = {
  runs: Number.parseInt(values.runs as string, 10) || 1,
  temperature: Number.parseFloat(values.temperature as string) || 0,
  includeQuality: false,
  timeout: Number.parseInt(values.timeout as string, 10) || 120_000,
  providerName: values.provider as string | undefined,
};

// 场景过滤（substring 匹配）
const filterStr = values.filter as string | undefined;
const scenarios = filterStr
  ? ABLATION_SCENARIOS.filter((s) => s.id.includes(filterStr))
  : ABLATION_SCENARIOS;

console.log("\nADR-137: Pressure Field Ablation Experiment");
console.log(
  `  scenarios=${scenarios.length}${filterStr ? ` (filter: "${filterStr}")` : ""} runs=${config.runs} temperature=${config.temperature}`,
);
if (values.dump) console.log("  dump: enabled");
console.log("");

if (scenarios.length === 0) {
  console.error(
    filterStr
      ? `No scenarios match filter "${filterStr}". Available: ${ABLATION_SCENARIOS.map((s) => s.id).join(", ")}`
      : "No ablation scenarios found. Check that branch/app scenarios are registered.",
  );
  process.exit(2);
}

// dump 目录
const dumpDir = values.dump
  ? `eval-ablation-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}`
  : undefined;

// 流式进度
let completed = 0;

runAblationSuite(scenarios, config, {
  dumpDir,
  onPairComplete: (pair) => {
    completed++;
    const f = pair.full.passRate;
    const np = pair.noPressure.passRate;
    const b = pair.baseline.passRate;
    console.log(
      `  [${completed}/${scenarios.length}] ${pair.scenarioId}  Full=${(f * 100).toFixed(0)}%  NoPressure=${(np * 100).toFixed(0)}%  Baseline=${(b * 100).toFixed(0)}%`,
    );
  },
})
  .then((report) => {
    printAblationReport(report);

    if (dumpDir) {
      console.log(`\nPrompt dumps + JSON report: ${dumpDir}/`);
    }

    // 退出码：Δ_structural > 0 → 0（压力场有贡献），否则 1
    process.exit(report.summary.deltaStructural > 0 ? 0 : 1);
  })
  .catch((err) => {
    console.error("Ablation experiment failed:", err);
    process.exit(2);
  });
