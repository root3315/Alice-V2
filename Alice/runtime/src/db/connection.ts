/**
 * Инициализация SQLite + Drizzle (через better-sqlite3).
 *
 * ADR-53: переход на Drizzle migration, удаление рукописного raw SQL DDL.
 * @see docs/adr/53-audit-gap-closure.md
 */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { load as loadBetterTrigram } from "sqlite-better-trigram";
import { ftsEnsurePopulated } from "./fts.js";
import * as schema from "./schema.js";

let _db: ReturnType<typeof drizzle> | null = null;
let _sqlite: InstanceType<typeof Database> | null = null;
let _dbPath: string | null = null;

/** Абсолютный путь к директории drizzle/ (совместим со средами tsx и vitest). */
const MIGRATIONS_FOLDER = resolve(fileURLToPath(import.meta.url), "../../../drizzle");

/**
 * Возвращает экземпляр Drizzle. Требует предварительного вызова initDb().
 *
 * I10: параметр dbPath удалён, неявная ленивая инициализация устранена.
 * Вся инициализация проходит через initDb(path), getDb() выполняет только чтение.
 */
export function getDb() {
  if (!_db) {
    throw new Error("Database not initialized. Call initDb(path) first.");
  }
  return _db;
}

/**
 * Возвращает текущий путь к файлу базы данных.
 * M4 исправление: позволяет anomaly.ts и другим модулям получить реальный путь к БД без хардкода.
 */
export function getDbPath(): string {
  return _dbPath ?? "alice.db";
}

export function isDbInitialized(): boolean {
  return _db != null;
}

/**
 * Инициализирует базу данных: открывает соединение и запускает миграции.
 *
 * I10: может вызываться только один раз. Для повторной инициализации сначала вызовите closeDb().
 * Гарантирует строгий порядок жизненного цикла: initDb → getDb → closeDb.
 */
export function initDb(dbPath: string = "alice.db"): void {
  if (_db) {
    throw new Error(
      `Database already initialized (${_dbPath}). Call closeDb() before re-initializing.`,
    );
  }

  _dbPath = dbPath;
  _sqlite = new Database(dbPath);
  _sqlite.exec("PRAGMA journal_mode = WAL");
  // ADR-145: загружаем токенизатор better_trigram FTS5 — обязательно до migrate(),
  // поскольку migration SQL ссылается на токенизатор better_trigram.
  try {
    loadBetterTrigram(_sqlite);
  } catch (e) {
    _sqlite.close();
    _sqlite = null;
    _dbPath = null;
    throw new Error(
      `Failed to load FTS5 better_trigram extension: ${e instanceof Error ? e.message : e}`,
    );
  }
  _db = drizzle(_sqlite, { schema });

  migrate(_db, { migrationsFolder: MIGRATIONS_FOLDER });

  // ADR-145: восстановление исторических данных после первого деплоя — полный rebuild при пустом FTS-индексе
  ftsEnsurePopulated();
}

/**
 * Возвращает нижележащий экземпляр better-sqlite3 (для транзакций).
 */
export function getSqlite(): InstanceType<typeof Database> {
  if (!_sqlite) throw new Error("Database not initialized");
  return _sqlite;
}

/**
 * Закрывает соединение с базой данных.
 */
export function closeDb(): void {
  if (_sqlite) {
    _sqlite.close();
    _sqlite = null;
    _db = null;
    _dbPath = null;
  }
}
