/**
 * FTS5 полнотекстовые запросы + восстановление индекса при запуске.
 *
 * **Синхронизация записей выполняется автоматически триггерами SQLite** (migration 0017_fts5_triggers.sql) —
 * INSERT/UPDATE/DELETE в исходных таблицах синхронизируют FTS-индекс без ручных вызовов из приложения.
 *
 * Этот модуль отвечает только за:
 * 1. Запросы: searchMessagesFts / searchDiaryFts / searchThreadsFts
 * 2. Восстановление при запуске: ftsEnsurePopulated (обрабатывает исторические данные до деплоя триггеров)
 *
 * @see docs/adr/145-local-fulltext-search.md
 * @see runtime/drizzle/0017_fts5_triggers.sql
 */
import { getSqlite } from "./connection.js";
import type { DbMessageRecord } from "./queries.js";

// ── FTS5 запросы ──────────────────────────────────────────────────────────

/** Форма raw row для FTS5-поиска (соответствует возврату .all() в better-sqlite3). */
interface FtsSearchRow {
  id: number;
  platform: string;
  msg_id: number | null;
  native_chat_id: string | null;
  native_msg_id: string | null;
  stable_message_id: string | null;
  tick: number;
  chat_id: string;
  sender_id: string | null;
  sender_name: string | null;
  text: string | null;
  media_type: string | null;
  is_outgoing: number;
  reply_to_msg_id: number | null;
  /** Drizzle mode:"timestamp" хранится как Unix-timestamp в секундах. */
  created_at: number;
  /** Контекстный фрагмент, возвращаемый вспомогательной функцией FTS5 snippet() (присутствует только при запросе). */
  snippet: string | null;
}

/** Тип возврата FTS-поиска — DbMessageRecord с добавленным полем snippet. */
export type FtsMessageResult = DbMessageRecord & { chatId: string; snippet: string | null };

/** Маппинг raw row → FtsMessageResult. */
function mapRow(r: FtsSearchRow): FtsMessageResult {
  return {
    platform: r.platform,
    msgId: r.msg_id ?? null,
    nativeChatId: r.native_chat_id,
    nativeMsgId: r.native_msg_id,
    stableMessageId: r.stable_message_id,
    tick: r.tick,
    chatId: r.chat_id,
    senderId: r.sender_id,
    senderName: r.sender_name,
    text: r.text,
    mediaType: r.media_type,
    isOutgoing: !!r.is_outgoing,
    replyToMsgId: r.reply_to_msg_id,
    // created_at — timestamp в секундах, конструктор Date ожидает миллисекунды
    createdAt: new Date(r.created_at * 1000),
    snippet: r.snippet,
  };
}

/** Проекция столбцов SELECT — используется во всех запросах. */
const COLUMNS = `m.id, m.platform, m.msg_id, m.native_chat_id, m.native_msg_id, m.stable_message_id,
  m.tick, m.chat_id, m.sender_id, m.sender_name,
  m.text, m.media_type, m.is_outgoing, m.reply_to_msg_id, m.created_at`;

/** Параметры поиска. */
export interface FtsSearchOptions {
  /** Ограничить по ID чата (если не указан — поиск по всем чатам). */
  chatId?: string;
  /** Ограничить по ID отправителя (точное совпадение с колонкой sender_id). */
  senderId?: string;
  /** Возвращать только сообщения после этой даты (Unix-timestamp в секундах). */
  afterTs?: number;
  /** Возвращать только сообщения до этой даты (Unix-timestamp в секундах). */
  beforeTs?: number;
  /** Максимальное число результатов (по умолчанию 20, предел 20). */
  limit?: number;
}

