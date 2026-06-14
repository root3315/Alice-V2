/**
 * Вектор личности и его эволюция.
 * Соответствует Python voices.py PersonalityVector + personality_evolution_step().
 */

import type { PersonalityWeights } from "../utils/math.js";

/**
 * Реестр идентичностей голосов — единственная точка определения 4 голосов.
 * ADR-81: голос Reflection удалён. Consolidation — это возникающее свойство многошагового выполнения в обычном action sandbox.
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
 * Проецирует веса на ограниченный симплекс {π | π_i ∈ [piMin, piMax], Σπ = 1}.
 * Итерирует clamp → normalize до сходимости (обычно 2-3 прохода).
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
  /** π = (π_D, π_C, π_S, π_X), при условии sum = 1. ADR-81: 4 измерения. */
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
 * Пакетная эволюция личности: накапливает все дельты обратной связи, затем выполняет одну регрессию к среднему + одну проекцию.
 *
 * Исключает ситуацию, когда многократный вызов personalityEvolutionStep на одной обратной связи
 * приводит к избыточному применению регрессии и проекции (N обратных связей → N регрессий вместо 1).
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

  // накапливаем все дельты
  for (const { actionIdx, feedback } of feedbacks) {
    newWeights[actionIdx] += alpha * feedback;
  }

  // одна регрессия к среднему
  for (let i = 0; i < newWeights.length; i++) {
    const home = piHome[i] ?? 1 / newWeights.length;
    newWeights[i] -= gamma * (newWeights[i] - home);
  }

  // одна проекция
  return new PersonalityVector(projectToSimplex(newWeights, piMin, PERSONALITY_MAX));
}
