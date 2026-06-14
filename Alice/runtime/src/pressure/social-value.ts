/**
 * D5: Net Social Value + Social Value Gate.
 *
 * V(a, n) = ΔP(a, n) - λ · C_social(a, n)
 *
 * Действие выполняется только при V > 0, иначе — молчание (Axiom 4).
 * λ ≥ 1 гарантирует, что цена социальной ошибки больше равноценного снятия давления.
 *
 * @see paper/ Definition 9: Net Social Value
 * @see paper/ Axiom 4: Social Value Gate
 */

import { PRESSURE_SPECS } from "../graph/constants.js";
import type { PressureDims } from "../utils/math.js";

/** Имена измерений P1-P6 (выводятся из PRESSURE_SPECS, выровнены с индексом kappa). */
const STD_DIMS = Object.keys(PRESSURE_SPECS) as (keyof typeof PRESSURE_SPECS)[];

/**
 * Оценить ожидаемое снижение давления ΔP(a, n) после действия.
 *
 * P2-2 fix: при наличии kappa для вклада каждого измерения применяется tanh(raw/κ_k)
 * с нормализацией до [0, 1) перед суммированием — это предотвращает монополизацию ΔP
 * одним измерением из-за разницы в единицах измерения.
 * Пример: давление P4 по треду может достигать 400+, тогда как P6 — лишь 0.1; без нормализации P4 полностью доминирует.
 *
 * @param contributions - вклады сущностей по измерениям { P1: { entityId: value }, ... }
 * @param targetId - ID целевой сущности
 * @param kappa - κ нормализации API (опционально; при наличии применяется tanh-нормализация)
 * @returns ожидаемое снижение давления (≥ 0)
 */
export function estimateDeltaP(
  contributions: Record<string, Record<string, number>>,
  targetId: string,
  kappa?: PressureDims,
): number {
  let total = 0;

  // Стандартные измерения P1-P6: опциональная tanh-нормализация
  for (let i = 0; i < STD_DIMS.length; i++) {
    const dimContribs = contributions[STD_DIMS[i]];
    if (!dimContribs) continue;
    const raw = dimContribs[targetId] ?? 0;
    total += kappa ? Math.tanh(raw / kappa[i]) : raw;
  }

  // Нестандартные измерения (P_prospect и т.д.): прямое суммирование
  for (const [dim, dimContribs] of Object.entries(contributions)) {
    if ((STD_DIMS as readonly string[]).includes(dim)) continue;
    total += dimContribs[targetId] ?? 0;
  }

  // ΔP не должен быть отрицательным (действие не увеличивает давление)
  return Math.max(0, total);
}

/**
 * Вычислить Net Social Value.
 *
 * V(a, n) = ΔP - λ · C_social
 *
 * @param deltaP - ожидаемое снижение давления
 * @param socialCost - социальные издержки
 * @param lambda - коэффициент неприятия потерь (≥ 1)
 * @returns Net Social Value (может быть положительным или отрицательным)
 *
 * @see paper/ Definition 9
 */
export function computeNetSocialValue(deltaP: number, socialCost: number, lambda: number): number {
  return deltaP - lambda * socialCost;
}

/**
 * Вычислить Net Social Value с штрафом за неопределённость + информационным приростом VoI.
 *
 * NSV(a, n) = ΔP - λ·C_social - β·H(bel) + γ·VoI(a, n)
 *
 * Член β·H рассматривает неопределённость как штраф (консервативно), γ·VoI — как награду за исследование.
 * Вместе они образуют приближение Expected Free Energy в стиле Active Inference.
 *
 * @param deltaP - ожидаемое снижение давления
 * @param socialCost - социальные издержки
 * @param lambda - коэффициент неприятия потерь (≥ 1)
 * @param beliefEntropy - Shannon entropy H(bel) целевого убеждения
 * @param beta - коэффициент штрафа за неопределённость (≥ 0)
 * @param gamma - коэффициент информационного прироста VoI (≥ 0)
 * @param voiValue - значение информационного прироста VoI (отношение информации Калмана, [0,1))
 * @returns значение NSV (может быть положительным или отрицательным)
 *
 * @see paper-pomdp/ Def 5.2
 * @see docs/adr/151-algorithm-audit/ #1 информационный прирост VoI
 */
export function computeNSVBeta(
  deltaP: number,
  socialCost: number,
  lambda: number,
  beliefEntropy: number,
  beta: number,
  gamma: number,
  voiValue: number,
): number {
  return deltaP - lambda * socialCost - beta * beliefEntropy + gamma * voiValue;
}

/**
 * VoI (Value of Information) — информационный прирост по отношению Калмана.
 *
 * VoI = σ² / (σ² + σ²_obs)
 *
 * Большой σ² → VoI ≈ 1 (высокая неопределённость, действие даёт большой информационный прирост)
 * Малый σ² → VoI ≈ 0 (достаточно определённо, информационный прирост от действия пренебрежим)
 *
 * @param sigma2 - текущая дисперсия убеждения (можно суммировать по нескольким измерениям)
 * @param sigma2Obs - дисперсия шума наблюдения (константа, контролирует скорость сходимости)
 * @returns значение VoI ∈ [0, 1)
 *
 * @see docs/adr/151-algorithm-audit/ #1 информационный прирост VoI
 */
export function computeVoI(sigma2: number, sigma2Obs: number): number {
  return sigma2 / (sigma2 + sigma2Obs);
}
