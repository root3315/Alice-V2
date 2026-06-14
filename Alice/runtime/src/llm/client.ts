/**
 * Vercel AI SDK — цепочка fallback для нескольких LLM endpoint.
 *
 * D5 (ADR-123 §D5): расширение единственного синглтона provider до упорядоченного массива endpoint.
 * Каждый endpoint имеет собственный автоматический выключатель (через per-endpoint breaker в resilience.ts).
 * `selectProviderForFirstPass()` возвращает endpoint для первого прохода/общих структурированных задач по маршруту firstPass,
 * `selectProviderForTick()` возвращает модель для последующего выполнения shell/tool по маршруту toolTick.
 * При полностью открытых выключателях в маршруте — откат к первому (ожидание полуоткрытой пробы).
 *
 * Используется @ai-sdk/openai-compatible (а не @ai-sdk/openai),
 * поскольку Alice подключается к OpenAI-совместимому прокси (например, ohmygpt), а не к нативному API OpenAI.
 *
 * @see docs/adr/123-crystallization-substrate-generalization.md §D5
 */
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { Config, ProviderConfig } from "../config.js";
import { getBreakerState } from "./resilience.js";

// -- Типы -------------------------------------------------------------------

interface ProviderEntry {
  config: ProviderConfig;
  provider: ReturnType<typeof createOpenAICompatible>;
}

export interface AvailableProvider {
  provider: ReturnType<typeof createOpenAICompatible>;
  model: string;
  name: string;
}

// -- Состояние --------------------------------------------------------------

let _providers: ProviderEntry[] = [];
let _routing: Config["llmRouting"] = {
  firstPass: [],
  toolTick: [],
  opsFirstPass: [],
  opsToolTick: [],
  eval: [],
  auxiliary: [],
  reflect: [],
};
const _providerByName = new Map<string, ProviderEntry>();
const _routeBags = new Map<string, string[]>();

// -- Публичный API ----------------------------------------------------------

/** Инициализировать цепочку endpoint из Config.providers. Вызывается один раз при запуске. */
export function initProviders(config: Config): void {
  _providers = config.providers.map((pc) => ({
    config: pc,
    provider: createOpenAICompatible({
      name: pc.name,
      baseURL: pc.baseUrl,
      apiKey: pc.apiKey,
      // Включить режим json_schema, чтобы generateObject отправлял полную схему API,
      // принуждая сервер к structured output. Иначе отправляется только { type: "json_object" },
      // LLM возвращает свободный JSON → систематические сбои Zod-валидации.
      // @see https://github.com/vercel/ai/issues/5197
      supportsStructuredOutputs: true,
    }),
  }));
  _providerByName.clear();
  for (const entry of _providers) {
    _providerByName.set(entry.config.name, entry);
  }
  _routing = config.llmRouting ?? {
    firstPass: _providers.map((entry) => entry.config.name),
    toolTick: _providers.map((entry) => entry.config.name),
    opsFirstPass: _providers.map((entry) => entry.config.name),
    opsToolTick: _providers.map((entry) => entry.config.name),
    eval: _providers.map((entry) => entry.config.name),
    auxiliary: _providers.map((entry) => entry.config.name),
    reflect: _providers.map((entry) => entry.config.name),
  };
  _routeBags.clear();
}

/**
 * Вернуть текущий доступный firstPass endpoint (пропускать те, чей автовыключатель открыт).
 * firstPass используется для первого прохода/общих структурированных задач, не для последующей модели выполнения shell/tool tick.
 * При полностью открытых выключателях — откат к первому, ожидание полуоткрытой пробы.
 */
export function selectProviderForFirstPass(ops = false): AvailableProvider {
  const useOps = ops && _routing.opsFirstPass.length > 0;
  if (useOps) {
    // ops: СТРОГИЙ приоритет (opus первый), НЕ shuffle — sonnet только если opus circuit-open.
    return selectAvailableFromRoute(_routing.opsFirstPass, "opsFirstPass");
  }
  return selectShuffledAvailableFromRoute("firstPass", _routing.firstPass);
}

