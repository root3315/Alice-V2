/**
 * Семантическая память — кэш векторов эмбеддингов в SQLite (ADDITIVE, OPTIONAL).
 *
 * Назначение: хранить эмбеддинги текстов памяти (факты/мысли/эпизоды/запросы), чтобы:
 *  1) НЕ переэмбеддить неизменный текст (экономия вызовов локального сервера);
 *  2) recall мог достать вектор синхронно из кэша и косинус-ранжировать кандидатов.
 *
 * Ключ — sha256 нормализованного текста + модель. Смена модели ⇒ старые строки
 * не матчатся (cache miss), поэтому семантика самоинвалидируется без миграций.
 *
 * BOUNDED: «embed-with-cache» работает только по переданному ОГРАНИЧЕННОМУ набору
 * кандидатов (recall уже отобрал их keyword/recency-проходом) — мы не эмбеддим
 * всю память безгранично. Ёмкость кэша ограничена LRU-вытеснением.
 *
 * SAFE: при отключённых эмбеддингах сюда никто не заходит; при сбое сервера
 * embed-with-cache возвращает то, что есть в кэше (возможно пусто) — recall
 * деградирует к keyword-поведению.
 *
 * @see embeddings.ts — транспорт (HTTP) + косинус
 * @see recall.mod.ts — потребитель
 */
import { createHash } from "node:crypto";
import { asc, eq, inArray } from "drizzle-orm";
import { getDb } from "../db/connection.js";
import { embeddingCache } from "../db/schema.js";
import { createLogger } from "../utils/logger.js";
import { type EmbeddingConfig, embedTexts, isEmbeddingEnabled } from "./embeddings.js";

const log = createLogger("embedding-store");

/** Максимум строк в кэше. При превышении вытесняем самые старые по updatedAt (LRU). */
const CACHE_CAPACITY = 5_000;
/**
 * Максимум НОВЫХ эмбеддингов за один вызов embedWithCache. Жёсткий потолок стоимости:
 * даже при холодном кэше один recall не делает безграничный батч.
 */
const MAX_NEW_EMBEDS_PER_CALL = 64;

/** Нормализация текста для ключа кэша (совпадает по духу с normalizeFactContent). */
function normalizeForHash(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLowerCase();
}

/** Стабильный ключ кэша: sha256(model + "\0" + нормализованный текст). */
function cacheKey(text: string, model: string): string {
  return createHash("sha256")
    .update(`${model}\0${normalizeForHash(text)}`)
    .digest("hex");
}

/** Записать/обновить вектор в кэше (idempotent upsert). */
function putVector(hash: string, model: string, vec: number[], nowMs: number): void {
  getDb()
    .insert(embeddingCache)
    .values({ textHash: hash, model, dim: vec.length, vec, updatedAt: nowMs })
    .onConflictDoUpdate({
      target: embeddingCache.textHash,
      set: { model, dim: vec.length, vec, updatedAt: nowMs },
    })
    .run();
}

