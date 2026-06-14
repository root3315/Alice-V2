/**
 * App Toolkit — общие утилиты.
 *
 * Чистые функции, без зависимостей от фреймворков. Здесь бизнес-логика приложений использует общие возможности: расчёт часовых поясов, разбор дат и т.д.
 *
 * @see docs/adr/132-app-toolkit.md
 */

/** Возвращает текущее местное время по смещению часового пояса (объект Date, UTC-поля имитируют локальное время). */
export function localNow(timezoneOffset: number): Date {
  const offsetMs = timezoneOffset * 60 * 60 * 1000;
  return new Date(Date.now() + offsetMs);
}

/** Разбирает строку даты в формате YYYY-MM-DD. При некорректном формате возвращает null. */
export function parseYMD(dateStr: string): { year: number; month: number; day: number } | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return null;
  const [year, month, day] = dateStr.split("-").map(Number);
  return { year, month, day };
}

/** Форматирует дату в строку YYYY-MM-DD. */
export function formatYMD(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

const WEEKDAY_ZH = [
  "воскресенье",
  "понедельник",
  "вторник",
  "среда",
  "четверг",
  "пятница",
  "суббота",
];

/** UTC Day index → название дня недели. */
export function weekdayZH(utcDayIndex: number): string {
  return `${WEEKDAY_ZH[utcDayIndex]}`;
}

/** Час → метка временного периода. */
export function timePeriod(hour: number): string {
  if (hour < 6) return "ночь";
  if (hour < 12) return "утро";
  if (hour < 18) return "день";
  return "вечер";
}

/** Форматирует смещение часового пояса в строку UTC+N / UTC-N. */
export function formatTimezone(offset: number): string {
  return `UTC${offset >= 0 ? "+" : ""}${offset}`;
}
