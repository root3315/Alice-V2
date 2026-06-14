/**
 * Belief 衰减——信念随时间回归先验。
 *
 * Затухание среднего (экспоненциальный период полураспада):
 *   μ_eff(t) = μ_prior + (μ - μ_prior) · 2^{-(t - t_obs) / h}
 *
 * Расширение дисперсии (стационарное состояние процесса OU):
 *   σ²(t) = σ²_∞ - (σ²_∞ - σ²_obs) · e^{-2θ(t - t_obs)}
 *
 * Исправление F4: dt вычисляется в секундах настенного времени (wall-clock seconds), а не в тиках.
 * В режиме conversation интервал тика 3 с, в старой реализации 500 тиков — всего 25 минут
 * до половинного затухания (ожидаемое значение — 8 часов). После перехода на настенные часы
 * скорость затухания не зависит от интервала тика.
 *
 * @see paper-pomdp/ Def 3.1
 */
import { type BeliefDecayParams, type BeliefTriple, DEFAULT_BELIEF_DECAY } from "./types.js";

/**
 * Применяет временно́е затухание к убеждению, возвращает новый BeliefTriple.
 *
 * Исходный объект не изменяется (immutable). Если nowMs ≤ tObs — возвращает копию без изменений.
 *
 * @param b Текущий тройной вектор убеждения (tObs — настенное время в мс)
 * @param nowMs Текущее настенное время (мс)
 * @param params Параметры затухания (halfLife в секундах)
 */
export function decayBelief(
  b: BeliefTriple,
  nowMs: number,
  params: BeliefDecayParams = DEFAULT_BELIEF_DECAY,
): BeliefTriple {
  const dtS = (nowMs - b.tObs) / 1000; // разница настенного времени в секундах
  if (dtS <= 0) return { ...b };

  // μ затухает к априорному значению
  const muEff = params.muPrior + (b.mu - params.muPrior) * 2 ** (-dtS / params.halfLife);

  // σ² расширяется до стационарной дисперсии
  const sigma2Eff =
    params.sigma2Inf - (params.sigma2Inf - b.sigma2) * Math.exp(-2 * params.theta * dtS);

  return { mu: muEff, sigma2: sigma2Eff, tObs: b.tObs };
}
