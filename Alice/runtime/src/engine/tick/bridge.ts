/**
 * Tick Bridge — адаптирует конвейер Blackboard Tick к существующему интерфейсу orchestrator.
 *
 * Обязанности:
 * 1. Получение FeatureFlags + Blackboard из ActContext + ActionQueueItem
 * 2. Сборка TickDeps (обёртка над существующими функциями модулей)
 * 3. Вызов основного цикла tick()
 * 4. Конвертация TickResult в SubcycleResult (для потребления существующим orchestrator)
 *
 * @see docs/adr/142-action-space-architecture/README.md
 */

import type { ActionRuntimeConfig } from "../../core/action-executor.js";
import { getDb } from "../../db/connection.js";
import { type AvailableProvider, selectProviderForTick } from "../../llm/client.js";
import { TELEGRAM_ACTIONS } from "../../telegram/actions/index.js";
import { hasPaletteEntries } from "../../telegram/apps/sticker-palette.js";
import { createLogger } from "../../utils/logger.js";
import type { PressureDims } from "../../utils/math.js";
import type { EngagementSession } from "../act/engagement.js";
import type { MessageRecord } from "../act/messages.js";
import { extractRuntimeConfig } from "../act/runtime-config.js";
import type { ActionQueueItem } from "../action-queue.js";
import type { ActContext } from "../react/orchestrator.js";
import type { SubcycleResult } from "../react/types.js";
import { collectAllTools } from "./affordance-filter.js";
import { createBlackboard } from "./blackboard.js";
import { callTickLLM } from "./callLLM.js";
import { shouldUseOpsModel } from "./ops-model.js";
import type { TickPromptContext } from "./prompt-builder.js";
import type { ResolvedTarget } from "./target.js";
import { type TickDeps, tick } from "./tick.js";
import type { FeatureFlags, TickResult, UnifiedTool } from "./types.js";

const log = createLogger("tick/bridge");

// Model-tiering (#23): работач берём из env (тот же OPS_CHANNEL_ID, что incident-детекция
// в events.ts). Не задан → Opus-маршрут вообще не включается, поведение как раньше.
// Решение Opus/sonnet — в shouldUseOpsModel: только реальная ops-работа, не «просто так».
const OPS_CHANNEL_ID = process.env.OPS_CHANNEL_ID;

// ═══════════════════════════════════════════════════════════════════════════
// Вычисление FeatureFlags
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Вычисляет runtime FeatureFlags из ActContext.
 *
 * Каждый флаг соответствует жёсткому условию-шлюзу:
 * - Конфигурационные (hasMusic, hasBrowser, hasTTS, hasVideo): зависят от наличия API key / URL
 * - Графовые (hasStickers, hasBots, hasSystemThreads): зависят от состояния сущностей WorldModel
 * - Всегда истинные (hasWeather): погодный API (wttr.in) бесплатный, без ключа
 */
