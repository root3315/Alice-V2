/**
 * ADR-167: источники данных фидов — прямое подключение к публичным API.
 *
 * Каждый источник данных — асинхронная функция, возвращающая унифицированный FeedItem[].
 * Не зависит от промежуточных слоёв вроде RSSHub, напрямую вызывает публичные API платформ.
 *
 * Источники данных:
 * - 60s.viki.moe: агрегатор горячих тем (Bilibili, HackerNews, бесплатные игры Epic и др.)
 * - api.bgm.tv: официальный API Bangumi (аниме-премьеры сегодня)
 *
 * @see docs/adr/167-rsshub-perception-channel.md
 */
import { createLogger } from "../utils/logger.js";

const log = createLogger("feed-sources");

/** Унифицированная запись фида. */
export interface FeedItem {
  title: string;
  url: string;
  snippet: string;
}

/** Обёртка fetch с таймаутом. */
async function fetchWithTimeout(url: string, timeoutMs = 10_000): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

// ── Источник данных 60s.viki.moe ─────────────────────────────────────────────

const VIKI_BASE = "https://60s.viki.moe";

/** Горячие темы Bilibili. */
export async function fetchBiliHot(limit = 5): Promise<FeedItem[]> {
  try {
    const resp = await fetchWithTimeout(`${VIKI_BASE}/v2/bili`);
    if (!resp.ok) return [];
    const json = (await resp.json()) as { code: number; data: Array<Record<string, unknown>> };
    if (json.code !== 200 || !Array.isArray(json.data)) return [];
    return json.data
      .slice(0, limit)
      .map((item) => ({
        title: String(item.title ?? ""),
        url: String(item.link ?? ""),
        snippet: "",
      }))
      .filter((i) => i.title);
  } catch (e) {
    log.warn("feed: bili hot failed", { error: e instanceof Error ? e.message : String(e) });
    return [];
  }
}

/** Топ HackerNews. */
export async function fetchHackerNewsTop(limit = 5): Promise<FeedItem[]> {
  try {
    const resp = await fetchWithTimeout(`${VIKI_BASE}/v2/hacker-news/top`);
    if (!resp.ok) return [];
    const json = (await resp.json()) as {
      code: number;
      data: Array<{ title?: string; link?: string; score?: number }>;
    };
    if (json.code !== 200 || !Array.isArray(json.data)) return [];
    return json.data
      .slice(0, limit)
      .map((item) => ({
        title: item.title ?? "",
        url: item.link ?? "",
        snippet: item.score ? `${item.score} points` : "",
      }))
      .filter((i) => i.title);
  } catch (e) {
    log.warn("feed: hacker news failed", { error: e instanceof Error ? e.message : String(e) });
    return [];
  }
}

// ── Универсальный RSS/Atom-фетчер (без зависимостей) ─────────────────────────

/** Снять CDATA/теги, декодировать базовые сущности, схлопнуть пробелы. */
function cleanXmlText(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/** Первый матч содержимого тега в блоке item/entry. */
function pickXmlTag(block: string, tag: string): string {
  return block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i"))?.[1] ?? "";
}

/**
 * Универсальный RSS 2.0 / Atom фетчер: WordPress-/новостные ленты (напр. MLBB-новости)
 * без RSSHub и внешних парсеров. Толерантен к сбоям: любая ошибка → [].
 */
export async function fetchRss(feedUrl: string, limit = 5): Promise<FeedItem[]> {
  try {
    const resp = await fetchWithTimeout(feedUrl, 12_000);
    if (!resp.ok) return [];
    const xml = await resp.text();
    const items: FeedItem[] = [];
    const itemRe = /<(item|entry)\b[\s\S]*?<\/\1>/gi;
    let m = itemRe.exec(xml);
    while (m !== null && items.length < limit) {
      const block = m[0];
      const title = cleanXmlText(pickXmlTag(block, "title"));
      // RSS: <link>url</link>; Atom: <link href="..."/>.
      const atomHref = block.match(/<link[^>]*href="([^"]+)"/i)?.[1];
      const url = cleanXmlText(atomHref ?? pickXmlTag(block, "link"));
      const snippet = cleanXmlText(
        pickXmlTag(block, "description") || pickXmlTag(block, "summary"),
      ).slice(0, 160);
      if (title) items.push({ title, url, snippet });
      m = itemRe.exec(xml);
    }
    return items;
  } catch (e) {
    log.warn("feed: rss failed", { url: feedUrl, error: e instanceof Error ? e.message : String(e) });
    return [];
  }
}

/** Бесплатные игры Epic этой недели. */
export async function fetchEpicFreeGames(): Promise<FeedItem[]> {
  try {
    const resp = await fetchWithTimeout(`${VIKI_BASE}/v2/epic`);
    if (!resp.ok) return [];
    const json = (await resp.json()) as {
      code: number;
      data: Array<{
        title?: string;
        link?: string;
        description?: string;
        is_free_now?: boolean;
        free_end?: string;
      }>;
    };
    if (json.code !== 200 || !Array.isArray(json.data)) return [];
    return json.data
      .filter((item) => item.is_free_now)
      .map((item) => ({
        title: item.title ?? "",
        url: item.link ?? "",
        snippet: item.free_end ? `бесплатно до ${item.free_end}` : "",
      }))
      .filter((i) => i.title);
  } catch (e) {
    log.warn("feed: epic free games failed", { error: e instanceof Error ? e.message : String(e) });
    return [];
  }
}

/** Этот день в истории. */
export async function fetchTodayInHistory(limit = 3): Promise<FeedItem[]> {
  try {
    const resp = await fetchWithTimeout(`${VIKI_BASE}/v2/today-in-history`);
    if (!resp.ok) return [];
    const json = (await resp.json()) as {
      code: number;
      data: {
        items?: Array<{ title?: string; year?: string; description?: string; link?: string }>;
      };
    };
    if (json.code !== 200 || !json.data?.items) return [];
    return json.data.items
      .slice(0, limit)
      .map((item) => ({
        title: `${item.year ?? ""} г. — ${item.title ?? ""}`.trim(),
        url: item.link ?? "",
        snippet: (item.description ?? "").slice(0, 100),
      }))
      .filter((i) => i.title);
  } catch (e) {
    log.warn("feed: today in history failed", {
      error: e instanceof Error ? e.message : String(e),
    });
    return [];
  }
}

// ── Официальный API Bangumi ───────────────────────────────────────────────────

/** Аниме-премьеры сегодня (официальный API Bangumi, полностью открытый). */
export async function fetchBangumiToday(limit = 5): Promise<FeedItem[]> {
  try {
    const resp = await fetchWithTimeout("https://api.bgm.tv/calendar");
    if (!resp.ok) return [];
    const calendar = (await resp.json()) as Array<{
      weekday: { id: number; cn: string };
      items: Array<{
        name_cn?: string;
        name?: string;
        url?: string;
        air_date?: string;
      }>;
    }>;

    // Определяем день недели сегодня (Bangumi weekday id: 1=Mon...7=Sun)
    const todayId = new Date().getDay() || 7; // JS: 0=Sun → 7
    const todayEntry = calendar.find((d) => d.weekday.id === todayId);
    if (!todayEntry) return [];

    return todayEntry.items
      .slice(0, limit)
      .map((item) => ({
        title: item.name_cn || item.name || "",
        url: item.url ?? "",
        snippet: item.air_date ? `в эфире с ${item.air_date}` : "",
      }))
      .filter((i) => i.title);
  } catch (e) {
    log.warn("feed: bangumi calendar failed", {
      error: e instanceof Error ? e.message : String(e),
    });
    return [];
  }
}