function selectAvailableFromRoute(route: readonly string[], routeName: string): AvailableProvider {
  if (_providers.length === 0) {
    throw new Error("No providers initialized — call initProviders() first");
  }
  const entries = route.flatMap((name) => {
    const entry = _providerByName.get(name);
    return entry ? [entry] : [];
  });
  if (entries.length === 0) {
    throw new Error(`No providers configured for LLM route "${routeName}"`);
  }

  for (const entry of entries) {
    if (getBreakerState(entry.config.name) !== "open") {
      return { provider: entry.provider, model: entry.config.model, name: entry.config.name };
    }
  }
  // Все open → принудительно использовать первый в маршруте (ожидание полуоткрытой пробы)
  const first = entries[0];
  return { provider: first.provider, model: first.config.model, name: first.config.name };
}

function nextEndpointFromRoute(routeName: string, route: readonly string[]): string {
  let bag = _routeBags.get(routeName);
  if (!bag || bag.length === 0) {
    bag = shuffle([...route]);
    _routeBags.set(routeName, bag);
  }
  return bag.pop() ?? route[0] ?? "";
}

function selectShuffledAvailableFromRoute(
  routeName: string,
  route: readonly string[],
): AvailableProvider {
  for (let attempt = 0; attempt < route.length; attempt++) {
    const endpointName = nextEndpointFromRoute(routeName, route);
    const entry = _providerByName.get(endpointName);
    if (entry && getBreakerState(entry.config.name) !== "open") {
      return { provider: entry.provider, model: entry.config.model, name: entry.config.name };
    }
  }
  return selectAvailableFromRoute(route, routeName);
}

function shuffle<T>(items: T[]): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}

/**
 * Выбор модели для входной точки tick.
 *
 * Идентификатор ротации — стабильный model ID (AvailableProvider.model), не имя endpoint.
 * Имя endpoint используется только для маршрутизации, автовыключателей и диагностики транспорта.
 *
 * Граница выбора — subcycle тика: корректировки/повторные проходы внутри одного subcycle должны переиспользовать одну модель,
 * чтобы избежать дрейфа личности и способа рассуждения в рамках одного действия.
 */
export function selectProviderForTick(ops = false): AvailableProvider {
  const useOps = ops && _routing.opsToolTick.length > 0;
  if (useOps) {
    // ops: СТРОГИЙ приоритет (opus первый), НЕ shuffle — sonnet только если opus circuit-open.
    return selectAvailableFromRoute(_routing.opsToolTick, "opsToolTick");
  }
  return selectShuffledAvailableFromRoute("toolTick", _routing.toolTick);
}

/**
 * Provider для eval / calibration.
 *
 * Независим от боевых firstPass/toolTick, чтобы тестовый выбор модели не загрязнял продакшн-маршруты.
 */
export function getEvalProvider(): AvailableProvider {
  return selectAvailableFromRoute(_routing.eval, "eval");
}

/**
 * Provider для внутренних вспомогательных задач приложения.
 *
 * Не участвует в пуле выполнения toolTick; выбирается по порядку fallback в llm.routing.auxiliary.
 */
export function getAuxiliaryProvider(): AvailableProvider {
  return selectAvailableFromRoute(_routing.auxiliary, "auxiliary");
}

/**
 * Есть ли хотя бы один provider с автовыключателем не в состоянии open.
 *
 * Слой evolve вызывает эту функцию перед directed_override —
 * при полностью сработавших провайдерах принудительное действие лишь вхолостую расходует тик.
 *
 * @see docs/adr/156-emotional-reactivity-damping.md — исправление каскадного сбоя
 */
export function isAnyProviderHealthy(): boolean {
  if (_providers.length === 0) return false;
  return _providers.some((entry) => getBreakerState(entry.config.name) !== "open");
}

/** Сбросить список провайдеров (для тестов). */
export function resetProviders(): void {
  _providers = [];
  _providerByName.clear();
  _routing = {
    firstPass: [],
    toolTick: [],
    opsFirstPass: [],
    opsToolTick: [],
    eval: [],
    auxiliary: [],
    reflect: [],
  };
  _routeBags.clear();
}