function deriveFeatureFlags(ctx: ActContext): FeatureFlags {
  const { config, G } = ctx;
  return {
    hasWeather: true, // wttr.in бесплатный, всегда доступен
    hasMusic: !!config.musicApiBaseUrl,
    hasBrowser: !!config.exaApiKey,
    hasTTS: !!config.ttsBaseUrl && !!config.ttsApiKey,
    hasVideo: !!config.youtubeApiKey,
    hasStickers:
      hasPaletteEntries(getDb()) ||
      (G.has("self") && Array.isArray(G.getDynamic("self", "installed_stickers"))),
    hasBots: G.getEntitiesByType("contact").some((id) => G.getContact(id).is_bot === true),
    hasSystemThreads: G.getEntitiesByType("thread").some(
      (tid) => G.getThread(tid).source === "system" && G.getThread(tid).status === "open",
    ),
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Преобразование TickResult → SubcycleResult
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Конвертирует TickResult в SubcycleResult.
 *
 * Правила маппинга:
 * - stepsUsed → roundsUsed (семантически эквивалентны, разные названия)
 * - observations/preparedCategories существуют только в TickResult, не маппируются
 */
function toSubcycleResult(result: TickResult): SubcycleResult {
  return {
    outcome: result.outcome,
    execution: result.execution,
    duration: result.duration,
    roundsUsed: result.stepsUsed,
    episodeRounds: result.episodeRounds,
    tcMeta: result.tcMeta,
    failureKind: result.failureKind,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Сборка TickDeps
// ═══════════════════════════════════════════════════════════════════════════

function buildTickDeps(): TickDeps {
  return {
    callLLM: async (system, user, tick, target, voice, contextVars, selectedProvider) => {
      return callTickLLM(system, user, tick, target, voice, contextVars, selectedProvider);
    },

    // ADR-214 Wave A: resolveQueries удалён.
    // В shell-native архитектуре scriptResult.actions всегда пуст,
    // resolveQueries никогда не выполнял никакой значимой работы.
    // Действия Query выполняются напрямую через Engine API HTTP внутри контейнера.
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Общий контекст выполнения tick
// ═══════════════════════════════════════════════════════════════════════════

/** Полный тип контекста для tick() — TickPromptContext + runtime-зависимости. */
type TickRunContext = TickPromptContext & {
  client: unknown;
  runtimeConfig: ActionRuntimeConfig;
  llmProvider: AvailableProvider;
};

/** Все предварительно подготовленные артефакты, необходимые для запуска tick(). */
interface TickRunKit {
  board: ReturnType<typeof createBlackboard>;
  allTools: readonly UnifiedTool[];
  deps: TickDeps;
}

/**
 * Строит Blackboard + список инструментов + зависимости для запуска tick().
 * Выделяет общую логику для использования в runTickSubcycle.
 */
function prepareTickRun(
  ctx: ActContext,
  item: ActionQueueItem,
  contextVars: Record<string, unknown>,
  opts?: { maxSteps?: number },
): TickRunKit {
  const features = deriveFeatureFlags(ctx);
  const pressures = ctx.getCurrentPressures() as PressureDims;

  const board = createBlackboard({
    pressures,
    voice: item.action,
    target: item.target ?? null,
    features,
    contextVars,
    maxSteps: opts?.maxSteps,
  });

  const allTools = collectAllTools(ctx.dispatcher.mods, TELEGRAM_ACTIONS);
  const deps = buildTickDeps();

  return { board, allTools, deps };
}

/** Собирает TickRunContext, необходимый для tick(), из ActContext. */
function buildTickRunContext(
  ctx: ActContext,
  item: ActionQueueItem,
  currentTick: number,
  messages: MessageRecord[],
  observations: string[],
  llmProvider: AvailableProvider,
): TickRunContext {
  return {
    G: ctx.G,
    dispatcher: ctx.dispatcher,
    mods: ctx.dispatcher.mods,
    config: ctx.config,
    item,
    tick: currentTick,
    messages,
    observations,
    round: 0,
    client: ctx.client,
    runtimeConfig: extractRuntimeConfig(ctx.config),
    llmProvider,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Публичный API — прямая замена runReActSubcycle
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Запускает подцикл Blackboard Tick — замена drop-in для orchestrator.ts.
 *
 * ADR-169 структурный рефакторинг: разрешение запросов и продолжение по ошибкам
 * инкапсулированы в цикл tick(). Слой bridge только собирает Blackboard + deps + context,
 * логика продолжения циклов в нём отсутствует.
 *
 * @see docs/adr/169-fire-query-auto-continuation.md
 */
export async function runTickSubcycle(
  ctx: ActContext,
  item: ActionQueueItem,
  currentTick: number,
  _targetChatId: number | null,
  liveMessages: MessageRecord[],
  _resolved: ResolvedTarget | null,
  contextVars: Record<string, unknown> | undefined,
  _session: EngagementSession,
): Promise<SubcycleResult> {
  const { board, allTools, deps } = prepareTickRun(ctx, item, contextVars ?? {});
  // Model-tiering (#23): Opus только когда в работач к Алисе реально обращаются
  // (вопрос/код-ревью/инцидент); автономные патрули и болтовня остаются на sonnet.
  const opsChannel =
    item.target && ctx.G.has(item.target) ? ctx.G.getChannel(item.target) : null;
  const isOpsTick = shouldUseOpsModel(item.target, OPS_CHANNEL_ID, opsChannel, Date.now());
  const llmProvider = selectProviderForTick(isOpsTick);
  if (isOpsTick) {
    log.info("ops tick → opus route", {
      target: item.target,
      model: llmProvider.model,
      endpoint: llmProvider.name,
      pendingDirected: opsChannel?.pending_directed ?? 0,
    });
  }

  const tickCtx = buildTickRunContext(
    ctx,
    item,
    currentTick,
    liveMessages,
    board.observations,
    llmProvider,
  );
  const result = await tick(board, allTools, deps, tickCtx);
  // ADR-215: пробросить LLM residue в ActionQueueItem → потребляется processResult
  if (result.llmResidue) item.llmResidue = result.llmResidue;
  return toSubcycleResult(result);
}

// ADR-214 Wave B: runCorrectionTick удалён.
// В shell-native архитектуре Telegram-действия выполняются напрямую через Engine API HTTP внутри контейнера;
// механические повторы и LLM-коррекции correction tick являются мёртвым кодом.
