/**
 * ADR-112 D5: Метрики верификации естественности.
 *
 * Три наблюдаемых метрики для проверки естественности поведения:
 * - IDI (Interval Distribution Index): соответствие распределения интервалов действий распределению Вейбулла
 * - VDE (Voice Diversity Entropy): энтропия Шеннона при выборе голоса
 * - RAI (Reciprocal Adaptation Index): индекс взаимной адаптации
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
 * Вычисляет интервалы из последовательности временных меток действий.
 * Возвращает массив положительных интервалов (в миллисекундах) в хронологическом порядке.
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
 * Оценка максимального правдоподобия показателя степенного закона α (Clauset et al. 2009).
 *
 * MLE: α = 1 + n / Σ ln(x_i / x_min)
 *
 * @param intervals массив положительных интервалов
 * @returns оценка α (имеет смысл только при α > 1)
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
 * CDF степенного закона: F(x) = 1 - (x / x_min)^(-α + 1)
 */
function powerLawCDF(x: number, xMin: number, alpha: number): number {
  if (x < xMin) return 0;
  return 1 - (x / xMin) ** -(alpha - 1);
}

// ── Weibull MLE ──────────────────────────────────────────────────────────
// Weibull — промежуточное распределение между степенным законом и экспоненциальным: c<1 — степенноподобное, c=1 — экспоненциальное, c>1 — узкий хвост.
// @see Malmgren et al. (2008 PNAS) — Weibull лучше аппроксимирует интервалы активности человека, чем чистый степенной закон

/**
 * Двухпараметрический MLE для Weibull (Ньютон-Рафсон для shape c, аналитически для scale b).
 *
 * Weibull CDF: F(x) = 1 - exp(-(x/b)^c)
 *
 * Уравнение правдоподобия MLE (профильное правдоподобие по c):
 *   g(c) = 1/c + (1/n)Σln(x_i) - [Σ x_i^c · ln(x_i)] / [Σ x_i^c] = 0
 * Аналитическое решение для b: b = (Σ x_i^c / n)^(1/c)
 *
 * @param intervals массив положительных интервалов
 * @returns { c: shape, b: scale }
 */
