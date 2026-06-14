/**
 * Агрегация давления: нормализация API и полный вычислительный конвейер.
 * Соответствует Python pressure.py api_aggregate() + compute_all_pressures().
 */

import { DEFAULT_KAPPA } from "../graph/constants.js";
import type { WorldModel } from "../graph/world-model.js";
import type { PressureDims } from "../utils/math.js";
import { tanhNormalize } from "../utils/math.js";
import { pProspect } from "./p-prospect.js";
import { p1AttentionDebt } from "./p1-attention.js";
import { p2InformationPressure } from "./p2-information.js";
import { p3RelationshipCooling } from "./p3-relationship.js";
import { p4ThreadDivergence } from "./p4-thread.js";
import { p5ResponseObligation } from "./p5-response.js";
import { type CuriosityHistory, p6CuriosityWithHistory } from "./p6-curiosity.js";
import type { PropagationConfig } from "./propagation.js";
import { propagatePressuresMatrix as propagatePressures } from "./propagation.js";

export type { PressureResult } from "./p1-attention.js";

// ═══════════════════════════════════════════════════════════════════════════
// ADR-112 D4: AdaptiveKappa — адаптивное κ, управляемое статистикой сигналов во время выполнения
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Адаптивное κ: динамически подстраивается на основе статистики сигналов во время выполнения.
 *
 * κ_k(n) = max(κ_min_k, EMA_k(n))
 * EMA_k(n) = α × |P_k(n)| + (1-α) × EMA_k(n-1)
 * α = 0.02 (полупериод 50 тиков)
 *
 * Эффект: после работы P3=16.55 → κ₃ автоматически повышается → tanh(16.55/κ₃) больше не насыщается.
 *
 * @see docs/adr/112-pressure-dynamics-rehabilitation/ §D4
 */
export class AdaptiveKappa {
  private ema: [number, number, number, number, number, number];
  private readonly kappaMin: [number, number, number, number, number, number];
  /** Полупериод EMA (секунды). Исправление по аудиту: изменён с tick-based alpha на time-driven. */
  private readonly halfLifeS: number;

  /**
   * @param kappaMin минимальное kappa для каждого измерения
   * @param halfLifeS полупериод EMA (секунды). По умолчанию 1500s (25 минут) —
   *   эквивалентно старому поведению alpha=0.02 при tick=30s (50 ticks × 30s).
   *   Time-driven подход обеспечивает одинаковую скорость адаптации по настенным часам
   *   для patrol-режима (tick=300s) и conversation-режима (tick=30s).
   */
  constructor(kappaMin: [number, number, number, number, number, number], halfLifeS = 1500) {
    this.kappaMin = [...kappaMin] as [number, number, number, number, number, number];
    this.halfLifeS = halfLifeS;
    // Начальный EMA = kappaMin (при холодном старте используются жёстко заданные значения по умолчанию)
    this.ema = [...kappaMin] as [number, number, number, number, number, number];
  }

  /**
   * Обновляет EMA и возвращает текущее действующее kappa.
   * Вызывается один раз за тик, после завершения computeAllPressures.
   *
   * @param pressures шестимерные значения давления текущего тика
   * @param dtS интервал тика (секунды). Используется для вычисления time-driven alpha.
   *   alpha = 1 - exp(-dt * ln2 / halfLife) — гарантирует постоянный полупериод EMA
   *   по настенным часам независимо от изменения интервала тика.
   */
  update(
    pressures: [number, number, number, number, number, number],
    dtS?: number,
  ): [number, number, number, number, number, number] {
    // Time-driven alpha: чем больше dt, тем больше alpha (шаг шире)
    const effectiveDt = dtS != null && dtS > 0 ? dtS : 60; // fallback 60s
    const alpha = 1 - Math.exp((-effectiveDt * Math.LN2) / this.halfLifeS);
    for (let i = 0; i < 6; i++) {
      this.ema[i] = alpha * Math.abs(pressures[i]) + (1 - alpha) * this.ema[i];
    }
    return this.current();
  }

  /** Возвращает текущее действующее kappa (max(kappaMin, EMA)). */
  current(): [number, number, number, number, number, number] {
    return [
      Math.max(this.kappaMin[0], this.ema[0]),
      Math.max(this.kappaMin[1], this.ema[1]),
      Math.max(this.kappaMin[2], this.ema[2]),
      Math.max(this.kappaMin[3], this.ema[3]),
      Math.max(this.kappaMin[4], this.ema[4]),
      Math.max(this.kappaMin[5], this.ema[5]),
    ];
  }

