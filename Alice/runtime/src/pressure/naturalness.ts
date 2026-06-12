/**
 * ADR-112 D5: 自然性验证指标。
 *
 * 三个可观测指标，用于验证行为自然性：
 * - IDI (Interval Distribution Index): 行动间隔分布与 Weibull 分布的拟合度
 * - VDE (Voice Diversity Entropy): 声部选择的 Shannon 熵
 * - RAI (Reciprocal Adaptation Index): 双向互动适应度
 *
 * @see docs/adr/112-pressure-dynamics-rehabilitation/ §D5
 * @see docs/adr/151-algorithm-audit/priority-ranking.md #4
 * @see Stouffer et al. (2006) "Log-normal and power-law in human correspondence"
 * @see Malmgren et al. (2008 PNAS) "Poissonian explanation for heavy tails in e-mail"
 */

import type { WorldModel } from "../graph/world-model.js";

// ═══════════════════════════════════════════════════════════════════════════
// IDI: Interval Distribution Index
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 从行动时间戳序列计算间隔。
 * 返回正间隔数组（毫秒），按时间顺序。
 */
export function computeIntervals(timestamps: number[]): number[] {
  if (timestamps.length < 2) return [];
  const sorted = [...timestamps].sort((a, b) => a - b);
  const intervals: number[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const dt = sorted[i] - sorted[i - 1];
    if (dt > 0) intervals.push(dt);
  }
  return intervals;
}

/**
 * 幂律指数 α 的最大似然估计（Clauset et al. 2009）。
 *
 * MLE: α = 1 + n / Σ ln(x_i / x_min)
 *
 * @param intervals 正间隔数组
 * @returns α 估计值（α > 1 才有意义）
 */
export function estimatePowerLawAlpha(intervals: number[]): number {
  if (intervals.length === 0) return 1;
  const xMin = Math.min(...intervals);
  if (xMin <= 0) return 1;
  let logSum = 0;
  for (const x of intervals) {
    logSum += Math.log(x / xMin);
  }
  if (logSum === 0) return 1;
  return 1 + intervals.length / logSum;
}

/**
 * 幂律 CDF: F(x) = 1 - (x / x_min)^(-α + 1)
 */
function powerLawCDF(x: number, xMin: number, alpha: number): number {
  if (x < xMin) return 0;
  return 1 - (x / xMin) ** -(alpha - 1);
}

// ── Weibull MLE ──────────────────────────────────────────────────────────
// Weibull 是幂律和指数的桥梁分布：c<1 类幂律、c=1 指数、c>1 窄尾。
// @see Malmgren et al. (2008 PNAS) — Weibull 比纯幂律更好地拟合人类活动间隔

/**
 * Weibull 两参数 MLE（Newton-Raphson 迭代求 shape c，解析求 scale b）。
 *
 * Weibull CDF: F(x) = 1 - exp(-(x/b)^c)
 *
 * MLE 似然方程（对 c 的 profile likelihood）：
 *   g(c) = 1/c + (1/n)Σln(x_i) - [Σ x_i^c · ln(x_i)] / [Σ x_i^c] = 0
 * 解析求 b: b = (Σ x_i^c / n)^(1/c)
 *
 * @param intervals 正间隔数组
 * @returns { c: shape, b: scale }
 */
export function estimateWeibullParams(intervals: number[]): { c: number; b: number } {
  const xs = intervals.filter((x) => x > 0);
  if (xs.length < 2) return { c: 1, b: xs[0] ?? 1 };

  const n = xs.length;
  const logXs = xs.map((x) => Math.log(x));
  const meanLogX = logXs.reduce((s, v) => s + v, 0) / n;

  // Newton-Raphson 迭代求 shape c
  let c = 1.0; // 初始值：指数分布
  const maxIter = 50;
  const tol = 1e-8;

  for (let iter = 0; iter < maxIter; iter++) {
    let S = 0; // Σ x_i^c
    let T = 0; // Σ x_i^c · ln(x_i)
    let U = 0; // Σ x_i^c · (ln(x_i))^2

    for (let i = 0; i < n; i++) {
      const xc = xs[i] ** c;
      S += xc;
      T += xc * logXs[i];
      U += xc * logXs[i] * logXs[i];
    }

    const g = 1 / c + meanLogX - T / S;
    const gPrime = -1 / (c * c) - (U * S - T * T) / (S * S);

    if (Math.abs(gPrime) < 1e-15) break;

    const step = g / gPrime;
    const cNew = c - step;

    // 保证 c > 0
    c = cNew > 0.01 ? cNew : c / 2;

    if (Math.abs(step) < tol) break;
  }

  // Scale: b = (Σ x_i^c / n)^(1/c)
  let S = 0;
  for (const x of xs) S += x ** c;
  const b = (S / n) ** (1 / c);

  return { c, b };
}

