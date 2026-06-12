/**
 * Feeds Mod — ADR-167: Feed 感知通道。
 *
 * Alice 的互联网视觉：通过公开 API 拉取反映人设品味的内容源，
 * 定时拉取新条目，在适当时机注入 prompt 让 LLM 自行决定是否分享。
 *
 * 架构要点：
 * - 后台异步轮询（setInterval）写入模块级缓存
 * - onTickStart/contribute 同步读取缓存（不阻塞 tick）
 * - 条目有保质期（shelfLifeHours）和最大曝光次数（maxExposures）
 * - 不创建线程——feed 内容是环境信息，不是事务
 * - 不新增 action——LLM 用现有 send_message 等能力分享
 *
 * 行为真实性（模拟真实刷手机行为）：
 * - 压力门控：忙着回消息时不刷手机（API > 0.5 → 跳过）
 * - 冷却期：刚看过手机不会马上又看（距上次注入 < 10 min → 跳过）
 * - 概率性注入：即使空闲也不是每个 tick 都刷（30% 概率跳过）
 * - 随机采样 + 来源多样性：从缓存中随机选 2-3 条，尽量覆盖不同来源
 *
 * 数据源：60s.viki.moe（聚合 API）+ Bangumi 官方 API。
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

// ── 缓存条目 ─────────────────────────────────────────────────────────────────

/** 缓存中的单条 feed 条目。 */
interface CachedFeedItem {
  /** 来源 feed 的 label（LLM 可见）。 */
  feedLabel: string;
  /** 条目标题。 */
  title: string;
  /** 条目 URL。 */
  url: string;
  /** 摘要。 */
  snippet: string;
  /** 首次拉取时间（ms）。 */
  fetchedMs: number;
  /** 已曝光次数（注入 prompt 的次数）。 */
  exposures: number;
}

// ── 模块级缓存（后台轮询写入，Mod 同步读取）──────────────────────────────────

/** 全局 feed 条目缓存。key = `${label}::${title}` 去重。 */
const feedCache = new Map<string, CachedFeedItem>();

/** 每条 feed 的上次拉取时间。key = label。 */
const lastFetchMs = new Map<string, number>();

/** 轮询定时器引用（用于清理）。 */
let pollTimer: ReturnType<typeof setInterval> | null = null;

/** 配置快照。 */
let feedsConfig: FeedsConfig | null = null;

/** 生成缓存 key。 */
function cacheKey(label: string, title: string): string {
  return `${label}::${title}`;
}

/**
 * ADR-220: 暴露可注入的 feed 条目给 snapshot 构建器。
 * 过滤已过期和已达最大曝光次数的条目。
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

// ── 后台轮询 ─────────────────────────────────────────────────────────────────

/**
 * 拉取单个 feed（调用其 fetcher 函数）。
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
 * 检查并拉取到期的 feeds（单次调度周期）。
 * 被 setInterval 调用，异步执行，不阻塞任何 tick。
 */
async function pollFeeds(): Promise<void> {
  if (!feedsConfig) return;

  const now = Date.now();
  const shelfLifeMs = feedsConfig.shelfLifeHours * 3600_000;

  // 清理过期条目
  for (const [key, item] of feedCache) {
    if (now - item.fetchedMs > shelfLifeMs) {
      feedCache.delete(key);
    }
  }

  for (const feed of feedsConfig.feeds) {
    const last = lastFetchMs.get(feed.label) ?? 0;
    if (now - last < feed.intervalMin * 60_000) continue;

    // 标记拉取时间（即使失败也不重试，等下一个周期）
    lastFetchMs.set(feed.label, now);
    await fetchOneFeed(feed, now);
  }
}

/**
 * 启动后台轮询。首次立即拉取一次，之后每 60 秒检查一次。
 * 幂等——重复调用不会创建多个定时器。
 */
export function startFeedPoller(): void {
  if (pollTimer) return;

  feedsConfig = loadFeedsConfig();

  log.info("feeds: starting poller", { feeds: feedsConfig.feeds.length });

  // 首次立即拉取（不 await，不阻塞启动）
  void pollFeeds();

  // 每 60 秒检查一次（实际拉取频率由各 feed 的 intervalMin 控制）
  pollTimer = setInterval(() => void pollFeeds(), 60_000);
}

