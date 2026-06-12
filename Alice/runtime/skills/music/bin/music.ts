#!/usr/bin/env npx tsx
/**
 * music CLI — 音乐搜索。
 *
 * 用法: npx tsx music.ts <query>
 * 环境变量: MUSIC_API_BASE — NeteaseCloudMusicApi 的 base URL
 * 输出: JSON to stdout
 *
 * 接入 NeteaseCloudMusicApi 兼容后端。
 * 流程：搜索 → 详情 → 播放链接，合并返回。
 *
 * @see docs/adr/132-app-toolkit.md
 */

const MAX_RESULTS = 5;

// ── NeteaseCloudMusicApi 响应类型 ──

interface NcmSearchSong {
  id: number;
  name: string;
  artists: { name: string }[];
  album: { name: string };
}

interface NcmSearchResponse {
  result?: { songs?: NcmSearchSong[] };
}

interface NcmSongUrlResponse {
  data?: { id: number; url: string | null }[];
}

// ── main ──

const query = process.argv[2];
if (!query) {
  console.error("Usage: music.ts <query>");
  process.exit(1);
}

const baseUrl = (process.env.MUSIC_API_BASE ?? "").replace(/\/+$/, "");
if (!baseUrl) {
  console.error("MUSIC_API_BASE env var required");
  process.exit(1);
}

const signal = AbortSignal.timeout(10_000);

// Step 1: 搜索
const searchUrl = `${baseUrl}/search?keywords=${encodeURIComponent(query)}&limit=${MAX_RESULTS}`;
const searchRes = await fetch(searchUrl, { signal });
if (!searchRes.ok) {
  console.error(`Search failed: ${searchRes.status}`);
  process.exit(1);
}
const searchData = (await searchRes.json()) as NcmSearchResponse;
const rawSongs = searchData.result?.songs;
if (!rawSongs || rawSongs.length === 0) {
  // 无结果也输出有效 JSON
  console.log(JSON.stringify({ query, songs: [] }));
  process.exit(0);
}

const ids = rawSongs.map((s) => s.id);

// Step 2: 获取播放链接
const urlsMap = new Map<number, string>();
try {
  const urlRes = await fetch(`${baseUrl}/song/url/v1?id=${ids.join(",")}&level=standard`, {
    signal,
  });
  if (urlRes.ok) {
    const urlData = (await urlRes.json()) as NcmSongUrlResponse;
    for (const item of urlData.data ?? []) {
      if (item.url) urlsMap.set(item.id, item.url);
    }
  }
} catch {
  // 播放链接获取失败不影响整体结果
}

// 程序自己 print 格式化输出
console.log(`🎵 Music — "${query}"`);
for (const [i, s] of rawSongs.entries()) {
  const artist = s.artists.map((a) => a.name).join(" / ");
  const url = urlsMap.get(s.id) ?? "";
  console.log(`${i + 1}. ${s.name} — ${artist} (${s.album.name})${url ? ` ${url}` : ""}`);
}
if (rawSongs.length === 0) {
  console.log("No results found.");
}
