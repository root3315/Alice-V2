/**
 * 人格向量及其演化。
 * 对应 Python voices.py PersonalityVector + personality_evolution_step()。
 */

import type { PersonalityWeights } from "../utils/math.js";

/**
 * 声部身份注册表 — 4 个声部的唯一定义点。
 * ADR-81: Reflection 声部移除。Consolidation 是常规 action sandbox 多跳执行的涌现属性。
 * @see paper-five-dim/ Def 3.6: π = (π_D, π_C, π_S, π_X)
 */
export const VOICES = [
  { id: "diligence", short: "D", display: "Diligence", index: 0 },
  { id: "curiosity", short: "C", display: "Curiosity", index: 1 },
  { id: "sociability", short: "S", display: "Sociability", index: 2 },
  { id: "caution", short: "X", display: "Caution", index: 3 },
] as const;

export type VoiceAction = (typeof VOICES)[number]["id"];
export const VOICE_COUNT = VOICES.length;

export const VOICE_INDEX = Object.fromEntries(VOICES.map((v) => [v.id, v.index])) as Record<
  VoiceAction,
  number
>;

export const VOICE_BY_INDEX = Object.fromEntries(VOICES.map((v) => [v.index, v.id])) as Record<
  number,
  VoiceAction
>;

/**
 * 将权重投影到有界单纯形 {π | π_i ∈ [piMin, piMax], Σπ = 1}。
 * 迭代 clamp → normalize 直到收敛（通常 2-3 轮）。
 * @see paper-five-dim Def 3.6 (eq 14)
 */
function projectToSimplex(weights: number[], piMin: number, piMax: number): PersonalityWeights {
  const w = [...weights];
  for (let iter = 0; iter < 10; iter++) {
    for (let i = 0; i < w.length; i++) w[i] = Math.max(piMin, Math.min(piMax, w[i]));
    const s = w.reduce((a, b) => a + b, 0);
    if (s <= 0) {
      const u = 1 / w.length;
      return [u, u, u, u];
    }
    for (let i = 0; i < w.length; i++) w[i] /= s;
    if (w.every((v) => v >= piMin - 1e-10 && v <= piMax + 1e-10)) break;
  }
  return [w[0], w[1], w[2], w[3]];
}

export const PERSONALITY_MIN = 0.05;
const PERSONALITY_MAX = 0.5;

export class PersonalityVector {
  /** π = (π_D, π_C, π_S, π_X)，满足 sum = 1。ADR-81: 4 维。 */
  weights: PersonalityWeights;

  constructor(weights?: number[]) {
    const w = weights ? [...weights] : [0.25, 0.25, 0.25, 0.25];
    this.weights = [w[0], w[1], w[2], w[3]] as PersonalityWeights;
    this._normalize();
  }

  private _normalize(): void {
    const s = this.weights.reduce((a, b) => a + b, 0);
    if (s > 0) {
      for (let i = 0; i < this.weights.length; i++) {
        this.weights[i] /= s;
      }
    } else {
      this.weights = [0.25, 0.25, 0.25, 0.25];
    }
  }

  get piD(): number {
    return this.weights[0];
  }
  get piC(): number {
    return this.weights[1];
  }
  get piS(): number {
    return this.weights[2];
  }
  get piX(): number {
    return this.weights[3];
  }

  toString(): string {
    const parts = VOICES.map((v, i) => `${v.short}=${this.weights[i].toFixed(3)}`);
    return `PersonalityVector(${parts.join(", ")})`;
  }
}

/**
 * 批量人格演化：累加所有 feedback delta 后执行一次均值回归 + 一次投影。
 *
 * 避免单 feedback 调用 personalityEvolutionStep 多次导致
 * 均值回归和投影被过度应用（N 次 feedback → N 次回归 vs 1 次回归）。
 */
export function personalityEvolutionBatch(
  personality: PersonalityVector,
  feedbacks: Array<{ actionIdx: number; feedback: number }>,
  alpha: number,
  gamma: number,
  piHome: PersonalityWeights | number[],
  piMin: number = PERSONALITY_MIN,
): PersonalityVector {
  const newWeights = [...personality.weights];

  // 累加所有 delta
  for (const { actionIdx, feedback } of feedbacks) {
    newWeights[actionIdx] += alpha * feedback;
  }

  // 一次均值回归
  for (let i = 0; i < newWeights.length; i++) {
    const home = piHome[i] ?? 1 / newWeights.length;
    newWeights[i] -= gamma * (newWeights[i] - home);
  }

  // 一次投影
  return new PersonalityVector(projectToSimplex(newWeights, piMin, PERSONALITY_MAX));
}
