/**
 * 关系向量工具库 (ADR-178) — 纯函数，无副作用。
 *
 * 5 维连续向量 (familiarity/trust/affection/attraction/respect)
 * 替代离散 tier+relationType 作为关系的一等表示。
 *
 * @see docs/adr/178-relationship-vector-field.md
 */

import type { ContactAttrs, DunbarTier, RelationType } from "./entities.js";

// ═══════════════════════════════════════════════════════════════════════════
// 类型
// ═══════════════════════════════════════════════════════════════════════════

export interface RelationshipVector {
  familiarity: number;
  trust: number;
  affection: number;
  attraction: number;
  respect: number;
}

export type RVDimension = keyof RelationshipVector;

export const RV_DIMENSIONS: readonly RVDimension[] = [
  "familiarity",
  "trust",
  "affection",
  "attraction",
  "respect",
] as const;

export type RomanticPhase =
  | "none"
  | "tension"
  | "courtship"
  | "passion"
  | "bonding"
  | "cooling"
  | "estranged";

export type ChemistryLevel = "magnetic" | "electric" | "warm" | "comfortable" | "awkward" | "cold";

// ═══════════════════════════════════════════════════════════════════════════
// 常量
// ═══════════════════════════════════════════════════════════════════════════

/** 新联系人初始向量。 */
export const INITIAL_RV: Readonly<RelationshipVector> = Object.freeze({
  familiarity: 0,
  trust: 0.3, // 陌生人有基础信任
  affection: 0,
  attraction: 0,
  respect: 0.3, // 基础礼貌尊重
});

/**
 * 各维度衰减参数 λ（指数衰减 half-life 秒数）。
 * value(t+Δ) = value(t) × exp(-ln2 × Δ / halfLife)
 */
export const DIMENSION_DECAY: Readonly<Record<RVDimension, number>> = Object.freeze({
  familiarity: 30 * 86400, // 30 天半衰期——熟悉度消退最慢
  trust: 60 * 86400, // 60 天——信任建立慢、消退也慢
  affection: 14 * 86400, // 14 天——情感需要持续维护
  attraction: 7 * 86400, // 7 天——吸引力消退最快
  respect: 45 * 86400, // 45 天——尊重较稳定
});

/** 关系原型——各类关系在向量空间中的典型位置。 */
export const RELATIONSHIP_PROTOTYPES: Readonly<Record<RelationType, RelationshipVector>> =
  Object.freeze({
    romantic: { familiarity: 0.9, trust: 0.8, affection: 0.9, attraction: 0.8, respect: 0.7 },
    close_friend: { familiarity: 0.9, trust: 0.9, affection: 0.7, attraction: 0.1, respect: 0.8 },
    friend: { familiarity: 0.6, trust: 0.6, affection: 0.4, attraction: 0.1, respect: 0.6 },
    family: { familiarity: 0.8, trust: 0.7, affection: 0.6, attraction: 0, respect: 0.6 },
    colleague: { familiarity: 0.4, trust: 0.4, affection: 0.1, attraction: 0, respect: 0.5 },
    acquaintance: { familiarity: 0.2, trust: 0.3, affection: 0, attraction: 0, respect: 0.3 },
    unknown: { familiarity: 0, trust: 0.3, affection: 0, attraction: 0, respect: 0.3 },
  });

/** sense_chemistry 指令的 chemistry 枚举到刺激强度的映射。 */
export const CHEMISTRY_STIMULUS: Readonly<Record<ChemistryLevel, number>> = Object.freeze({
  magnetic: 0.8,
  electric: 0.6,
  warm: 0.4,
  comfortable: 0.2,
  awkward: -0.3,
  cold: -0.6,
});

/** Velocity EMA 平滑系数（α 越小越平滑）。待 simulation 校准。 */
export const RV_VELOCITY_ALPHA = 0.05;

/** familiarity 每次互动的增量（天花板阻尼前）。 */
export const FAMILIARITY_INTERACTION_DELTA = 0.02;

// ═══════════════════════════════════════════════════════════════════════════
// 核心函数
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 指数衰减：value × exp(-ln2 × elapsedMs / (halfLifeS × 1000))。
 */
export function decayDimension(value: number, halfLifeS: number, elapsedMs: number): number {
  if (elapsedMs <= 0 || halfLifeS <= 0) return value;
  const lambda = Math.LN2 / (halfLifeS * 1000);
  return value * Math.exp(-lambda * elapsedMs);
}

/**
 * 带天花板阻尼的增长：value += α × stimulus × (1 - value)。
 * stimulus > 0 增长，stimulus < 0 收缩（用 value 而非 1-value 作为阻尼）。
 */
export function growDimension(value: number, alpha: number, stimulus: number): number {
  if (stimulus >= 0) {
    // 增长：越靠近 1 越慢
    return Math.min(1, value + alpha * stimulus * (1 - value));
  }
  // 收缩：越靠近 0 越慢（用 value 作为阻尼）
  return Math.max(0, value + alpha * stimulus * value);
}

/**
 * EMA 更新 velocity：vel = α × delta + (1-α) × prevVel。
 */
export function updateVelocity(prevVel: number, delta: number, alpha: number): number {
  return alpha * delta + (1 - alpha) * prevVel;
}

/**
 * 从 familiarity 导出 Dunbar tier（Phase 3 用，Phase 1-2 不替换现有 tier）。
 */
