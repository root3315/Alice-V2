/**
 * Семантическая память — клиент эмбеддингов (ADDITIVE, OPTIONAL, keyless/local).
 *
 * Назначение: дать recall.mod возможность ранжировать память ПО СМЫСЛУ, а не только
 * по ключевым словам. Этот модуль — ТОЛЬКО транспорт: он превращает текст в вектор
 * через локальный OpenAI-совместимый эндпоинт /v1/embeddings. Он НИЧЕГО не решает
 * за Алису и не участвует в tick-loop / личности / голосах — он лишь обогащает
 * RETRIEVAL.
 *
 * Бэкенд: любой сервер, реализующий OpenAI `/v1/embeddings`
 * (Ollama `bge-m3`, llama.cpp server, text-embeddings-inference, LM Studio, …).
 * Модель и адрес — из config (модель-агностично, ничего не захардкожено).
 *
 * ГАРАНТИИ БЕЗОПАСНОСТИ КОГНИЦИИ:
 *  - OFF BY DEFAULT: если base_url/model не заданы — isEmbeddingEnabled()=false и
 *    весь семантический путь молча пропускается. recall работает как раньше.
 *  - GRACEFUL: любой сетевой/HTTP/parse-сбой → возвращаем null, НЕ бросаем. recall
 *    откатывается ровно к keyword/recency/graph-поведению.
 *  - SELF-DISABLING: после нескольких подряд сбоев клиент временно «замолкает»
 *    (cooldown), чтобы упавший/отсутствующий сервер не тормозил каждый recall.
 *
 * @see recall.mod.ts — где семантический балл блендится АДДИТИВНО
 * @see embedding-store.ts — кэш векторов в SQLite (не переэмбеддить неизменный текст)
 */
import { createLogger } from "../utils/logger.js";

const log = createLogger("embeddings");

/** Подмножество Config, нужное клиенту эмбеддингов (удобно мокать в тестах). */
export interface EmbeddingConfig {
  /** Base URL OpenAI-совместимого сервера. Пусто = отключено. */
  embeddingBaseUrl: string;
  /** API key (для локального/keyless — пустая строка, тогда заголовок не шлётся). */
  embeddingApiKey: string;
  /** Модель эмбеддинга (например bge-m3). Пусто = отключено. */
  embeddingModel: string;
}

/** Таймаут одного запроса. Локальный CPU-инференс эмбеддингов короткого текста быстр. */
const REQUEST_TIMEOUT_MS = 8_000;
/** Сколько подряд сбоев до временного «замолкания». */
const FAILURE_THRESHOLD = 3;
/** Длительность cooldown после серии сбоев. */
const COOLDOWN_MS = 60_000;

// Состояние «мягкого выключателя» на уровне процесса. Сбрасывается в тестах.
let _consecutiveFailures = 0;
let _mutedUntilMs = 0;

/** Включён ли семантический путь? Пустой base_url ИЛИ model ⇒ полностью отключено. */
export function isEmbeddingEnabled(config: EmbeddingConfig): boolean {
  return !!config.embeddingBaseUrl.trim() && !!config.embeddingModel.trim();
}

/** Сброс мягкого выключателя (для тестов и горячей переконфигурации). */
export function resetEmbeddingBreaker(): void {
  _consecutiveFailures = 0;
  _mutedUntilMs = 0;
}

function noteFailure(): void {
  _consecutiveFailures++;
  if (_consecutiveFailures >= FAILURE_THRESHOLD) {
    _mutedUntilMs = Date.now() + COOLDOWN_MS;
    log.debug("Embedding endpoint muted after repeated failures", {
      failures: _consecutiveFailures,
      cooldownMs: COOLDOWN_MS,
    });
  }
}

function noteSuccess(): void {
  _consecutiveFailures = 0;
  _mutedUntilMs = 0;
}

function isMuted(): boolean {
  return Date.now() < _mutedUntilMs;
}

/**
 * Получить эмбеддинги для пачки текстов одним запросом.
 *
 * @returns массив векторов (по одному на вход, в том же порядке) ИЛИ null при
 *   отключении/сбое/недоступности. НИКОГДА не бросает — recall полагается на это.
 */
export async function embedTexts(
  texts: string[],
  config: EmbeddingConfig,
): Promise<number[][] | null> {
  if (!isEmbeddingEnabled(config)) return null;
  if (texts.length === 0) return [];
  if (isMuted()) return null;

  const baseUrl = config.embeddingBaseUrl.replace(/\/$/, "");
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  // keyless: заголовок Authorization шлём только если ключ непустой.
  if (config.embeddingApiKey) headers.Authorization = `Bearer ${config.embeddingApiKey}`;

  try {
    const response = await fetch(`${baseUrl}/embeddings`, {
      method: "POST",
      headers,
      body: JSON.stringify({ model: config.embeddingModel, input: texts }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      log.debug("Embedding API non-OK", { status: response.status });
      noteFailure();
      return null;
    }

    const data = (await response.json()) as {
      data?: Array<{ embedding?: number[]; index?: number }>;
    };
    const rows = data.data;
    if (!Array.isArray(rows) || rows.length !== texts.length) {
      log.debug("Embedding API shape mismatch", {
        expected: texts.length,
        got: Array.isArray(rows) ? rows.length : "none",
      });
      noteFailure();
      return null;
    }

    // Сортируем по index (на случай, если сервер вернёт не по порядку), затем берём вектор.
    const ordered = [...rows].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    const vectors: number[][] = [];
    for (const row of ordered) {
      if (!Array.isArray(row.embedding) || row.embedding.length === 0) {
        noteFailure();
        return null;
      }
      vectors.push(row.embedding);
    }
    noteSuccess();
    return vectors;
  } catch (e) {
    // Сетевой сбой / таймаут / битый JSON — всё сюда. Молча деградируем.
    log.debug("Embedding request failed", { error: e instanceof Error ? e.message : String(e) });
    noteFailure();
    return null;
  }
}

/** Удобная обёртка для единственного текста (query-эмбеддинг). */
export async function embedOne(text: string, config: EmbeddingConfig): Promise<number[] | null> {
  const vecs = await embedTexts([text], config);
  return vecs && vecs.length === 1 ? vecs[0] : null;
}

/** Косинусная близость двух векторов [-1, 1]. Несовпадение длины → 0 (безопасно). */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
