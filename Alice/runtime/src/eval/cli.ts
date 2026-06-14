/**
 * ADR-136: Eval CLI — точка входа командной строки.
 *
 * Использование:
 *   pnpm eval                         # Последовательный режим: пропускает пройденные, останавливается на FAIL
 *   pnpm eval -- --full               # Полный перезапуск: игнорирует кэш + не останавливается
 *   pnpm eval -- --reset              # Сбрасывает кэш и перезапускает
 *   pnpm eval -- --runs 3             # 3 прогона на сценарий (pass@3)
 *   pnpm eval -- --tag app            # Только сценарии с тегом app
 *   pnpm eval -- --prefix branch.reply  # Только сценарии типа reply
 *   pnpm eval -- --json               # Дополнительно экспортирует JSON-отчёт
 *   pnpm eval -- --dump               # Дамп prompt для упавших сценариев (диагностика)
 *
 * Поведение по умолчанию (последовательный режим):
 * - Сценарии с pass читаются из .eval-cache.json и помечаются SKIP
 * - LLM вызывается только для fail/непроверенных сценариев
 * - Останавливается на первом FAIL (экономия ресурсов)
 * - Кэш обновляется сразу после каждого сценария (прерывание не теряет прогресс)
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

// pnpm иногда вставляет лишний "--" перед аргументами скрипта, из-за чего parseArgs
// воспринимает последующие флаги как positional args. Убираем этот артефакт заранее.
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

// --reset: очищает кэш и продолжает
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

// Потоковый вывод: сначала печатается заголовок таблицы, затем строка результата сразу после каждого сценария
let headerPrinted = false;

// ADR-139: директория для дампов prompt (на основе временной метки, чтобы избежать конфликтов)
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
    // Полный отчёт (блок статистики — строки сценариев уже выведены в потоковом коллбэке)
    console.log("");
    console.log(renderReport(report));

    if (values.json) {
      const path = exportReportJson(report);
      console.log(`\nJSON report exported: ${path}`);
    }

    if (dumpDir) {
      console.log(`\nPrompt dumps: ${dumpDir}/`);
    }

    // Код выхода: все pass@k → 0, иначе 1
    const allPass = report.scenarios.every((s) => s.passAtK);
    process.exit(allPass ? 0 : 1);
  })
  .catch((err) => {
    console.error("Eval failed:", err);
    process.exit(2);
  });
