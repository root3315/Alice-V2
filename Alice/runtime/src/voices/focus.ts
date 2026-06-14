/**
 * Вычисление фокусного множества (ADR-26 §2).
 *
 * Каждый голос объявляет функцию релевантности R_v(T(e)), отбирает top-K сущностей в фокусное множество,
 * громкость = π_v × mean(R_v) по фокусному множеству.
 *
 * Заменяет глобальный tanh(Pi/κi) + маппинг через функцию активации из v4.
 */

import { readEmotionState } from "../emotion/graph.js";
import { emotionStateMoodSignal } from "../emotion/state.js";
import { type TensionVector, tensionNorm, ZERO_TENSION } from "../graph/tension.js";
import type { WorldModel } from "../graph/world-model.js";
import { elapsedS, readNodeMs } from "../pressure/clock.js";
import type { VoiceAction } from "./personality.js";

// -- Типы -------------------------------------------------------------------

export interface FocalSet {
  /** ID сущностей в фокусном множестве (в порядке убывания R_v). */
  entities: string[];
  /** Сущность с наибольшим R_v (цель действия). */
  primaryTarget: string | null;
  /** Среднее значение R_v по фокусному множеству. */
  meanRelevance: number;
}

// -- Функции релевантности R_v ----------------------------------------------

/** Взвешенное среднее. */
function weightedMean(values: number[], weights: number[]): number {
  let sumWV = 0;
  let sumW = 0;
  for (let i = 0; i < values.length; i++) {
    sumWV += weights[i] * values[i];
    sumW += weights[i];
  }
  return sumW > 0 ? sumWV / sumW : 0;
}

/**
 * ADR-181: Весовые константы R_v.
 *
 * Каждый набор весов управляет вкладом компонент тензора напряжения в голос.
 * Взвешенное среднее обеспечивает сопоставимую полосу пропускания сигнала для разных голосов.
 */
export const W_DILIGENCE = {
  values: ["tau1", "tau4", "tau5", "tauP"] as const,
  weights: [1.0, 0.7, 1.0, 0.5],
};
export const W_CURIOSITY = { values: ["tau2", "tau6"] as const, weights: [0.8, 1.0] };
export const W_SOCIABILITY = { values: ["tau3", "tau5"] as const, weights: [1.0, 0.6] };

/** ADR-181: R_Diligence = WeightedMean([τ₁, τ₄, τ₅, τ_P], [1.0, 0.7, 1.0, 0.5]) */
export function rDiligence(t: TensionVector): number {
  return weightedMean([t.tau1, t.tau4, t.tau5, t.tauP], W_DILIGENCE.weights);
}

/** ADR-181: R_Curiosity = WeightedMean([τ₂, τ₆], [0.8, 1.0]) */
export function rCuriosity(t: TensionVector): number {
  return weightedMean([t.tau2, t.tau6], W_CURIOSITY.weights);
}

/** ADR-181: R_Sociability = WeightedMean([τ₃, τ₅], [1.0, 0.6]) — τ₅ двойная маршрутизация. */
export function rSociability(t: TensionVector): number {
  return weightedMean([t.tau3, t.tau5], W_SOCIABILITY.weights);
}

/** ADR-181: Веса R_Caution. */
const ALPHA_CONFLICT = 0.6;
const ALPHA_RISK = 0.8;
/** ADR-191: Вес пикового всплеска скорости. tauSpike ∈ [1,5], α=0.5 → при z=2 rCaution += 1.0. */
const ALPHA_SPIKE = 0.5;
/** κ_norm: масштаб нормализации tensionNorm. */
const KAPPA_NORM = 10;

/**
 * ADR-181: Нормализованная энтропия Шеннона H(τ̂).
 *
 * Измеряет рассеянность вектора напряжения (степень конфликта целей):
 * - H ≈ 1: напряжение равномерно распределено по измерениям → конфликт нескольких целей → активация BIS
 * - H ≈ 0: доминирует одно измерение → цель ясна → подавление не требуется
 *
 * @param t - вектор напряжения
 * @returns нормализованная энтропия [0, 1]
 */
export function normalizedEntropy(t: TensionVector): number {
  const dims = [t.tau1, t.tau2, t.tau3, t.tau4, t.tau5, t.tau6, t.tauP];
  const absVals = dims.map(Math.abs);
  const sum = absVals.reduce((a, b) => a + b, 0);
  if (sum <= 0) return 0;

  const N = dims.length;
  let entropy = 0;
  for (const v of absVals) {
    const p = v / sum; // L1-нормализация
    if (p > 0) entropy -= p * Math.log(p);
  }
  // нормализация к [0, 1]
  return entropy / Math.log(N);
}

/**
 * ADR-181: R_Caution — формула энтропии на основе теории BIS.
 *
 * R_Caution(τ(e)) = (α_c · H(τ̂) · ‖τ‖_norm + α_r · τ_risk(e) + α_s · τ_spike) × (1 + uncertainty)
 *
 * Аудиторское исправление: uncertainty изменён с аддитивного на мультипликативное модулирование.
 * Старая формула `... + uncertainty` давала Caution постоянный пол 0.5 (R_v) при низком давлении,
 * тогда как R_v других голосов ≈ 0, Caution систематически побеждал → Алиса чрезмерно молчала в тишине,
 * подавляя поведение "missing" голоса Sociability (соскучиться по кому-то и выйти на связь).
 *
 * Новая формула: uncertainty как мультипликативный усилитель (1 + uncertainty):
 * при высокой неопределённости сигнал Caution усиливается (конфликт и риск весят больше),
 * но нулевой сигнал × любой множитель = ноль (нет ложной активации при отсутствии сигнала).
 *
 * @see docs/adr/178-voice-first-principles.md — Gray's RST: BIS → Caution
 */
