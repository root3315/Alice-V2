/**
 * ADR-167: Канал восприятия Feed — отдельная конфигурация.
 *
 * Персональные feeds жёстко заданы здесь (равнозначны SOUL_CORE — вкусы Alice).
 * Источники данных напрямую подключены к публичным API (60s.viki.moe + Bangumi и др.), без зависимости от RSSHub.
 *
 * @see docs/adr/167-rsshub-perception-channel.md
 */
import {
  type FeedItem,
  fetchBangumiToday,
  fetchBiliHot,
  fetchEpicFreeGames,
  fetchHackerNewsTop,
  fetchTodayInHistory,
} from "./sources.js";

/** Определение одного feed. */
export interface FeedDef {
  /** Семантический тег, видимый LLM (например "Тренды Bilibili"). */
  label: string;
  /** Интервал опроса (минуты). */
  intervalMin: number;
  /** Функция получения данных. */
  fetcher: () => Promise<FeedItem[]>;
}

/** Конфигурация канала восприятия Feed. */
export interface FeedsConfig {
  /** Персональные feeds. */
  feeds: FeedDef[];
  /** Максимальное число показов одной записи (количество инъекций в prompt); после превышения не отображается. */
  maxExposures: number;
  /** Срок хранения записи (часы). По истечении удаляется, даже если не была показана. */
  shelfLifeHours: number;
}

// ── Персональные feeds: отражают вкусы и интересы Alice ────────────────────────────────────
// Критерии отбора: популярные публичные источники контента, близкие к повседневному опыту 16-летнего цифрового аборигена.
// Источники данных: 60s.viki.moe (агрегирующий API, бесплатно без ключа) + официальный API Bangumi.
// В дальнейшем корректируется по мере эволюции персонажа Alice.

const PERSONA_FEEDS: FeedDef[] = [
  // Социальные тренды — знать, о чём все говорят
  { label: "Тренды Bilibili", intervalMin: 120, fetcher: () => fetchBiliHot(5) },
  // Технологии — повседневная жизнь цифрового аборигена
  { label: "Популярное на HackerNews", intervalMin: 360, fetcher: () => fetchHackerNewsTop(5) },
  // Игры — бесплатные игры Epic как естественный материал для разговора
  { label: "Бесплатные игры недели в Epic", intervalMin: 720, fetcher: fetchEpicFreeGames },
  // ACG — новые серии аниме сегодня
  { label: "Новые серии аниме сегодня", intervalMin: 720, fetcher: () => fetchBangumiToday(5) },
  // Занимательные факты — день в истории (материал для тем разговора)
  { label: "Этот день в истории", intervalMin: 1440, fetcher: () => fetchTodayInHistory(3) },
];

/** Загрузить конфигурацию feeds. */
export function loadFeedsConfig(): FeedsConfig {
  return {
    feeds: PERSONA_FEEDS,
    maxExposures: 2,
    shelfLifeHours: 12,
  };
}
