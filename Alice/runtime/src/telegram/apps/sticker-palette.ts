/**
 * Sticker Palette — слой запросов: семантический тег → fileId.
 *
 * Phase 1: ручной INSERT или поддержка через скрипт администратора.
 * Phase 2: автоматическая индексация VLM (побочный продукт describeMedia("sticker") → upsertFromVLM)
 *         + отслеживание частоты использования + взвешенная выборка + запасной подбор по измерениям.
 *
 * @see https://github.com/TelechaBot/anime-identify — классификация аниме-изображений
 */
import type { TelegramClient } from "@mtcute/node";
import { and, eq, isNotNull, notInArray, sql } from "drizzle-orm";
import { z } from "zod";

import type { getDb } from "../../db/connection.js";
import { stickerPalette } from "../../db/schema.js";
import { createLogger } from "../../utils/logger.js";

/** Тип экземпляра Drizzle DB (соответствует возвращаемому значению getDb()). */
type Db = ReturnType<typeof getDb>;

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
  db.insert(stickerPalette)
    .values({
      label: params.label,
      fileId: params.fileId,
      fileUniqueId: params.fileUniqueId,
      emoji: params.emoji,
      setName: params.setName,
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

  // Основной пул: собственные установленные наборы стикеров (приоритет)
  const own = db
    .select({ fileId: stickerPalette.fileId })
    .from(stickerPalette)
    .where(and(eq(col, value), isNotNull(stickerPalette.setName)))
    .all();
  if (own.length > 0) {
    return own[Math.floor(Math.random() * own.length)].fileId;
  }

  // Резервный пул: стикеры, найденные VLM (используется, если основной пул не дал совпадений)
  const fallback = db
    .select({ fileId: stickerPalette.fileId })
    .from(stickerPalette)
    .where(and(eq(col, value), sql`${stickerPalette.setName} IS NULL`))
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

  // 1. VLM dimension match — значения измерений являются стандартным словарём запросов LLM
  if (EMOTIONS.has(lower)) {
    const hit = pickByDimension(db, "emotion", lower, chatId);
    if (hit) return hit;
  }
  if (ACTIONS.has(lower)) {
    const hit = pickByDimension(db, "action", lower, chatId);
    if (hit) return hit;
  }

  // 2-3. Text-based matching (точный label → совпадение по подстроке) — установленные приоритетнее, VLM как запасной вариант
  const ownRows = db
    .select({ label: stickerPalette.label, fileId: stickerPalette.fileId })
    .from(stickerPalette)
    .where(isNotNull(stickerPalette.setName))
    .all();

  const ownExact = ownRows.find((r) => r.label === label);
  if (ownExact) return ownExact.fileId;
  const ownPartial = ownRows.find((r) => label.includes(r.label) || r.label.includes(label));
  if (ownPartial) return ownPartial.fileId;

  // Нет совпадений среди установленных → переход к резервному пулу VLM
  const vlmRows = db
    .select({ label: stickerPalette.label, fileId: stickerPalette.fileId })
    .from(stickerPalette)
    .where(sql`${stickerPalette.setName} IS NULL`)
    .all();

  const vlmExact = vlmRows.find((r) => r.label === label);
  if (vlmExact) return vlmExact.fileId;
  const vlmPartial = vlmRows.find((r) => label.includes(r.label) || r.label.includes(label));
  if (vlmPartial) return vlmPartial.fileId;

  return null;
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

  // Установленные приоритетнее, VLM как запасной вариант
  const own = db
    .select({ fileId: stickerPalette.fileId })
    .from(stickerPalette)
    .where(and(eq(stickerPalette.emoji, emoji), isNotNull(stickerPalette.setName)))
    .all();
  if (own.length > 0) {
    return own.length === 1 ? own[0].fileId : own[Math.floor(Math.random() * own.length)].fileId;
  }

  const candidates = db
    .select({ fileId: stickerPalette.fileId })
    .from(stickerPalette)
    .where(and(eq(stickerPalette.emoji, emoji), sql`${stickerPalette.setName} IS NULL`))
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
  const own = db
    .select({ fileId: stickerPalette.fileId })
    .from(stickerPalette)
    .where(isNotNull(stickerPalette.setName))
    .all();
  const pool =
    own.length > 0
      ? own
      : db.select({ fileId: stickerPalette.fileId }).from(stickerPalette).all();
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

  // Очистка устаревших стикеров: строки, где setName не входит в список установленных (защищаем VLM-стикеры: setName IS NULL)
  try {
    if (installedSetNames.size === 0) {
      // Нет установленных наборов стикеров → удаляем все записи, принадлежащие наборам
      const { changes } = db.delete(stickerPalette).where(isNotNull(stickerPalette.setName)).run();
      removed = changes;
    } else {
      const { changes } = db
        .delete(stickerPalette)
        .where(
          and(
            isNotNull(stickerPalette.setName),
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
