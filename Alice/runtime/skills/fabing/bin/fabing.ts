#!/usr/bin/env npx tsx
/**
 * fabing CLI — 发病文学。
 *
 * 用法: npx tsx fabing.ts <name>
 * 输出: 格式化文本 to stdout
 *
 * 后端：60s.viki.moe（开源聚合 API，无需 API key）。
 *
 * @see https://github.com/vikiboss/60s
 */

const name = process.argv[2];
if (!name) {
  console.error("Usage: fabing.ts <name>");
  process.exit(1);
}

const signal = AbortSignal.timeout(10_000);
const resp = await fetch(`https://60s.viki.moe/v2/fabing?name=${encodeURIComponent(name)}`, {
  signal,
});
if (!resp.ok) {
  console.error(`API failed: ${resp.status}`);
  process.exit(1);
}

const json = (await resp.json()) as { code: number; data?: { saying?: string } };
if (json.code !== 200 || !json.data?.saying) {
  console.error("Invalid API response");
  process.exit(1);
}

console.log(`💘 Безумное признание — ${json.data.saying}`);
