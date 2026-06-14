/**
 * Per-contact Hawkes самовозбуждающийся процесс — модель предсказания среды.
 *
 * Независимо моделирует самовозбуждающуюся динамику входящих сообщений для каждого контакта:
 *   λ(t) = μ + λ_carry · exp(-β · Δt)
 *
 * Рекурсивное O(1) онлайн-обновление, начальные параметры задаются по уровню Dunbar tier.
 * Чистый функциональный модуль — никаких побочных эффектов, никакого IO.
 *
 * Позиция в когнитивной архитектуре:
 *   - signal-decay.ts = сенсорный регистр (затухание сигнала на стороне Alice)
 *   - hawkes.ts = модель предсказания среды (прогноз поведенческих паттернов собеседника)
 *   Оба ортогональны и не заменяют друг друга.
 *
 * @see docs/adr/153-per-contact-hawkes/README.md
 * @see Masuda et al. 2013: Self-exciting point process modeling of conversation
 * @see Hawkes (1971): Spectra of some self-exciting and mutually exciting point processes
 */

import type { DunbarTier } from "../graph/entities.js";

// ═══════════════════════════════════════════════════════════════════════════
// Определения типов
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Параметры процесса Hawkes для отдельного контакта.
 * Для каждого контакта своя независимая группа; начальные значения берутся из таблицы tier, возможна онлайн-калибровка.
 *
 * Условие устойчивости: α/β < 1 (коэффициент ветвления < 1), иначе процесс взрывается.
 *
 * @see docs/adr/153-per-contact-hawkes/README.md §3
 */
export interface HawkesParams {
  /** Базовая интенсивность μ (events/s). "Частота сообщений собеседника без внешних стимулов". */
  readonly mu: number;
  /** Интенсивность самовозбуждения α. Скачок λ при поступлении события. */
  readonly alpha: number;
  /** Скорость затухания β (1/s). Скорость угасания эффекта самовозбуждения. halfLife = ln2/β. */
  readonly beta: number;
}

/**
 * Состояние среды выполнения Hawkes для отдельного контакта.
 * Для O(1) онлайн-обновления достаточно всего двух чисел.
 *
 * Стратегия хранения: сохраняется в атрибутах узла графа (ContactAttrs),
 * персистируется вместе со снимком графа в SQLite.
 */
export interface HawkesState {
  /** Накопленная величина возбуждения (промежуточная переменная рекурсивного обновления). */
  lambdaCarry: number;
  /** Время настенных часов последнего события (ms). 0 = нет истории событий. */
  lastEventMs: number;
}

/**
 * Результат запроса интенсивности Hawkes.
 */
export interface HawkesIntensity {
  /** Мгновенная интенсивность λ(t) = μ + carry_decayed. */
  lambda: number;
  /** Базовая интенсивность μ (для нормализации). */
  mu: number;
  /** Компонент самовозбуждения λ(t) - μ (чистый прирост активности разговора). */
  excitation: number;
  /** Нормализованная «теплота» excitation / (α/β), clamp [0, 1]. */
  normalizedHeat: number;
}

// ═══════════════════════════════════════════════════════════════════════════
// Таблица параметров по умолчанию
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Dunbar tier → параметры Hawkes по умолчанию.
 *
 * Обоснование дизайна:
 * - μ ≈ 4 / DUNBAR_TIER_THETA — базовая частота сообщений (1/μ ≈ θ_c/4).
 *   Смысл: «порог охлаждения θ_c примерно в 4 раза больше типичного интервала между сообщениями» — давление охлаждения отношений накапливается только при превышении интервала в 4 раза.
 * - α: консервативное значение, коэффициент ветвления α/β ∈ [0.36, 0.91]
 * - β: у близких друзей остаточная теплота сохраняется дольше (полупериод ~3.5 мин), у дальних контактов угасает быстрее (~21 мин)
 *
 * @see docs/adr/153-per-contact-hawkes/README.md §3.1
 * @see docs/adr/151-algorithm-audit/research-online-calibration.md §2.1
 */
export const HAWKES_TIER_DEFAULTS: Record<DunbarTier, HawkesParams> = {
  5: { mu: 5.6e-4, alpha: 0.003, beta: 3.3e-3 },
  15: { mu: 2.8e-4, alpha: 0.002, beta: 2.8e-3 },
  50: { mu: 9.3e-5, alpha: 0.001, beta: 1.1e-3 },
  150: { mu: 2.3e-5, alpha: 0.0005, beta: 8.3e-4 },
  500: { mu: 5.8e-6, alpha: 0.0002, beta: 5.6e-4 },
};