/** 停止后台轮询（测试用）。 */
export function stopFeedPoller(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

/** 清空缓存（测试用）。 */
export function _resetFeedCache(): void {
  feedCache.clear();
  lastFetchMs.clear();
  feedsConfig = null;
}

// ── 行为真实性参数 ───────────────────────────────────────────────────────────

/** 压力阈值：高于此值时 Alice 在"忙正事"，不刷手机。 */
const PRESSURE_GATE = 0.5;

/** 注入冷却期（ms）：距上次注入不足此时间则跳过。 */
const INJECT_COOLDOWN_MS = 10 * 60_000; // 10 min

/** 概率性跳过：即使满足条件也有此概率不注入（模拟"这次没看手机"）。 */
const SKIP_PROBABILITY = 0.3;

/** 每次最多展示条目数。 */
const MAX_ITEMS_PER_INJECT = 3;

// ── Mod 状态 ─────────────────────────────────────────────────────────────────

interface FeedsState {
  /** 标记：后台轮询是否已启动。 */
  pollerStarted: boolean;
  /** 上次成功注入 feed 的时间（ms）。 */
  lastInjectMs: number;
}

// ── 采样辅助 ─────────────────────────────────────────────────────────────────

/**
 * 从候选列表中多样性采样：优先覆盖不同来源，每个来源最多 1 条，
 * 同来源内随机选。类似人刷手机看到的混合信息流。
 */
function diverseSample(items: CachedFeedItem[], n: number): CachedFeedItem[] {
  // 按来源分组
  const byLabel = new Map<string, CachedFeedItem[]>();
  for (const item of items) {
    const group = byLabel.get(item.feedLabel) ?? [];
    group.push(item);
    byLabel.set(item.feedLabel, group);
  }

  const result: CachedFeedItem[] = [];
  const labels = [...byLabel.keys()];

  // 第一轮：每个来源随机选 1 条（覆盖多样性）
  for (const label of labels) {
    if (result.length >= n) break;
    // biome-ignore lint/style/noNonNullAssertion: label 来自 byLabel.keys()
    const group = byLabel.get(label)!;
    const idx = Math.floor(Math.random() * group.length);
    result.push(group.splice(idx, 1)[0]);
  }

  // 第二轮：如果还不够，从剩余中随机补
  if (result.length < n) {
    const remaining = [...byLabel.values()].flat();
    while (result.length < n && remaining.length > 0) {
      const idx = Math.floor(Math.random() * remaining.length);
      result.push(remaining.splice(idx, 1)[0]);
    }
  }

  return result;
}

// ── Mod 定义 ─────────────────────────────────────────────────────────────────

export const feedsMod = createMod<FeedsState>("feeds", {
  category: "mechanic",
  description: "ADR-167: канал восприятия фидов — интернет-зрение Алисы",
  initialState: { pollerStarted: false, lastInjectMs: 0 },
})
  .onTickStart((ctx) => {
    // 首次 tick 时启动后台轮询（确保只启动一次）
    if (!ctx.state.pollerStarted) {
      startFeedPoller();
      ctx.state.pollerStarted = true;
    }
  })
  .contribute((ctx): ContributionItem[] => {
    if (!feedsConfig || feedCache.size === 0) return [];

    // ── 行为门控：模拟真实"刷手机"条件 ──

    // 1. 压力门控：忙着处理消息时不刷手机
    const pressure = readPressureApi(ctx);
    if (pressure > PRESSURE_GATE) return [];

    // 2. 冷却期：刚看过手机不会马上又看
    const now = ctx.nowMs;
    if (ctx.state.lastInjectMs > 0 && now - ctx.state.lastInjectMs < INJECT_COOLDOWN_MS) {
      return [];
    }

    // 3. 概率性跳过：人不是每时每刻都在看手机
    if (Math.random() < SKIP_PROBABILITY) return [];

    // ── 筛选 + 采样 ──

    const shelfLifeMs = feedsConfig.shelfLifeHours * 3600_000;
    const maxExp = feedsConfig.maxExposures;

    const eligible: CachedFeedItem[] = [];
    for (const item of feedCache.values()) {
      if (now - item.fetchedMs > shelfLifeMs) continue;
      if (item.exposures >= maxExp) continue;
      eligible.push(item);
    }

    if (eligible.length === 0) return [];

    // 多样性采样：随机选 2-3 条，尽量覆盖不同来源
    const toShow = diverseSample(eligible, MAX_ITEMS_PER_INJECT);

    // 递增曝光计数 + 记录注入时间
    for (const item of toShow) {
      item.exposures += 1;
    }
    ctx.state.lastInjectMs = now;

    // 渲染为 prompt section
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
        40, // order: 中后（不挤占核心上下文）
        30, // priority: 低（可被 token 预算裁剪）
      ),
    ];
  })
  .build();
