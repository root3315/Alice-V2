/**
 * 审计事件写入（ADR-54）。
 *
 * 关键运行时异常写入 audit_events 表，支持 SQL 结构化查询。
 * 写入失败静默忽略——审计不应影响主流程。
 *
 * @see docs/adr/54-pre-mortem-safety-net.md
 */
import { getDb } from "./connection.js";
import { auditEvents } from "./schema.js";

export type AuditLevel = "fatal" | "error" | "warn";

/**
 * 写入一条审计事件。
 *
 * @param tick    当前 tick（如不在 tick 上下文中可传 -1）
 * @param level   严重程度
 * @param source  来源模块（与 createLogger tag 一致）
 * @param message 事件描述
 * @param details 附加细节（序列化为 JSON）
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
