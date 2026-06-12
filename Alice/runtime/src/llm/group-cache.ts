/**
 * 群组元信息持久缓存 — 独立 SQLite KV（与主 alice.db 隔离）。
 *
 * 缓存内容：
 * - 群组管理员列表（user ID → status + custom title）
 * - 群组元信息（成员数、媒体限制、Alice 是否为 admin）
 *
 * 使用 raw better-sqlite3（无 Drizzle）——schema 简单，与 media-cache 同模式。
 * 管理员/权限变动极低频（天/周级），持久化避免重启后的冷启动 API burst。
 */
import type Database from "better-sqlite3";
import type { Statement } from "better-sqlite3";
import BetterSqlite3 from "better-sqlite3";
import { createLogger } from "../utils/logger.js";

const log = createLogger("group-cache");

let _db: InstanceType<typeof Database> | null = null;

// prepared statements
let _adminGet: Statement | null = null;
let _adminDel: Statement | null = null;
let _adminSet: Statement | null = null;
let _infoGet: Statement | null = null;
let _infoSet: Statement | null = null;

// ═══════════════════════════════════════════════════════════════════════════
// 类型定义
// ═══════════════════════════════════════════════════════════════════════════

export interface AdminInfo {
  status: "creator" | "admin";
  title: string | null;
}

export interface ChatInfo {
  membersCount: number | null;
  /** 被禁止的媒体类型列表。空 = 无限制。 */
  restrictions: string[];
  /** Alice 是否为该群 admin。 */
  isAliceAdmin: boolean;
}

// ═══════════════════════════════════════════════════════════════════════════
// 生命周期
// ═══════════════════════════════════════════════════════════════════════════

export function initGroupCache(dbPath = "group-cache.db"): void {
  if (_db) {
    throw new Error("Group cache already initialized. Call closeGroupCache() first.");
  }
  _db = new BetterSqlite3(dbPath);
  _db.exec("PRAGMA journal_mode = WAL");
  _db.exec(`
    CREATE TABLE IF NOT EXISTS chat_admins (
      chat_id    INTEGER NOT NULL,
      user_id    INTEGER NOT NULL,
      status     TEXT NOT NULL,
      title      TEXT,
      updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
      PRIMARY KEY (chat_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS chat_info (
      chat_id        INTEGER PRIMARY KEY,
      members_count  INTEGER,
      restrictions   TEXT NOT NULL DEFAULT '[]',
      is_alice_admin INTEGER NOT NULL DEFAULT 0,
      updated_at     INTEGER NOT NULL DEFAULT (unixepoch())
    );
  `);

  _adminGet = _db.prepare("SELECT user_id, status, title FROM chat_admins WHERE chat_id = ?");
  _adminDel = _db.prepare("DELETE FROM chat_admins WHERE chat_id = ?");
  _adminSet = _db.prepare(
    "INSERT OR REPLACE INTO chat_admins (chat_id, user_id, status, title) VALUES (?, ?, ?, ?)",
  );
  _infoGet = _db.prepare(
    "SELECT members_count, restrictions, is_alice_admin FROM chat_info WHERE chat_id = ?",
  );
  _infoSet = _db.prepare(
    "INSERT OR REPLACE INTO chat_info (chat_id, members_count, restrictions, is_alice_admin) VALUES (?, ?, ?, ?)",
  );

  // TTL 清理：90 天无更新的群组记录（Alice 可能已离开）
  const TTL_SECONDS = 90 * 24 * 3600;
  _db.prepare("DELETE FROM chat_admins WHERE updated_at < unixepoch() - ?").run(TTL_SECONDS);
  _db.prepare("DELETE FROM chat_info WHERE updated_at < unixepoch() - ?").run(TTL_SECONDS);

  log.info("Group cache initialized", { dbPath });
}

export function closeGroupCache(): void {
  _adminGet = null;
  _adminDel = null;
  _adminSet = null;
  _infoGet = null;
  _infoSet = null;
  if (_db) {
    _db.close();
    _db = null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 管理员缓存
// ═══════════════════════════════════════════════════════════════════════════

/** 获取缓存的管理员列表。 */
export function getCachedAdmins(chatId: number): Map<number, AdminInfo> | undefined {
  if (!_adminGet) return undefined;
  const rows = _adminGet.all(chatId) as Array<{
    user_id: number;
    status: string;
    title: string | null;
  }>;
  if (rows.length === 0) return undefined;
  const map = new Map<number, AdminInfo>();
  for (const r of rows) {
    map.set(r.user_id, { status: r.status as "creator" | "admin", title: r.title });
  }
  return map;
}

/** 写入管理员列表（全量替换）。 */
export function setCachedAdmins(chatId: number, admins: Map<number, AdminInfo>): void {
  if (!_db || !_adminDel || !_adminSet) return;
  const del = _adminDel;
  const set = _adminSet;
  const tx = _db.transaction(() => {
    del.run(chatId);
    for (const [userId, info] of admins) {
      set.run(chatId, userId, info.status, info.title);
    }
  });
  tx();
}

// ═══════════════════════════════════════════════════════════════════════════
// 群组元信息缓存
// ═══════════════════════════════════════════════════════════════════════════

/** 获取缓存的群组元信息。 */
export function getCachedChatInfo(chatId: number): ChatInfo | undefined {
  if (!_infoGet) return undefined;
  const row = _infoGet.get(chatId) as
    | { members_count: number | null; restrictions: string; is_alice_admin: number }
    | undefined;
  if (!row) return undefined;
  return {
    membersCount: row.members_count,
    restrictions: JSON.parse(row.restrictions) as string[],
    isAliceAdmin: row.is_alice_admin === 1,
  };
}

/** 写入群组元信息。 */
export function setCachedChatInfo(chatId: number, info: ChatInfo): void {
  _infoSet?.run(
    chatId,
    info.membersCount,
    JSON.stringify(info.restrictions),
    info.isAliceAdmin ? 1 : 0,
  );
}
