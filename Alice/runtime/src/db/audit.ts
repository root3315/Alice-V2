/**
 * Запись аудит-событий (ADR-54).
 *
 * Критические аномалии времени выполнения записываются в таблицу audit_events
 * и доступны для структурированных SQL-запросов.
 * Сбои записи молча игнорируются — аудит не должен влиять на основной процесс.
 *
 * @see docs/adr/54-pre-mortem-safety-net.md
 */
import { getDb } from "./connection.js";
import { auditEvents } from "./schema.js";

export type AuditLevel = "fatal" | "error" | "warn";

/**
 * Записывает одно аудит-событие.
 *
 * @param tick    Текущий tick (передать -1, если не в tick-контексте)
 * @param level   Уровень серьёзности
 * @param source  Исходный модуль (соответствует тегу createLogger)
 * @param message Описание события
 * @param details Дополнительные детали (сериализуются в JSON)
 */
export function writeAuditEvent(
  tick: number,
  level: AuditLevel,
  source: string,
  message: string,
  details?: Record<string, unknown>,
): void {
  try {
    getDb()
      .insert(auditEvents)
      .values({
        tick,
        level,
        source,
        message,
        details: details ? JSON.stringify(details) : null,
      })
      .run();
  } catch (e) {
    console.error("audit write failed:", e);
  }
}
