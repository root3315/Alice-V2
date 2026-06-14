/**
 * ADR-136: Eval Runner — сквозной исполнитель оценки, унифицированный с продакшн tick().
 *
 * Основной поток (каждый запуск каждого сценария):
 * 1. createEvalFixture → собирает fixture
 * 2. buildEvalTickDeps → строит TickDeps для eval (режим записи)
 * 3. tick(board, allTools, deps, ctx) → вызывает продакшн-цикл tick
 * 4. gradeStructural → послойная оценка (goal/budget/process)
 *
 * Решения по дизайну:
 * - Напрямую вызывает продакшн tick(), различия поведения eval инжектируются через TickDeps
 * - LLM-вызовы используют отдельный evalCallLLM, допускающий переопределение temperature + пропуск аудита
 * - Telegram-действия не выполняются (режим записи) — интересует только принятие решений, не исполнение
 * - eval-сообщения статичны, не загружаются
 * - Абляционные эксперименты маршрутизируются через deps.buildPrompt
 * - Диагностические снимки собираются через deps.onStep
 *
 * @see docs/adr/136-model-eval-suite.md
 * @see docs/adr/142-action-space-architecture/README.md
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { generateText } from "ai";
import { type Config, getLlmProviderByRoute, loadConfig } from "../config.js";
import {
  type CompletedAction,
  encodeCompletedAction,
  mergeScriptExecutionResults,
} from "../core/script-execution.js";
import { extractRuntimeConfig } from "../engine/act/runtime-config.js";
import { collectAllTools } from "../engine/tick/affordance-filter.js";
import { createBlackboard } from "../engine/tick/blackboard.js";
import { type TickDeps, tick } from "../engine/tick/tick.js";
import type { FeatureFlags, TickResult, ToolCategory } from "../engine/tick/types.js";
import type { WorldModel } from "../graph/world-model.js";
import { getEvalProvider, initProviders } from "../llm/client.js";
import { parseTickStep } from "../llm/schemas.js";
import { TELEGRAM_ACTIONS } from "../telegram/actions/index.js";
import { createLogger } from "../utils/logger.js";
import { buildAblationPrompt } from "./ablation.js";
import { type EvalCache, isCachedPass, loadCache, saveCache } from "./cache.js";
import { createEvalFixture, type EvalFixture, setupEvalDb, teardownEvalDb } from "./fixtures.js";
import { gradeStructural, toEvalTickResult } from "./graders.js";
import { parseScriptActions } from "./script-actions.js";
import { ALL_SCENARIOS } from "./scenarios/index.js";
import type {
  AblationCondition,
  AggregatedStat,
  EvalReport,
  EvalRunnerConfig,
  EvalRunResult,
  EvalScenario,
  ScenarioAggregateResult,
} from "./types.js";

const log = createLogger("eval");

// ── LLM-вызов для Eval ─────────────────────────────────────────────────────────

type EvalLLMResult = {
  script: string;
  afterward: "done" | "waiting_reply" | "watching" | "resting" | "fed_up" | "cooling_down";
};

/**
 * LLM-вызов для Eval — логика идентична callTickLLM,
 * но допускает переопределение temperature и не пишет в аудит-лог.
 *
 * @see docs/adr/211-instructor-js-script-prevalidation.md
 */
async function evalCallLLM(
  system: string,
  user: string,
  temperature: number,
  timeout: number,
): Promise<EvalLLMResult | null> {
  try {
    const { provider, model } = getEvalProvider();
    const { text } = await generateText({
      model: provider(model),
      system,
      prompt: user,
      temperature,
      abortSignal: AbortSignal.timeout(timeout),
    });
    const step = parseTickStep(text);
    return { script: step.script, afterward: step.afterward };
  } catch (e) {
    log.error("Eval LLM call failed", e);
    return null;
  }
}

// ── Вывод FeatureFlags ─────────────────────────────────────────────────────

/** Выводит FeatureFlags из eval Config + Graph (логика идентична tick/bridge.ts). */
function deriveEvalFeatureFlags(config: Config, G: WorldModel): FeatureFlags {
  return {
    hasWeather: true,
    hasMusic: !!config.musicApiBaseUrl,
    hasBrowser: !!config.exaApiKey,
    hasTTS: !!config.ttsBaseUrl && !!config.ttsApiKey,
    hasStickers: G.has("self") && Array.isArray(G.getDynamic("self", "installed_stickers")),
    hasBots: G.getEntitiesByType("contact").some((id) => G.getContact(id).is_bot === true),
    hasSystemThreads: G.getEntitiesByType("thread").some(
      (tid) => G.getThread(tid).source === "system" && G.getThread(tid).status === "open",
    ),
    hasVideo: !!config.youtubeApiKey,
  };
}

