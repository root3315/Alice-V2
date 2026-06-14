/**
 * ADR-110: реальное время → человекочитаемая длительность.
 *
 * Замечание 8 статьи: Signal S не должен содержать вычислительные величины (raw tick counts / raw seconds).
 * Принимает секунды, возвращает человекочитаемую длительность.
 *
 * @see docs/adr/62-d5-social-cost-paper-alignment.md
 */

/** Преобразует секунды в человекочитаемую длительность. */
export function humanDuration(seconds: number): string {
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `about ${Math.round(seconds / 60)} minutes`;
  if (seconds < 86400) return `about ${Math.round(seconds / 3600)} hours`;
  return `about ${Math.round(seconds / 86400)} days`;
}

/**
 * Комбинация humanDuration + "ago".
 * К "just now" не добавляется "ago" (чтобы избежать "just now ago").
 * К остальным длительностям "ago" добавляется автоматически.
 */
export function humanDurationAgo(seconds: number): string {
  const d = humanDuration(seconds);
  return d === "just now" ? "just now" : `${d} ago`;
}
