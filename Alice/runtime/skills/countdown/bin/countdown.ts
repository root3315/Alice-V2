#!/usr/bin/env npx tsx
/**
 * countdown CLI — 日期倒计时。
 *
 * 用法: npx tsx bin/countdown.ts YYYY-MM-DD
 * 输出: JSON to stdout（CountdownResultSchema 形状）
 *
 * timezoneOffset 通过 Engine API 读取（同 calendar.ts）。
 * 无 ALICE_ENGINE_URL 时 fallback 到 UTC+0。
 *
 * @see docs/adr/202-engine-api.md
 * @see docs/adr/132-app-toolkit.md
 */

import { fetchTimezoneOffset, localNow, parseYMD } from "../../_lib/engine-client.js";

const WEEKDAY_ZH = ["воскресенье", "понедельник", "вторник", "среда", "четверг", "пятница", "суббота"];
function weekdayZH(utcDayIndex: number): string {
  return `${WEEKDAY_ZH[utcDayIndex]}`;
}

// ── main ──

const dateStr = process.argv[2] ?? "";
if (!dateStr) {
  console.error("Usage: countdown.ts YYYY-MM-DD");
  process.exit(1);
}

const parsed = parseYMD(dateStr);
if (!parsed) {
  console.error(`Invalid date format: ${dateStr} (expected YYYY-MM-DD)`);
  process.exit(1);
}

const timezoneOffset = await fetchTimezoneOffset();

const targetDate = new Date(Date.UTC(parsed.year, parsed.month - 1, parsed.day));
const local = localNow(timezoneOffset);
const todayDate = new Date(
  Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()),
);

const diffMs = targetDate.getTime() - todayDate.getTime();
const days = Math.round(diffMs / (1000 * 60 * 60 * 24));
const weekday = weekdayZH(targetDate.getUTCDay());

console.log(JSON.stringify({ target: dateStr, days, weekday }));
