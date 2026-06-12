/**
 * Belief Triple — Social POMDP 核心数据结构。
 *
 * Alice 对世界的认识不是确定值，而是带不确定性的信念。
 * 每个信念由 (μ, σ², t_obs) 三元组表示：
 *   μ     — 均值估计（"最可能的值"）
 *   σ²    — 方差（"有多不确定"）
 *   t_obs — 上次观测 tick（"多久没更新了"）
 *
 * @see paper-pomdp/ Def 3.1
 */
export interface BeliefTriple {
  /** 均值估计。 */
  mu: number;
  /** 方差（不确定性）。 */
  sigma2: number;
  /** 上次观测的墙钟时间（ms）。F4 修复：从 tick 改为 wall-clock ms，消除 conversation 模式下衰减加速问题。 */
  tObs: number;
}

export interface BeliefDecayParams {
  /** 半衰期（秒）。F4: 从 ticks 改为 seconds，与 tick 间隔解耦。 */
  halfLife: number;
  /** 先验均值（衰减目标）。 */
  muPrior: number;
  /** 稳态方差上界。 */
  sigma2Inf: number;
  /** 方差增长速率（per second）。 */
  theta: number;
}

export const DEFAULT_BELIEF_DECAY: BeliefDecayParams = {
  halfLife: 86_400, // 1 天（秒）
  muPrior: 0, // 中性先验
  sigma2Inf: 1.0, // 完全不确定
  theta: 1 / 60_000, // σ² 增长：~8.3h 达到 63% of σ²_∞
};

/**
 * 印象特质/兴趣信念的衰减参数。
 * μ 半衰期较短（8h），鼓励 LLM 持续强化观察。
 * σ² 膨胀极慢（θ = 1/6M）——人格特质和兴趣是 stable properties，
 * 不观察并不意味着"变得更不确定"，只意味着"印象变淡"（μ 衰减）。
 * 旧 θ=1/60000 导致 24h 间隔后 σ²→0.95，结晶条件永远无法跨日满足。
 * @see docs/adr/89-impression-formation-system.md §Phase 1
 * @see docs/adr/208-cognitive-label-interest-domain.md
 */
export const TRAIT_BELIEF_DECAY: BeliefDecayParams = {
  halfLife: 28_800, // 8 小时（秒）— 未结晶印象的 μ 衰减
  muPrior: 0, // 中性（未被观察 = 无特质倾向）
  sigma2Inf: 1.0,
  theta: 1 / 6_000_000, // σ² 膨胀极慢：24h 后 σ²≈0.046（可跨日结晶），72h 后 σ²≈0.10（需重新积累）
};

/**
 * 信念变更日志条目 — 观测历史 (paper Def 3.2)。
 * 记录每次 BeliefStore.update() 调用的前后状态，支持因果溯源。
 * @see docs/adr/123-crystallization-substrate-generalization.md §D1
 */
export interface BeliefChangeEntry {
  /** 完整 key: entityId::domain:attribute */
  key: string;
  /** 变更前均值。 */
  oldMu: number;
  /** 变更后均值。 */
  newMu: number;
  /** 变更前方差。 */
  oldSigma2: number;
  /** 变更后方差。 */
  newSigma2: number;
  /** 观测值。 */
  observation: number;
  /** 更新通道。 */
  channel: "structural" | "semantic";
  /** 变更时间（墙钟 ms）。 */
  ms: number;
}
