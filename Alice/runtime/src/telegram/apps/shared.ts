/**
 * App Toolkit 共享工具。
 *
 * 纯函数，零框架依赖。App 业务逻辑在这里共享时区计算、日期解析等基础能力。
 *
 * @see docs/adr/132-app-toolkit.md
 */

/** 根据时区偏移获取当地时间（Date 对象，UTC 字段模拟本地时间）。 */
export function localNow(timezoneOffset: number): Date {
  const offsetMs = timezoneOffset * 60 * 60 * 1000;
  return new Date(Date.now() + offsetMs);
}

/** 解析 YYYY-MM-DD 格式日期字符串。无效格式返回 null。 */
export function parseYMD(dateStr: string): { year: number; month: number; day: number } | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return null;
  const [year, month, day] = dateStr.split("-").map(Number);
  return { year, month, day };
}

/** 格式化为 YYYY-MM-DD。 */
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

/** UTC Day index → 星期N 中文。 */
export function weekdayZH(utcDayIndex: number): string {
  return `${WEEKDAY_ZH[utcDayIndex]}`;
}

/** 小时 → 时段中文标签。 */
export function timePeriod(hour: number): string {
  if (hour < 6) return "ночь";
  if (hour < 12) return "утро";
  if (hour < 18) return "день";
  return "вечер";
}

/** 格式化时区为 UTC+N / UTC-N。 */
export function formatTimezone(offset: number): string {
  return `UTC${offset >= 0 ? "+" : ""}${offset}`;
}
