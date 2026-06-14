/**
 * Feeds Mod — ADR-167: канал восприятия фидов.
 *
 * Интернет-зрение Алисы: получает контент из публичных API, отражающий её вкусы,
 * периодически подтягивает новые записи и в подходящий момент вставляет их в prompt,
 * позволяя LLM самостоятельно решать, делиться ли ими.
 *
 * Архитектурные ключевые моменты:
 * - Фоновый асинхронный поллинг (setInterval) пишет в кэш уровня модуля
 * - onTickStart/contribute синхронно читают кэш (не блокируют tick)
 * - Записи имеют срок хранения (shelfLifeHours) и максимальное число показов (maxExposures)
 * - Потоки не создаются — содержимое фида является фоновой информацией, а не транзакцией
 * - Новые action не добавляются — LLM делится через существующие возможности (send_message и т. д.)
 *
 * Поведенческая аутентичность (имитация реального листания телефона):
 * - Блокировка по давлению: при активной переписке телефон не листается (API > 0.5 → пропуск)
 * - Период охлаждения: только что посмотрела телефон — сразу снова не смотрит (< 10 мин → пропуск)
 * - Вероятностная инъекция: даже при простое не каждый tick листается (вероятность пропуска 30%)
 * - Случайная выборка + разнообразие источников: из кэша случайно выбирается 2–3 записи разных источников
 *
 * Источники данных: 60s.viki.moe (агрегирующий API) + официальный API Bangumi.
 *
 * @see docs/adr/167-rsshub-perception-channel.md
 */
import { createMod } from "../core/mod-builder.js";
import { PromptBuilder } from "../core/prompt-style.js";
import type { ContributionItem } from "../core/types.js";
import { readPressureApi, section } from "../core/types.js";
import { type FeedDef, type FeedsConfig, loadFeedsConfig } from "../feeds/config.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("feeds");

// ── Записи кэша ──────────────────────────────────────────────────────────────

/** Единственная запись фида в кэше. */
interface CachedFeedItem {
  /** Метка исходного фида (видна LLM). */
  feedLabel: string;
  /** Заголовок записи. */
  title: string;
  /** URL записи. */
  url: string;
  /** Краткое описание. */
  snippet: string;
  /** Время первого получения (мс). */
  fetchedMs: number;
  /** Количество показов (сколько раз запись вставлялась в prompt). */
  exposures: number;
}

// ── Кэш уровня модуля (запись — фоновый поллинг, чтение — Mod синхронно) ─────

/** Глобальный кэш записей фида. key = `${label}::${title}` для дедупликации. */
const feedCache = new Map<string, CachedFeedItem>();

/** Время последнего получения для каждого фида. key = label. */
const lastFetchMs = new Map<string, number>();

/** Ссылка на таймер поллинга (для очистки). */
let pollTimer: ReturnType<typeof setInterval> | null = null;

/** Снимок конфигурации. */
let feedsConfig: FeedsConfig | null = null;

/** Генерирует ключ кэша. */
function cacheKey(label: string, title: string): string {
  return `${label}::${title}`;
}

/**
 * ADR-220: предоставляет инжектируемые записи фида для построителя снимков.
 * Фильтрует просроченные записи и записи с превышенным числом показов.
 */
export function getInjectableFeedItems(): Array<{ title: string; url: string; snippet: string }> {
  if (!feedsConfig) return [];
  const now = Date.now();
  const shelfLifeMs = feedsConfig.shelfLifeHours * 3600_000;
  const maxExp = feedsConfig.maxExposures;
  const result: Array<{ title: string; url: string; snippet: string }> = [];
  for (const item of feedCache.values()) {
    if (now - item.fetchedMs > shelfLifeMs) continue;
    if (item.exposures >= maxExp) continue;
    result.push({ title: item.title, url: item.url, snippet: item.snippet });
  }
  return result;
}

// ── Фоновый поллинг ───────────────────────────────────────────────────────────

