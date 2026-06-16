/**
 * Sticker Palette — слой запросов: семантический тег → fileId.
 *
 * Phase 1: ручной INSERT или поддержка через скрипт администратора.
 * Phase 2: автоматическая индексация VLM (побочный продукт describeMedia("sticker") → upsertFromVLM)
 *         + отслеживание частоты использования + взвешенная выборка + запасной подбор по измерениям.
 *
 * @see https://github.com/TelechaBot/anime-identify — классификация аниме-изображений
 */
import type { Sticker, TelegramClient } from "@mtcute/node";
import { and, eq, isNotNull, notInArray, sql } from "drizzle-orm";
import { z } from "zod";

import type { Config } from "../../config.js";
import type { getDb } from "../../db/connection.js";
import { stickerPalette } from "../../db/schema.js";
import {
  embedManyCached,
  embedQueryCached,
  warmEmbeddingOnIngest,
} from "../../llm/embedding-store.js";
import { cosineSimilarity, type EmbeddingConfig, isEmbeddingEnabled } from "../../llm/embeddings.js";
import { describeMedia, getStickerAnalysis, isVisionEnabled } from "../../llm/vision.js";
import { createLogger } from "../../utils/logger.js";

/** Тип экземпляра Drizzle DB (соответствует возвращаемому значению getDb()). */
type Db = ReturnType<typeof getDb>;

/**
 * Предикат «стикер НЕ отключён владельцем» (disabled = 0). Добавляется в WHERE КАЖДОГО
 * запроса выборки стикера на отправку — отключённый через дашборд стикер не должен
 * просочиться ни по одному пути подбора (см. Part A spec). Текстовые пути, где WHERE
 * не покрывает все строки, дополнительно фильтруют результат по disabled на стороне JS.
 */
const NOT_DISABLED = eq(stickerPalette.disabled, 0);

/** Предикат «стикер помечен значимым владельцем» (signature = 1). */
const IS_SIGNATURE = eq(stickerPalette.signature, 1);

/**
 * Стабильный зарезервированный токен инвокации значимого стикера: `signature`.
 *
 * Это детерминированный ключ, по которому LLM (или код) может ОСОЗНАННО запросить
 * именно значимый стикер вне зависимости от текста смысла. Не зависит от языка/формулировки
 * meaning — формулировка может меняться, токен остаётся прежним. Документирован в affordance.
 */
export const SIGNATURE_RESERVED_TOKEN = "signature";

/** Строка одного значимого стикера (для affordance/self-факта/инвокации). */
export interface SignatureSticker {
  id: number;
  fileId: string;
  fileUniqueId: string;
  meaning: string | null;
}

/**
 * Возвращает АКТИВНЫЙ значимый стикер (signature=1 И НЕ disabled), либо null.
 *
 * ГАРАНТИЯ OFF-BY-DEFAULT: при отсутствии помеченных строк (дефолт) — возвращает null,
 * поэтому все опирающиеся на неё ветки (resolveLabel, affordance, self-факт) становятся no-op,
 * а поведение остаётся байт-в-байт прежним. Если значимых несколько — берём первый по id
 * (детерминированно, без RNG): осознанный выбор владельца, а не вероятностный вес.
 */
export function getSignatureSticker(db: Db): SignatureSticker | null {
  const row = db
    .select({
      id: stickerPalette.id,
      fileId: stickerPalette.fileId,
      fileUniqueId: stickerPalette.fileUniqueId,
      meaning: stickerPalette.meaning,
    })
    .from(stickerPalette)
    .where(and(IS_SIGNATURE, NOT_DISABLED))
    .orderBy(stickerPalette.id)
    .limit(1)
    .get();
  return row ? { ...row, meaning: row.meaning ?? null } : null;
}

// ═══════════════════════════════════════════════════════════════════════════
// Phase 1: Базовые запросы
// ═══════════════════════════════════════════════════════════════════════════

/** Возвращает все активные теги палитры (для подстановки в prompt). */
export function getPaletteLabels(db: Db): string[] {
  const rows = db
    .select({ label: stickerPalette.label, emoji: stickerPalette.emoji })
    .from(stickerPalette)
    .all();
  return rows.map((r) => `${r.emoji ?? "🏷️"} ${r.label}`);
}

/** Проверяет, непуста ли палитра (для hasStickers). */
export function hasPaletteEntries(db: Db): boolean {
  const row = db.select({ id: stickerPalette.id }).from(stickerPalette).limit(1).get();
  return row != null;
}

// ═══════════════════════════════════════════════════════════════════════════
// Phase 2: Автоматическая индексация VLM
// ═══════════════════════════════════════════════════════════════════════════

/** Быстрая проверка: есть ли стикер в палитре (дедупликация по file_unique_id). */
export function isInPalette(db: Db, fileUniqueId: string): boolean {
  const row = db
    .select({ id: stickerPalette.id })
    .from(stickerPalette)
    .where(eq(stickerPalette.fileUniqueId, fileUniqueId))
    .limit(1)
    .get();
  return row != null;
}

/** Параметры upsertFromVLM (единственный источник истины — Zod). */
export const upsertParamsSchema = z.object({
  fileUniqueId: z.string(),
  fileId: z.string(),
  label: z.string(),
  emoji: z.string().optional(),
  setName: z.string().optional(),
  /** Курируемый стикер (batch-VLM пак): true → curated=1, защищён от очистки. По умолчанию false. */
  curated: z.boolean().optional(),
  /**
   * fileId растровой миниатюры для АНИМИРОВАННЫХ стикеров (превью-кадр для дашборда).
   * Опционально: статичные стикеры его не передают (их основной файл — уже растр) → остаётся null.
   * При повторной индексации обновляется как другие refreshable-поля.
   */
  thumbFileId: z.string().optional(),
  emotion: z.string(),
  action: z.string(),
  intensity: z.string(),
});

export type UpsertParams = z.infer<typeof upsertParamsSchema>;

