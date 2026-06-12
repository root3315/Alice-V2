/**
 * 纯数学工具函数——与 Python simulation/pressure.py 中的辅助函数一一对应。
 */

// -- 维度类型 ---------------------------------------------------------------

/** 4 维人格权重向量 [diligence, curiosity, sociability, caution]。ADR-81: Reflection 移除。 */
export type PersonalityWeights = [number, number, number, number];

/** 7 维张力向量 [tau1, tau2, tau3, tau4, tau5, tau6, tauP]。 */
export type TensionDims = [number, number, number, number, number, number, number];

/** 6 维压力向量 [P1, P2, P3, P4, P5, P6]。 */
export type PressureDims = [number, number, number, number, number, number];

/**
 * Sigmoid 冷却函数（线性时间域）。
 * 对应 Python: 1 / (1 + exp(-beta * (x - theta)))
 *
 * @deprecated P3 已迁移到 logSigmoid（对数时间域）。保留供其他维度或回归测试使用。
 */
export function sigmoid(x: number, beta: number, theta: number): number {
  const exponent = -beta * (x - theta);
  // clip 防止 overflow
  const clipped = Math.max(-50, Math.min(50, exponent));
  return 1.0 / (1.0 + Math.exp(clipped));
}

/**
 * 对数域 sigmoid——P3 关系冷却专用。
 *
 * Weber-Fechner 定律：人类感知时间变化的能力与时间的对数成正比。
 * 将 sigmoid 输入从线性时间映射到对数时间，使长期沉默仍有增量区分度。
 *
 * cooling(t) = σ(β_r · (ln(1 + t/τ₀) - ln(1 + θ/τ₀)))
 *
 * 性质：
 * - t = θ 时 σ = 0.5（拐点不变）
 * - t << θ 时 σ ≈ 0（短沉默无压力）
 * - t >> θ 时 σ → 1（有界，Homeostasis 定理安全）
 * - 对数压缩使 1h vs 1d 仍有区分（旧公式中两者都映射到 ~1.0）
 *
 * @param silenceS 沉默时长（秒）
 * @param betaR 对数域 sigmoid 陡度（推荐 2.5）
 * @param thetaS 期望交互间隔（秒）
 * @param tau0 时间感知粒度（秒，推荐 600）
 *
 * @see docs/adr/111-log-time-sigmoid/README.md
 */
export function logSigmoid(silenceS: number, betaR: number, thetaS: number, tau0: number): number {
  const sLog = Math.log(1 + silenceS / tau0);
  const muC = Math.log(1 + thetaS / tau0);
  const exponent = -betaR * (sLog - muC);
  const clipped = Math.max(-50, Math.min(50, exponent));
  return 1.0 / (1.0 + Math.exp(clipped));
}

/**
 * tanh 归一化，clip 到 [0, 1)。
 * 对应 Python: np.tanh(np.clip(x / kappa, 0, None))
 */
export function tanhNormalize(value: number, kappa: number): number {
  if (kappa <= 0) return 0;
  const ratio = Math.max(0, value / kappa);
  return Math.tanh(ratio);
}

/**
 * 数值稳定的 softmax。
 * 对应 Python: shifted = L - L.max(); exp(shifted/tau) / sum(exp(shifted/tau))
 */
export function softmax(values: number[], tau: number): number[] {
  if (values.length === 0) return [];
  // M6 修复: 循环求 max，避免 Math.max(...values) 对大数组栈溢出
  let maxVal = -Infinity;
  for (const v of values) if (v > maxVal) maxVal = v;
  const shifted = values.map((v) => (v - maxVal) / tau);
  const exps = shifted.map(Math.exp);
  const sum = exps.reduce((a, b) => a + b, 0);
  return exps.map((e) => e / sum);
}

/**
 * P2 可检索性（遗忘曲线）。
 * 对应 Python: (1 + (n - last_access) / (9 * stability))^d
 */
export function retrievability(
  tick: number,
  lastAccess: number,
  stability: number,
  d: number,
): number {
  const gap = Math.max(0, tick - lastAccess);
  const denom = 9.0 * Math.max(stability, 1e-6);
  return (1.0 + gap / denom) ** d;
}

/**
 * 时间衰减因子: 1/(1 + age/halfLife)。age=0 → 1.0，age=halfLife → 0.5。
 * M3 DRY: 统一 focus.ts / system1.ts / propagation.ts 中的手写衰减公式。
 * halfLife=Infinity → 不衰减（1/(1+0) = 1.0）。
 */
export function decayFactor(age: number, halfLife: number): number {
  if (halfLife < 0) throw new Error(`decayFactor: halfLife must be >= 0, got ${halfLife}`);
  if (halfLife === 0) return age <= 0 ? 1.0 : 0.0;
  return 1.0 / (1.0 + Math.max(0, age) / halfLife);
}

/**
 * 标准 sigmoid: σ(x) = 1 / (1 + exp(-x))，带溢出保护。
 * m1 DRY: 统一 p-prospect.ts 中的本地 sigmoid。
 */
export function standardSigmoid(x: number): number {
  const clamped = Math.max(-50, Math.min(50, x));
  return 1 / (1 + Math.exp(-clamped));
}

/**
 * L2 距离。
 */
export function l2Distance(a: number[], b: number[]): number {
  // M7 修复: 维度不等时抛错，不再静默截断
  if (a.length !== b.length) {
    throw new Error(`l2Distance: mismatched dimensions ${a.length} vs ${b.length}`);
  }
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const diff = a[i] - b[i];
    sum += diff * diff;
  }
  return Math.sqrt(sum);
}

/**
 * 标准差。
 */
export function std(values: number[]): number {
  if (values.length === 0) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

/**
 * 归一化数组使其和为 1。
 */
export function normalize(values: number[]): number[] {
  if (values.length === 0) return [];
  const sum = values.reduce((a, b) => a + b, 0);
  if (sum <= 0) return values.map(() => 1.0 / values.length);
  return values.map((v) => v / sum);
}

/**
 * ADR-117 D4: Box-Muller 高斯 jitter。
 * σ = 0.15 → 95% 的时间在 ±30% 以内，极端值由 Math.max(100) 兜底。
 */
export function applyJitter(delayMs: number): number {
  const u1 = Math.random();
  const u2 = Math.random();
  const z = Math.sqrt(-2 * Math.log(u1 || 1e-10)) * Math.cos(2 * Math.PI * u2);
  const jittered = delayMs * (1 + 0.15 * z);
  return Math.max(100, Math.round(jittered));
}
