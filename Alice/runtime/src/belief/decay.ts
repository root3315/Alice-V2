/**
 * Belief 衰减——信念随时间回归先验。
 *
 * 均值衰减（指数半衰期）:
 *   μ_eff(t) = μ_prior + (μ - μ_prior) · 2^{-(t - t_obs) / h}
 *
 * 方差膨胀（OU 过程稳态）:
 *   σ²(t) = σ²_∞ - (σ²_∞ - σ²_obs) · e^{-2θ(t - t_obs)}
 *
 * F4 修复：dt 使用墙钟秒差（wall-clock seconds），而非 tick 差。
 * conversation 模式下 tick 间隔 3s，旧实现中 500 ticks 仅 25 分钟
 * 就衰减一半（设计预期 8 小时）。改用墙钟后衰减速率与 tick 间隔解耦。
 *
 * @see paper-pomdp/ Def 3.1
 */
import { type BeliefDecayParams, type BeliefTriple, DEFAULT_BELIEF_DECAY } from "./types.js";

/**
 * 对信念执行时间衰减，返回新的 BeliefTriple。
 *
 * 不修改原对象（immutable）。当 nowMs ≤ tObs 时原样返回。
 *
 * @param b 当前信念三元组（tObs 为墙钟 ms）
 * @param nowMs 当前墙钟时间（ms）
 * @param params 衰减参数（halfLife 单位：秒）
 */
export function decayBelief(
  b: BeliefTriple,
  nowMs: number,
  params: BeliefDecayParams = DEFAULT_BELIEF_DECAY,
): BeliefTriple {
  const dtS = (nowMs - b.tObs) / 1000; // 墙钟秒差
  if (dtS <= 0) return { ...b };

  // μ 向先验衰减
  const muEff = params.muPrior + (b.mu - params.muPrior) * 2 ** (-dtS / params.halfLife);

  // σ² 向稳态方差膨胀
  const sigma2Eff =
    params.sigma2Inf - (params.sigma2Inf - b.sigma2) * Math.exp(-2 * params.theta * dtS);

  return { mu: muEff, sigma2: sigma2Eff, tObs: b.tObs };
}