/**
 * Записывает результаты анализа VLM в палитру.
 * При конфликте file_unique_id — обновляет измерения и обновляет file_id.
 */
export function upsertFromVLM(db: Db, params: UpsertParams): void {
  // boolean → 0/1; при upsert обновляем curated только когда явно курируем (true), чтобы
  // оппортунистический путь (curated не передан) не сбрасывал ранее выставленный флаг.
  const curatedFlag = params.curated ? 1 : 0;
  db.insert(stickerPalette)
    .values({
      label: params.label,
      fileId: params.fileId,
      fileUniqueId: params.fileUniqueId,
      emoji: params.emoji,
      setName: params.setName,
      curated: curatedFlag,
      thumbFileId: params.thumbFileId,
      emotion: params.emotion,
      action: params.action,
      intensity: params.intensity,
    })
    .onConflictDoUpdate({
      target: stickerPalette.fileUniqueId,
      set: {
        fileId: params.fileId,
        label: params.label,
        emotion: params.emotion,
        action: params.action,
        intensity: params.intensity,
        // thumbFileId — refreshable: обновляем ТОЛЬКО когда явно передан (re-index анимированного
        // стикера бэкфилит/освежает превью). Оппортунистический путь его не передаёт → НЕ затираем
        // в null ранее захваченную миниатюру.
        ...(params.thumbFileId != null ? { thumbFileId: params.thumbFileId } : {}),
        // setName/curated обновляем только при явной курации (батч-индекс),
        // иначе оставляем как было (оппортунистический путь не перетирает курируемый пак).
        ...(params.curated
          ? { setName: params.setName, curated: 1 }
          : {}),
      },
    })
    .run();
}

// ═══════════════════════════════════════════════════════════════════════════
// Phase 2: Подбор по измерениям (установленные приоритетнее → VLM как запасной вариант)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Перечисление измерений VLM — единственный словарь, которым LLM запрашивает палитру.
 * Синхронизировано с stickerVlmSchema (src/llm/vision.ts).
 * @see docs/adr/148-sticker-palette-phase2-vlm-index.md §D3
 */
const EMOTIONS = new Set([
  "happy",
  "sad",
  "angry",
  "surprised",
  "shy",
  "tired",
  "neutral",
  "love",
  "scared",
]);
const ACTIONS = new Set([
  "wave",
  "hug",
  "cry",
  "laugh",
  "sleep",
  "eat",
  "dance",
  "thumbsup",
  "facepalm",
  "peek",
]);
// "none" не входит в множество — не является осмысленным измерением для запроса

/**
 * Запрос кандидатов по столбцу измерения.
 *
 * Двухуровневая выборка (установленные приоритетнее):
 * 1. Основной пул (setName IS NOT NULL) — наборы стикеров, установленные Алисой, равномерно случайно
 * 2. Резервный пул (setName IS NULL) — стикеры, найденные VLM в диалогах; используется только при отсутствии совпадений в основном пуле
 *
 * Без взвешивания по частоте использования — чтобы избежать закрепления высокочастотных стикеров.
 * @see stickerVlmSchema in src/llm/vision.ts — единственный источник истины для перечисления измерений
 */
function pickByDimension(
  db: Db,
  column: "emotion" | "action",
  value: string,
  _chatId?: string | number,
): string | null {
  const col = column === "emotion" ? stickerPalette.emotion : stickerPalette.action;

  // Основной пул: собственные установленные наборы стикеров (приоритет).
  // disabled = 0 — отключённые владельцем стикеры НИКОГДА не попадают в выборку.
  const own = db
    .select({ fileId: stickerPalette.fileId })
    .from(stickerPalette)
    .where(and(eq(col, value), isNotNull(stickerPalette.setName), NOT_DISABLED))
    .all();
  if (own.length > 0) {
    return own[Math.floor(Math.random() * own.length)].fileId;
  }

  // Резервный пул: стикеры, найденные VLM (используется, если основной пул не дал совпадений)
  const fallback = db
    .select({ fileId: stickerPalette.fileId })
    .from(stickerPalette)
    .where(and(eq(col, value), sql`${stickerPalette.setName} IS NULL`, NOT_DISABLED))
    .all();
  if (fallback.length > 0) {
    return fallback[Math.floor(Math.random() * fallback.length)].fileId;
  }

  return null;
}

/**
 * Разрешает семантический тег в fileId.
 *
 * Стратегия сопоставления (по приоритету):
 * 1. Совпадение по измерению VLM (happy, hug, laugh... — стандартный словарь LLM)
 * 2. Точное совпадение label (полный текст VLM description)
 * 3. Совпадение по подстроке (label ⊂ description или description ⊂ label)
 * 4. null (вызывающая сторона сама решает, является ли значение сырым fileId)
 *
 * Никакой эвристики, специфичной для языка — LLM запрашивает напрямую через перечисление измерений VLM.
 * @see stickerVlmSchema in src/llm/vision.ts — единственный источник истины для перечисления измерений
 */
