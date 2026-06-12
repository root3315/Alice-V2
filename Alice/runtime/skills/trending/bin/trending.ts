#!/usr/bin/env npx tsx
/**
 * trending CLI — 热搜/热榜查询。
 *
 * 用法: npx tsx trending.ts [platform]
 * 输出: JSON to stdout
 *
 * 后端：60s.viki.moe（开源热搜聚合 API，无需 API key）。
 * 支持平台：weibo/zhihu/douyin/bilibili/baidu/toutiao/rednote
 *
 * @see https://github.com/vikiboss/60s
 */

const BASE_URL = "https://60s.viki.moe";

interface PlatformDef {
  route: string;
  label: string;
  extract: (item: Record<string, unknown>) => { title: string; url: string; snippet: string };
}

const commonExtract: PlatformDef["extract"] = (item) => ({
  title: String(item.title ?? ""),
  url: String(item.link ?? item.url ?? ""),
  snippet: item.hot_value ? `хайп ${item.hot_value}` : "",
});

const PLATFORMS: Record<string, PlatformDef> = {
  weibo: { route: "/v2/weibo", label: "Тренды Weibo", extract: commonExtract },
  zhihu: {
    route: "/v2/zhihu",
    label: "Топ Zhihu",
    extract: (item) => ({
      title: String(item.title ?? ""),
      url: String(item.link ?? ""),
      snippet: String(item.hot_value_desc ?? item.detail ?? "").slice(0, 100),
    }),
  },
  douyin: { route: "/v2/douyin", label: "Тренды Douyin", extract: commonExtract },
  bilibili: {
    route: "/v2/bili",
    label: "Тренды Bilibili",
    extract: (item) => ({
      title: String(item.title ?? ""),
      url: String(item.link ?? ""),
      snippet: "",
    }),
  },
  baidu: {
    route: "/v2/baidu/hot",
    label: "Тренды Baidu",
    extract: (item) => ({
      title: String(item.title ?? ""),
      url: String(item.url ?? ""),
      snippet: String(item.desc ?? "").slice(0, 100),
    }),
  },
  toutiao: { route: "/v2/toutiao", label: "Тренды Toutiao", extract: commonExtract },
  rednote: {
    route: "/v2/rednote",
    label: "Тренды RedNote",
    extract: (item) => ({
      title: String(item.title ?? ""),
      url: String(item.link ?? ""),
      snippet: item.score ? `хайп ${item.score}` : "",
    }),
  },
};

// ── main ──

const platform = (process.argv[2] ?? "weibo").toLowerCase().trim();
const def = PLATFORMS[platform] ?? PLATFORMS.weibo;

const signal = AbortSignal.timeout(10_000);
const resp = await fetch(`${BASE_URL}${def.route}`, { signal });
if (!resp.ok) {
  console.error(`API failed: ${resp.status}`);
  process.exit(1);
}

const json = (await resp.json()) as { code: number; data: unknown };
if (json.code !== 200 || !Array.isArray(json.data)) {
  console.error("Invalid API response");
  process.exit(1);
}

const items = (json.data as Record<string, unknown>[])
  .slice(0, 10)
  .map(def.extract)
  .filter((it) => it.title);

// 程序自己 print 格式化输出
console.log(`🔥 ${def.label}`);
for (const [i, item] of items.entries()) {
  const meta = item.snippet ? ` (${item.snippet})` : "";
  console.log(`${i + 1}. ${item.title}${meta}`);
}
