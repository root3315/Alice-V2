/**
 * Eval 结果缓存 — 顺序测试的 skip-on-pass 支持。
 *
 * 缓存文件 `.eval-cache.json` 记录每个场景的最近结果。
 * 默认行为：已 pass 的场景跳过，只重跑 fail/未测试的。
 * `--full` 忽略缓存全量重跑。`--reset` 清除缓存。
 *
 * 缓存粒度为 scenario ID 级别。每个场景完成后立即写入，
 * 中断的运行不会丢失已完成场景的进度。
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createLogger } from "../utils/logger.js";

const log = createLogger("eval:cache");

/** 缓存文件默认路径（runtime 工作目录下）。 */
const DEFAULT_CACHE_PATH = ".eval-cache.json";

/** 单个场景的缓存条目。 */
export interface EvalCacheEntry {
  /** 是否通过。 */
  pass: boolean;
  /** 记录时间 ISO 字符串。 */
  timestamp: string;
  /** 运行时使用的模型。 */
  model?: string;
  /** 通过率（多 run 时有意义）。 */
  passRate?: number;
}

/** 缓存文件的完整结构。 */
export interface EvalCache {
  [scenarioId: string]: EvalCacheEntry;
}

/** 加载缓存。文件不存在或格式错误返回空对象。 */
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

/** 保存缓存（原子写入：先写临时文件再 rename 不值得，eval 不是高频写入）。 */
export function saveCache(cache: EvalCache, path = DEFAULT_CACHE_PATH): void {
  writeFileSync(path, JSON.stringify(cache, null, 2), "utf-8");
}

/** 清除缓存文件。 */
export function resetCache(path = DEFAULT_CACHE_PATH): void {
  if (existsSync(path)) {
    writeFileSync(path, "{}", "utf-8");
    log.info("Cache reset");
  }
}

/** 查询场景是否已缓存为 pass。 */
export function isCachedPass(cache: EvalCache, scenarioId: string): boolean {
  const entry = cache[scenarioId];
  return !!entry?.pass;
}

/** 缓存统计摘要。 */
export function cacheSummary(cache: EvalCache): { total: number; passed: number; failed: number } {
  let passed = 0;
  let failed = 0;
  for (const entry of Object.values(cache)) {
    if (entry.pass) passed++;
    else failed++;
  }
  return { total: passed + failed, passed, failed };
}