export function resolveLabel(db: Db, label: string, chatId?: string | number): string | null {
  const lower = label.toLowerCase();

  // 0. ВЫСОКИЙ ПРИОРИТЕТ: осознанная инвокация значимого стикера (signature).
  //    OFF-BY-DEFAULT: getSignatureSticker() возвращает null, пока владелец не пометил стикер →
  //    эта ветка не выполняется и поведение остаётся байт-в-байт прежним.
  //    Совпадение детерминированное (НИКАКОГО RNG-веса): либо стабильный зарезервированный токен
  //    `signature`, либо запрос ССЫЛАЕТСЯ на смысл (двусторонний подстрочный матч meaning ⇄ label,
  //    без учёта регистра). Уважает NOT_DISABLED (getSignatureSticker уже фильтрует disabled).
  const sig = getSignatureSticker(db);
  if (sig) {
    if (lower === SIGNATURE_RESERVED_TOKEN) return sig.fileId;
    const meaningLower = (sig.meaning ?? "").trim().toLowerCase();
    if (
      meaningLower.length > 0 &&
      (lower.includes(meaningLower) || meaningLower.includes(lower))
    ) {
      return sig.fileId;
    }
  }

  // 1. VLM dimension match — значения измерений являются стандартным словарём запросов LLM
  if (EMOTIONS.has(lower)) {
    const hit = pickByDimension(db, "emotion", lower, chatId);
    if (hit) return hit;
  }
  if (ACTIONS.has(lower)) {
    const hit = pickByDimension(db, "action", lower, chatId);
    if (hit) return hit;
  }

  // 2-3. Text-based matching (точный label → совпадение по подстроке) — установленные приоритетнее, VLM как запасной вариант.
  // disabled = 0 — отключённые стикеры исключаем из выборки (фильтр в WHERE покрывает все строки пула).
  const ownRows = db
    .select({ label: stickerPalette.label, fileId: stickerPalette.fileId })
    .from(stickerPalette)
    .where(and(isNotNull(stickerPalette.setName), NOT_DISABLED))
    .all();

  const ownExact = ownRows.find((r) => r.label === label);
  if (ownExact) return ownExact.fileId;
  const ownPartial = ownRows.find((r) => label.includes(r.label) || r.label.includes(label));
  if (ownPartial) return ownPartial.fileId;

  // Нет совпадений среди установленных → переход к резервному пулу VLM (тоже без отключённых)
  const vlmRows = db
    .select({ label: stickerPalette.label, fileId: stickerPalette.fileId })
    .from(stickerPalette)
    .where(and(sql`${stickerPalette.setName} IS NULL`, NOT_DISABLED))
    .all();

  const vlmExact = vlmRows.find((r) => r.label === label);
  if (vlmExact) return vlmExact.fileId;
  const vlmPartial = vlmRows.find((r) => label.includes(r.label) || r.label.includes(label));
  if (vlmPartial) return vlmPartial.fileId;

  return null;
}

// ═══════════════════════════════════════════════════════════════════════════
// Tier 1.5: подбор «по смыслу» через эмбеддинги (ADDITIVE, OFF BY DEFAULT)
// ═══════════════════════════════════════════════════════════════════════════

/** Минимальная косинусная близость для семантического матча (тот же порог, что в recall.mod). */
const SEMANTIC_STICKER_MIN_SIMILARITY = 0.55;
/** Жёсткий потолок кандидатов на эмбеддинг за один подбор (ограничивает стоимость). */
const SEMANTIC_CANDIDATE_CAP = 200;

/**
 * Разрешает запрос в fileId ПО СМЫСЛУ через эмбеддинги (опциональный слой).
 *
 * ГАРАНТИЯ БАЙТ-В-БАЙТ: если эмбеддинги выключены (isEmbeddingEnabled=false) —
 * возвращает null НЕМЕДЛЕННО, ничего не эмбеддит и не читает БД. Вызывающая сторона
 * (index.ts) вызывает эту функцию только когда дешёвый resolveLabel уже вернул null,
 * поэтому при выключенных эмбеддингах путь отправки стикера остаётся прежним.
 *
 * Логика (когда включено):
 * 1. Эмбеддим запрос (кэш-обёртка embedQueryCached).
 * 2. Берём кандидатов: сперва собственный/курируемый пул (setName IS NOT NULL ИЛИ curated=1),
 *    затем — резервный пул (setName IS NULL). Каждый пул проверяется отдельно: если в
 *    приоритетном пуле нашёлся матч ≥ порога — берём его, к резервному не спускаемся.
 * 3. Эмбеддим метки кандидатов (embedManyCached), косинус-ранжируем, возвращаем лучший
 *    fileId при cosine ≥ 0.55, иначе null.
 *
 * @returns fileId лучшего по смыслу стикера или null (выключено/нет матча/сбой).
 */
export async function resolveLabelSemantic(
  db: Db,
  query: string,
  embeddingConfig: EmbeddingConfig,
  _chatId?: string | number,
): Promise<string | null> {
  // СТРОГИЙ no-op при выключенных эмбеддингах — гарантирует прежнее поведение.
  if (!isEmbeddingEnabled(embeddingConfig)) return null;
  const q = query.trim();
  if (!q) return null;

  const nowMs = Date.now();
  const queryVec = await embedQueryCached(q, embeddingConfig, nowMs);
  if (!queryVec) return null; // сбой/cooldown сервера эмбеддингов → молча деградируем

  // Приоритетный пул: установленные самостоятельно ИЛИ курируемые паки.
  // disabled = 0 — отключённые владельцем стикеры исключаем из кандидатов.
  const ownRows = db
    .select({ label: stickerPalette.label, fileId: stickerPalette.fileId })
    .from(stickerPalette)
    .where(
      and(
        // ВАЖНО: явные скобки вокруг OR — иначе SQL-приоритет (AND > OR) превратит условие в
        // `setName IS NOT NULL OR (curated = 1 AND disabled = 0)`, и отключённый установленный
        // стикер просочился бы в кандидаты.
        sql`(${stickerPalette.setName} IS NOT NULL OR ${stickerPalette.curated} = 1)`,
        NOT_DISABLED,
      ),
    )
    .limit(SEMANTIC_CANDIDATE_CAP)
    .all();

  const ownHit = await rankBySimilarity(ownRows, queryVec, embeddingConfig, nowMs);
  if (ownHit) return ownHit;

  // Резервный пул: VLM-найденные (setName IS NULL и не курируемые), тоже без отключённых.
  const fallbackRows = db
    .select({ label: stickerPalette.label, fileId: stickerPalette.fileId })
    .from(stickerPalette)
    .where(
      and(
        sql`(${stickerPalette.setName} IS NULL AND ${stickerPalette.curated} = 0)`,
        NOT_DISABLED,
      ),
    )
    .limit(SEMANTIC_CANDIDATE_CAP)
    .all();

  return rankBySimilarity(fallbackRows, queryVec, embeddingConfig, nowMs);
}

