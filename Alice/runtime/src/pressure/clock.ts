/**
 * 墙钟时间辅助。
 *
 * ADR-166: Wall-Clock First — 墙钟毫秒是一切时间计算的 single source of truth。
 * Tick 序号只测量顺序，不测量持续时间。
 *
 * 两类消费者使用不同入口：
 * - **压力计算**: `readNodeMs()` → 返回 0 表示未知 → 调用者跳过（Unknown ≠ Old）
 * - **渲染/显示**: `estimateAgeS()` / `estimateEventMs()` → tick × 60s 近似兜底
 *
 * @see docs/adr/166-wallclock-purification.md
 */
import type { WorldModel } from "../graph/world-model.js";

// -- 常量 -------------------------------------------------------------------

/**
 * ADR-166: 旧制 tick 间隔估算值（ms）。
 * 仅用于无 _ms 属性的历史数据渲染。不参与压力计算。
 * @see docs/adr/166-wallclock-purification.md §4.4
 */
export const LEGACY_TICK_INTERVAL_MS = 60_000;

// -- 精确读取（压力计算用） --------------------------------------------------

/**
 * 从图节点读取墙钟毫秒时间戳。
 * 直接读 _ms 属性，缺失时返回 0（= 未知）。
 *
 * 压力计算应使用此函数。返回 0 时调用者应跳过该贡献——
 * 不知道时间 → 不断言压力（Unknown ≠ Old）。
 *
 * @see docs/adr/166-wallclock-purification.md §4.2
 */
export function readNodeMs(G: WorldModel, nodeId: string, msKey: string): number {
  if (G.has(nodeId)) {
    const ms = G.getDynamic(nodeId, msKey);
    if (typeof ms === "number" && ms > 0) return ms;
  }
  return 0;
}

// -- 近似估算（渲染/显示用） --------------------------------------------------

/**
 * 估算事件发生时的墙钟 ms。
 *
 * 优先级: ms > createdAt > tick × 60s 回退。返回 0 表示未知。
 *
 * 用于 Mod contribute 渲染——给 LLM 看的时间标签允许近似。
 * 压力计算不应使用此函数。
 *
 * @see docs/adr/166-wallclock-purification.md §4.4
 */
export function estimateEventMs(
  entry: { ms?: number | null; createdAt?: Date | null; tick?: number | null },
  nowMs: number,
  currentTick: number,
): number {
  if (typeof entry.ms === "number" && entry.ms > 0) return entry.ms;
  if (entry.createdAt instanceof Date) return entry.createdAt.getTime();
  if (typeof entry.tick === "number")
    return nowMs - (currentTick - entry.tick) * LEGACY_TICK_INTERVAL_MS;
  return 0;
}

/**
 * 估算事件距今的秒数。未知返回 0。
 *
 * 统一替代 6 个 Mod 文件中的 14 处内联 `(tick差) × 60` 模式。
 * 压力计算不应使用此函数。
 *
 * @see docs/adr/166-wallclock-purification.md §5 Wave 3
 */
export function estimateAgeS(
  entry: { ms?: number | null; createdAt?: Date | null; tick?: number | null },
  nowMs: number,
  currentTick: number,
): number {
  const eventMs = estimateEventMs(entry, nowMs, currentTick);
  return eventMs > 0 ? Math.max(0, (nowMs - eventMs) / 1000) : 0;
}

// -- 通用辅助 ----------------------------------------------------------------

/**
 * 计算自某事件以来的秒数。
 */
export function elapsedS(nowMs: number, eventMs: number): number {
  return Math.max(0, (nowMs - eventMs) / 1000);
}