// ── Построение TickDeps для Eval ──────────────────────────────────────────────────

/** Контейнер диагностических данных — записывается из обратного вызова onStep. */
interface EvalDiagnostics {
  promptSnapshots: Array<{ round: number; system: string; user: string; script: string | null }>;
}

/**
 * Строит TickDeps для Eval — адаптирует eval fixture к интерфейсу продакшн tick().
 *
 * Отличия от продакшн buildTickDeps (bridge.ts):
 * - callLLM: использует evalCallLLM (переопределение temperature + без аудит-лога)
 * - executeActions: no-op (режим записи, Telegram-действия не выполняются)
 * - fetchMessages: пусто (eval-сообщения статичны)
 * - buildPrompt: маршрутизация по условию абляции (contextVars.__ablation_condition)
 * - onStep: сбор диагностических снимков
 */
/**
 * H17: выводит completedActions (как факты CompletedAction) из распарсенного скрипта.
 *
 * Eval работает в режиме записи и не исполняет контейнер, поэтому реальных строк
 * `__ALICE_ACTION__` нет. Здесь мы воспроизводим те completedActions, которые runtime
 * сгенерировал бы для telegram-сайд-эффектов и внутренних инструкций self — чтобы
 * управление в production tick() (hasCompletedSend, продолжения, reply-ветка) вело себя
 * реалистично. App-вызовы (use_*_app/google/visit) НЕ являются telegram-сайд-эффектами и
 * не дают completedActions (в runtime это просто вывод навыка); grader читает их из
 * распарсенного скрипта через toEvalTickResult.
 *
 * @see src/core/script-execution.ts — CompletedAction / encodeCompletedAction
 */
function deriveCompletedActions(
  script: string,
  contextVars: Record<string, unknown> | undefined,
): { completedActions: string[]; completedActionFacts: CompletedAction[] } {
  const chatId = String(contextVars?.TARGET_CHAT ?? "channel:eval");
  const parsed = parseScriptActions(script);
  const facts: CompletedAction[] = [];
  let msgSeq = 1;

  for (const action of parsed.actions) {
    if (action.type !== "telegram") continue; // App-вызовы не дают completedActions
    const msgId = String(msgSeq++);
    switch (action.fn) {
      case "send_message":
        facts.push({ kind: "sent", chatId, msgId });
        break;
      case "react":
        facts.push({
          kind: "react",
          chatId,
          msgId,
          emoji: typeof action.args.emoji === "string" ? action.args.emoji : undefined,
        });
        break;
      case "send_sticker":
        facts.push({ kind: "sticker", chatId, msgId });
        break;
      case "send_file":
        facts.push({ kind: "sent-file", chatId, msgId });
        break;
    }
  }
  for (const instruction of parsed.instructions) {
    facts.push({ kind: "internal", command: instruction.fn });
  }

  return {
    completedActions: facts.map((fact) => encodeCompletedAction(fact)),
    completedActionFacts: facts,
  };
}

function buildEvalTickDeps(
  _fx: EvalFixture,
  temperature: number,
  timeout: number,
  ablationCondition: AblationCondition | undefined,
  diagnostics: EvalDiagnostics,
): TickDeps {
  return {
    callLLM: async (system, user, _tick, _target, _voice, contextVars) => {
      const result = await evalCallLLM(system, user, temperature, timeout);
      if (!result) return null;
      // H17: правдиво выводим completedActions/silenceReason из сгенерированного скрипта,
      // вместо жёстких []/null. Это то, что сделал бы runtime, исполнив скрипт.
      const { completedActions, completedActionFacts } = deriveCompletedActions(
        result.script,
        contextVars,
      );
      const silenceReason = parseScriptActions(result.script).silenceReason;
      return {
        afterward: result.afterward,
        toolCallCount: 1,
        budgetExhausted: false,
        rawScript: result.script,
        commandOutput: `$ ${result.script}\n(eval)`,
        logs: [result.script],
        errors: [],
        instructionErrors: [],
        errorCodes: [],
        duration: 0,
        thinks: [],
        queryLogs: [],
        observations: [],
        completedActions,
        completedActionFacts,
        silenceReason,
        llmProvider: "eval",
        llmModel: "eval",
      };
    },

    // Маршрутизация абляции
    buildPrompt:
      ablationCondition && ablationCondition !== "full"
        ? (board, allTools, ctx) => buildAblationPrompt(ablationCondition, board, allTools, ctx)
        : undefined,

    // Диагностический снимок
    onStep: (info) => diagnostics.promptSnapshots.push(info),
  };
}