/** Косинус-ранжирование набора {label,fileId} против вектора запроса; null если лучший < порога. */
async function rankBySimilarity(
  rows: Array<{ label: string; fileId: string }>,
  queryVec: number[],
  embeddingConfig: EmbeddingConfig,
  nowMs: number,
): Promise<string | null> {
  if (rows.length === 0) return null;
  const labels = rows.map((r) => r.label).filter((l) => l.trim().length > 0);
  if (labels.length === 0) return null;

  const vecByLabel = await embedManyCached(labels, embeddingConfig, nowMs);
  if (vecByLabel.size === 0) return null;

  let bestFileId: string | null = null;
  let bestScore = -1;
  for (const row of rows) {
    const vec = vecByLabel.get(row.label);
    if (!vec) continue;
    const score = cosineSimilarity(queryVec, vec);
    if (score > bestScore) {
      bestScore = score;
      bestFileId = row.fileId;
    }
  }
  return bestScore >= SEMANTIC_STICKER_MIN_SIMILARITY ? bestFileId : null;
}

// ═══════════════════════════════════════════════════════════════════════════
// Tier 2: цепочка деградации keyword → emoji → palette
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Сопоставление семантических тегов с emoji (на уровне структуры, LLM не видит).
 * @see EMOTIONS, ACTIONS — единственный источник истины
 */
export const KEYWORD_TO_EMOJI: Record<string, string> = {
  // emotions
  happy: "😊",
  sad: "😢",
  angry: "😠",
  surprised: "😲",
  shy: "😳",
  tired: "😴",
  love: "❤️",
  scared: "😨",
  // actions
  wave: "👋",
  hug: "🤗",
  cry: "😭",
  laugh: "😂",
  sleep: "😴",
  dance: "💃",
  thumbsup: "👍",
  facepalm: "🤦",
  peek: "🫣",
};

/**
 * Обратное сопоставление emoji → emotion (используется и в bootstrap, и в Tier 2).
 * Инверсия KEYWORD_TO_EMOJI + расширение распространёнными вариантами.
 */
export const EMOJI_TO_EMOTION: Record<string, string> = {
  "😊": "happy",
  "😃": "happy",
  "😄": "happy",
  "😁": "happy",
  "🥰": "love",
  "😢": "sad",
  "😭": "sad",
  "😠": "angry",
  "😡": "angry",
  "😲": "surprised",
  "😮": "surprised",
  "😳": "shy",
  "😴": "tired",
  "😨": "scared",
  "😱": "scared",
  "❤️": "love",
  "💕": "love",
  "😍": "love",
};

/** Обратное сопоставление emoji → action. */
export const EMOJI_TO_ACTION: Record<string, string> = {
  "👋": "wave",
  "🤗": "hug",
  "😭": "cry",
  "😂": "laugh",
  "💃": "dance",
  "🕺": "dance",
  "👍": "thumbsup",
  "🤦": "facepalm",
  "🫣": "peek",
};

/**
 * Деградация Tier 2: keyword → emoji → сопоставление по столбцу palette.emoji.
 * Используется, когда в палитре есть данные, но столбцы измерений (emotion/action) отсутствуют (например, на этапе bootstrap),
 * и совпадение выполняется косвенно через столбец emoji.
 */
export function resolveByEmoji(db: Db, keyword: string, _chatId?: string | number): string | null {
  const emoji = KEYWORD_TO_EMOJI[keyword.toLowerCase()];
  if (!emoji) return null;

  // Установленные приоритетнее, VLM как запасной вариант. disabled = 0 — без отключённых.
  const own = db
    .select({ fileId: stickerPalette.fileId })
    .from(stickerPalette)
    .where(and(eq(stickerPalette.emoji, emoji), isNotNull(stickerPalette.setName), NOT_DISABLED))
    .all();
  if (own.length > 0) {
    return own.length === 1 ? own[0].fileId : own[Math.floor(Math.random() * own.length)].fileId;
  }

  const candidates = db
    .select({ fileId: stickerPalette.fileId })
    .from(stickerPalette)
    .where(
      and(eq(stickerPalette.emoji, emoji), sql`${stickerPalette.setName} IS NULL`, NOT_DISABLED),
    )
    .all();

  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0].fileId;

  // Несколько кандидатов → равномерно случайный (у столбца emoji нет измерения частоты использования)
  return candidates[Math.floor(Math.random() * candidates.length)].fileId;
}

/**
 * Генерирует предварительный просмотр доступных ключевых слов (для сообщений об ошибках Tier 3).
 * Формируется динамически из палитры — если есть данные измерений, использует их; иначе константы EMOTIONS/ACTIONS.
 */
export function getAvailableKeywords(db: Db): string {
  // Запрашиваем значения emotion/action, присутствующие в палитре
  const emotionRows = db
    .select({ emotion: stickerPalette.emotion })
    .from(stickerPalette)
    .where(sql`${stickerPalette.emotion} IS NOT NULL AND ${stickerPalette.emotion} != 'neutral'`)
    .groupBy(stickerPalette.emotion)
    .all();
  const actionRows = db
    .select({ action: stickerPalette.action })
    .from(stickerPalette)
    .where(sql`${stickerPalette.action} IS NOT NULL AND ${stickerPalette.action} != 'none'`)
    .groupBy(stickerPalette.action)
    .all();

  const emotions = emotionRows.map((r) => r.emotion).filter(Boolean);
  const actions = actionRows.map((r) => r.action).filter(Boolean);

  // Есть данные измерений → используем реальные данные; иначе — константные наборы
  const emotionList = emotions.length > 0 ? emotions : [...EMOTIONS].filter((e) => e !== "neutral");
  const actionList = actions.length > 0 ? actions : [...ACTIONS];

  return `Emotions: ${emotionList.join(", ")}. Actions: ${actionList.join(", ")}`;
}

