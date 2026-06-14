/**
 * Goldilocks Window — оптимальное окно контакта per-contact.
 *
 * Объединяет порог охлаждения P3 (θ_c) и константу охлаждения C_sat (τ_cool)
 * в временное окно [t_min, t_max] на уровне per-tier, модулируя ΔP на уровне принятия решений V-max.
 *
 * Основная формула (лог-нормальная колоколообразная функция полезности в логарифмической области):
 *   U(t) = exp(-0.5 × ((ln(t) - ln(t_peak)) / σ_ln)²)
 *
 * Чистый функциональный модуль — без побочных эффектов, без IO, без внешних зависимостей (только импорт типов и констант).
 *
 * @see docs/adr/154-goldilocks-window/README.md
 * @see Fang et al. 2025 "The Goldilocks Time Window for Proactive Interventions"
 */

import { DUNBAR_TIER_THETA } from "../graph/constants.js";
import type { DunbarTier } from "../graph/entities.js";

// ═══════════════════════════════════════════════════════════════════════════
// Константы
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Коэффициент масштабирования θ_c → τ_cool.
 *
 * Выбор α=0.15 даёт t_min ≈ 0.35 × θ_c (период охлаждения примерно треть от θ_c).
 * Вывод: t_min = 2.3 × τ_cool = 2.3 × α × θ_c ≈ 0.345 × θ_c.
 *
 * @see docs/adr/154-goldilocks-window/README.md §3.2
 */
const GOLDILOCKS_ALPHA = 0.15;

/**
 * Логарифм порога затухания σ_cool (10%) = ln(10) ≈ 2.302585.
 * t_min = τ_cool × ln(1/θ_low) = τ_cool × ln(10).
 */
const LN_10 = Math.log(10);

// ═══════════════════════════════════════════════════════════════════════════
// Типы
// ═══════════════════════════════════════════════════════════════════════════

/** Параметры Goldilocks Window. */
export interface GoldilocksParams {
  /** Наиболее ранний момент контакта (секунды). При t < tMin → U = 0. */
  tMin: number;
  /** Наиболее поздний желательный момент контакта (секунды) = θ_c. При t > tMax → постепенное затухание. */
  tMax: number;
  /** Время пика полезности (секунды) = √(tMin × tMax). */
  tPeak: number;
  /** Стандартное отклонение в логарифмической области (ширина окна). */
  sigmaLn: number;
  /** Константа времени упреждающего охлаждения per-tier (секунды). */
  tauCool: number;
}

// ═══════════════════════════════════════════════════════════════════════════
// Основные чистые функции
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Выводит параметры Goldilocks Window из уровня Dunbar.
 *
 * Цепочка вывода:
 *   τ_cool = α × θ_c
 *   t_min  = ln(10) × τ_cool  ≈ 2.3 × τ_cool
 *   t_max  = θ_c
 *   t_peak = √(t_min × t_max)   ← центральная точка в логарифмической области (геометрическое среднее)
 *   σ_ln   = (ln(t_max) - ln(t_min)) / 4  ← чтобы t_min/t_max попадали в ±2σ
 *
 * @see docs/adr/154-goldilocks-window/README.md §2.2, §4.1
 */
export function goldilocksParams(tier: DunbarTier): GoldilocksParams {
  const thetaC = DUNBAR_TIER_THETA[tier];
  const tauCool = GOLDILOCKS_ALPHA * thetaC;
  const tMin = LN_10 * tauCool;
  const tMax = thetaC;
  const tPeak = Math.sqrt(tMin * tMax);
  const sigmaLn = (Math.log(tMax) - Math.log(tMin)) / 4;

  return { tMin, tMax, tPeak, sigmaLn, tauCool };
}

