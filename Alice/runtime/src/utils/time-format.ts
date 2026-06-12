/**
 * ADR-110: 墙钟时间 → 人类可读时长。
 *
 * 论文 Remark 8: Signal S 不得包含计算域量（raw tick counts / raw seconds）。
 * 接受秒数，返回人类可读时长。
 *
 * @see docs/adr/62-d5-social-cost-paper-alignment.md
 */

/** 将秒数转换为人类可读时长。 */
export function humanDuration(seconds: number): string {
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `about ${Math.round(seconds / 60)} minutes`;
  if (seconds < 86400) return `about ${Math.round(seconds / 3600)} hours`;
  return `about ${Math.round(seconds / 86400)} days`;
}

/**
 * humanDuration + "ago" 的组合。
 * "just now" 不追加 "ago"（避免 "just now ago"）。
 * 其他时长自动追加 "ago"。
 */
export function humanDurationAgo(seconds: number): string {
  const d = humanDuration(seconds);
  return d === "just now" ? "just now" : `${d} ago`;
}
