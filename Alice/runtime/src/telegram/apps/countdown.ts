/**
 * use_countdown_app — 日期倒计时。
 *
 * 纯函数，不依赖框架类型。
 *
 * @see docs/adr/132-app-toolkit.md
 */

import type { CountdownResultSchema as CountdownResult } from "../action-schemas.js";

export type { CountdownResultSchema as CountdownResult } from "../action-schemas.js";

import { localNow, parseYMD, weekdayZH } from "./shared.js";

/**
 * 计算目标日期距今天的天数。
 * @returns null 表示日期格式无效
 */
export function getCountdownData(dateStr: string, timezoneOffset: number): CountdownResult | null {
  const parsed = parseYMD(dateStr);
  if (!parsed) return null;

  const targetDate = new Date(Date.UTC(parsed.year, parsed.month - 1, parsed.day));
  const local = localNow(timezoneOffset);
  const todayDate = new Date(
    Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()),
  );

  const diffMs = targetDate.getTime() - todayDate.getTime();
  const days = Math.round(diffMs / (1000 * 60 * 60 * 24));
  const weekday = weekdayZH(targetDate.getUTCDay());

  return { target: dateStr, days, weekday };
}
