#!/usr/bin/env npx tsx
/**
 * kfc CLI — 疯狂星期四文案。
 *
 * 用法: npx tsx kfc.ts
 * 输出: 格式化文本 to stdout
 *
 * 后端：60s.viki.moe（开源聚合 API，无需 API key）。
 *
 * @see https://github.com/vikiboss/60s
 */

const signal = AbortSignal.timeout(10_000);
const resp = await fetch("https://60s.viki.moe/v2/kfc", { signal });
if (!resp.ok) {
  console.error(`API failed: ${resp.status}`);
  process.exit(1);
}

const json = (await resp.json()) as { code: number; data?: { kfc?: string } };
if (json.code !== 200 || !json.data?.kfc) {
  console.error("Invalid API response");
  process.exit(1);
}

console.log(`🍗 Безумный четверг — ${json.data.kfc}`);
