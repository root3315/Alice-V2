/**
 * Персистентный кеш метаданных групп — отдельная SQLite KV (изолирована от основной alice.db).
 *
 * Содержимое кеша:
 * - список администраторов группы (user ID → status + custom title)
 * - метаданные группы (кол-во участников, медиаограничения, является ли Alice admin)
 *
 * Использует raw better-sqlite3 (без Drizzle) — схема простая, аналог media-cache.
 * Изменения прав/администраторов крайне редки (дни/недели), персистентность устраняет
 * API burst при холодном старте после перезапуска.
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
// Определения типов
// ═══════════════════════════════════════════════════════════════════════════

export interface AdminInfo {
  status: "creator" | "admin";
  title: string | null;
}

export interface ChatInfo {
  membersCount: number | null;
  /** Список запрещённых типов медиа. Пусто = без ограничений. */
  restrictions: string[];
  /** Является ли Alice администратором этой группы. */
  isAliceAdmin: boolean;
}

// ═══════════════════════════════════════════════════════════════════════════
// Жизненный цикл
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

  // TTL-очистка: записи групп без обновлений за 90 дней (Alice, вероятно, покинула их)
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
// Кеш администраторов
// ═══════════════════════════════════════════════════════════════════════════

/** Получить закешированный список администраторов. */
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

/** Записать список администраторов (полная замена). */
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
// Кеш метаданных группы
// ═══════════════════════════════════════════════════════════════════════════

/** Получить закешированные метаданные группы. */
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

/** Записать метаданные группы. */
export function setCachedChatInfo(chatId: number, info: ChatInfo): void {
  _infoSet?.run(
    chatId,
    info.membersCount,
    JSON.stringify(info.restrictions),
    info.isAliceAdmin ? 1 : 0,
  );
}
