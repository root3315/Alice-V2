/**
 * Локальный модуль OCR — PaddleOCR PP-OCRv4 через @gutenye/ocr-node.
 *
 * Работает как **дополнительный слой** поверх VLM (не fallback): VLM даёт описание на естественном языке,
 * OCR точно извлекает текст из изображения. Они взаимодополняют друг друга — VLM силён в сцене/эмоции/композиции,
 * OCR — в точном воспроизведении текста из скриншотов/мемов.
 *
 * @see docs/adr/88-multimodal-proactive-behavior.md
 */

import { randomBytes } from "node:crypto";
import { unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../config.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("ocr");

// ═══════════════════════════════════════════════════════════════════════════
// Типы (зеркало из @gutenye/ocr-common, чтобы избежать deep import)
// ═══════════════════════════════════════════════════════════════════════════

/** Строка результата OCR-детекции. Совместима с типом Line из @gutenye/ocr-common. */
export interface OcrLine {
  text: string;
  /** Среднее значение уверенности (0–1). */
  mean: number;
  /** Четырёхточечный ограничивающий прямоугольник [[x,y], [x,y], [x,y], [x,y]]. */
  box?: number[][];
}

/** Интерфейс экземпляра Ocr из @gutenye/ocr-node (duck typing, без привязки к пути импорта).
 * Замечание: detect() в @gutenye/ocr-node@1.4.8 принимает только путь к файлу, не ImageRawData.
 * Внутри: Detection.run() → ImageRaw.open(path) → sharp(path) — необходимо передавать строковый путь. */
interface OcrEngine {
  detect(imagePath: string): Promise<OcrLine[]>;
}

// ═══════════════════════════════════════════════════════════════════════════
// Ленивый синглтон — Ocr.create() холодный старт 1–3 с, инициализируется только при первом вызове
// ═══════════════════════════════════════════════════════════════════════════

let _initPromise: Promise<OcrEngine> | null = null;

/**
 * Получить или инициализировать синглтон OCR-движка.
 * Конкурентные вызовы разделяют один и тот же Promise, повторная инициализация исключена.
 */
async function getEngine(): Promise<OcrEngine> {
  if (!_initPromise) {
    _initPromise = (async () => {
      const { default: Ocr } = await import("@gutenye/ocr-node");
      const engine = (await Ocr.create()) as OcrEngine;
      log.info("OCR engine initialized");
      return engine;
    })();
  }
  return _initPromise;
}

// ═══════════════════════════════════════════════════════════════════════════
// Утилиты
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Обёртка Promise с таймаутом.
 *
 * try/finally гарантирует очистку таймера при любом исходе (успех/ошибка),
 * устраняя утечку таймера при голом setTimeout в Promise.race.
 * timer.unref() не даёт таймеру блокировать корректное завершение процесса.
 *
 * @see .claude/sessions/ocr-research.md §Q4
 */
async function withTimeout<T>(promise: Promise<T>, ms: number, msg: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(msg)), ms);
    timer.unref();
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Публичный API
// ═══════════════════════════════════════════════════════════════════════════

/** Включён ли OCR. */
export function isOcrEnabled(config: Config): boolean {
  return config.ocrEnabled;
}

/** Таймаут одного OCR-инференса (мс). Нормальный инференс 100–500 мс, 5 с — достаточный запас. */
const OCR_TIMEOUT_MS = 5_000;

/** Лимит размера Buffer (байты). Слишком большие изображения пропускаются, чтобы избежать переполнения памяти ONNX. */
const MAX_BUFFER_SIZE = 5 * 1024 * 1024; // 5 MB

/** Максимальное количество символов, извлекаемых OCR. Предотвращает разбухание контекста. */
const MAX_TEXT_LENGTH = 500;