/**
 * FTS5 полнотекстовый поиск по messageLog (сортировка BM25).
 *
 * trigram-токенизатор нативно поддерживает CJK — сегментация не нужна,
 * любая подстрока из 3+ символов попадает в индекс.
 * expression передаётся напрямую в FTS5 MATCH — поддерживается полный синтаксис FTS5:
 *   - неявный AND: `погода путешествие` (пробел = оба должны совпасть)
 *   - OR: `погода OR дождь`
 *   - NOT: `погода NOT дождь`
 *   - фраза: `"hello world"`
 *   - префикс: `hel*`
 *
 * SQL-запрос строится динамически (условий немного; better-sqlite3 кэширует prepare внутри).
 *
 * @param expression Выражение FTS5 MATCH
 * @param opts Необязательные условия фильтрации
 */
export function searchMessagesFts(expression: string, opts?: FtsSearchOptions): FtsMessageResult[] {
  const matchExpr = expression.trim();
  if (!matchExpr) return [];

  const conditions = ["message_log_fts MATCH ?"];
  const params: unknown[] = [matchExpr];

  if (opts?.chatId) {
    conditions.push("m.chat_id = ?");
    params.push(opts.chatId);
  }
  if (opts?.senderId) {
    conditions.push("m.sender_id = ?");
    params.push(opts.senderId);
  }
  if (opts?.afterTs != null) {
    conditions.push("m.created_at >= ?");
    params.push(opts.afterTs);
  }
  if (opts?.beforeTs != null) {
    conditions.push("m.created_at <= ?");
    params.push(opts.beforeTs);
  }

  const limit = Math.min(opts?.limit ?? 20, 20);
  params.push(limit);

  // snippet(table, column_index, open, close, ellipsis, max_tokens)
  // column 0 = text (message_log_fts содержит только один столбец)
  const sql = `SELECT ${COLUMNS},
  snippet(message_log_fts, 0, '»', '«', '…', 64) as snippet
FROM message_log_fts fts
JOIN message_log m ON m.id = fts.rowid
WHERE ${conditions.join(" AND ")}
ORDER BY bm25(message_log_fts) LIMIT ?`;

  const rows = getSqlite()
    .prepare(sql)
    .all(...params) as FtsSearchRow[];
  return rows.map(mapRow);
}

// ── Diary FTS5 запросы ────────────────────────────────────────────────────

export interface FtsDiaryRecord {
  id: number;
  tick: number;
  content: string;
  about: string | null;
  createdAt: Date;
}

/**
 * FTS5 полнотекстовый поиск по diary_entries (сортировка BM25).
 *
 * @param expression Выражение FTS5 MATCH
 * @param opts Необязательные условия фильтрации (сущность about, временной диапазон)
 */
export function searchDiaryFts(
  expression: string,
  opts?: { about?: string; afterTs?: number; beforeTs?: number; limit?: number },
): FtsDiaryRecord[] {
  const matchExpr = expression.trim();
  if (!matchExpr) return [];

  const conditions = ["diary_fts MATCH ?"];
  const params: unknown[] = [matchExpr];

  if (opts?.about) {
    conditions.push("d.about = ?");
    params.push(opts.about);
  }
  if (opts?.afterTs != null) {
    conditions.push("d.created_at >= ?");
    params.push(opts.afterTs);
  }
  if (opts?.beforeTs != null) {
    conditions.push("d.created_at <= ?");
    params.push(opts.beforeTs);
  }

  const limit = Math.min(opts?.limit ?? 20, 20);
  params.push(limit);

  const sql = `SELECT d.id, d.tick, d.content, d.about, d.created_at
FROM diary_fts fts
JOIN diary_entries d ON d.id = fts.rowid
WHERE ${conditions.join(" AND ")}
ORDER BY bm25(diary_fts) LIMIT ?`;

  const rows = getSqlite()
    .prepare(sql)
    .all(...params) as Array<{
    id: number;
    tick: number;
    content: string;
    about: string | null;
    created_at: number;
  }>;

  return rows.map((r) => ({
    id: r.id,
    tick: r.tick,
    content: r.content,
    about: r.about,
    createdAt: new Date(r.created_at * 1000),
  }));
}

// ── Threads FTS5 запросы ──────────────────────────────────────────────────

