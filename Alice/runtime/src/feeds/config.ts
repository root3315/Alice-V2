/**
 * ADR-167: Feed 感知通道 — 独立配置。
 *
 * 人设 feeds 硬编码于此（和 SOUL_CORE 同等地位——Alice 的品味）。
 * 数据源直接对接公开 API（60s.viki.moe + Bangumi 等），不依赖 RSSHub。
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

/** 单条 feed 定义。 */
export interface FeedDef {
  /** LLM 可见的语义标签（如 "B站热搜"）。 */
  label: string;
  /** 拉取间隔（分钟）。 */
  intervalMin: number;
  /** 数据拉取函数。 */
  fetcher: () => Promise<FeedItem[]>;
}

/** Feed 感知通道配置。 */
export interface FeedsConfig {
  /** 人设 feeds。 */
  feeds: FeedDef[];
  /** 单条条目最大曝光次数（注入 prompt 的次数），超过后不再展示。 */
  maxExposures: number;
  /** 条目保质期（小时）。超过后即使未曝光也丢弃。 */
  shelfLifeHours: number;
}

// ── 人设 feeds：反映 Alice 的品味和兴趣 ────────────────────────────────────
// 选择标准：公开热门内容源，贴近 16 岁数码原住民的日常刷机体验。
// 数据源：60s.viki.moe（聚合 API，免费无 key）+ Bangumi 官方 API。
// 后续按 Alice 人设演化调整。

const PERSONA_FEEDS: FeedDef[] = [
  // 社交热点——知道大家在聊什么
  { label: "Тренды Bilibili", intervalMin: 120, fetcher: () => fetchBiliHot(5) },
  // 技术前沿——数码原住民的日常
  { label: "Популярное на HackerNews", intervalMin: 360, fetcher: () => fetchHackerNewsTop(5) },
  // 游戏——Epic 免费游戏是天然的 pebbling 素材
  { label: "Бесплатные игры недели в Epic", intervalMin: 720, fetcher: fetchEpicFreeGames },
  // ACG——今日新番
  { label: "Новые серии аниме сегодня", intervalMin: 720, fetcher: () => fetchBangumiToday(5) },
  // 冷知识——历史上的今天（聊天话题素材）
  { label: "Этот день в истории", intervalMin: 1440, fetcher: () => fetchTodayInHistory(3) },
];

/** 加载 feeds 配置。 */
export function loadFeedsConfig(): FeedsConfig {
  return {
    feeds: PERSONA_FEEDS,
    maxExposures: 2,
    shelfLifeHours: 12,
  };
}