  /** Для сериализации/отладки. */
  toDict(): { ema: number[]; kappaMin: number[] } {
    return { ema: [...this.ema], kappaMin: [...this.kappaMin] };
  }
}

export interface AllPressures {
  P1: number;
  P2: number;
  P3: number;
  P4: number;
  P5: number;
  P6: number;
  /** ADR-23: перспективное давление (управляется Thread horizon). Равно 0 при отсутствии horizon. */
  P_prospect: number;
  /** API ∈ [0, 7): 6 × tanh(P_k/κ_k) ∈ [0,1) + tanh(P_prospect/κ_prospect) ∈ [0,1). */
  API: number;
  /** ADR-195: Peak-based API ∈ [0, 7) — tanh-нормализация максимального вклада одной сущности по каждому измерению. Управляет интервалом тика. */
  API_peak: number;
  /** A(n) = A_max · tanh(API(n) / κ) */
  A: number;
  /** Вклады сущностей по каждой компоненте давления (включая эффективные значения после распространения) */
  contributions: Record<string, Record<string, number>>;
  /** ADR-26: вклады P_prospect по каждой сущности (используется в buildTensionMap). */
  prospectContributions: Record<string, number>;
  /** D2 Trend: история суммарного давления по измерениям за последние N тиков (без текущего тика), используется для вычисления Trend в Semantic Triple ⟨F,T,S⟩. */
  pressureHistory: {
    P1: number[];
    P2: number[];
    P3: number[];
    P4: number[];
    P5: number[];
    P6: number[];
  };
}

// -- D2 Trend: кольцевой буфер истории давления (инстанциируется, не персистируется, после перезапуска накапливается заново) ------

const PRESSURE_HISTORY_SIZE = 10;

/** Экземпляр истории давления — устраняет глобальное изменяемое состояние, обеспечивает изоляцию тестов. */
export type PressureHistory = Array<[number, number, number, number, number, number]>;

/** Создаёт пустой экземпляр истории давления. */
export function createPressureHistory(): PressureHistory {
  return [];
}

/**
 * API(G, n) = Σ_k tanh(P_k / κ_k) ∈ [0, 6)
 *
 * v4: tanh-нормализация. API — чистое наблюдаемое, не поступает на вход ни одной функции давления.
 */
export function apiAggregate(
  p1: number,
  p2: number,
  p3: number,
  p4: number,
  p5: number,
  p6: number,
  kappa: PressureDims = DEFAULT_KAPPA,
): number {
  const raw = [p1, p2, p3, p4, p5, p6];
  let sum = 0;
  for (let i = 0; i < 6; i++) {
    sum += tanhNormalize(raw[i], kappa[i]);
  }
  return sum;
}

/**
 * ADR-195: Peak-based API — tanh-нормализация максимального вклада одной сущности по каждому измерению.
 * Интенсивная метрика by construction: не растёт с увеличением числа сущностей.
 *
 * API_peak = Σ_k tanh(max_e(P_k(e)) / κ_k)
 *
 * @see docs/adr/195-pressure-saturation-tick-storm.md
 */
export function apiPeak(
  contribSources: Record<string, number>[],
  kappa: PressureDims = DEFAULT_KAPPA,
): number {
  let sum = 0;
  for (let i = 0; i < contribSources.length && i < 6; i++) {
    const contribs = contribSources[i];
    let maxVal = 0;
    for (const v of Object.values(contribs)) {
      if (v > maxVal) maxVal = v;
    }
    sum += tanhNormalize(maxVal, kappa[i]);
  }
  return sum;
}

/**
 * A(n) = A_max · tanh(API(n) / κ)
 */
export function observableMapping(api: number, aMax: number = 10.0, kappa: number = 20.0): number {
  return aMax * Math.tanh(api / kappa);
}

/**
 * Вычисляет все шесть давлений + распространение Лапласиана + нормализованный API.
 *
 * Конвейер v4:
 * 1. Вычислить локальные давления P1-P6 (P3 не читает API)
 * 2. Распространение: p_eff = propagate(G, local, μ)
 * 3. Нормализованный API = Σ tanh(P_k / κ_k)
 *
 * @see paper/ §3 eq 1-6: P_k(G, n) = f_k(G, n)
 * @see paper/ §5: API(G,n) = Σ tanh(P_k/κ_k)
 */