/**
 * Фильтрация, сортировка и конкатенация читаемого текста из сырых строк OCR.
 *
 * Чистая функция без побочных эффектов — удобна для юнит-тестов.
 *
 * 1. Фильтр по уверенности: строки ниже minConfidence отбрасываются
 * 2. Сортировка по порядку чтения: сверху→вниз, внутри строки слева→вправо
 * 3. Конкатенация + обрезка: разделитель пробел, при превышении MAX_TEXT_LENGTH обрезается с многоточием
 */
export function processOcrLines(lines: OcrLine[], minConfidence: number): string | undefined {
  if (!lines || lines.length === 0) return undefined;

  const filtered = lines.filter((line) => line.mean >= minConfidence);
  if (filtered.length === 0) return undefined;

  // Сортировка по порядку чтения: по top (сверху→вниз), внутри строки по left (слева→вправо)
  filtered.sort((a, b) => {
    const aTop = minY(a.box);
    const bTop = minY(b.box);
    // Определение одной строки: разница top < половины высоты строки (грубая эвристика)
    const rowThreshold = 15;
    if (Math.abs(aTop - bTop) < rowThreshold) {
      return minX(a.box) - minX(b.box);
    }
    return aTop - bTop;
  });

  const joined = filtered
    .map((l) => l.text.trim())
    .filter(Boolean)
    .join(" ");
  if (!joined) return undefined;
  return joined.length > MAX_TEXT_LENGTH ? `${joined.slice(0, MAX_TEXT_LENGTH)}…` : joined;
}

/**
 * Извлечь текст из Buffer изображения.
 *
 * Поток: Buffer → временный файл → ocr.detect(path) → processOcrLines → удаление временного файла.
 * detect() в @gutenye/ocr-node@1.4.8 принимает только путь к файлу (внутри ImageRaw.open(path)
 * вызывает sharp для декодирования), поэтому используется мост через временный файл.
 *
 * @param imageBuffer сырой Buffer изображения (JPEG/PNG/WebP и другие форматы, поддерживаемые sharp)
 * @param config глобальная конфигурация (ocrMinConfidence)
 * @returns извлечённый текст или undefined (отключено/текста нет/ошибка)
 */
export async function extractText(
  imageBuffer: Buffer,
  config: Config,
): Promise<string | undefined> {
  if (!config.ocrEnabled) return undefined;

  // Защита: пустой/слишком большой buffer
  if (imageBuffer.byteLength === 0 || imageBuffer.byteLength > MAX_BUFFER_SIZE) {
    return undefined;
  }

  const tmpPath = join(tmpdir(), `alice-ocr-${randomBytes(8).toString("hex")}.tmp`);
  try {
    writeFileSync(tmpPath, imageBuffer);

    const engine = await getEngine();
    const lines = await withTimeout(engine.detect(tmpPath), OCR_TIMEOUT_MS, "OCR timeout");

    const result = processOcrLines(lines, config.ocrMinConfidence);
    if (result) {
      log.info("OCR extracted", {
        lines: lines.filter((l) => l.mean >= config.ocrMinConfidence).length,
        totalChars: result.length,
        preview: result.slice(0, 60),
      });
    }
    return result;
  } catch (e) {
    log.warn("OCR failed", { error: e instanceof Error ? e.message : String(e) });
    return undefined;
  } finally {
    try {
      unlinkSync(tmpPath);
    } catch {
      /* Ошибка очистки не влияет на основной поток */
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Внутренние утилиты
// ═══════════════════════════════════════════════════════════════════════════

/** Минимальное Y из четырёх точек box (top). Возвращает 0, если box отсутствует. */
function minY(box: number[][] | undefined): number {
  if (!box || box.length === 0) return 0;
  return Math.min(...box.map((p) => p[1]));
}

/** Минимальное X из четырёх точек box (left). Возвращает 0, если box отсутствует. */
function minX(box: number[][] | undefined): number {
  if (!box || box.length === 0) return 0;
  return Math.min(...box.map((p) => p[0]));
}