export function deriveTier(familiarity: number): DunbarTier {
  if (familiarity >= 0.8) return 5;
  if (familiarity >= 0.6) return 15;
  if (familiarity >= 0.4) return 50;
  if (familiarity >= 0.2) return 150;
  return 500;
}

/**
 * 从向量导出关系类型——取与原型最接近的类型（欧氏距离）。
 */
export function deriveRelationType(v: RelationshipVector): RelationType {
  let bestType: RelationType = "unknown";
  let bestDist = Infinity;
  for (const [type, proto] of Object.entries(RELATIONSHIP_PROTOTYPES)) {
    let sumSq = 0;
    for (const dim of RV_DIMENSIONS) {
      const diff = v[dim] - proto[dim];
      sumSq += diff * diff;
    }
    if (sumSq < bestDist) {
      bestDist = sumSq;
      bestType = type as RelationType;
    }
  }
  return bestType;
}

/**
 * 从向量+velocity 导出浪漫阶段。
 *
 * 阶段判定基于 attraction + affection 的组合：
 * - none:      attraction < 0.1
 * - tension:   attraction >= 0.1, affection < 0.3
 * - courtship: attraction >= 0.3, affection in [0.3, 0.6)
 * - passion:   attraction >= 0.5, affection >= 0.6
 * - bonding:   attraction >= 0.3, affection >= 0.7, vel_attraction ≤ 0 (稳定)
 * - cooling:   attraction 下降中 (vel_attraction < -0.01), affection >= 0.3
 * - estranged: attraction 曾高现低, affection 也在下降
 */
export function deriveRomanticPhase(
  v: RelationshipVector,
  vel: Record<RVDimension, number>,
): RomanticPhase {
  const { attraction, affection } = v;

  if (attraction < 0.1) return "none";

  // 冷却/疏远检测优先
  if (vel.attraction < -0.01 && affection >= 0.3) {
    if (vel.affection < -0.005) return "estranged";
    return "cooling";
  }

  // 正常阶段递进
  if (attraction >= 0.5 && affection >= 0.6) {
    // 高吸引 + 高情感：passion 或 bonding
    if (vel.attraction <= 0 && affection >= 0.7) return "bonding";
    return "passion";
  }

  if (attraction >= 0.3 && affection >= 0.3) return "courtship";
  if (affection < 0.3) return "tension";

  return "tension";
}

// ═══════════════════════════════════════════════════════════════════════════
// ContactAttrs 读取
// ═══════════════════════════════════════════════════════════════════════════

/** 从 ContactAttrs 读取关系向量，缺失值用 INITIAL_RV 填充。 */
export function readRV(attrs: Partial<ContactAttrs>): RelationshipVector {
  return {
    familiarity: attrs.rv_familiarity ?? INITIAL_RV.familiarity,
    trust: attrs.rv_trust ?? INITIAL_RV.trust,
    affection: attrs.rv_affection ?? INITIAL_RV.affection,
    attraction: attrs.rv_attraction ?? INITIAL_RV.attraction,
    respect: attrs.rv_respect ?? INITIAL_RV.respect,
  };
}

/** 从 ContactAttrs 读取 velocity 向量，缺失值为 0。 */
export function readVelocity(attrs: Partial<ContactAttrs>): Record<RVDimension, number> {
  return {
    familiarity: attrs.rv_vel_familiarity ?? 0,
    trust: attrs.rv_vel_trust ?? 0,
    affection: attrs.rv_vel_affection ?? 0,
    attraction: attrs.rv_vel_attraction ?? 0,
    respect: attrs.rv_vel_respect ?? 0,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Prompt 渲染
// ═══════════════════════════════════════════════════════════════════════════

/** 维度值 → 语义标签。 */
function dimensionLabel(value: number): string {
  if (value >= 0.8) return "very high";
  if (value >= 0.6) return "high";
  if (value >= 0.4) return "moderate";
  if (value >= 0.2) return "low";
  return "very low";
}

/** velocity → 趋势标签。 */
function trendLabel(vel: number): string | null {
  if (vel > 0.02) return "rising";
  if (vel > 0.005) return "slightly rising";
  if (vel < -0.02) return "falling";
  if (vel < -0.005) return "slightly falling";
  return null; // stable — 不渲染
}

/**
 * 渲染关系向量为语义事实（LLM 可读）。
 * 只渲染非默认值的维度，避免信息噪音。
 */
export function renderRelationshipFacts(
  v: RelationshipVector,
  vel: Record<RVDimension, number>,
  displayName: string,
): string | null {
  const facts: string[] = [];

  for (const dim of RV_DIMENSIONS) {
    const value = v[dim];
    const initial = INITIAL_RV[dim];
    // 只渲染偏离初始值的维度
    if (Math.abs(value - initial) < 0.05) continue;

    const label = dimensionLabel(value);
    const trend = trendLabel(vel[dim]);
    const trendStr = trend ? ` (${trend})` : "";
    facts.push(`${dim}: ${label}${trendStr}`);
  }

  if (facts.length === 0) return null;

  const phase = deriveRomanticPhase(v, vel);
  const phaseStr = phase !== "none" ? `, romantic phase: ${phase}` : "";

  // 单行输出——调用方通过 PromptBuilder.of() 注入，不支持多行
  return `relationship with ${displayName}: ${facts.join(", ")}${phaseStr}`;
}