// ── Многораундовая симуляция App stay() ──────────────────────────────────────────
//
// Ключевая ценность BT-фреймворка — многошаговое выполнение. Когда LLM правильно использует stay()
// для ожидания асинхронного результата App, eval обязан симулировать round 2
// (инжектировать мок-результат App → повторить tick), иначе тестируется лишь половина BT-цикла.
//
// Продакшн-поток: round 1 → stay() → watcher ожидает → round 2 получает результат → send_message
// Симуляция eval: round 1 → stay() → инжект mock-результата → round 2 → оценка объединённых раундов

/** Извлекает действия асинхронного вызова App (паттерн use_*_app) из сгенерированного скрипта.
 *
 * H17 (реализация намерения "Wave B"): раньше всегда возвращала [], из-за чего многораундовая
 * симуляция была отключена. Теперь выводим App-вызовы из распарсенного скрипта — это App-действия
 * (use_*_app/google/visit), которые в runtime порождают асинхронный результат, ожидаемый stay()/expect_reply().
 */
function getAppActions(script: string | null): Array<{ fn: string; args?: Record<string, unknown> }> {
  if (!script) return [];
  return parseScriptActions(script)
    .actions.filter((action) => action.type === "dispatch")
    .map((action) => ({ fn: action.fn, args: action.args }));
}

/** Последний непустой скрипт из диагностических снимков (= скрипт самого свежего раунда). */
function lastSnapshotScript(diagnostics: EvalDiagnostics): string | null {
  for (let i = diagnostics.promptSnapshots.length - 1; i >= 0; i--) {
    const script = diagnostics.promptSnapshots[i].script;
    if (script) return script;
  }
  return null;
}

/**
 * Генерирует мок-результаты для вызовов App (используется при инжекте в round 2 eval).
 *
 * Формат: `[use_X_app результат] конкретные данные`
 * - Префикс содержит оригинальное имя функции, чтобы LLM мог связать "это результат моего предыдущего вызова"
 * - Данные достаточно конкретны для генерации осмысленного ответа LLM
 */
function mockAppResults(actions: Array<{ fn: string; args?: Record<string, unknown> }>): string[] {
  return actions.map((a) => {
    const q = String(a.args?.query ?? a.args?.location ?? a.args?.date ?? a.args?.event ?? "");
    switch (a.fn) {
      case "use_weather_app":
        return `[${a.fn} 结果] ${q || "目标城市"}：多云，25°C，东南风 2-3 级，适合出行`;
      case "use_calendar_app":
        return `[${a.fn} 结果] ${q || "查询日期"}：星期三，工作日`;
      case "use_countdown_app":
        return `[${a.fn} 结果] 距离${q || "目标日期"}还有 123 天`;
      case "use_video_app":
        return `[${a.fn} 结果] 搜索"${q}": 1. 经典教程 (12min) 2. 快速入门 (8min) 3. 进阶指南 (15min)`;
      case "google":
        return `[${a.fn} 结果] 搜索"${q}": 最新 iPhone 16 于 2025 年 9 月发布，起售价 $799`;
      case "visit":
        return `[${a.fn} 结果] 网页摘要: ${q || "页面内容概述"}，关键信息已提取`;
      case "use_trending_app":
        return `[${a.fn} 结果] 1. #科技新突破 (1.2亿阅读) 2. #春季养生 (8000万阅读) 3. #新片上映 (6500万阅读)`;
      case "use_music_app":
        return `[${a.fn} 结果] 1. 夜的钢琴曲 — 石进 2. River Flows in You — 李闰珉`;
      default:
        return `[${a.fn} 结果] 查询完成`;
    }
  });
}

/**
 * Объединяет TickResult двух раундов — outcome берётся из round 2, остальное накапливается.
 */
