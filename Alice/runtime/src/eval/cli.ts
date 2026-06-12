/**
 * ADR-136: Eval CLI — 命令行入口。
 *
 * 用法：
 *   pnpm eval                         # 顺序测试：跳过已 pass 的场景，遇 FAIL 停止
 *   pnpm eval -- --full               # 全量重跑：忽略缓存 + 不停止
 *   pnpm eval -- --reset              # 清除缓存后重跑
 *   pnpm eval -- --runs 3             # 每场景 3 次运行（pass@3）
 *   pnpm eval -- --tag app            # 只跑 app 标签场景
 *   pnpm eval -- --prefix branch.reply  # 只跑 reply 类场景
 *   pnpm eval -- --json               # 额外导出 JSON 报告
 *   pnpm eval -- --dump               # 失败场景导出 prompt dump（诊断用）
 *
 * 默认行为（顺序测试模式）：
 * - 已 pass 的场景从 .eval-cache.json 读取，标记 SKIP
 * - 只对 fail/未测试的场景调用 LLM
 * - 遇到第一个 FAIL 立即停止（省钱）
 * - 每个场景完成后立即写入缓存（中断不丢进度）
 *
 * @see docs/adr/136-model-eval-suite.md
 */
import { parseArgs } from "node:util";
import { resetCache } from "./cache.js";
import {
  exportReportJson,
  renderReport,
  renderScenarioLine,
  renderScenarioTableHeader,
} from "./report.js";
import { runEvalSuite } from "./runner.js";
import type { EvalRunnerConfig, ScenarioTag } from "./types.js";

// pnpm 有时会在 script args 前注入一个多余的 "--"，导致 parseArgs
// 将后续 flag 当作 positional args。预处理移除这个干扰。
const rawArgs = process.argv.slice(2);
if (rawArgs[0] === "--") rawArgs.shift();

const { values } = parseArgs({
  args: rawArgs,
  options: {
    runs: { type: "string", short: "n", default: "1" },
    temperature: { type: "string", short: "t", default: "0" },
    tag: { type: "string", multiple: true },
    prefix: { type: "string" },
    timeout: { type: "string", default: "180000" },
    json: { type: "boolean", default: false },
    dump: { type: "boolean", default: false },
    full: { type: "boolean", default: false },
    reset: { type: "boolean", default: false },
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
  filterTags: values.tag as ScenarioTag[] | undefined,
  filterPrefix: values.prefix as string | undefined,
  providerName: values.provider as string | undefined,
};

// --reset: 清除缓存后继续
if (values.reset) resetCache();

const isFullMode = !!values.full;

console.log(`\nADR-134 Model Eval Suite`);
console.log(`  runs=${config.runs} temperature=${config.temperature} timeout=${config.timeout}ms`);
console.log(
  `  mode: ${isFullMode ? "full (ignore cache, run all)" : "sequential (skip passed, fail-fast)"}`,
);
if (config.filterTags) console.log(`  tags: ${config.filterTags.join(", ")}`);
if (config.filterPrefix) console.log(`  prefix: ${config.filterPrefix}`);
if (values.dump) console.log(`  dump: enabled`);
if (values.reset) console.log(`  cache: reset`);
console.log("");

// 流式输出：场景表头先打印，每完成一个场景立即输出结果行
let headerPrinted = false;

// ADR-139: prompt dump 目录（基于时间戳，避免冲突）
const dumpDir = values.dump
  ? `eval-dump-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}`
  : undefined;

runEvalSuite(config, {
  dumpDir,
  skipPassed: !isFullMode,
  runAll: isFullMode,
  onScenarioComplete: (agg) => {
    if (!headerPrinted) {
      console.log(renderScenarioTableHeader());
      headerPrinted = true;
    }
    console.log(renderScenarioLine(agg));
  },
})
  .then((report) => {
    // 完整报告（统计段 — 场景行已在流式回调中输出）
    console.log("");
    console.log(renderReport(report));

    if (values.json) {
      const path = exportReportJson(report);
      console.log(`\nJSON report exported: ${path}`);
    }

    if (dumpDir) {
      console.log(`\nPrompt dumps: ${dumpDir}/`);
    }

    // 退出码：全部 pass@k → 0，否则 1
    const allPass = report.scenarios.every((s) => s.passAtK);
    process.exit(allPass ? 0 : 1);
  })
  .catch((err) => {
    console.error("Eval failed:", err);
    process.exit(2);
  });