/**
 * Получает данные одного фида (вызывает его функцию fetcher).
 */
async function fetchOneFeed(feed: FeedDef, now: number): Promise<void> {
  try {
    const items = await feed.fetcher();
    let newCount = 0;
    for (const item of items) {
      const key = cacheKey(feed.label, item.title);
      if (!feedCache.has(key)) {
        feedCache.set(key, {
          feedLabel: feed.label,
          title: item.title,
          url: item.url,
          snippet: item.snippet,
          fetchedMs: now,
          exposures: 0,
        });
        newCount++;
      }
    }
    if (newCount > 0) {
      log.info("feeds: new items", { label: feed.label, count: newCount });
    }
  } catch (e) {
    log.warn("feeds: fetch failed", {
      label: feed.label,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

/**
 * Проверяет и получает фиды с истёкшим интервалом (один цикл планировщика).
 * Вызывается setInterval, выполняется асинхронно, не блокирует ни один tick.
 */
async function pollFeeds(): Promise<void> {
  if (!feedsConfig) return;

  const now = Date.now();
  const shelfLifeMs = feedsConfig.shelfLifeHours * 3600_000;

  // Очистка просроченных записей
  for (const [key, item] of feedCache) {
    if (now - item.fetchedMs > shelfLifeMs) {
      feedCache.delete(key);
    }
  }

  for (const feed of feedsConfig.feeds) {
    const last = lastFetchMs.get(feed.label) ?? 0;
    if (now - last < feed.intervalMin * 60_000) continue;

    // Фиксируем время получения (даже при ошибке не повторяем — ждём следующий цикл)
    lastFetchMs.set(feed.label, now);
    await fetchOneFeed(feed, now);
  }
}

/**
 * Запускает фоновый поллинг. При первом запуске сразу делает один запрос, затем проверяет каждые 60 секунд.
 * Идемпотентен — повторный вызов не создаёт дополнительных таймеров.
 */
export function startFeedPoller(): void {
  if (pollTimer) return;

  feedsConfig = loadFeedsConfig();

  log.info("feeds: starting poller", { feeds: feedsConfig.feeds.length });

  // Первый запрос сразу (без await, не блокирует запуск)
  void pollFeeds();

  // Проверка каждые 60 секунд (реальная частота получения управляется intervalMin каждого фида)
  pollTimer = setInterval(() => void pollFeeds(), 60_000);
}

/** Останавливает фоновый поллинг (для тестов). */
export function stopFeedPoller(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

/** Очищает кэш (для тестов). */
export function _resetFeedCache(): void {
  feedCache.clear();
  lastFetchMs.clear();
  feedsConfig = null;
}

// ── Параметры поведенческой аутентичности ────────────────────────────────────

/** Порог давления: выше этого значения Алиса «занята делами» и телефон не листает. */
const PRESSURE_GATE = 0.5;

/** Период охлаждения инъекции (мс): если с последней инъекции прошло меньше этого значения — пропуск. */
const INJECT_COOLDOWN_MS = 10 * 60_000; // 10 min

/** Вероятностный пропуск: даже при выполнении условий с этой вероятностью инъекция не происходит (имитация «в этот раз не посмотрела телефон»). */
const SKIP_PROBABILITY = 0.3;

/** Максимальное число записей за одну инъекцию. */
const MAX_ITEMS_PER_INJECT = 3;

// ── Состояние Mod ─────────────────────────────────────────────────────────────

interface FeedsState {
  /** Флаг: запущен ли фоновый поллинг. */
  pollerStarted: boolean;
  /** Время последней успешной инъекции фида (мс). */
  lastInjectMs: number;
}

// ── Вспомогательные функции выборки ──────────────────────────────────────────

/**
 * Разнообразная выборка из кандидатов: сначала покрывает разные источники, не более 1 записи с источника,
 * внутри источника выбирает случайно. Похоже на смешанную ленту при листании телефона.
 */
function diverseSample(items: CachedFeedItem[], n: number): CachedFeedItem[] {
  // Группируем по источнику
  const byLabel = new Map<string, CachedFeedItem[]>();
  for (const item of items) {
    const group = byLabel.get(item.feedLabel) ?? [];
    group.push(item);
    byLabel.set(item.feedLabel, group);
  }

  const result: CachedFeedItem[] = [];
  const labels = [...byLabel.keys()];

  // Первый круг: случайно выбираем 1 запись с каждого источника (обеспечиваем разнообразие)
  for (const label of labels) {
    if (result.length >= n) break;
    // biome-ignore lint/style/noNonNullAssertion: label взят из byLabel.keys()
    const group = byLabel.get(label)!;
    const idx = Math.floor(Math.random() * group.length);
    result.push(group.splice(idx, 1)[0]);
  }

  // Второй круг: если ещё не хватает, добираем случайно из оставшихся
  if (result.length < n) {
    const remaining = [...byLabel.values()].flat();
    while (result.length < n && remaining.length > 0) {
      const idx = Math.floor(Math.random() * remaining.length);
      result.push(remaining.splice(idx, 1)[0]);
    }
  }

  return result;
}

// ── Определение Mod ───────────────────────────────────────────────────────────

export const feedsMod = createMod<FeedsState>("feeds", {
  category: "mechanic",
  description: "ADR-167: канал восприятия фидов — интернет-зрение Алисы",
  initialState: { pollerStarted: false, lastInjectMs: 0 },
})
  .onTickStart((ctx) => {
    // При первом tick запускаем фоновый поллинг (гарантируем единственный запуск)
    if (!ctx.state.pollerStarted) {
      startFeedPoller();
      ctx.state.pollerStarted = true;
    }
  })
  .contribute((ctx): ContributionItem[] => {
    if (!feedsConfig || feedCache.size === 0) return [];

    // ── Поведенческие блокировки: имитация реального «листания телефона» ──

    // 1. Блокировка по давлению: при активной обработке сообщений телефон не листается
    const pressure = readPressureApi(ctx);
    if (pressure > PRESSURE_GATE) return [];

    // 2. Период охлаждения: только что посмотрела телефон — сразу снова не смотрит
    const now = ctx.nowMs;
    if (ctx.state.lastInjectMs > 0 && now - ctx.state.lastInjectMs < INJECT_COOLDOWN_MS) {
      return [];
    }

    // 3. Вероятностный пропуск: человек смотрит в телефон не каждую минуту
    if (Math.random() < SKIP_PROBABILITY) return [];

    // ── Фильтрация + выборка ──

    const shelfLifeMs = feedsConfig.shelfLifeHours * 3600_000;
    const maxExp = feedsConfig.maxExposures;

    const eligible: CachedFeedItem[] = [];
    for (const item of feedCache.values()) {
      if (now - item.fetchedMs > shelfLifeMs) continue;
      if (item.exposures >= maxExp) continue;
      eligible.push(item);
    }

    if (eligible.length === 0) return [];

    // Разнообразная выборка: случайно выбираем 2–3 записи, стараемся охватить разные источники
    const toShow = diverseSample(eligible, MAX_ITEMS_PER_INJECT);

    // Увеличиваем счётчик показов + фиксируем время инъекции
    for (const item of toShow) {
      item.exposures += 1;
    }
    ctx.state.lastInjectMs = now;

    // Рендерим в секцию prompt
    const lines = toShow.map((item) => {
      let line = `${item.feedLabel} «${item.title}»`;
      if (item.url) line += ` ${item.url}`;
      return PromptBuilder.of(line);
    });

    return [
      section(
        "feed-items",
        lines,
        "Ты только что увидела в телефоне",
        40, // order: ближе к концу (не вытесняет основной контекст)
        30, // priority: низкий (может быть урезан бюджетом токенов)
      ),
    ];
  })
  .build();