/** Контроль ёмкости: вытеснить самые старые строки, если кэш перерос лимит. */
function enforceCapacity(): void {
  try {
    const count = getDb().select({ h: embeddingCache.textHash }).from(embeddingCache).all().length;
    if (count <= CACHE_CAPACITY) return;
    const overflow = count - CACHE_CAPACITY;
    const oldest = getDb()
      .select({ h: embeddingCache.textHash })
      .from(embeddingCache)
      .orderBy(asc(embeddingCache.updatedAt))
      .limit(overflow)
      .all();
    const keys = oldest.map((r) => r.h);
    if (keys.length > 0) {
      getDb().delete(embeddingCache).where(inArray(embeddingCache.textHash, keys)).run();
    }
  } catch (e) {
    log.debug("enforceCapacity failed (non-fatal)", {
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

/** Прочитать кэшированные векторы для набора текстов (только попадания, по текущей модели). */
function readCached(texts: string[], model: string): Map<string, number[]> {
  const out = new Map<string, number[]>();
  if (texts.length === 0) return out;
  const keyByHash = new Map<string, string>();
  for (const t of texts) keyByHash.set(cacheKey(t, model), t);
  try {
    const rows = getDb()
      .select()
      .from(embeddingCache)
      .where(inArray(embeddingCache.textHash, [...keyByHash.keys()]))
      .all();
    for (const row of rows) {
      const text = keyByHash.get(row.textHash);
      // Игнорируем строки другой модели/размерности (самоинвалидация).
      if (text != null && row.model === model && Array.isArray(row.vec) && row.vec.length > 0) {
        out.set(text, row.vec);
      }
    }
  } catch (e) {
    log.debug("readCached failed (non-fatal)", {
      error: e instanceof Error ? e.message : String(e),
    });
  }
  return out;
}

/**
 * Получить эмбеддинг ОДНОГО текста (используется для query) с кэшем.
 * Попадание в кэш → без сети. Промах → один запрос, результат кэшируется.
 * Возвращает null при отключении/сбое (recall тогда пропускает семантику).
 */
export async function embedQueryCached(
  text: string,
  config: EmbeddingConfig,
  nowMs: number,
): Promise<number[] | null> {
  if (!isEmbeddingEnabled(config)) return null;
  const model = config.embeddingModel;
  const cached = readCached([text], model);
  const hit = cached.get(text);
  if (hit) {
    // Освежаем updatedAt (LRU), но без переэмбеддинга.
    try {
      getDb()
        .update(embeddingCache)
        .set({ updatedAt: nowMs })
        .where(eq(embeddingCache.textHash, cacheKey(text, model)))
        .run();
    } catch {
      /* non-fatal */
    }
    return hit;
  }
  const vecs = await embedTexts([text], config);
  if (!vecs || vecs.length !== 1) return null;
  putVector(cacheKey(text, model), model, vecs[0], nowMs);
  enforceCapacity();
  return vecs[0];
}

/**
 * Получить эмбеддинги для ОГРАНИЧЕННОГО набора текстов памяти, используя кэш.
 *
 * - Возвращает Map text → vector (только те, что удалось получить).
 * - Промахи кэша эмбеддятся ОДНИМ батчем (с потолком MAX_NEW_EMBEDS_PER_CALL).
 * - При сбое сервера возвращает то, что уже было в кэше (graceful).
 *
 * @param texts ограниченный набор (recall передаёт уже отобранных кандидатов)
 */
export async function embedManyCached(
  texts: string[],
  config: EmbeddingConfig,
  nowMs: number,
): Promise<Map<string, number[]>> {
  const result = new Map<string, number[]>();
  if (!isEmbeddingEnabled(config) || texts.length === 0) return result;

  const model = config.embeddingModel;
  // Дедуп входа (один и тот же текст не эмбеддим дважды).
  const unique = [...new Set(texts.map((t) => t).filter((t) => t.trim().length > 0))];

  const cached = readCached(unique, model);
  for (const [t, v] of cached) result.set(t, v);

  const misses = unique.filter((t) => !cached.has(t)).slice(0, MAX_NEW_EMBEDS_PER_CALL);
  if (misses.length === 0) return result;

  const vecs = await embedTexts(misses, config);
  if (!vecs) return result; // сервер недоступен → отдаём только кэш-попадания

  for (let i = 0; i < misses.length; i++) {
    const v = vecs[i];
    if (Array.isArray(v) && v.length > 0) {
      putVector(cacheKey(misses[i], model), model, v, nowMs);
      result.set(misses[i], v);
    }
  }
  enforceCapacity();
  return result;
}

/**
 * Фоново «прогреть» эмбеддинг текста при ингесте (новый факт/мысль/kb).
 *
 * Fire-and-forget: НЕ блокирует и НЕ бросает. Если эмбеддинги выключены — мгновенно
 * выходит (один булев чек). Иначе ставит асинхронную задачу, которая кэширует вектор,
 * чтобы будущий recall нашёл этот текст по смыслу без задержки на эмбеддинг.
 *
 * Это «embed on ingest»-часть: ленивый бэкфилл по кандидатам recall дополняет её.
 * BOUNDED: один короткий текст за вызов; ошибки молча проглатываются.
 */
export function warmEmbeddingOnIngest(text: string, config: EmbeddingConfig, nowMs: number): void {
  if (!isEmbeddingEnabled(config)) return;
  if (!text || text.trim().length === 0) return;
  // Не ждём результата: ингест-путь синхронен и не должен зависеть от сервера.
  void embedQueryCached(text, config, nowMs).catch(() => {
    /* graceful: прогрев не критичен */
  });
}

/** Тест-хелпер: текущее число строк в кэше. */
export function embeddingCacheSize(): number {
  return getDb().select({ h: embeddingCache.textHash }).from(embeddingCache).all().length;
}

export { cacheKey as _cacheKeyForTest };
