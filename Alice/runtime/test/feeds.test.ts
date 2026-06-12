/**
 * feeds 单元测试。
 *
 * 覆盖：
 * 1. Feed Sources：各数据源的 JSON 解析和错误处理
 * 2. Feeds Config：人设 feeds 完整性
 * 3. Feeds Mod：构建正确性
 */
import { afterEach, describe, expect, it, vi } from "vitest";

// ── Feed Sources ─────────────────────────────────────────────────────────────

describe("feed sources", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("fetchBiliHot", () => {
    it("解析 60s.viki.moe 格式", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(() =>
          Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                code: 200,
                data: [
                  { title: "热搜1", link: "https://b.com/1" },
                  { title: "热搜2", link: "https://b.com/2" },
                  { title: "", link: "https://b.com/3" },
                ],
              }),
          }),
        ),
      );

      const { fetchBiliHot } = await import("../src/feeds/sources.js");
      const items = await fetchBiliHot(5);

      expect(items).toHaveLength(2); // 空标题过滤
      expect(items[0].title).toBe("热搜1");
      expect(items[0].url).toBe("https://b.com/1");
    });

    it("API 失败返回空数组", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(() => Promise.reject(new Error("network"))),
      );

      const { fetchBiliHot } = await import("../src/feeds/sources.js");
      expect(await fetchBiliHot()).toEqual([]);
    });
  });

  describe("fetchHackerNewsTop", () => {
    it("解析 HN 格式", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(() =>
          Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                code: 200,
                data: [{ title: "Show HN: My Project", link: "https://hn.com/1", score: 100 }],
              }),
          }),
        ),
      );

      const { fetchHackerNewsTop } = await import("../src/feeds/sources.js");
      const items = await fetchHackerNewsTop(5);

      expect(items).toHaveLength(1);
      expect(items[0].snippet).toBe("100 points");
    });
  });

  describe("fetchEpicFreeGames", () => {
    it("只返回当前免费的游戏", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(() =>
          Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                code: 200,
                data: [
                  {
                    title: "Free Game",
                    link: "https://epic.com/1",
                    is_free_now: true,
                    free_end: "2026/03/01",
                  },
                  { title: "Paid Game", link: "https://epic.com/2", is_free_now: false },
                ],
              }),
          }),
        ),
      );

      const { fetchEpicFreeGames } = await import("../src/feeds/sources.js");
      const items = await fetchEpicFreeGames();

      expect(items).toHaveLength(1);
      expect(items[0].title).toBe("Free Game");
      expect(items[0].snippet).toContain("2026/03/01");
    });
  });

  describe("fetchBangumiToday", () => {
    it("解析 Bangumi calendar API", async () => {
      const todayId = new Date().getDay() || 7;
      vi.stubGlobal(
        "fetch",
        vi.fn(() =>
          Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve([
                {
                  weekday: { id: todayId, cn: "今天" },
                  items: [
                    {
                      name_cn: "番剧A",
                      name: "Anime A",
                      url: "https://bgm.tv/1",
                      air_date: "2026-01-01",
                    },
                    { name_cn: "", name: "Anime B", url: "https://bgm.tv/2" },
                  ],
                },
              ]),
          }),
        ),
      );

      const { fetchBangumiToday } = await import("../src/feeds/sources.js");
      const items = await fetchBangumiToday(5);

      expect(items).toHaveLength(2);
      expect(items[0].title).toBe("番剧A");
      expect(items[1].title).toBe("Anime B"); // fallback to name
    });
  });

  describe("fetchTodayInHistory", () => {
    it("解析历史上的今天", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(() =>
          Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                code: 200,
                data: {
                  items: [
                    {
                      title: "某事件",
                      year: "1900",
                      description: "详细描述",
                      link: "https://baike.com/1",
                    },
                  ],
                },
              }),
          }),
        ),
      );

      const { fetchTodayInHistory } = await import("../src/feeds/sources.js");
      const items = await fetchTodayInHistory(3);

      expect(items).toHaveLength(1);
      expect(items[0].title).toBe("1900年 某事件");
    });
  });
});

// ── Feeds Config ─────────────────────────────────────────────────────────────

describe("loadFeedsConfig", () => {
  it("人设 feeds 非空且有合理默认值", async () => {
    const { loadFeedsConfig } = await import("../src/feeds/config.js");
    const config = loadFeedsConfig();

    expect(config.feeds.length).toBeGreaterThan(0);
    expect(config.maxExposures).toBeGreaterThan(0);
    expect(config.shelfLifeHours).toBeGreaterThan(0);

    for (const feed of config.feeds) {
      expect(feed.label).toBeTruthy();
      expect(feed.intervalMin).toBeGreaterThan(0);
      expect(typeof feed.fetcher).toBe("function");
    }
  });
});

// ── Feeds Mod ────────────────────────────────────────────────────────────────

describe("feedsMod", () => {
  it("builds without error", async () => {
    const { feedsMod } = await import("../src/mods/feeds.mod.js");
    expect(feedsMod.meta.name).toBe("feeds");
    expect(feedsMod.meta.category).toBe("mechanic");
    expect(feedsMod.onTickStart).toBeDefined();
    expect(feedsMod.contribute).toBeDefined();
  });
});