export interface FtsThreadRecord {
  id: number;
  title: string;
  status: string;
  weight: string;
  tensionFrame: string | null;
  summary: string | null;
  involves: string | null;
  createdTick: number;
  lastBeatTick: number | null;
}

/**
 * FTS5 полнотекстовый поиск по narrative_threads (сортировка BM25).
 *
 * @param expression Выражение FTS5 MATCH
 * @param opts Необязательные условия фильтрации (фильтр по status)
 */
export function searchThreadsFts(
  expression: string,
  opts?: { status?: string; limit?: number },
): FtsThreadRecord[] {
  const matchExpr = expression.trim();
  if (!matchExpr) return [];

  const conditions = ["threads_fts MATCH ?"];
  const params: unknown[] = [matchExpr];

  if (opts?.status) {
    conditions.push("t.status = ?");
    params.push(opts.status);
  }

  const limit = Math.min(opts?.limit ?? 20, 20);
  params.push(limit);

  const sql = `SELECT t.id, t.title, t.status, t.weight, t.tension_frame, t.summary,
       t.involves, t.created_tick, t.last_beat_tick
FROM threads_fts fts
JOIN narrative_threads t ON t.id = fts.rowid
WHERE ${conditions.join(" AND ")}
ORDER BY bm25(threads_fts) LIMIT ?`;

  const rows = getSqlite()
    .prepare(sql)
    .all(...params) as Array<{
    id: number;
    title: string;
    status: string;
    weight: string;
    tension_frame: string | null;
    summary: string | null;
    involves: string | null;
    created_tick: number;
    last_beat_tick: number | null;
  }>;

  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    status: r.status,
    weight: r.weight,
    tensionFrame: r.tension_frame,
    summary: r.summary,
    involves: r.involves,
    createdTick: r.created_tick,
    lastBeatTick: r.last_beat_tick,
  }));
}

// ── Восстановление индекса при запуске ────────────────────────────────────

/**
 * Условный rebuild при запуске: полный rebuild, если FTS-индекс пуст, а исходная таблица — нет.
 *
 * Сценарии:
 * 1. Первый запуск после деплоя migration 0017 — исторические данные существовали до триггеров.
 * 2. FTS-индекс случайно повреждён — rebuild восстанавливает его из исходной таблицы.
 *
 * После деплоя триггеров последующие INSERT/UPDATE/DELETE синхронизируются автоматически.
 * Эта функция обрабатывает только данные, записанные до того, как триггеры существовали.
 *
 * **Важный нюанс реализации**: `SELECT count(*) FROM fts` для FTS-таблицы с content=
 * проксируется к исходной таблице (возвращает её строки), а не отражает реальное состояние индекса.
 * Для получения фактического числа проиндексированных документов необходимо обращаться к теневой таблице `_docsize`.
 * @see https://www.sqlite.org/fts5.html#the_docsize_table
 */
export function ftsEnsurePopulated(): void {
  const sqlite = getSqlite();

  const check = (ftsTable: string, sourceTable: string) => {
    // Число строк в теневой таблице _docsize = фактическое количество документов в FTS-индексе
    // count(*) на самой fts-таблице нельзя использовать — в режиме content= оно проксируется к исходной таблице
    const indexedCount = (
      sqlite.prepare(`SELECT count(*) as n FROM ${ftsTable}_docsize`).get() as { n: number }
    ).n;
    if (indexedCount > 0) return; // индекс уже содержит данные, пропускаем
    const srcCount = (
      sqlite.prepare(`SELECT count(*) as n FROM ${sourceTable}`).get() as { n: number }
    ).n;
    if (srcCount === 0) return; // исходная таблица тоже пуста, rebuild не нужен
    sqlite.exec(`INSERT INTO ${ftsTable}(${ftsTable}) VALUES('rebuild')`);
  };

  check("message_log_fts", "message_log");
  check("diary_fts", "diary_entries");
  check("threads_fts", "narrative_threads");
}