/**
 * Корректирующие коэффициенты параметров Hawkes для группового чата.
 *
 * Большинство сообщений в группе не адресованы Alice, самовозбуждение слабее, затухание быстрее.
 * Определение события: учитываются только directed / mentions_alice сообщения.
 *
 * @see docs/adr/153-per-contact-hawkes/README.md §3.3
 */
export const HAWKES_GROUP_MODIFIERS = {
  /** Скидка α — самовозбуждение в группе слабее, чем в личном чате. */
  alphaDiscount: 0.3,
  /** Множитель β — переключение тем в группе происходит быстрее. */
  betaMultiplier: 1.5,
} as const;

// ═══════════════════════════════════════════════════════════════════════════
// Основные чистые функции
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Запрашивает мгновенную интенсивность Hawkes λ(t) для контакта. O(1).
 * Чистая функция — не изменяет state.
 *
 * λ(t) = μ + λ_carry · exp(-β · Δt_s)
 *
 * Холодный старт (lastEventMs = 0) деградирует до чистой базовой интенсивности μ.
 *
 * @param params - параметры Hawkes контакта
 * @param state - состояние среды выполнения Hawkes контакта
 * @param nowMs - текущее время настенных часов (ms)
 */
export function queryIntensity(
  params: HawkesParams,
  state: HawkesState,
  nowMs: number,
): HawkesIntensity {
  const { mu, alpha, beta } = params;

  // Холодный старт: нет исторических событий → чистая базовая интенсивность
  if (state.lastEventMs <= 0 || state.lambdaCarry <= 0) {
    return { lambda: mu, mu, excitation: 0, normalizedHeat: 0 };
  }

  const dtS = Math.max(0, (nowMs - state.lastEventMs) / 1000);
  const carryDecayed = state.lambdaCarry * Math.exp(-beta * dtS);
  const lambda = mu + carryDecayed;
  const excitation = carryDecayed;

  // Нормализованная «теплота»: excitation / theoreticalMax, clamp [0, 1].
  //
  // Исправление по результатам аудита: старая нормализация excitation/(α/β) использовала
  // коэффициент ветвления как ориентир, но excitation нескольких подряд идущих сообщений
  // уже превышает α/β (α/β ≈ 0.9), из-за чего normalizedHeat для всех активных диалогов
  // зажимается до 1.0 (бинарный переключатель).
  //
  // Новый ориентир: α/(1 - α/β) = α·β/(β-α) — теоретический предел excitation
  // при бесконечно быстрых последовательных событиях.
  // Для таблицы параметров α/β ∈ [0.36, 0.91] это значение в 1.6–11 раз больше α/β,
  // что обеспечивает непрерывную чувствительность normalizedHeat в диапазоне 2–20 сообщений.
  const branchRatio = beta > 0 ? alpha / beta : 0;
  const theoreticalMax = branchRatio < 1 && beta > alpha ? (alpha * beta) / (beta - alpha) : alpha;
  const normalizedHeat = Math.min(1, theoreticalMax > 0 ? excitation / theoreticalMax : 0);

  return { lambda, mu, excitation, normalizedHeat };
}

/**
 * Обновляет состояние Hawkes для контакта (вызывается при поступлении события). O(1).
 * Возвращает новое состояние (иммутабельное обновление).
 *
 * λ_carry_new = λ_carry_old · exp(-β · Δt_s) + α
 *
 * Сначала затухает старый carry, затем накладывается новое возбуждение — гарантирует рекурсивную точность.
 *
 * @param params - параметры Hawkes контакта
 * @param state - старое состояние
 * @param eventMs - время поступления события (ms)
 */
export function updateOnEvent(
  params: HawkesParams,
  state: HawkesState,
  eventMs: number,
): HawkesState {
  const { alpha, beta } = params;

  // Первое событие или защита от обратного хода времени
  if (state.lastEventMs <= 0 || eventMs <= state.lastEventMs) {
    return { lambdaCarry: alpha, lastEventMs: eventMs };
  }

  const dtS = (eventMs - state.lastEventMs) / 1000;
  const decayedCarry = state.lambdaCarry * Math.exp(-beta * dtS);
  return {
    lambdaCarry: decayedCarry + alpha,
    lastEventMs: eventMs,
  };
}

