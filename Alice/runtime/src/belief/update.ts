/**
 * Belief 更新——双通道观测融合。
 *
 * Structural（结构性）: LLM 明确输出的事实 → 覆写 mu, σ² → ε（接近 0）。
 * Semantic（语义性）:   LLM 推断的模糊信号 → EMA ≈ Kalman 融合。
 *
 * @see paper-pomdp/ Def 3.2
 */
import type { BeliefTriple } from "./types.js";

/** structural 更新后的残留方差（不为 0，保留微量不确定性）。 */
const STRUCTURAL_EPSILON = 0.01;

/** semantic 更新的默认 EMA 权重。 */
const DEFAULT_ALPHA = 0.3;

/** semantic 更新的默认观测噪声。 */
const DEFAULT_NOISE = 0.1;

export interface UpdateOptions {
  /** EMA 权重 α ∈ (0,1]，仅 semantic 通道使用。 */
  alpha?: number;
  /** 观测噪声方差，仅 semantic 通道使用。 */
  noise?: number;
}

/**
 * 根据新观测更新信念。
 *
 * @param b - 当前信念三元组
 * @param observation - 观测值
 * @param channel - 更新通道
 * @param nowMs - 当前墙钟时间（ms）。F4: 从 tick 改为 wall-clock ms。
 * @param options - 可选参数
 * @returns 更新后的新 BeliefTriple
 */
export function updateBelief(
  b: BeliefTriple,
  observation: number,
  channel: "structural" | "semantic",
  nowMs: number,
  options?: UpdateOptions,
): BeliefTriple {
  if (channel === "structural") {
    // 结构性更新：LLM 明确声明，直接覆写
    return {
      mu: observation,
      sigma2: STRUCTURAL_EPSILON,
      tObs: nowMs,
    };
  }

  // 语义性更新：EMA ≈ Kalman
  const alpha = options?.alpha ?? DEFAULT_ALPHA;
  const noise = options?.noise ?? DEFAULT_NOISE;

  const muNew = (1 - alpha) * b.mu + alpha * observation;
  // 语义推断不应比明确声明（structural）更确定 → σ² 下界为 STRUCTURAL_EPSILON
  const sigma2New = Math.max((1 - alpha) ** 2 * b.sigma2 + alpha ** 2 * noise, STRUCTURAL_EPSILON);

  return {
    mu: muNew,
    sigma2: sigma2New,
    tObs: nowMs,
  };
}
