/**
 * 媒体语义缓存 — 独立 SQLite KV（与主 alice.db 隔离）。
 *
 * 使用 raw better-sqlite3（无 Drizzle）——schema 简单，不需要 migration 体系。
 * 缓存贴纸集标题和 VLM 图片/GIF 描述，重启不丢失。
 *
 * @see docs/adr/88-multimodal-proactive-behavior.md
 */
import type Database from "better-sqlite3";
import type { Statement } from "better-sqlite3";
import BetterSqlite3 from "better-sqlite3";
import { createLogger } from "../utils/logger.js";

const log = createLogger("media-cache");

let _db: InstanceType<typeof Database> | null = null;

// prepared statements（initMediaCache 时初始化，closeMediaCache 时清空）
let _descGet: Statement | null = null;
let _descSet: Statement | null = null;
let _stickerGet: Statement | null = null;
let _stickerSet: Statement | null = null;
let _ocrGet: Statement | null = null;
let _ocrSet: Statement | null = null;

/**
 * 初始化媒体缓存数据库：CREATE TABLE IF NOT EXISTS + WAL 模式。
 * 遵循 db/connection.ts 的单例模式：模块级 _db 变量 + init/close 生命周期。
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

  // 预编译 prepared statements
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

  // 定期清理：删除 30 天前的记录（TTL = 30 天），防止无限增长
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

/** 关闭媒体缓存数据库。 */
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
// 媒体描述缓存（photo / gif）
// ═══════════════════════════════════════════════════════════════════════════

/** 获取缓存的媒体描述。 */
export function getCachedDescription(fileUniqueId: string): string | undefined {
  if (!_descGet) return undefined;
  const row = _descGet.get(fileUniqueId) as { description: string } | undefined;
  return row?.description;
}

/** 写入媒体描述缓存。 */
export function setCachedDescription(
  fileUniqueId: string,
  mediaType: string,
  description: string,
): void {
  _descSet?.run(fileUniqueId, mediaType, description);
}

// ═══════════════════════════════════════════════════════════════════════════
// 贴纸集标题缓存
// ═══════════════════════════════════════════════════════════════════════════

/** 获取缓存的贴纸集标题。 */
export function getCachedStickerSetTitle(
  setId: string,
): { title: string; shortName: string } | undefined {
  if (!_stickerGet) return undefined;
  const row = _stickerGet.get(setId) as { title: string; short_name: string } | undefined;
  if (!row) return undefined;
  return { title: row.title, shortName: row.short_name };
}

/** 写入贴纸集标题缓存。 */
export function setCachedStickerSetTitle(setId: string, title: string, shortName: string): void {
  _stickerSet?.run(setId, title, shortName);
}

// ═══════════════════════════════════════════════════════════════════════════
// OCR 文字缓存
// ═══════════════════════════════════════════════════════════════════════════

/** 获取缓存的 OCR 文字。 */
export function getCachedOcrText(fileUniqueId: string): string | undefined {
  if (!_ocrGet) return undefined;
  const row = _ocrGet.get(fileUniqueId) as { ocr_text: string } | undefined;
  return row?.ocr_text;
}

/** 写入 OCR 文字缓存。 */
export function setCachedOcrText(fileUniqueId: string, ocrText: string): void {
  _ocrSet?.run(fileUniqueId, ocrText);
}
