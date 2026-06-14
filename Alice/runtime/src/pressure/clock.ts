/**
 * Вспомогательные функции для работы с настенными часами.
 *
 * ADR-166: Wall-Clock First — миллисекунды настенных часов являются единственным источником истины для всех временных вычислений.
 * Порядковый номер тика измеряет только последовательность, но не продолжительность.
 *
 * Два типа потребителей используют разные точки входа:
 * - **Вычисление давления**: `readNodeMs()` → возвращает 0 при неизвестном значении → вызывающий пропускает (Unknown ≠ Old)
 * - **Рендеринг/отображение**: `estimateAgeS()` / `estimateEventMs()` → приближение tick × 60s как запасной вариант
 *
 * @see docs/adr/166-wallclock-purification.md
 */
import type { WorldModel } from "../graph/world-model.js";

// -- Константы -------------------------------------------------------------------

/**
 * ADR-166: оценочное значение устаревшего тикового интервала (ms).
 * Используется только для рендеринга исторических данных без атрибута _ms. Не участвует в расчёте давления.
 * @see docs/adr/166-wallclock-purification.md §4.4
 */
export const LEGACY_TICK_INTERVAL_MS = 60_000;

// -- Точное чтение (для вычисления давления) --------------------------------------------------

/**
 * Читает метку времени настенных часов в миллисекундах из узла графа.
 * Напрямую читает атрибут _ms, при отсутствии возвращает 0 (= неизвестно).
 *
 * Эту функцию должны использовать вычисления давления. При возврате 0 вызывающий должен пропустить данный вклад —
 * время неизвестно → давление не утверждается (Unknown ≠ Old).
 *
 * @see docs/adr/166-wallclock-purification.md §4.2
 */
export function readNodeMs(G: WorldModel, nodeId: string, msKey: string): number {
  if (G.has(nodeId)) {
    const ms = G.getDynamic(nodeId, msKey);
    if (typeof ms === "number" && ms > 0) return ms;
  }
  return 0;
}

// -- Приближённая оценка (для рендеринга/отображения) --------------------------------------------------

/**
 * Оценивает время настенных часов события в мс.
 *
 * Приоритет: ms > createdAt > tick × 60s (запасной вариант). Возвращает 0 при неизвестном значении.
 *
 * Используется для рендеринга Mod contribute — временные метки для LLM допускают приближение.
 * Не должна использоваться в вычислениях давления.
 *
 * @see docs/adr/166-wallclock-purification.md §4.4
 */
export function estimateEventMs(
  entry: { ms?: number | null; createdAt?: Date | null; tick?: number | null },
  nowMs: number,
  currentTick: number,
): number {
  if (typeof entry.ms === "number" && entry.ms > 0) return entry.ms;
  if (entry.createdAt instanceof Date) return entry.createdAt.getTime();
  if (typeof entry.tick === "number")
    return nowMs - (currentTick - entry.tick) * LEGACY_TICK_INTERVAL_MS;
  return 0;
}

/**
 * Оценивает возраст события в секундах. Возвращает 0 при неизвестном значении.
 *
 * Единая замена 14 случаев встроенного паттерна `(разница тиков) × 60` в 6 файлах Mod.
 * Не должна использоваться в вычислениях давления.
 *
 * @see docs/adr/166-wallclock-purification.md §5 Wave 3
 */
export function estimateAgeS(
  entry: { ms?: number | null; createdAt?: Date | null; tick?: number | null },
  nowMs: number,
  currentTick: number,
): number {
  const eventMs = estimateEventMs(entry, nowMs, currentTick);
  return eventMs > 0 ? Math.max(0, (nowMs - eventMs) / 1000) : 0;
}

// -- Общие вспомогательные функции ----------------------------------------------------------------

/**
 * Вычисляет количество секунд, прошедших с момента события.
 */
export function elapsedS(nowMs: number, eventMs: number): number {
  return Math.max(0, (nowMs - eventMs) / 1000);
}