/**
 * Weibull CDF: F(x) = 1 - exp(-(x/b)^c)
 */
export function weibullCDF(x: number, c: number, b: number): number {
  if (x <= 0) return 0;
  return 1 - Math.exp(-((x / b) ** c));
}

// ── KS 统计量 ────────────────────────────────────────────────────────────

/**
 * 通用 Kolmogorov-Smirnov 统计量：经验分布与任意理论 CDF 的最大距离。
 * @param sorted 已排序的正值数组
 * @param cdf 理论 CDF 函数
 */
function ksDistance(sorted: number[], cdf: (x: number) => number): number {
  const n = sorted.length;
  if (n === 0) return 0;

  let maxD = 0;
  for (let i = 0; i < n; i++) {
    const theoreticalCDF = cdf(sorted[i]);
    const empiricalCDF = (i + 1) / n;
    maxD = Math.max(maxD, Math.abs(empiricalCDF - theoreticalCDF));
    // 也检查左侧跳跃点
    const empiricalLeft = i / n;
    maxD = Math.max(maxD, Math.abs(empiricalLeft - theoreticalCDF));
  }
  return maxD;
}

/**
 * Kolmogorov-Smirnov 统计量（幂律版本，保留用于并行验证）。
 */
export function ksStatistic(intervals: number[], alpha: number): number {
  if (intervals.length === 0) return 0;
  const sorted = [...intervals].sort((a, b) => a - b);
  const xMin = sorted[0];
  return ksDistance(sorted, (x) => powerLawCDF(x, xMin, alpha));
}

/**
 * IDI (Interval Distribution Index): 行动间隔分布与 Weibull 分布的拟合度。
 *
 * IDI = 1 - KS_distance(empirical, weibull_fit)
 * IDI > 0.7 → 行为节奏自然（Weibull 比纯幂律更通用地拟合人类活动间隔）。
 *
 * @param recentActions 最近行动记录（需含 ms 时间戳）
 * @returns IDI ∈ [0, 1]，数据不足时返回 null
 */
export function computeIDI(recentActions: ReadonlyArray<{ ms: number }>): number | null {
  const timestamps = recentActions.map((a) => a.ms);
  const intervals = computeIntervals(timestamps);

  // 至少需要 5 个间隔才能有意义的拟合
  if (intervals.length < 5) return null;

  const { c, b } = estimateWeibullParams(intervals);
  const sorted = [...intervals].sort((a, b) => a - b);
  const ks = ksDistance(sorted, (x) => weibullCDF(x, c, b));
  return Math.max(0, 1 - ks);
}

// ═══════════════════════════════════════════════════════════════════════════
// VDE: Voice Diversity Entropy
// ═══════════════════════════════════════════════════════════════════════════

/**
 * VDE (Voice Diversity Entropy): 声部选择的 Shannon 熵。
 *
 * VDE = -Σ p_v × log(p_v) / log(|V|)
 * 归一化到 [0, 1]。VDE > 0.6 → 声部多样性充分。
 *
 * @param recentActions 最近行动记录（需含 action/voice 名称）
 * @param voiceCount 声部总数（默认 4: Diligence, Caution, Sociability, Exploration）
 * @returns VDE ∈ [0, 1]，数据不足时返回 null
 */
export function computeVDE(
  recentActions: ReadonlyArray<{ action: string }>,
  voiceCount = 4,
): number | null {
  if (recentActions.length < 3 || voiceCount < 2) return null;

  // 统计各声部出现次数
  const counts = new Map<string, number>();
  for (const a of recentActions) {
    counts.set(a.action, (counts.get(a.action) ?? 0) + 1);
  }

  const total = recentActions.length;
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / total;
    if (p > 0) {
      entropy -= p * Math.log(p);
    }
  }

  // 归一化到 [0, 1]
  const maxEntropy = Math.log(voiceCount);
  if (maxEntropy === 0) return 0;
  return Math.min(1, entropy / maxEntropy);
}

