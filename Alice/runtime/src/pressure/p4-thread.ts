/**
 * P4 线程发散 (Thread Divergence) — Thread 驱动。
 * 对应 Python pressure.py P4_thread_divergence()。
 *
 * ADR-64 VI-1: age^β 替换为 log(1 + age/τ)，防止长线程数值爆炸。
 *
 * P4(n) = Σ_t log(1 + age(t)/τ) · w(t) · decayFactor(t)
 *
 * 审计修复: 移除 forecast 分量（remaining^(-δ)）。
 * P_prospect（p-prospect.ts）已独立处理 deadline 驱动的前瞻性压力，
 * P4 的 forecast 与 P_prospect 对同一 deadline 双重计费，导致临近
 * deadline 时 API 被过度放大（两个维度同时飙升）。
 * P4 现在只度量线程年龄增长（backtrack），deadline 紧迫感完全由 P_prospect 负责。
 *
 * dt 迁移：age 改用墙钟秒，threadAgeScale 单位从 ticks→seconds。
 */
import type { WorldModel } from "../graph/world-model.js";
import { elapsedS, readNodeMs } from "./clock.js";
import type { PressureResult } from "./p1-attention.js";

export function p4ThreadDivergence(
  G: WorldModel,
  _n: number,
  nowMs: number,
  threadAgeScale: number = 86_400,
): PressureResult {
  const contributions: Record<string, number> = {};

  for (const tid of G.getEntitiesByType("thread")) {
    const attrs = G.getThread(tid);
    if (attrs.status !== "open") continue;

    // ADR-166: 使用 readNodeMs（精确），缺失时跳过该线程（Unknown ≠ Old）
    const createdMs = readNodeMs(G, tid, "created_ms");
    if (createdMs <= 0) continue;

    const w = attrs.w;
    const ageS = Math.max(elapsedS(nowMs, createdMs), 1.0);

    // ADR-195: 超过 maxAgeS 的线程贡献指数衰减，防止 zombie 线程永久饱和 P4
    const maxAgeS = threadAgeScale * 7; // 7 天（threadAgeScale=86400 时 = 604800s）
    const decayFactor = ageS > maxAgeS ? Math.exp(-(ageS - maxAgeS) / maxAgeS) : 1.0;

    // ADR-64 VI-1: 对数增长替代幂增长（threadAgeScale 现为秒：86400s = 1 天）
    contributions[tid] = Math.log(1 + ageS / threadAgeScale) * w * decayFactor;
  }

  const total = Object.values(contributions).reduce((a, b) => a + b, 0);
  return { total, contributions };
}