function mergeTickResults(r1: TickResult, r2: TickResult): TickResult {
  return {
    outcome: r2.outcome,
    observations: [...r1.observations, ...r2.observations],
    execution: mergeScriptExecutionResults([r1.execution, r2.execution]),
    stepsUsed: r1.stepsUsed + r2.stepsUsed,
    preparedCategories: [
      ...new Set([...r1.preparedCategories, ...r2.preparedCategories]),
    ] as ToolCategory[],
    duration: r1.duration + r2.duration,
    episodeRounds: r1.episodeRounds + r2.episodeRounds,
  };
}

// ── Запуск одного сценария ─────────────────────────────────────────────────────────────

async function runScenarioOnce(
  scenario: EvalScenario,
  runIndex: number,
  config: EvalRunnerConfig,
  dumpDir?: string,
): Promise<EvalRunResult> {
  const start = Date.now();

  setupEvalDb();
  try {
    const fx = createEvalFixture(scenario);

    // 1. Выводим FeatureFlags + собираем полный набор инструментов
    const features = deriveEvalFeatureFlags(fx.ctx.config, fx.graph);
    const allTools = collectAllTools(fx.dispatcher.mods, TELEGRAM_ACTIONS);

    // 2. Создаём Blackboard
    const board = createBlackboard({
      pressures: fx.ctx.getCurrentPressures(),
      voice: fx.item.action,
      target: fx.item.target ?? null,
      features,
      contextVars: fx.contextVars,
    });

    // 3. Строим eval TickDeps
    const ablationCondition = fx.contextVars.__ablation_condition as AblationCondition | undefined;
    const diagnostics: EvalDiagnostics = { promptSnapshots: [] };
    const deps = buildEvalTickDeps(
      fx,
      config.temperature,
      config.timeout,
      ablationCondition,
      diagnostics,
    );

    // 4. Вызываем продакшн tick()
    const tickCtx = {
      G: fx.graph,
      dispatcher: fx.dispatcher,
      mods: fx.dispatcher.mods,
      config: fx.ctx.config,
      item: fx.item,
      tick: fx.tick,
      messages: fx.messages,
      observations: [] as string[],
      round: 0,
      nowMs: fx.nowMs,
      client: null as null,
      runtimeConfig: extractRuntimeConfig(fx.ctx.config),
    };
    let result = await tick(board, allTools, deps, tickCtx);

    // 4b. Multi-round: продолжение App (stay/expect_reply)
    // Когда LLM использует stay() или expect_reply() для ожидания асинхронного результата App — симулируем round 2.
    // Воспроизводим продакшн engagement watcher: round 1 вызывает App → round 2 отвечает после получения результата.
    // LLM может использовать stay() (наблюдение-ожидание) или expect_reply() (ожидание ответа) — оба сигнала валидны.
    // H17: getAppActions выводит App-вызовы из скрипта round 1 (последний снимок onStep).
    // Если LLM ждёт (stay/expect_reply) после вызова App — симулируем round 2 с мок-результатом App.
    const round1Script = lastSnapshotScript(diagnostics);
    const appActions = getAppActions(round1Script);
    const isWaiting = result.outcome === "watching" || result.outcome === "waiting_reply";
    if (isWaiting && appActions.length > 0) {
      log.info(
        `  → ${result.outcome}() with ${appActions.length} app action(s), simulating round 2`,
      );

      // Сохраняем данные round 1 (board arrays разделяют ссылки с result — необходимо сначала скопировать).
      // mergeScriptExecutionResults делает глубокую копию execution (включая completedActionFacts/errorDetails).
      const r1: TickResult = {
        ...result,
        observations: [...result.observations],
        execution: mergeScriptExecutionResults([result.execution]),
        preparedCategories: [...result.preparedCategories],
      };

      // Сбрасываем изменяемое состояние board (сохраняем preparedCategories — совместимость со старыми eval-утверждениями)
      const appObs = mockAppResults(appActions);
      board.observations = appObs;
      board.execution = mergeScriptExecutionResults([]);
      board.budget.usedSteps = 0;

      // Round 2
      const r2 = await tick(board, allTools, deps, {
        ...tickCtx,
        round: 1,
        observations: appObs,
      });

      result = mergeTickResults(r1, r2);
    }

    // 5. Оценка
    // H17: передаём grader сгенерированные скрипты по раундам (из диагностических снимков),
    // чтобы toEvalTickResult правдиво вывел actions/instructions/silenceReason.
    const executedScripts = diagnostics.promptSnapshots
      .map((snap) => snap.script)
      .filter((script): script is string => script !== null);
    const structural = gradeStructural(
      toEvalTickResult(result, executedScripts),
      scenario.structural,
      result.stepsUsed,
    );

    // ADR-139: prompt dump — экспорт диагностических снимков для провалившихся сценариев
    if (dumpDir && !structural.pass && diagnostics.promptSnapshots.length > 0) {
      const safeId = scenario.id.replace(/[^a-zA-Z0-9._-]/g, "_");
      for (let si = 0; si < diagnostics.promptSnapshots.length; si++) {
        const snap = diagnostics.promptSnapshots[si];
        // Используем индекс массива вместо snap.round, чтобы избежать конфликтов имён файлов при сбросе usedSteps в многораундовом tick
        const prefix = `${dumpDir}/${safeId}_s${si}`;
        writeFileSync(`${prefix}_system.txt`, snap.system, "utf-8");
        writeFileSync(`${prefix}_user.txt`, snap.user, "utf-8");
        if (snap.script) writeFileSync(`${prefix}_script.js`, snap.script, "utf-8");
      }
    }

    return {
      scenarioId: scenario.id,
      runIndex,
      script: result.execution.thinks.join("\n") || null,
      steps: result.stepsUsed,
      structural,
      duration: Date.now() - start,
      errors: result.execution.errors,
      // `needs` — старое имя поля в выводе eval; значение берётся из legacy preparedCategories.
      needs: result.preparedCategories as string[],
    };
  } catch (e) {
    return {
      scenarioId: scenario.id,
      runIndex,
      script: null,
      steps: 0,
      structural: { pass: false, checks: [], score: 0 },
      duration: Date.now() - start,
      errors: [e instanceof Error ? e.message : String(e)],
    };
  } finally {
    teardownEvalDb();
  }
}