// ═══════════════════════════════════════════════════════════════════════════
// RAI: Reciprocal Adaptation Index
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Pearson 相关系数。
 * @returns r ∈ [-1, 1]，数据不足或方差为零时返回 0
 */
export function pearsonCorrelation(x: readonly number[], y: readonly number[]): number {
  const n = Math.min(x.length, y.length);
  if (n < 3) return 0;

  let sumX = 0;
  let sumY = 0;
  for (let i = 0; i < n; i++) {
    sumX += x[i];
    sumY += y[i];
  }
  const meanX = sumX / n;
  const meanY = sumY / n;

  let covXY = 0;
  let varX = 0;
  let varY = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i] - meanX;
    const dy = y[i] - meanY;
    covXY += dx * dy;
    varX += dx * dx;
    varY += dy * dy;
  }

  const denom = Math.sqrt(varX * varY);
  if (denom < 1e-10) return 0;
  return covXY / denom;
}

/**
 * RAI (Reciprocal Adaptation Index): 双向互动适应度。
 *
 * 计算 Alice 的响应间隔与对应频道活跃度的相关性。
 * RAI ∈ [-0.3, 0.3] → 自然适应（非机械同步也非完全忽视）。
 *
 * 从图中提取每个已监控频道的：
 * - Alice 响应间隔: 基于 last_alice_action_ms 推算
 * - 频道活跃度: unread + contact_recv_window 作为活跃度代理
 *
 * @param G 伴侣图
 * @returns RAI ∈ [-1, 1]，数据不足时返回 null
 */
export function computeRAI(G: WorldModel, nowMs = Date.now()): number | null {
  // 从图中收集已监控频道的数据对
  const responseIntervals: number[] = [];
  const activityLevels: number[] = [];

  for (const chId of G.getEntitiesByType("channel")) {
    const attrs = G.getChannel(chId);
    const lastAliceMs = Number(attrs.last_alice_action_ms ?? 0);
    const lastActiveMs = Number(attrs.last_activity_ms ?? 0);
    const unread = Number(attrs.unread ?? 0);
    const recvWindow = Number(attrs.contact_recv_window ?? 0);

    // 需要 Alice 和频道都有活动记录
    if (lastAliceMs <= 0 || lastActiveMs <= 0) continue;

    // Alice 响应间隔（ms）：当前时间 - Alice 最后行动
    // 越大说明 Alice 回复越慢
    const responseInterval = nowMs - lastAliceMs;

    // 频道活跃度：unread 消息 + 累计接收消息数作为代理
    const activityLevel = unread + recvWindow;

    if (responseInterval > 0 && activityLevel >= 0) {
      responseIntervals.push(responseInterval);
      activityLevels.push(activityLevel);
    }
  }

  if (responseIntervals.length < 3) return null;

  // 负相关意味着活跃度高的频道 Alice 回复更快 → 自然适应
  // 正相关意味着活跃频道反而回复更慢 → 不自然
  // 接近 0 → 独立（也自然）
  return pearsonCorrelation(responseIntervals, activityLevels);
}

// ═══════════════════════════════════════════════════════════════════════════
// 聚合指标
// ═══════════════════════════════════════════════════════════════════════════

export interface NaturalnessMetrics {
  /** 行动间隔分布与 Weibull 拟合度 ∈ [0,1]。null = 数据不足。 */
  idi: number | null;
  /** 声部多样性熵 ∈ [0,1]。null = 数据不足。 */
  vde: number | null;
  /** 双向适应度 ∈ [-1,1]。null = 数据不足。 */
  rai: number | null;
}

/**
 * 计算所有自然性指标。
 *
 * @param G 伴侣图
 * @param recentActions 最近行动记录
 * @param nowMs 当前墙钟时间
 */
export function computeNaturalness(
  G: WorldModel,
  recentActions: ReadonlyArray<{ tick: number; action: string; ms: number }>,
  nowMs = Date.now(),
): NaturalnessMetrics {
  return {
    idi: computeIDI(recentActions),
    vde: computeVDE(recentActions),
    rai: computeRAI(G, nowMs),
  };
}