/**
 * Вычисляет полезность Goldilocks U(t, c) ∈ [0, 1].
 *
 * Три зоны:
 *   t < tMin    → 0 (период охлаждения, не беспокоить)
 *   tMin ≤ t ≤ tMax → лог-нормальный колокол (внутри окна, максимальная полезность)
 *   t > tMax    → постепенное затухание (эстафета с P3, без резкого спада)
 *
 * Адаптивные поправки (опциональные):
 *   - emaIntervalS: EMA исторической частоты взаимодействий → для высокочастотных контактов tMin сокращается
 *   - sigma2Tier: дисперсия убеждений о tier → при неопределённости окно расширяется
 *
 * @param silenceS - время, прошедшее с последнего взаимодействия (секунды)
 * @param tier - уровень Dunbar контакта
 * @param emaIntervalS - EMA исторической частоты взаимодействий (секунды), опционально
 * @param sigma2Tier - дисперсия убеждений о tier (0-1), опционально
 * @returns значение полезности ∈ [0, 1]
 *
 * @see docs/adr/154-goldilocks-window/README.md §2.3, §4.4
 */
export function computeGoldilocksUtility(
  silenceS: number,
  tier: DunbarTier,
  emaIntervalS?: number,
  sigma2Tier?: number,
): number {
  if (silenceS <= 0) return 0;

  const params = goldilocksParams(tier);
  let { tMin, tMax, tPeak, sigmaLn } = params;

  // Адаптация 1: EMA исторической частоты взаимодействий — окно открывается раньше для высокочастотных контактов
  // Когда emaInterval намного меньше θ_c, tMin пропорционально сокращается
  if (emaIntervalS != null && emaIntervalS > 0) {
    const ratio = emaIntervalS / tMax;
    if (ratio < 0.5) {
      // Высокочастотные контакты: tMin сокращается, tPeak сдвигается раньше
      const shrink = 0.5 + ratio; // ratio=0.1 → shrink=0.6, ratio=0.5 → shrink=1.0
      tMin *= shrink;
      tPeak = Math.sqrt(tMin * tMax);
      sigmaLn = (Math.log(tMax) - Math.log(tMin)) / 4;
    }
  }

  // Адаптация 2: неопределённость убеждений σ² — при неопределённости окно расширяется
  // Зажим в [0, 1] предотвращает аномально широкое окно из-за переполнения σ² в BeliefStore
  if (sigma2Tier != null && sigma2Tier > 0.3) {
    sigmaLn *= 1 + Math.min(sigma2Tier, 1.0);
  }

  // Период охлаждения: t < tMin → полезность равна 0
  if (silenceS < tMin) return 0;

  // Внутри окна: лог-нормальный колокол
  // U(t) = exp(-0.5 × ((ln(t) - ln(tPeak)) / σ_ln)²)
  if (silenceS <= tMax) {
    const z = (Math.log(silenceS) - Math.log(tPeak)) / sigmaLn;
    return Math.exp(-0.5 * z * z);
  }

  // После окна: постепенное затухание (без резкого спада, эстафета с P3)
  // Полезность в точке tMax используется как начальное значение, затем убывает в логарифмической области
  const zAtMax = (Math.log(tMax) - Math.log(tPeak)) / sigmaLn;
  const uAtMax = Math.exp(-0.5 * zAtMax * zAtMax);
  // После tMax экспоненциальное затухание: U × exp(-(t - tMax) / tMax)
  // tMax используется как константа времени затухания — чем дальше отношение, тем медленнее затухание (tMax=θ_c самокалибруется)
  const overshoot = (silenceS - tMax) / tMax;
  return uAtMax * Math.exp(-overshoot);
}

/**
 * Константа времени упреждающего охлаждения per-tier (секунды).
 *
 * τ_cool(tier) = α × DUNBAR_TIER_THETA[tier]
 *
 * Заменяет старую глобальную фиксированную константу упреждающего охлаждения.
 *
 * @see docs/adr/154-goldilocks-window/README.md §3.2
 */
export function proactiveCooldownForTier(tier: DunbarTier): number {
  return GOLDILOCKS_ALPHA * DUNBAR_TIER_THETA[tier];
}