// ── Агрегация ───────────────────────────────────────────────────────────────────

function aggregateScenario(scenario: EvalScenario, runs: EvalRunResult[]): ScenarioAggregateResult {
  const structuralPasses = runs.filter((r) => r.structural.pass).length;
  return {
    scenarioId: scenario.id,
    title: scenario.title,
    tags: scenario.tags,
    expectedIntent: scenario.structural.expectedIntent,
    expectedBranch: scenario.structural.expectedBranch,
    runs,
    passAtK: structuralPasses > 0,
    passAllK: structuralPasses === runs.length,
    passRate: runs.length > 0 ? structuralPasses / runs.length : 0,
  };
}

// ── Главная точка входа ──────────────────────────────────────────────────────────────────

/** Объект необязательных параметров — заменяет позиционные параметры, упрощает расширение. */
export interface EvalSuiteOptions {
  /** Список сценариев (по умолчанию все BRANCH_SCENARIOS) */
  readonly scenarios?: readonly EvalScenario[];
  /** Обратный вызов после завершения всех runs одного сценария (для потокового вывода CLI) */
  readonly onScenarioComplete?: (result: ScenarioAggregateResult) => void;
  /** ADR-139: Директория для дампа промптов провалившихся сценариев. При установке автоматически экспортирует system/user/script. */
  readonly dumpDir?: string;
  /** Пропускать уже прошедшие сценарии (по умолчанию true — режим последовательного тестирования). Установить false для полного перезапуска. */
  readonly skipPassed?: boolean;
  /** Не останавливаться при FAIL (по умолчанию false — режим fail-fast). Установить true для прохождения всех сценариев. */
  readonly runAll?: boolean;
}

/**
 * Запускает полный eval suite.
 *
 * @param config — конфигурация eval runner
 * @param options — необязательные параметры (список сценариев, потоковый обратный вызов и т.д.)
 */