/**
 * Финальный фолбэк: любой стикер из палитры (установленные приоритетнее VLM-найденных).
 * Нужен, чтобы `irc sticker --keyword X` НИКОГДА не падал, даже если набор не
 * классифицирован по эмоциям/действиям (как нейтральный bootstrap-набор) — лучше
 * отправить нейтральный стикер, чем вернуть ошибку. null только если палитра пуста.
 */
export function pickAnySticker(db: Db): string | null {
  // disabled = 0 — даже финальный фолбэк не отправляет отключённый владельцем стикер.
  const own = db
    .select({ fileId: stickerPalette.fileId })
    .from(stickerPalette)
    .where(and(isNotNull(stickerPalette.setName), NOT_DISABLED))
    .all();
  const pool =
    own.length > 0
      ? own
      : db
          .select({ fileId: stickerPalette.fileId })
          .from(stickerPalette)
          .where(NOT_DISABLED)
          .all();
  if (pool.length === 0) return null;
  return pool[Math.floor(Math.random() * pool.length)].fileId;
}

// ═══════════════════════════════════════════════════════════════════════════
// Инкрементальная синхронизация установленных наборов стикеров
// ═══════════════════════════════════════════════════════════════════════════

const syncLog = createLogger("sticker-sync");

export interface SyncStats {
  added: number;
  removed: number;
  refreshed: number;
}

/**
 * Инкрементальная синхронизация установленных наборов стикеров в палитру (идемпотентно, безопасно запускать в любой момент).
 *
 * Логика:
 * 1. Получаем список установленных наборов стикеров (Telegram API)
 * 2. Для каждого набора: получаем детали → для каждого стикера:
 *    - fileUniqueId уже существует → обновляем fileId (Telegram может его обновить)
 *    - fileUniqueId не существует → вставляем грубый тег (emoji→dimension)
 * 3. Очистка устаревших стикеров: строки в палитре, где setName отсутствует в списке установленных → DELETE
 *    (исключая стикеры VLM с setName IS NULL — они не из установленных наборов)
 *
 * @returns SyncStats — статистика синхронизации
 */