export function estimateWeibullParams(intervals: number[]): { c: number; b: number } {
  const xs = intervals.filter((x) => x > 0);
  if (xs.length < 2) return { c: 1, b: xs[0] ?? 1 };

  const n = xs.length;
  const logXs = xs.map((x) => Math.log(x));
  const meanLogX = logXs.reduce((s, v) => s + v, 0) / n;

  // Итерация Ньютона-Рафсона для нахождения shape c
  let c = 1.0; // начальное значение: экспоненциальное распределение
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

    // гарантируем c > 0
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
 * CDF Weibull: F(x) = 1 - exp(-(x/b)^c)
 */
export function weibullCDF(x: number, c: number, b: number): number {
  if (x <= 0) return 0;
  return 1 - Math.exp(-((x / b) ** c));
}

// ── Статистика KS ────────────────────────────────────────────────────────────

/**
 * Общая статистика Колмогорова-Смирнова: максимальное расстояние между эмпирическим распределением и произвольной теоретической CDF.
 * @param sorted отсортированный массив положительных значений
 * @param cdf теоретическая функция CDF
 */
function ksDistance(sorted: number[], cdf: (x: number) => number): number {
  const n = sorted.length;
  if (n === 0) return 0;

  let maxD = 0;
  for (let i = 0; i < n; i++) {
    const theoreticalCDF = cdf(sorted[i]);
    const empiricalCDF = (i + 1) / n;
    maxD = Math.max(maxD, Math.abs(empiricalCDF - theoreticalCDF));
    // также проверяем левую точку скачка
    const empiricalLeft = i / n;
    maxD = Math.max(maxD, Math.abs(empiricalLeft - theoreticalCDF));
  }
  return maxD;
}

/**
 * Статистика Колмогорова-Смирнова (версия для степенного закона, сохранена для параллельной верификации).
 */
export function ksStatistic(intervals: number[], alpha: number): number {
  if (intervals.length === 0) return 0;
  const sorted = [...intervals].sort((a, b) => a - b);
  const xMin = sorted[0];
  return ksDistance(sorted, (x) => powerLawCDF(x, xMin, alpha));
}

/**
 * IDI (Interval Distribution Index): соответствие распределения интервалов действий распределению Weibull.
 *
 * IDI = 1 - KS_distance(empirical, weibull_fit)
 * IDI > 0.7 → ритм поведения естественен (Weibull универсальнее аппроксимирует интервалы активности человека, чем чистый степенной закон).
 *
 * @param recentActions последние записи о действиях (требуются временные метки ms)
 * @returns IDI ∈ [0, 1], null при нехватке данных
 */
export function computeIDI(recentActions: ReadonlyArray<{ ms: number }>): number | null {
  const timestamps = recentActions.map((a) => a.ms);
  const intervals = computeIntervals(timestamps);

  // для значимой аппроксимации нужно не менее 5 интервалов
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
 * VDE (Voice Diversity Entropy): энтропия Шеннона при выборе голоса.
 *
 * VDE = -Σ p_v × log(p_v) / log(|V|)
 * Нормализовано до [0, 1]. VDE > 0.6 → разнообразие голосов достаточно.
 *
 * @param recentActions последние записи о действиях (требуются имена action/voice)
 * @param voiceCount общее число голосов (по умолчанию 4: Diligence, Caution, Sociability, Exploration)
 * @returns VDE ∈ [0, 1], null при нехватке данных
 */
export function computeVDE(
  recentActions: ReadonlyArray<{ action: string }>,
  voiceCount = 4,
): number | null {
  if (recentActions.length < 3 || voiceCount < 2) return null;

  // подсчёт числа появлений каждого голоса
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

  // нормализация до [0, 1]
  const maxEntropy = Math.log(voiceCount);
  if (maxEntropy === 0) return 0;
  return Math.min(1, entropy / maxEntropy);
}

// ═══════════════════════════════════════════════════════════════════════════
// RAI: Reciprocal Adaptation Index
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Коэффициент корреляции Пирсона.
 * @returns r ∈ [-1, 1], 0 при нехватке данных или нулевой дисперсии
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
 * RAI (Reciprocal Adaptation Index): индекс взаимной адаптации.
 *
 * Вычисляет корреляцию между интервалами ответов Alice и активностью соответствующих каналов.
 * RAI ∈ [-0.3, 0.3] → естественная адаптация (ни механическая синхронизация, ни полное игнорирование).
 *
 * Для каждого отслеживаемого канала из графа извлекается:
 * - Интервал ответа Alice: вычисляется на основе last_alice_action_ms
 * - Активность канала: unread + contact_recv_window как прокси активности
 *
 * @param G граф компаньона
 * @returns RAI ∈ [-1, 1], null при нехватке данных
 */
export function computeRAI(G: WorldModel, nowMs = Date.now()): number | null {
  // собираем пары данных по отслеживаемым каналам из графа
  const responseIntervals: number[] = [];
  const activityLevels: number[] = [];

  for (const chId of G.getEntitiesByType("channel")) {
    const attrs = G.getChannel(chId);
    const lastAliceMs = Number(attrs.last_alice_action_ms ?? 0);
    const lastActiveMs = Number(attrs.last_activity_ms ?? 0);
    const unread = Number(attrs.unread ?? 0);
    const recvWindow = Number(attrs.contact_recv_window ?? 0);

    // требуется наличие записей активности как от Alice, так и от канала
    if (lastAliceMs <= 0 || lastActiveMs <= 0) continue;

    // Интервал ответа Alice (ms): текущее время - последнее действие Alice
    // чем больше, тем медленнее Alice отвечает
    const responseInterval = nowMs - lastAliceMs;

    // Активность канала: непрочитанные сообщения + накопленное число принятых сообщений как прокси
    const activityLevel = unread + recvWindow;

    if (responseInterval > 0 && activityLevel >= 0) {
      responseIntervals.push(responseInterval);
      activityLevels.push(activityLevel);
    }
  }

  if (responseIntervals.length < 3) return null;

  // Отрицательная корреляция: в активных каналах Alice отвечает быстрее → естественная адаптация
  // Положительная корреляция: в активных каналах Alice отвечает медленнее → неестественно
  // Близко к 0 → независимость (тоже естественно)
  return pearsonCorrelation(responseIntervals, activityLevels);
}

// ═══════════════════════════════════════════════════════════════════════════
// Агрегированные метрики
// ═══════════════════════════════════════════════════════════════════════════

export interface NaturalnessMetrics {
  /** Соответствие распределения интервалов действий Weibull ∈ [0,1]. null = недостаточно данных. */
  idi: number | null;
  /** Энтропия разнообразия голосов ∈ [0,1]. null = недостаточно данных. */
  vde: number | null;
  /** Взаимная адаптация ∈ [-1,1]. null = недостаточно данных. */
  rai: number | null;
}

/**
 * Вычисляет все метрики естественности.
 *
 * @param G граф компаньона
 * @param recentActions последние записи о действиях
 * @param nowMs текущее время настенных часов
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