export function rCaution(t: TensionVector, uncertainty: number): number {
  const H = normalizedEntropy(t);
  const normMag = Math.tanh(tensionNorm(t) / KAPPA_NORM);
  const signal =
    ALPHA_CONFLICT * H * normMag + ALPHA_RISK * t.tauRisk + ALPHA_SPIKE * (t.tauSpike ?? 0);
  return signal * (1 + uncertainty);
}

// -- Размер фокусного множества ---------------------------------------------

/** K = max(2, min(5, ceil(|entities| / 3))) */
export function focalSetSize(entityCount: number): number {
  if (entityCount <= 0) return 0;
  return Math.max(2, Math.min(5, Math.ceil(entityCount / 3)));
}

// -- Вычисление фокусного множества -----------------------------------------

/** Сортирует по R_v по убыванию, берёт top-K. */
function topK(scored: [string, number][], k: number): [string, number][] {
  return scored.sort((a, b) => b[1] - a[1]).slice(0, k);
}

/** Читает сигнал настроения EmotionState (ADR-268); старый скалярный self mood больше не является управляющим authority. */
export function readSelfMood(G: WorldModel, nowMs = Date.now()): number {
  if (!G.has("self")) return 0;
  return emotionStateMoodSignal(readEmotionState(G, nowMs));
}

/**
 * Вычисляет фокусные множества для каждого голоса.
 *
 * ADR-181: модуляция mood перенесена из этой функции в computeLoudness() (член ψ_v).
 * Фокусное множество отвечает только за сортировку R_v и выбор top-K, без модуляции mood.
 *
 * @param tensionMap - вектора напряжения по каждой сущности (из buildTensionMap)
 * @param G - граф компаньона
 * @param tick - текущий tick (порядковый)
 * @param options.uncertainty - глобальная неопределённость (базовый уровень R_Caution)
 * @param options.nowMs - текущее время настенных часов (мс), по умолчанию Date.now()
 */
export function computeFocalSets(
  tensionMap: Map<string, TensionVector>,
  G: WorldModel,
  _tick: number,
  options: {
    uncertainty?: number;
    nowMs?: number;
    targetWhitelist?: ReadonlySet<string> | null;
  } = {},
): Record<VoiceAction, FocalSet> {
  const { uncertainty = 0.5, nowMs = Date.now(), targetWhitelist = null } = options;
  const entityIds = Array.from(tensionMap.keys()).filter(
    (eid) => !targetWhitelist || targetWhitelist.has(eid),
  );
  const K = focalSetSize(entityIds.length);

  const getTension = (eid: string): TensionVector => tensionMap.get(eid) ?? ZERO_TENSION;

  const voiceConfigs: [VoiceAction, (eid: string) => number][] = [
    [
      "diligence",
      (eid) => {
        let base = rDiligence(getTension(eid));
        // S12 исправление: затухание недавно сброшенных сущностей (защита от спама, захватывающего focal set)
        if (G.has(eid)) {
          const clearedMs = readNodeMs(G, eid, "recently_cleared_ms");
          if (clearedMs > 0) {
            const ageS = elapsedS(nowMs, clearedMs);
            const damping = Math.min(1.0, ageS / 180); // 3 ticks × 60s = постепенное восстановление за 180s
            base *= damping;
          }
        }
        return base;
      },
    ],
    ["curiosity", (eid) => rCuriosity(getTension(eid))],
    [
      "sociability",
      (eid) => {
        const base = rSociability(getTension(eid));
        if (!G.has(eid)) return base;
        let boost = 0;

        // H2: boost реакции (период полураспада 5 ticks = 300s)
        const reactionMs = readNodeMs(G, eid, "reaction_boost_ms");
        if (reactionMs > 0) {
          const ageS = elapsedS(nowMs, reactionMs);
          boost += 0.5 / (1 + ageS / 300); // 5 ticks × 60s = 300s
        }

        // M2: boost вернувшегося контакта (период полураспада 10 ticks = 600s)
        const returningMs = readNodeMs(G, eid, "returning_ms");
        if (returningMs > 0) {
          const ageS = elapsedS(nowMs, returningMs);
          boost += 2.0 / (1 + ageS / 600); // 10 ticks × 60s = 600s
        }

        return base + boost;
      },
    ],
    ["caution", (eid) => rCaution(getTension(eid), uncertainty)],
  ];

  const emptySet: FocalSet = { entities: [], primaryTarget: null, meanRelevance: 0 };
  const result: Record<VoiceAction, FocalSet> = {
    diligence: emptySet,
    curiosity: emptySet,
    sociability: emptySet,
    caution: emptySet,
  };

  for (const [voice, rFn] of voiceConfigs) {
    if (entityIds.length === 0) {
      result[voice] = { entities: [], primaryTarget: null, meanRelevance: 0 };
      continue;
    }

    const scored = entityIds.map((eid) => [eid, rFn(eid)] as [string, number]);
    // Статья Def 3.8 (eq 16): E_v = top_κ({e ∈ V | R_v(T(e,n)) > 0}, R_v)
    // В конкуренции за фокусное множество участвуют только положительно релевантные сущности; при всех нулях fallback сохраняет все (защита от пустого множества)
    const positive = scored.filter(([, r]) => r > 0);
    const top = topK(positive.length > 0 ? positive : scored, K);
    const meanR = top.reduce((sum, [, r]) => sum + r, 0) / top.length;

    result[voice] = {
      entities: top.map(([eid]) => eid),
      primaryTarget: top[0][0],
      meanRelevance: meanR,
    };
  }

  return result;
}
