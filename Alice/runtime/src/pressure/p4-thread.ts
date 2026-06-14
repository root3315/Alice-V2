/**
 * P4 расхождение потоков (Thread Divergence) — управляется Thread.
 * Соответствует Python pressure.py P4_thread_divergence().
 *
 * ADR-64 VI-1: age^β заменено на log(1 + age/τ), предотвращает числовое переполнение для длинных потоков.
 *
 * P4(n) = Σ_t log(1 + age(t)/τ) · w(t) · decayFactor(t)
 *
 * Исправление по результатам аудита: удалён компонент forecast (remaining^(-δ)).
 * P_prospect (p-prospect.ts) уже самостоятельно обрабатывает перспективное давление, управляемое deadline;
 * forecast в P4 и P_prospect вместе двойно учитывали один и тот же deadline, что приводило к избыточному
 * усилению API при приближении к дедлайну (одновременный рост по двум измерениям).
 * P4 теперь измеряет только накопление возраста потока (backtrack), а срочность deadline полностью передана P_prospect.
 *
 * Миграция dt: age переведён в секунды настенных часов, единица threadAgeScale изменена с ticks на seconds.
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

    // ADR-166: используем readNodeMs (точное значение), при отсутствии — пропускаем поток (Unknown ≠ Old)
    const createdMs = readNodeMs(G, tid, "created_ms");
    if (createdMs <= 0) continue;

    const w = attrs.w;
    const ageS = Math.max(elapsedS(nowMs, createdMs), 1.0);

    // ADR-195: вклад потоков старше maxAgeS экспоненциально затухает, предотвращая постоянное насыщение P4 зомби-потоками
    const maxAgeS = threadAgeScale * 7; // 7 дней (при threadAgeScale=86400 = 604800s)
    const decayFactor = ageS > maxAgeS ? Math.exp(-(ageS - maxAgeS) / maxAgeS) : 1.0;

    // ADR-64 VI-1: логарифмический рост вместо степенного (threadAgeScale теперь в секундах: 86400s = 1 день)
    contributions[tid] = Math.log(1 + ageS / threadAgeScale) * w * decayFactor;
  }

  const total = Object.values(contributions).reduce((a, b) => a + b, 0);
  return { total, contributions };
}