export function computeAllPressures(
  G: WorldModel,
  n: number,
  options: {
    kappa?: [number, number, number, number, number, number];
    threadAgeScale?: number;
    mu?: number;
    d?: number;
    /** @deprecated Исправление по аудиту: компонента forecast удалена из P4, теперь централизованно обрабатывается через P_prospect. Параметр сохранён во избежание ошибок компиляции на стороне вызывающего кода. */
    deltaDeadline?: number;
    /** ADR-23: крутизна сигмоиды P_prospect. */
    kSteepness?: number;
    /** ADR-23: нормализующее κ для P_prospect. */
    kappaProspect?: number;
    /** D2 Trend: внешне управляемый экземпляр истории давления (устраняет глобальное изменяемое состояние). */
    history?: PressureHistory;
    /** Текущее время по настенным часам (миллисекунды). Обязательно после миграции dt в формулах давления. */
    nowMs?: number;
    /** ADR-112 D2: базовое значение фонового любопытства η. */
    eta?: number;
    /** ADR-112: P6 curiosity pressure smoothing window. */
    k?: number;
    /** ADR-268/P6 audit: явная история сглаживания curiosity, исключает разделяемое состояние на уровне модуля. */
    curiosityHistory?: CuriosityHistory;
    /** Коэффициент инерции FJ-MM ρ ∈ [0,1). Смешивает локальное давление с историческим средним перед распространением, подавляя переходные выбросы. По умолчанию 0.2. Установить 0 для отключения. */
    rho?: number;
    /** Конфигурация распространения APPNP. Если не задано, используется legacy one-hop. */
    propagationConfig?: PropagationConfig;
    /** ADR-161 §3.4: EMA скорости сообщений per-channel (передаётся в P3 для управления theta через траекторию группы). */
    channelRateEma?: Map<string, { ema: number; variance: number }>;
    /** ADR-161 §3.4: продолжительность текущего тика по настенным часам (секунды), используется для пересчёта единиц EMA. */
    tickDt?: number;
  } = {},
): AllPressures {
  const {
    kappa = DEFAULT_KAPPA,
    threadAgeScale = 86_400,
    mu = 0.3,
    d = -0.5,
    deltaDeadline: _deltaDeadline,
    kSteepness = 5.0,
    kappaProspect = 3.0,
    history,
    nowMs = Date.now(),
    eta = 0.6,
    k = 20,
    curiosityHistory,
    rho = 0.2,
    propagationConfig,
    channelRateEma,
    tickDt,
  } = options;

  // 1. Локальные давления
  const r1 = p1AttentionDebt(G, nowMs);
  const r2 = p2InformationPressure(G, n, nowMs, d);
  const r3 = p3RelationshipCooling(G, n, nowMs, channelRateEma, tickDt);
  const r4 = p4ThreadDivergence(G, n, nowMs, threadAgeScale);
  const r5 = p5ResponseObligation(G, n, nowMs);
  const r6 = p6CuriosityWithHistory(G, nowMs, eta, k, curiosityHistory);

  // ADR-23: P_prospect (независимое аддитивное слагаемое, не участвует в распространении Лапласиана)
  const rProspect = pProspect(G, n, nowMs, kSteepness);

  // 2. Инерционное сглаживание FJ-MM + распространение Лапласиана
  // FJ-MM: перед распространением смешивает суммарное локальное давление с историческим средним, подавляя переходные выбросы.
  // p_smoothed_k = (1-rho) * p_local_k + rho * mean(history[-2:])[k]
  // Коэффициент масштабирования вычисляется по измерениям и пропорционально применяется к per-entity contributions.
  // API aggregate по-прежнему использует исходный p_local (для сохранения чувствительности).
  const rawTotals = [r1.total, r2.total, r3.total, r4.total, r5.total, r6.total];
  const smoothingRatios = [1, 1, 1, 1, 1, 1];
  if (rho > 0 && history && history.length > 0) {
    const lastN = history.slice(-2);
    const histMean = [0, 0, 0, 0, 0, 0];
    for (const h of lastN) {
      for (let i = 0; i < 6; i++) histMean[i] += h[i];
    }
    for (let i = 0; i < 6; i++) histMean[i] /= lastN.length;
    for (let i = 0; i < 6; i++) {
      const smoothed = (1 - rho) * rawTotals[i] + rho * histMean[i];
      // Исправление по аудиту: clamp smoothingRatio в [0.1, 10], предотвращает экстремальное увеличение коэффициента при резком падении давления.
      // Старый код мог давать множитель порядка 10^6, когда rawTotals падало с высокого значения до 1e-14.
      const rawRatio = rawTotals[i] > 1e-15 ? smoothed / rawTotals[i] : 1;
      smoothingRatios[i] = Math.max(0.1, Math.min(10, rawRatio));
    }
  }

  const contribSources = [
    r1.contributions,
    r2.contributions,
    r3.contributions,
    r4.contributions,
    r5.contributions,
    r6.contributions,
  ];
  const localAll: Record<string, number> = {};
  for (let dim = 0; dim < 6; dim++) {
    const ratio = smoothingRatios[dim];
    for (const [eid, val] of Object.entries(contribSources[dim])) {
      localAll[eid] = (localAll[eid] ?? 0.0) + val * ratio;
    }
  }
  const pEff = propagatePressures(G, localAll, mu, nowMs, propagationConfig);

  // Распределяем прирост от распространения по исходной принадлежности
  const effContributions: Record<string, Record<string, number>> = {
    P1: {},
    P2: {},
    P3: {},
    P4: {},
    P5: {},
    P6: {},
  };
  const contribPairs: [string, Record<string, number>][] = [
    ["P1", r1.contributions],
    ["P2", r2.contributions],
    ["P3", r3.contributions],
    ["P4", r4.contributions],
    ["P5", r5.contributions],
    ["P6", r6.contributions],
  ];
  for (const [pk, ck] of contribPairs) {
    for (const [eid, localVal] of Object.entries(ck)) {
      const totalLocal = localAll[eid] ?? 0;
      const totalEff = pEff[eid] ?? totalLocal;
      if (totalLocal > 1e-10) {
        // Распределяем эффективное значение после распространения пропорционально исходному вкладу (защита 1e-10 предотвращает деление на ноль из-за взаимного уничтожения плавающей точки)
        effContributions[pk][eid] = localVal * (totalEff / totalLocal);
      } else {
        effContributions[pk][eid] = localVal;
      }
    }
  }

  // 3. tanh-нормализованный API (чистое наблюдаемое) + независимое аддитивное слагаемое P_prospect
  // Проектное решение: API использует предраспространяемые локальные суммы (r_k.total), распространение влияет только на per-entity contributions.
  // Это связано с тем, что API — глобальный индикатор порога действия, не требующий гранулярности по сущностям;
  // при этом прирост от распространения в contributions используется для выбора фокусного множества и построения Tension Map.
  const apiBase = apiAggregate(r1.total, r2.total, r3.total, r4.total, r5.total, r6.total, kappa);
  const prospectTerm = tanhNormalize(rProspect.total, kappaProspect);
  const api = apiBase + prospectTerm;
  const a = observableMapping(api);

  // D2 Trend: формируем историю по измерениям (без текущего тика) → затем обновляем кольцевой буфер
  // Если history отсутствует, возвращаем пустую историю (обратная совместимость: dry-run и вызовы без trend)
  const buf = history ?? [];
  const historyByDim = {
    P1: buf.map((h) => h[0]),
    P2: buf.map((h) => h[1]),
    P3: buf.map((h) => h[2]),
    P4: buf.map((h) => h[3]),
    P5: buf.map((h) => h[4]),
    P6: buf.map((h) => h[5]),
  };
  if (history) {
    history.push([r1.total, r2.total, r3.total, r4.total, r5.total, r6.total]);
    if (history.length > PRESSURE_HISTORY_SIZE) history.shift();
  }

  // ADR-195: Peak-based API — использует исходные pre-smoothing contributions (тот же источник, что и apiBase)
  const apiPeakVal = apiPeak(contribSources, kappa);
  // Аддитивное слагаемое prospect переиспользуется (в peak-сценарии у prospect только одно значение, peak=total)
  const apiPeakTotal = apiPeakVal + prospectTerm;

  return {
    P1: r1.total,
    P2: r2.total,
    P3: r3.total,
    P4: r4.total,
    P5: r5.total,
    P6: r6.total,
    P_prospect: rProspect.total,
    API: api,
    API_peak: apiPeakTotal,
    A: a,
    contributions: effContributions,
    prospectContributions: rProspect.contributions,
    pressureHistory: historyByDim,
  };
}