export async function syncInstalledSets(client: TelegramClient, db: Db): Promise<SyncStats> {
  let added = 0;
  let removed = 0;
  let refreshed = 0;

  const sets = await client.getInstalledStickers();
  const maxSets = 10;
  const maxStickersPerSet = 20;
  const installedSetNames = new Set<string>();

  for (const set of sets.slice(0, maxSets)) {
    installedSetNames.add(set.shortName);
    try {
      const fullSet = await client.getStickerSet(set.shortName);
      if (!fullSet.isFull) continue;

      for (const doc of fullSet.stickers.slice(0, maxStickersPerSet)) {
        const emoji = doc.alt ?? "";
        if (!emoji) continue;

        const fileId = doc.sticker.fileId;
        const fileUniqueId = doc.sticker.uniqueFileId;

        // Обратное сопоставление emoji → dimension
        const emotion = EMOJI_TO_EMOTION[emoji] ?? "neutral";
        const action = EMOJI_TO_ACTION[emoji] ?? "none";
        const label = `${emoji} sticker`;

        try {
          // Новый стикер: вставляем грубый тег (не перезаписываем существующие точные теги VLM)
          const { changes } = db
            .insert(stickerPalette)
            .values({
              label,
              fileId,
              fileUniqueId,
              emoji,
              setName: set.shortName,
              emotion,
              action,
              intensity: "medium",
            })
            .onConflictDoNothing()
            .run();
          if (changes > 0) {
            added++;
          } else {
            // Уже существует → обновляем fileId (Telegram мог его изменить)
            const { changes: updateChanges } = db
              .update(stickerPalette)
              .set({ fileId })
              .where(
                and(
                  eq(stickerPalette.fileUniqueId, fileUniqueId),
                  sql`${stickerPalette.fileId} != ${fileId}`,
                ),
              )
              .run();
            if (updateChanges > 0) refreshed++;
          }
        } catch {
          // Ошибка одной записи не блокирует общий процесс
        }
      }
    } catch (e) {
      syncLog.warn("Failed to fetch sticker set", {
        setName: set.shortName,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  // Очистка устаревших стикеров: строки, где setName не входит в список установленных.
  // Защищаем: VLM-стикеры (setName IS NULL) И курируемые паки (curated = 1) — последние
  // могут быть НЕ установлены в аккаунте Алисы, но проиндексированы вручную (batch-VLM).
  try {
    if (installedSetNames.size === 0) {
      // Нет установленных наборов стикеров → удаляем записи наборов, КРОМЕ курируемых
      const { changes } = db
        .delete(stickerPalette)
        .where(and(isNotNull(stickerPalette.setName), eq(stickerPalette.curated, 0)))
        .run();
      removed = changes;
    } else {
      const { changes } = db
        .delete(stickerPalette)
        .where(
          and(
            isNotNull(stickerPalette.setName),
            eq(stickerPalette.curated, 0),
            notInArray(stickerPalette.setName, [...installedSetNames]),
          ),
        )
        .run();
      removed = changes;
    }
  } catch (e) {
    syncLog.warn("Stale sticker cleanup failed", {
      error: e instanceof Error ? e.message : String(e),
    });
  }

  syncLog.info("Sync complete", { added, removed, refreshed });
  return { added, removed, refreshed };
}

// ═══════════════════════════════════════════════════════════════════════════
// Batch-индексация целого пака через VLM (curate, explicit-ask, фоновая задача)
// ═══════════════════════════════════════════════════════════════════════════

const indexLog = createLogger("sticker-indexer");

/**
 * Белый список растровых типов миниатюр (зеркалит RASTER_THUMB_TYPES в engine/act/messages.ts).
 * s/m/x/y/w/a/b/c/d = растровый JPEG; j = SVG outline, i = stripped, f/u/v = video.
 */
const RASTER_THUMB_TYPES = new Set(["s", "m", "x", "y", "w", "a", "b", "c", "d"]);

/** Жёсткий потолок размера пака — защита от патологически больших наборов. */
const MAX_STICKERS_PER_PACK = 200;
/**
 * Параллелизм VLM-вызовов внутри батча. Снижен 4 → 2: первый прогон пака ~120 стикеров дал
 * 25 vision-таймаутов («operation aborted due to timeout») — единственный vision-прокси не
 * вытягивал высокую конкуренцию. Кап 2 in-flight держит нагрузку в пределах прокси.
 */
const INDEX_CONCURRENCY = 2;
/** Сколько ДОПОЛНИТЕЛЬНЫХ попыток на стикер при таймауте/сбое VLM (всего 1 + RETRIES). */
const INDEX_RETRIES = 2;
/** Базовая задержка backoff между повторами (мс); растёт линейно: 400, 800. */
const INDEX_RETRY_BASE_DELAY_MS = 400;

/** Признак «грубого» (bootstrap) тега вида "<emoji> sticker" — такой не считаем богатым. */
function isCrudeLabel(label: string | null | undefined): boolean {
  if (!label) return true;
  return /\bsticker$/i.test(label.trim());
}

export interface BatchIndexStats {
  tagged: number;
  skipped: number;
  failed: number;
  total: number;
  /** Сколько успешных тегов потребовали хотя бы одного повтора (диагностика устойчивости). */
  retried: number;
}

export interface BatchIndexOpts {
  /** Переиндексировать даже уже богато размеченные стикеры этого пака. */
  force?: boolean;
  /** Конфиг эмбеддингов — при включённом прогреваем вектор описания (fire-and-forget). */
  embeddingConfig?: EmbeddingConfig;
}

/**
 * Индексирует ВЕСЬ пак стикеров через VLM, помечая строки как curated (защищены от очистки).
 *
 * Отличия от оппортунистического пути (engine/act/messages.ts):
 *  - нет лимита 20/пак (индексируем весь пак, потолок MAX_STICKERS_PER_PACK от патологий);
 *  - индексируем И текстовые стикеры (это явная курация, не фоновое восприятие);
 *  - пишет setName=shortName, curated=true → строка переживает syncInstalledSets cleanup.
 *
 * Извлечение кадра ТОЧНО как в messages.ts: для non-static — растровая миниатюра,
 * для static — полное медиа; size-gate 1024..512000; пропуск анимированных/SVG буферов.
 *
 * Идемпотентность: уже богато размеченный стикер ЭТОГО пака пропускается, если !force.
 * Ошибка одного стикера не прерывает батч.
 */
export async function batchIndexStickerSet(
  client: TelegramClient,
  db: Db,
  visionConfig: Config,
  shortName: string,
  opts: BatchIndexOpts = {},
): Promise<BatchIndexStats> {
  const force = opts.force ?? false;
  const embeddingConfig = opts.embeddingConfig;

  if (!isVisionEnabled(visionConfig)) {
    indexLog.warn("Batch index skipped: vision disabled", { shortName });
    return { tagged: 0, skipped: 0, failed: 0, total: 0, retried: 0 };
  }

  const set = await client.getStickerSet(shortName);
  const allDocs = set.stickers ?? [];
  let docs = allDocs;
  if (allDocs.length > MAX_STICKERS_PER_PACK) {
    docs = allDocs.slice(0, MAX_STICKERS_PER_PACK);
    indexLog.warn("Pack truncated to hard ceiling", {
      shortName,
      total: allDocs.length,
      cap: MAX_STICKERS_PER_PACK,
    });
  }

  const total = docs.length;
  let tagged = 0;
  let skipped = 0;
  let failed = 0;
  let retried = 0;

  indexLog.info("Batch index started", { shortName, total, force, concurrency: INDEX_CONCURRENCY });

  // Существующие богатые теги ЭТОГО пака (для идемпотентного пропуска при !force).
  const existingRich = new Set<string>();
  if (!force) {
    const rows = db
      .select({ fileUniqueId: stickerPalette.fileUniqueId, label: stickerPalette.label })
      .from(stickerPalette)
      .where(eq(stickerPalette.setName, shortName))
      .all();
    for (const r of rows) {
      if (!isCrudeLabel(r.label)) existingRich.add(r.fileUniqueId);
    }
  }

  /** Сентинел повторяемого сбоя VLM (таймаут или пустой анализ): различается от структурного skip. */
  class VisionAttemptError extends Error {}

  // ОДНА попытка обработки стикера: download → frame → VLM → upsert(curated).
  // Возвращает терминальный исход ("tagged"/"skipped"); БРОСАЕТ VisionAttemptError на повторяемом
  // сбое (таймаут vision / пустой анализ) — чтобы обёртка-ретрай его перехватила.
  async function attemptOne(doc: (typeof docs)[number]): Promise<"tagged" | "skipped"> {
    const media = doc.sticker as Sticker;
    const fileId = media.fileId;
    const fileUniqueId = media.uniqueFileId;
    const emoji = doc.alt || undefined;

    if (!fileUniqueId || !fileId) return "skipped";
    if (!force && existingRich.has(fileUniqueId)) return "skipped";

    // Извлечение кадра — ТОЧНО как в messages.ts.
    // Для НЕ-статичных стикеров запоминаем fileId выбранной растровой миниатюры — тот же кадр,
    // что идёт в VLM, переиспользуем как превью для дашборда (браузер не рисует .tgs/.webm).
    let buffer: Buffer;
    let thumbFileId: string | undefined;
    if (media.sourceType !== "static") {
      const thumb = media.thumbnails?.find(
        (t) => t.width > 0 && !Number.isNaN(t.width) && RASTER_THUMB_TYPES.has(t.type),
      );
      if (!thumb) return "skipped";
      thumbFileId = thumb.fileId;
      buffer = Buffer.from(await client.downloadAsBuffer(thumb));
    } else {
      buffer = Buffer.from(
        await client.downloadAsBuffer(media as Parameters<typeof client.downloadAsBuffer>[0]),
      );
    }
    if (buffer.byteLength > 512_000 || buffer.byteLength < 1024) return "skipped";
    // Анимированный/SVG head-byte → не растр, пропускаем (как в messages.ts).
    const head4 = buffer.subarray(0, 4);
    if (head4[0] === 0x3c && (head4[1] === 0x3f || head4[1] === 0x73)) return "skipped";

    const base64 = buffer.toString("base64");
    const caption = await describeMedia(base64, fileUniqueId, "sticker", visionConfig);
    const analysis = getStickerAnalysis(fileUniqueId);
    // В ОТЛИЧИЕ от оппортунистического пути — текстовые стикеры тоже индексируем (явная курация).
    // Пустой анализ/caption трактуем как ПОВТОРЯЕМЫЙ сбой VLM (часто это тихий таймаут прокси).
    if (!analysis || !caption) {
      throw new VisionAttemptError("empty VLM analysis/caption");
    }

    upsertFromVLM(db, {
      fileUniqueId,
      fileId,
      label: analysis.description,
      emoji,
      setName: shortName,
      curated: true,
      // Статичные стикеры → thumbFileId undefined (их основной файл уже растр).
      thumbFileId,
      emotion: analysis.emotion,
      action: analysis.action,
      intensity: analysis.intensity,
    });

    // Прогрев эмбеддинга описания (no-op при выключенных эмбеддингах).
    if (embeddingConfig) {
      warmEmbeddingOnIngest(analysis.description, embeddingConfig, Date.now());
    }
    return "tagged";
  }

  // Обёртка с повторами и нарастающим backoff: на vision-таймаут/сбой — до INDEX_RETRIES доп.
  // попыток (всего 1 + INDEX_RETRIES) с задержкой 400/800 мс. Структурный skip НЕ повторяется.
  // didRetry=true, если успех потребовал хотя бы одной повторной попытки.
  async function indexOne(
    doc: (typeof docs)[number],
  ): Promise<{ outcome: "tagged" | "skipped" | "failed"; didRetry: boolean }> {
    const fileUniqueId = (doc.sticker as Sticker).uniqueFileId;
    let lastErr: unknown;
    for (let attempt = 0; attempt <= INDEX_RETRIES; attempt++) {
      try {
        const outcome = await attemptOne(doc);
        return { outcome, didRetry: attempt > 0 };
      } catch (e) {
        lastErr = e;
        if (attempt < INDEX_RETRIES) {
          const delay = INDEX_RETRY_BASE_DELAY_MS * (attempt + 1);
          indexLog.debug("Sticker index attempt failed, retrying", {
            shortName,
            fileUniqueId,
            attempt: attempt + 1,
            delayMs: delay,
            error: e instanceof Error ? e.message : String(e),
          });
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }
    indexLog.debug("Sticker index failed after retries (continuing)", {
      shortName,
      fileUniqueId,
      attempts: INDEX_RETRIES + 1,
      error: lastErr instanceof Error ? lastErr.message : String(lastErr),
    });
    return { outcome: "failed", didRetry: true };
  }

  // Ограниченный параллелизм: «рабочие» тянут из общей очереди индексов.
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < docs.length) {
      const i = cursor++;
      const { outcome: r, didRetry } = await indexOne(docs[i]);
      if (r === "tagged" && didRetry) retried++;
      if (r === "tagged") tagged++;
      else if (r === "skipped") skipped++;
      else failed++;
      if ((tagged + skipped + failed) % 25 === 0) {
        indexLog.info("Batch index progress", {
          shortName,
          done: tagged + skipped + failed,
          total,
        });
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(INDEX_CONCURRENCY, docs.length) }, () => worker()),
  );

  indexLog.info("Batch index complete", { shortName, tagged, skipped, failed, retried, total });
  return { tagged, skipped, failed, total, retried };
}

// ═══════════════════════════════════════════════════════════════════════════
// Sticker Admin: read-only обзор палитры + toggle disabled для дашборда
// ═══════════════════════════════════════════════════════════════════════════

/** Сентинел для запроса группы стикеров без набора (set_name IS NULL) через query-параметр. */
export const NULL_SET_SENTINEL = "__null__";

/** Сводка одного пака стикеров для списка дашборда. */
export interface StickerPackSummary {
  /** Короткое имя набора; null = пул VLM-найденных стикеров (set_name IS NULL). */
  setName: string | null;
  /** Человекочитаемая метка пака (setName либо подпись для NULL-группы). */
  label: string;
  /** Всего стикеров в паке. */
  count: number;
  /** Сколько из них включено (disabled = 0). */
  enabledCount: number;
  /** true, если хотя бы один стикер пака курируемый (batch-VLM). */
  curated: boolean;
}

/** Одна строка стикера внутри пака (для грида дашборда). */
export interface StickerAdminRow {
  id: number;
  fileUniqueId: string;
  label: string;
  emoji: string | null;
  emotion: string | null;
  action: string | null;
  intensity: string | null;
  disabled: boolean;
  /** Помечен ли стикер значимым (signature=1) владельцем. */
  signature: boolean;
  /** Заметка о смысле значимого стикера (null, если не задана). */
  meaning: string | null;
}

/**
 * Группирует палитру по set_name → сводки паков для списка дашборда.
 * NULL-группа (стикеры, найденные VLM в чатах) выводится с подписью label.
 * Сортировка: курируемые/собственные (есть setName) выше, NULL-пул в конце.
 */
export function listStickerPacks(db: Db, nullGroupLabel = "(найденные в чатах)"): StickerPackSummary[] {
  const rows = db
    .select({
      setName: stickerPalette.setName,
      disabled: stickerPalette.disabled,
      curated: stickerPalette.curated,
    })
    .from(stickerPalette)
    .all();

  const groups = new Map<string | null, { count: number; enabled: number; curated: boolean }>();
  for (const r of rows) {
    const key = r.setName ?? null;
    const g = groups.get(key) ?? { count: 0, enabled: 0, curated: false };
    g.count += 1;
    if (r.disabled === 0) g.enabled += 1;
    if (r.curated === 1) g.curated = true;
    groups.set(key, g);
  }

  const out: StickerPackSummary[] = [];
  for (const [setName, g] of groups) {
    out.push({
      setName,
      label: setName ?? nullGroupLabel,
      count: g.count,
      enabledCount: g.enabled,
      curated: g.curated,
    });
  }

  // Собственные/курируемые паки выше, NULL-пул (setName=null) в конце; внутри — по имени.
  out.sort((a, b) => {
    if (a.setName === null && b.setName !== null) return 1;
    if (a.setName !== null && b.setName === null) return -1;
    if (a.curated !== b.curated) return a.curated ? -1 : 1;
    return (a.label || "").localeCompare(b.label || "");
  });
  return out;
}

/**
 * Возвращает все стикеры одного пака для грида дашборда.
 * setName === null → группа без набора (set_name IS NULL). Показываются и отключённые
 * (admin видит всё; флаг disabled управляет toggle), сортировка по id для стабильности.
 */
export function getStickerPack(db: Db, setName: string | null): StickerAdminRow[] {
  const where =
    setName === null
      ? sql`${stickerPalette.setName} IS NULL`
      : eq(stickerPalette.setName, setName);
  const rows = db
    .select({
      id: stickerPalette.id,
      fileUniqueId: stickerPalette.fileUniqueId,
      label: stickerPalette.label,
      emoji: stickerPalette.emoji,
      emotion: stickerPalette.emotion,
      action: stickerPalette.action,
      intensity: stickerPalette.intensity,
      disabled: stickerPalette.disabled,
      signature: stickerPalette.signature,
      meaning: stickerPalette.meaning,
    })
    .from(stickerPalette)
    .where(where)
    .orderBy(stickerPalette.id)
    .all();
  return rows.map((r) => ({
    id: r.id,
    fileUniqueId: r.fileUniqueId,
    label: r.label,
    emoji: r.emoji ?? null,
    emotion: r.emotion ?? null,
    action: r.action ?? null,
    intensity: r.intensity ?? null,
    disabled: r.disabled === 1,
    signature: r.signature === 1,
    meaning: r.meaning ?? null,
  }));
}

/**
 * Переключает флаг disabled одного стикера (toggle из дашборда).
 * Пишет прямо в БД, которую Алиса читает вживую → эффект без перезапуска.
 * @returns true, если строка найдена и обновлена.
 */
export function setStickerDisabled(db: Db, id: number, disabled: boolean): boolean {
  const { changes } = db
    .update(stickerPalette)
    .set({ disabled: disabled ? 1 : 0 })
    .where(eq(stickerPalette.id, id))
    .run();
  return changes > 0;
}

/**
 * Помечает/снимает «значимость» стикера (signature) + заметку о смысле (toggle из дашборда).
 * Пишет прямо в БД, которую Алиса читает вживую → эффект без перезапуска.
 *
 * При signature=false meaning принудительно сбрасывается в null (снятая значимость не должна
 * оставлять висячий смысл — это синхронизирует и self-факт, который очищается вызывающей стороной).
 * @returns строку после обновления (id/signature/meaning) или null, если строки нет.
 */
export function setStickerSignature(
  db: Db,
  id: number,
  signature: boolean,
  meaning?: string | null,
): { id: number; signature: boolean; meaning: string | null } | null {
  const trimmed = typeof meaning === "string" ? meaning.trim() : null;
  const nextMeaning = signature ? (trimmed && trimmed.length > 0 ? trimmed : null) : null;
  const { changes } = db
    .update(stickerPalette)
    .set({ signature: signature ? 1 : 0, meaning: nextMeaning })
    .where(eq(stickerPalette.id, id))
    .run();
  if (changes === 0) return null;
  return { id, signature, meaning: nextMeaning };
}

/**
 * Полностью УДАЛЯЕТ строку палитры по id (кнопка «удалить» в дашборде).
 *
 * Отличие от setStickerDisabled: disabled оставляет стикер в палитре (можно вернуть),
 * delete стирает его насовсем — после удаления ни один путь подбора его не вернёт.
 * Пишет прямо в БД, которую Алиса читает вживую → эффект без перезапуска.
 * @returns true, если строка найдена и удалена.
 */
export function deleteSticker(db: Db, id: number): boolean {
  const { changes } = db.delete(stickerPalette).where(eq(stickerPalette.id, id)).run();
  return changes > 0;
}

/**
 * Ищет file_id стикера по числовому id или по file_unique_id (для отдачи превью).
 * thumbFileId — растровая миниатюра анимированного стикера (null для статичных); маршрут
 * sticker-image использует её, чтобы отдать превью-кадр там, где основной файл не растр.
 */
export function lookupStickerFileId(
  db: Db,
  ref: { id?: number; fileUniqueId?: string },
): { fileId: string; fileUniqueId: string; thumbFileId: string | null } | null {
  let row: { fileId: string; fileUniqueId: string; thumbFileId: string | null } | undefined;
  const cols = {
    fileId: stickerPalette.fileId,
    fileUniqueId: stickerPalette.fileUniqueId,
    thumbFileId: stickerPalette.thumbFileId,
  };
  if (ref.id != null && Number.isFinite(ref.id)) {
    row = db.select(cols).from(stickerPalette).where(eq(stickerPalette.id, ref.id)).limit(1).get();
  } else if (ref.fileUniqueId) {
    row = db
      .select(cols)
      .from(stickerPalette)
      .where(eq(stickerPalette.fileUniqueId, ref.fileUniqueId))
      .limit(1)
      .get();
  }
  return row ? { ...row, thumbFileId: row.thumbFileId ?? null } : null;
}
