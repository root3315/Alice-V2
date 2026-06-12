#!/usr/bin/env npx tsx
/**
 * video CLI — 视频搜索与分享。
 *
 * 用法: npx tsx video.ts <query> [platform]
 * 环境变量: YOUTUBE_API_KEY — YouTube Data API v3 key（可选）
 * 输出: JSON to stdout
 *
 * 支持平台：bilibili（默认，始终可用）、youtube（需 API key）
 *
 * @see docs/adr/132-app-toolkit.md
 */

const MAX_RESULTS = 5;

// ── 辅助函数 ──

function stripHtml(s: string): string {
  return s.replace(/<[^>]+>/g, "");
}

function humanizeCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)} млн`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)} тыс.`;
  return String(n);
}

// ── Bilibili ──

interface BilibiliSearchItem {
  title: string;
  author: string;
  bvid: string;
  play: number;
  duration: string;
}

interface BilibiliSearchResponse {
  code: number;
  data?: { result?: BilibiliSearchItem[] };
}

async function searchBilibili(query: string, signal: AbortSignal) {
  const url = `https://api.bilibili.com/x/web-interface/search/type?search_type=video&keyword=${encodeURIComponent(query)}&page=1&page_size=${MAX_RESULTS}`;
  const res = await fetch(url, {
    signal,
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      Referer: "https://www.bilibili.com",
    },
  });
  if (!res.ok) return null;
  const json = (await res.json()) as BilibiliSearchResponse;
  if (json.code !== 0) return null;
  const results = json.data?.result;
  if (!Array.isArray(results) || results.length === 0) return null;

  return results.slice(0, MAX_RESULTS).map((v) => ({
    title: stripHtml(v.title),
    author: v.author,
    url: `https://www.bilibili.com/video/${v.bvid}`,
    duration: v.duration,
    views: humanizeCount(v.play),
    platform: "bilibili" as const,
  }));
}

// ── YouTube ──

interface YouTubeSearchResponse {
  items?: { id: { videoId: string }; snippet: { title: string; channelTitle: string } }[];
}

async function searchYouTube(query: string, apiKey: string, signal: AbortSignal) {
  const params = new URLSearchParams({
    part: "snippet",
    q: query,
    type: "video",
    maxResults: String(MAX_RESULTS),
    key: apiKey,
  });
  const res = await fetch(`https://www.googleapis.com/youtube/v3/search?${params}`, { signal });
  if (!res.ok) return null;
  const json = (await res.json()) as YouTubeSearchResponse;
  const items = json.items;
  if (!Array.isArray(items) || items.length === 0) return null;

  return items.map((item) => ({
    title: item.snippet.title,
    author: item.snippet.channelTitle,
    url: `https://youtu.be/${item.id.videoId}`,
    duration: "",
    views: "",
    platform: "youtube" as const,
  }));
}

// ── main ──

const query = process.argv[2];
if (!query) {
  console.error("Usage: video.ts <query> [platform]");
  process.exit(1);
}

const platform = (process.argv[3] ?? "bilibili").toLowerCase().trim();
const youtubeApiKey = process.env.YOUTUBE_API_KEY ?? "";
const signal = AbortSignal.timeout(10_000);

let items:
  | {
      title: string;
      author: string;
      url: string;
      duration: string;
      views: string;
      platform: string;
    }[]
  | null = null;
let platformLabel = "Bilibili";

if (platform === "youtube" && youtubeApiKey) {
  items = await searchYouTube(query, youtubeApiKey, signal);
  platformLabel = "YouTube";
} else {
  items = await searchBilibili(query, signal);
  platformLabel = "Bilibili";
}

// 程序自己 print 格式化输出
console.log(`📺 Video — ${platformLabel} "${query}"`);
if (!items || items.length === 0) {
  console.log("No results found.");
} else {
  for (const [i, v] of items.entries()) {
    const meta = [v.duration, v.views].filter(Boolean).join(" · ");
    console.log(`${i + 1}. ${v.title} — ${v.author}${meta ? ` (${meta})` : ""} ${v.url}`);
  }
}
