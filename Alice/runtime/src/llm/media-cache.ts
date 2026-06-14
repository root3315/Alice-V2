/**
 * Семантический кеш медиа — отдельная SQLite KV (изолирована от основной alice.db).
 *
 * Использует raw better-sqlite3 (без Drizzle) — схема простая, система миграций не нужна.
 * Кешируются заголовки стикерпаков и описания изображений/GIF от VLM; не теряются при перезапуске.
 *
 * @see docs/adr/88-multimodal-proactive-behavior.md
 */
import type Database from "better-sqlite3";
import type { Statement } from "better-sqlite3";
import BetterSqlite3 from "better-sqlite3";
import { createLogger } from "../utils/logger.js";

const log = createLogger("media-cache");

let _db: InstanceType<typeof Database> | null = null;

// prepared statements (инициализируются в initMediaCache, очищаются в closeMediaCache)
let _descGet: Statement | null = null;
let _descSet: Statement | null = null;
let _stickerGet: Statement | null = null;
let _stickerSet: Statement | null = null;
let _ocrGet: Statement | null = null;
let _ocrSet: Statement | null = null;

/**
 * Инициализировать БД медиакеша: CREATE TABLE IF NOT EXISTS + режим WAL.
 * Следует паттерну синглтона из db/connection.ts: модульная переменная _db + жизненный цикл init/close.
 */
export function initMediaCache(dbPath = "media-cache.db"): void {
  if (_db) {
    throw new Error("Media cache already initialized. Call closeMediaCache() first.");
  }
  _db = new BetterSqlite3(dbPath);
  _db.exec("PRAGMA journal_mode = WAL");
  _db.exec(`
    CREATE TABLE IF NOT EXISTS media_descriptions (
      file_unique_id TEXT PRIMARY KEY,
      media_type     TEXT NOT NULL,
      description    TEXT NOT NULL,
      created_at     INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS sticker_sets (
      set_id     TEXT PRIMARY KEY,
      title      TEXT NOT NULL,
      short_name TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS media_ocr (
      file_unique_id TEXT PRIMARY KEY,
      ocr_text       TEXT NOT NULL,
      created_at     INTEGER NOT NULL DEFAULT (unixepoch())
    );
  `);

  // Предварительная компиляция prepared statements
  _descGet = _db.prepare("SELECT description FROM media_descriptions WHERE file_unique_id = ?");
  _descSet = _db.prepare(
    "INSERT OR REPLACE INTO media_descriptions (file_unique_id, media_type, description) VALUES (?, ?, ?)",
  );
  _stickerGet = _db.prepare("SELECT title, short_name FROM sticker_sets WHERE set_id = ?");
  _stickerSet = _db.prepare(
    "INSERT OR REPLACE INTO sticker_sets (set_id, title, short_name) VALUES (?, ?, ?)",
  );
  _ocrGet = _db.prepare("SELECT ocr_text FROM media_ocr WHERE file_unique_id = ?");
  _ocrSet = _db.prepare(
    "INSERT OR REPLACE INTO media_ocr (file_unique_id, ocr_text) VALUES (?, ?)",
  );

  // Периодическая очистка: удаление записей старше 30 дней (TTL = 30 дней), предотвращение бесконечного роста
  const CACHE_TTL_SECONDS = 30 * 24 * 3600;
  const pruned = _db
    .prepare(`DELETE FROM media_descriptions WHERE created_at < unixepoch() - ?`)
    .run(CACHE_TTL_SECONDS);
  const prunedStickers = _db
    .prepare(`DELETE FROM sticker_sets WHERE created_at < unixepoch() - ?`)
    .run(CACHE_TTL_SECONDS);
  const prunedOcr = _db
    .prepare(`DELETE FROM media_ocr WHERE created_at < unixepoch() - ?`)
    .run(CACHE_TTL_SECONDS);
  if (pruned.changes > 0 || prunedStickers.changes > 0 || prunedOcr.changes > 0) {
    log.info("Media cache TTL cleanup", {
      descriptions: pruned.changes,
      stickerSets: prunedStickers.changes,
      ocr: prunedOcr.changes,
    });
  }

  log.info("Media cache initialized", { dbPath });
}

/** Закрыть БД медиакеша. */
export function closeMediaCache(): void {
  _descGet = null;
  _descSet = null;
  _stickerGet = null;
  _stickerSet = null;
  _ocrGet = null;
  _ocrSet = null;
  if (_db) {
    _db.close();
    _db = null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Кеш описаний медиа (photo / gif)
// ═══════════════════════════════════════════════════════════════════════════

/** Получить закешированное описание медиа. */
export function getCachedDescription(fileUniqueId: string): string | undefined {
  if (!_descGet) return undefined;
  const row = _descGet.get(fileUniqueId) as { description: string } | undefined;
  return row?.description;
}

/** Записать описание медиа в кеш. */
export function setCachedDescription(
  fileUniqueId: string,
  mediaType: string,
  description: string,
): void {
  _descSet?.run(fileUniqueId, mediaType, description);
}

// ═══════════════════════════════════════════════════════════════════════════
// Кеш заголовков стикерпаков
// ═══════════════════════════════════════════════════════════════════════════

/** Получить закешированный заголовок стикерпака. */
export function getCachedStickerSetTitle(
  setId: string,
): { title: string; shortName: string } | undefined {
  if (!_stickerGet) return undefined;
  const row = _stickerGet.get(setId) as { title: string; short_name: string } | undefined;
  if (!row) return undefined;
  return { title: row.title, shortName: row.short_name };
}

/** Записать заголовок стикерпака в кеш. */
export function setCachedStickerSetTitle(setId: string, title: string, shortName: string): void {
  _stickerSet?.run(setId, title, shortName);
}

// ═══════════════════════════════════════════════════════════════════════════
// Кеш OCR-текста
// ═══════════════════════════════════════════════════════════════════════════

/** Получить закешированный OCR-текст. */
export function getCachedOcrText(fileUniqueId: string): string | undefined {
  if (!_ocrGet) return undefined;
  const row = _ocrGet.get(fileUniqueId) as { ocr_text: string } | undefined;
  return row?.ocr_text;
}

/** Записать OCR-текст в кеш. */
export function setCachedOcrText(fileUniqueId: string, ocrText: string): void {
  _ocrSet?.run(fileUniqueId, ocrText);
}
