/**
 * P_prospect — 前瞻性压力（ADR-23 Wave 4）。
 *
 * Thread horizon 产生前瞻性压力，作为 API 的独立加法项。
 *
 * P_prospect = Σ_i w_i × σ(k × (1 - remaining_i / horizon_i))
 *   remaining = max(0, deadlineMs - nowMs)
 *   σ = sigmoid, 上界自然有限
 *
 * 无 horizon 线程 → P_prospect = 0（v4 退化）。
 */
import type { WorldModel } from "../graph/world-model.js";
import { standardSigmoid } from "../utils/math.js";
import { readNodeMs } from "./clock.js";
import type { PressureResult } from "./p1-attention.js";

/**
 * 计算 P_prospect。
 *
 * 从图中读取所有 open 状态的 Thread 实体（有 deadline 属性且有限），
 * 计算前瞻性压力。
 *
 * @param G 伴侣图
 * @param n 当前 tick
 * @param kSteepness sigmoid 陡度（默认 5.0）
 */
export function pProspect(
  G: WorldModel,
  _n: number,
  nowMs: number,
  kSteepness = 5.0,
): PressureResult {
  const contributions: Record<string, number> = {};

  for (const tid of G.getEntitiesByType("thread")) {
    const attrs = G.getThread(tid);
    if (attrs.status !== "open") continue;

    const deadline = attrs.deadline;
    if (!Number.isFinite(deadline)) continue;

    // ADR-166: 精确读取，缺失任一时间戳则跳过（Unknown ≠ Old）
    const createdMs = readNodeMs(G, tid, "created_ms");
    const deadlineMs = readNodeMs(G, tid, "deadline_ms");
    if (createdMs <= 0 || deadlineMs <= 0) continue;

    const horizonS = (deadlineMs - createdMs) / 1000;
    if (horizonS <= 0) continue;

    const remainingS = Math.max(0, (deadlineMs - nowMs) / 1000);
    const w = attrs.w;

    // σ(k × (1 - remaining / horizon)) — 接近 deadline 时趋近 1
    const progress = 1 - remainingS / horizonS;
    const pressure = w * standardSigmoid(kSteepness * progress);
    contributions[tid] = pressure;
  }

  const total = Object.values(contributions).reduce((a, b) => a + b, 0);
  return { total, contributions };
}
