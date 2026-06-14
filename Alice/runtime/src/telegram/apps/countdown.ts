/**
 * use_countdown_app — обратный отсчёт до даты.
 *
 * Чистые функции, без зависимости от типов фреймворка.
 *
 * @see docs/adr/132-app-toolkit.md
 */

import type { CountdownResultSchema as CountdownResult } from "../action-schemas.js";

export type { CountdownResultSchema as CountdownResult } from "../action-schemas.js";

import { localNow, parseYMD, weekdayZH } from "./shared.js";

/**
 * Вычисляет количество дней от сегодня до целевой даты.
 * @returns null если формат даты невалиден
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
