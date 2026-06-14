/**
 * Кэш результатов eval — поддержка skip-on-pass при последовательном тестировании.
 *
 * Файл кэша `.eval-cache.json` хранит последний результат для каждого сценария.
 * Поведение по умолчанию: сценарии с pass пропускаются, перезапускаются только fail/непроверенные.
 * `--full` игнорирует кэш и перезапускает всё. `--reset` очищает кэш.
 *
 * Гранулярность кэша — уровень scenario ID. Запись происходит сразу после завершения каждого сценария,
 * поэтому прерванный прогон не теряет прогресс по завершённым сценариям.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createLogger } from "../utils/logger.js";

const log = createLogger("eval:cache");

/** Путь по умолчанию к файлу кэша (в рабочей директории runtime). */
const DEFAULT_CACHE_PATH = ".eval-cache.json";

/** Запись кэша для одного сценария. */
export interface EvalCacheEntry {
  /** Пройден ли сценарий. */
  pass: boolean;
  /** Время записи в формате ISO-строки. */
  timestamp: string;
  /** Модель, использованная при запуске. */
  model?: string;
  /** Процент прохождений (значимо при нескольких прогонах). */
  passRate?: number;
}

/** Полная структура файла кэша. */
export interface EvalCache {
  [scenarioId: string]: EvalCacheEntry;
}

/** Загружает кэш. Возвращает пустой объект, если файл не существует или повреждён. */
export function loadCache(path = DEFAULT_CACHE_PATH): EvalCache {
  if (!existsSync(path)) return {};
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    return parsed as EvalCache;
  } catch {
    log.warn("Cache file corrupt, starting fresh");
    return {};
  }
}

/** Сохраняет кэш (атомарная запись через временный файл и rename не нужна — eval не пишет часто). */
export function saveCache(cache: EvalCache, path = DEFAULT_CACHE_PATH): void {
  writeFileSync(path, JSON.stringify(cache, null, 2), "utf-8");
}

/** Очищает файл кэша. */
export function resetCache(path = DEFAULT_CACHE_PATH): void {
  if (existsSync(path)) {
    writeFileSync(path, "{}", "utf-8");
    log.info("Cache reset");
  }
}

/** Проверяет, закэширован ли сценарий как pass. */
export function isCachedPass(cache: EvalCache, scenarioId: string): boolean {
  const entry = cache[scenarioId];
  return !!entry?.pass;
}

/** Сводная статистика по кэшу. */
export function cacheSummary(cache: EvalCache): { total: number; passed: number; failed: number } {
  let passed = 0;
  let failed = 0;
  for (const entry of Object.values(cache)) {
    if (entry.pass) passed++;
    else failed++;
  }
  return { total: passed + failed, passed, failed };
}
