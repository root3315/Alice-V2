#!/usr/bin/env npx tsx
/**
 * luck CLI — 今日运势。
 *
 * 用法: npx tsx luck.ts
 * 输出: 格式化文本 to stdout
 *
 * 后端：60s.viki.moe（开源聚合 API，无需 API key）。
 *
 * @see https://github.com/vikiboss/60s
 */

const signal = AbortSignal.timeout(10_000);
const resp = await fetch("https://60s.viki.moe/v2/luck", { signal });
if (!resp.ok) {
  console.error(`API failed: ${resp.status}`);
  process.exit(1);
}

const json = (await resp.json()) as {
  code: number;
  data?: { luck_desc?: string; luck_rank?: number; luck_tip?: string };
};
if (json.code !== 200 || !json.data) {
  console.error("Invalid API response");
  process.exit(1);
}

const { luck_desc, luck_rank, luck_tip } = json.data;
if (!luck_desc || luck_rank == null || !luck_tip) {
  console.error("Incomplete luck data");
  process.exit(1);
}

console.log(`🎯 Удача на сегодня — ${luck_desc} (${luck_rank}/30)`);
console.log(luck_tip);
