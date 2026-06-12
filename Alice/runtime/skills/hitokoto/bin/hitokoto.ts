#!/usr/bin/env npx tsx
/**
 * hitokoto CLI — 随机一言。
 *
 * 用法: npx tsx hitokoto.ts
 * 输出: 格式化文本 to stdout
 *
 * 后端：60s.viki.moe（开源聚合 API，无需 API key）。
 *
 * @see https://github.com/vikiboss/60s
 */

const signal = AbortSignal.timeout(10_000);
const resp = await fetch("https://60s.viki.moe/v2/hitokoto", { signal });
if (!resp.ok) {
  console.error(`API failed: ${resp.status}`);
  process.exit(1);
}

const json = (await resp.json()) as { code: number; data?: { hitokoto?: string } };
if (json.code !== 200 || !json.data?.hitokoto) {
  console.error("Invalid API response");
  process.exit(1);
}

console.log(`✨ Цитата — "${json.data.hitokoto}"`);