export async function runEvalSuite(
  config: EvalRunnerConfig,
  options?: EvalSuiteOptions,
): Promise<EvalReport> {
  // Инициализируем LLM provider
  const runtimeConfig = loadConfig();
  initProviders(runtimeConfig);

  const allScenarios = options?.scenarios ?? ALL_SCENARIOS;

  // Фильтрация
  let filtered: readonly EvalScenario[] = allScenarios;
  if (config.filterTags && config.filterTags.length > 0) {
    const tags = new Set(config.filterTags);
    filtered = filtered.filter((s) => s.tags.some((t) => tags.has(t)));
  }
  if (config.filterPrefix) {
    const prefix = config.filterPrefix;
    filtered = filtered.filter((s) => s.id.startsWith(prefix));
  }

  // ADR-139: Инициализация директории для дампа промптов
  const dumpDir = options?.dumpDir;
  if (dumpDir) {
    mkdirSync(dumpDir, { recursive: true });
    log.info(`Prompt dump enabled → ${dumpDir}`);
  }

  // ── Кэш: skip-on-pass при последовательном тестировании ──
  const skipPassed = options?.skipPassed ?? true;
  const cache: EvalCache = skipPassed ? loadCache() : {};
  let skippedCount = 0;

  const results: ScenarioAggregateResult[] = [];

  for (const scenario of filtered) {
    // Skip-on-pass: для уже прошедших сценариев генерируем cached-результат, LLM не вызывается
    if (skipPassed && isCachedPass(cache, scenario.id)) {
      skippedCount++;
      const cachedAgg: ScenarioAggregateResult = {
        scenarioId: scenario.id,
        title: scenario.title,
        tags: scenario.tags,
        expectedIntent: scenario.structural.expectedIntent,
        expectedBranch: scenario.structural.expectedBranch,
        runs: [],
        passAtK: true,
        passAllK: true,
        passRate: 1,
        cached: true,
      };
      results.push(cachedAgg);
      options?.onScenarioComplete?.(cachedAgg);
      continue;
    }

    const runs: EvalRunResult[] = [];
    for (let i = 0; i < config.runs; i++) {
      log.info(`Running ${scenario.id} [${i + 1}/${config.runs}]`);
      const result = await runScenarioOnce(scenario, i, config, dumpDir);
      runs.push(result);
    }
    const agg = aggregateScenario(scenario, runs);
    results.push(agg);
    options?.onScenarioComplete?.(agg);

    // Записываем в кэш (персистим немедленно после каждого сценария, чтобы прогресс не терялся при прерывании)
    cache[scenario.id] = {
      pass: agg.passAtK,
      timestamp: new Date().toISOString(),
      model: config.providerName ?? getLlmProviderByRoute(runtimeConfig, "eval")?.model,
      passRate: agg.passRate,
    };
    saveCache(cache);

    // Fail-fast: при отказе немедленно останавливаемся, не тратим последующие LLM-вызовы
    if (!agg.passAtK && !options?.runAll) {
      log.info(`FAIL on ${scenario.id} — stopping (use --full to continue past failures)`);
      break;
    }
  }

  if (skippedCount > 0) {
    log.info(`Skipped ${skippedCount} cached-pass scenarios (use --full to re-run all)`);
  }

  // ── Агрегация по тегам (только фактически запущенные сценарии) ──
  const tagStats: Record<string, AggregatedStat> = {};
  for (const agg of results) {
    if (agg.cached) continue; // Пропущенные через кэш не учитываются в статистике
    for (const tag of agg.tags) {
      if (!tagStats[tag]) tagStats[tag] = { pass: 0, total: 0, rate: 0 };
      tagStats[tag].total += agg.runs.length;
      tagStats[tag].pass += agg.runs.filter((r) => r.structural.pass).length;
    }
  }
  for (const stat of Object.values(tagStats)) {
    stat.rate = stat.total > 0 ? stat.pass / stat.total : 0;
  }

  // ── Агрегация по социальному интенту (ADR-138: Intent заменяет Branch как основное измерение) ──
  // Сценарии с допустимым набором группируются по первому интенту (основной интент)
  const intentStats: Record<string, AggregatedStat> = {};
  for (const agg of results) {
    if (agg.cached) continue; // Пропущенные через кэш не учитываются в статистике
    const raw = agg.expectedIntent;
    const intent = Array.isArray(raw) ? raw[0] : raw;
    if (!intentStats[intent]) intentStats[intent] = { pass: 0, total: 0, rate: 0 };
    intentStats[intent].total += agg.runs.length;
    intentStats[intent].pass += agg.runs.filter((r) => r.structural.pass).length;
  }
  for (const stat of Object.values(intentStats)) {
    stat.rate = stat.total > 0 ? stat.pass / stat.total : 0;
  }

  return {
    model: config.providerName ?? getLlmProviderByRoute(runtimeConfig, "eval")?.model ?? "unknown",
    timestamp: new Date().toISOString(),
    totalScenarios: filtered.length,
    runsPerScenario: config.runs,
    scenarios: results,
    tagStats,
    intentStats,
  };
}