/**
 * Возвращает параметры Hawkes по умолчанию для заданного Dunbar tier с опциональной групповой коррекцией.
 *
 * Групповая коррекция: α × alphaDiscount (0.3), β × betaMultiplier (1.5).
 * μ остаётся неизменным (определение группового события уже отфильтровано до directed-сообщений, семантика базовой частоты та же).
 *
 * @param tier - Dunbar tier
 * @param isGroup - является ли сценарий групповым
 */
export function getDefaultParams(tier: DunbarTier, isGroup?: boolean): HawkesParams {
  const base = HAWKES_TIER_DEFAULTS[tier] ?? HAWKES_TIER_DEFAULTS[50];
  if (!isGroup) return base;
  return {
    mu: base.mu,
    alpha: base.alpha * HAWKES_GROUP_MODIFIERS.alphaDiscount,
    beta: base.beta * HAWKES_GROUP_MODIFIERS.betaMultiplier,
  };
}

/**
 * Инициализирует нулевое состояние (новый контакт / нет истории).
 */
export function initialState(): HawkesState {
  return { lambdaCarry: 0, lastEventMs: 0 };
}

/**
 * Вычисляет Hawkes λ discount для per-candidate λ модуляции в V-maximizer.
 *
 * Высокая «теплота» разговора (normalizedHeat → 1) → низкий discount → снижение социальных издержек → большая готовность ответить.
 * Холодный разговор (normalizedHeat → 0) → discount = 1.0 → без влияния.
 *
 * discount = 1 - 0.3 × normalizedHeat, clamp [0.7, 1.0]
 *
 * @param intensity - возвращаемое значение queryIntensity
 * @returns ∈ [0.7, 1.0]
 */
export function computeHawkesLambdaDiscount(intensity: HawkesIntensity): number {
  return Math.max(0.7, 1 - 0.3 * intensity.normalizedHeat);
}

// ═══════════════════════════════════════════════════════════════════════════
// Phase 2: онлайн-калибровка μ + циркадная модуляция
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Порог байесовской онлайн-калибровки: требуется 30 событий для полного доверия наблюдениям.
 * w = min(1, event_count / N_threshold)
 *
 * @see docs/adr/153-per-contact-hawkes/README.md §3.2
 */
export const MU_CALIBRATION_THRESHOLD = 30;

/**
 * Вычисляет эффективную базовую частоту μ_eff с учётом онлайн-калибровки и циркадной модуляции.
 *
 * Обе коррекции можно применять независимо или совместно:
 * 1. Онлайн-калибровка: μ_eff = prior_μ × (1-w) + observed_μ × w
 * 2. Циркадная модуляция: μ_eff × (circadianFactor / 1.5)
 *
 * Диапазон circadianMultiplier [0.5, 2.5], среднее за 24 ч = 1.5.
 * Деление на 1.5 нормализует так, что среднее μ_eff за 24 ч = μ_tier.
 *
 * @param tierMu - μ по умолчанию для tier (events/s)
 * @param eventCount - накопленное число событий (опционально)
 * @param firstEventMs - время первого события в ms (опционально)
 * @param nowMs - текущее время в ms (опционально)
 * @param circadianFactor - возвращаемое значение circadianMultiplier (опционально)
 *
 * @see docs/adr/153-per-contact-hawkes/README.md §3.2
 * @see simulation/experiments/exp_hawkes_phase2_validation.py валидация 4/5
 */
export function effectiveMu(
  tierMu: number,
  eventCount?: number,
  firstEventMs?: number,
  nowMs?: number,
  circadianFactor?: number,
): number {
  let mu = tierMu;

  // Онлайн-калибровка: накопленная частота = event_count / duration
  if (
    eventCount != null &&
    eventCount > 0 &&
    firstEventMs != null &&
    firstEventMs > 0 &&
    nowMs != null
  ) {
    const durationS = (nowMs - firstEventMs) / 1000;
    if (durationS > 60) {
      const observedMu = eventCount / durationS;
      const w = Math.min(1, eventCount / MU_CALIBRATION_THRESHOLD);
      mu = tierMu * (1 - w) + observedMu * w;
    }
  }

  // Циркадная модуляция: circadianMultiplier ∈ [0.5, 2.5], mean=1.5
  if (circadianFactor != null) {
    mu *= circadianFactor / 1.5;
  }

  return Math.max(mu, 1e-8);
}
