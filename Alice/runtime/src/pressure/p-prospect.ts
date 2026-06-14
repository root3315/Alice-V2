/**
 * P_prospect — перспективное давление (ADR-23 Wave 4).
 *
 * Thread horizon создаёт перспективное давление как самостоятельный аддитивный член API.
 *
 * P_prospect = Σ_i w_i × σ(k × (1 - remaining_i / horizon_i))
 *   remaining = max(0, deadlineMs - nowMs)
 *   σ = sigmoid, верхняя граница естественно ограничена
 *
 * Нет потоков с horizon → P_prospect = 0 (деградация v4).
 */
import type { WorldModel } from "../graph/world-model.js";
import { standardSigmoid } from "../utils/math.js";
import { readNodeMs } from "./clock.js";
import type { PressureResult } from "./p1-attention.js";

/**
 * Вычисляет P_prospect.
 *
 * Читает из графа все Thread-сущности со статусом open (с конечным атрибутом deadline),
 * вычисляет перспективное давление.
 *
 * @param G граф компаньона
 * @param n текущий тик
 * @param kSteepness крутизна sigmoid (по умолчанию 5.0)
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

    // ADR-166: точное чтение, при отсутствии любой временной метки — пропустить (Unknown ≠ Old)
    const createdMs = readNodeMs(G, tid, "created_ms");
    const deadlineMs = readNodeMs(G, tid, "deadline_ms");
    if (createdMs <= 0 || deadlineMs <= 0) continue;

    const horizonS = (deadlineMs - createdMs) / 1000;
    if (horizonS <= 0) continue;

    const remainingS = Math.max(0, (deadlineMs - nowMs) / 1000);
    const w = attrs.w;

    // σ(k × (1 - remaining / horizon)) — стремится к 1 при приближении к deadline
    const progress = 1 - remainingS / horizonS;
    const pressure = w * standardSigmoid(kSteepness * progress);
    contributions[tid] = pressure;
  }

  const total = Object.values(contributions).reduce((a, b) => a + b, 0);
  return { total, contributions };
}
