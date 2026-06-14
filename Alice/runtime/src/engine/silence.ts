/**
 * D5 четырёхуровневый спектр молчания + инженерный предохранитель — Definition 10 статьи.
 *
 * Молчание — не просто "бездействие", а спектр решений с четырьмя теоретическими уровнями:
 *
 * L1: LOW_PRESSURE    — API < floor, делать нечего
 * L2: ACTIVE_COOLING  — подавление плотности действий, слишком много недавних действий
 * L3: STRATEGIC       — V(a,n) <= 0, ожидаемая отдача действия отрицательна
 * L4: DEFERRED        — VoI(null) > max NSV, выжидание лучше действия
 *
 * ADR-84: L5 в статье — это Degraded Action (деградированное действие), реализуется через V-maximizer fallback,
 * не входит в спектр молчания. CRISIS_OVERRIDE — инженерный предохранитель, обрабатывается gateCrisisMode в gate chain.
 *
 * @see paper-five-dim/ Definition 10: Silence Spectrum
 * @see paper-pomdp/ Def 5.3: Value of Information
 * @see docs/adr/84-theory-code-final-alignment.md
 */
import type { BeliefStore } from "../belief/store.js";
import type { SilenceLevel } from "./gates.js";

// Реэкспорт из gates.ts, чтобы потребителям не нужно было импортировать оба файла одновременно
export type { SilenceLevel } from "./gates.js";

/**
 * VoI-based silence (Paper 3, Def 5.3) — прокси через усиление Калмана.
 *
 * Исходное определение статьи: VoI(a_probe, bel) = E_o[V*(τ(bel, a_probe, o))] - V*(bel)
 * Полная реализация требует аппроксимации V* (вычислительно затратно).
 *
 * Упрощение: используем усиление Калмана K = σ² / (σ² + σ²_obs) как прокси VoI.
 * K означает "насколько следующее наблюдение снизит неопределённость" — чем больше K (σ² >> σ²_obs),
 * тем выше информационная ценность ожидания. Умножается на NSV_SCALE, чтобы VoI конкурировал с NSV в одном масштабе.
 *
 * Старая реализация использовала sigma2 * 0.001, что на два порядка ниже NSV,
 * делая математически невозможным срабатывание L4 отложенного молчания.
 *
 * @param focalEntities текущее множество фокальных сущностей
 * @param beliefs BeliefStore
 * @param _tick порядковый номер текущего tick (зарезервировано)
 * @param sigma2Obs дисперсия шума наблюдения (paper-pomdp Remark 4.3, по умолчанию 0.1)
 * @param nsvScale масштабирующий коэффициент типичного уровня NSV (делает VoI сопоставимым с NSV)
 * @returns значение VoI(null)
 *
 * @see paper-pomdp/ Def 5.3: Value of Information
 * @see paper-pomdp/ Proposition 5: Kalman gain simplification
 */
export function computeVoINull(
  focalEntities: string[],
  beliefs: BeliefStore,
  _tick: number,
  sigma2Obs: number = 0.1,
  nsvScale: number = 0.05,
): number {
  if (focalEntities.length === 0) return 0;
  let voiSum = 0;
  for (const eid of focalEntities) {
    // Kalman gain proxy: K = σ² / (σ² + σ²_obs)
    // высокий σ² → K ≈ 1 (наблюдение существенно снизит неопределённость) → ценность ожидания высока
    // низкий σ² → K ≈ 0 (уже очень уверены, ожидание почти не помогает) → ценность ожидания низка
    const bTier = beliefs.getOrDefault(eid, "tier");
    voiSum += bTier.sigma2 / (bTier.sigma2 + sigma2Obs);
    const bMood = beliefs.getOrDefault(eid, "mood");
    voiSum += bMood.sigma2 / (bMood.sigma2 + sigma2Obs);
  }
  // нормализуем по количеству фокальных сущностей, умножаем на NSV_SCALE для выравнивания масштаба с NSV
  return (voiSum / focalEntities.length) * nsvScale;
}

/**
 * Определение уровня молчания.
 *
 * Входные параметры — финальное состояние после прохождения цепочки gate.
 * Это сводная функция, классифицирующая решения отдельных gate из gates.ts по четырёхуровневому спектру.
 *
 * ADR-84: параметр isCrisis удалён — crisis обрабатывается gateCrisisMode в gate chain,
 * возвращает CRISIS_OVERRIDE, не проходит через classifySilence.
 *
 * Приоритет определения (от высокого к низкому):
 * 1. L4_DEFERRED      — VoI(null) > bestNSV и bestNSV > 0 (выжидание лучше действия)
 * 2. L3_STRATEGIC     — bestNSV <= 0 (ожидаемая отдача всех действий отрицательна)
 * 3. L2_ACTIVE_COOLING — подавление плотности действий (слишком много недавних)
 * 4. L1_LOW_PRESSURE  — недостаточное давление (запасной вариант по умолчанию)
 *
 * @see paper-five-dim/ Definition 10
 * @see docs/adr/84-theory-code-final-alignment.md
 */
export function classifySilence(
  _apiValue: number,
  _effectiveFloor: number,
  bestNSV: number,
  voiNull: number,
  isActiveCooling: boolean,
): SilenceLevel {
  // L4: отложенное действие — информационная ценность выжидания превышает чистую социальную ценность лучшего действия
  if (voiNull > bestNSV && bestNSV > 0) return "L4_DEFERRED";
  // L3: стратегическое молчание — ожидаемая отдача всех действий отрицательна
  if (bestNSV <= 0) return "L3_STRATEGIC";
  // L2: активное охлаждение — плотность действий слишком высока, подавляется экспоненциальным затуханием
  if (isActiveCooling) return "L2_ACTIVE_COOLING";
  // L1: низкое давление — общее давление системы недостаточно для действия
  return "L1_LOW_PRESSURE";
}
