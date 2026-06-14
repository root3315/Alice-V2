/**
 * Обновление убеждения — слияние наблюдений по двум каналам.
 *
 * Structural (структурный): явно заявленный LLM факт → перезаписывает mu, σ² → ε (близко к 0).
 * Semantic (семантический): нечёткий сигнал, выведенный LLM → EMA ≈ слияние Калмана.
 *
 * @see paper-pomdp/ Def 3.2
 */
import type { BeliefTriple } from "./types.js";

/** Остаточная дисперсия после structural-обновления (не нуль — сохраняет минимальную неопределённость). */
const STRUCTURAL_EPSILON = 0.01;

/** Вес EMA по умолчанию для semantic-обновления. */
const DEFAULT_ALPHA = 0.3;

/** Дисперсия шума наблюдения по умолчанию для semantic-обновления. */
const DEFAULT_NOISE = 0.1;

export interface UpdateOptions {
  /** Вес EMA α ∈ (0,1], только для semantic-канала. */
  alpha?: number;
  /** Дисперсия шума наблюдения, только для semantic-канала. */
  noise?: number;
}

/**
 * Обновляет убеждение на основе нового наблюдения.
 *
 * @param b - Текущий тройной вектор убеждения
 * @param observation - Значение наблюдения
 * @param channel - Канал обновления
 * @param nowMs - Текущее настенное время (мс). F4: заменено с tick на wall-clock ms.
 * @param options - Необязательные параметры
 * @returns Новый обновлённый BeliefTriple
 */
export function updateBelief(
  b: BeliefTriple,
  observation: number,
  channel: "structural" | "semantic",
  nowMs: number,
  options?: UpdateOptions,
): BeliefTriple {
  if (channel === "structural") {
    // Структурное обновление: LLM явно заявил — перезаписываем напрямую
    return {
      mu: observation,
      sigma2: STRUCTURAL_EPSILON,
      tObs: nowMs,
    };
  }

  // Семантическое обновление: EMA ≈ Kalman
  const alpha = options?.alpha ?? DEFAULT_ALPHA;
  const noise = options?.noise ?? DEFAULT_NOISE;

  const muNew = (1 - alpha) * b.mu + alpha * observation;
  // Семантический вывод не может быть достовернее явного заявления (structural) → нижняя граница σ² = STRUCTURAL_EPSILON
  const sigma2New = Math.max((1 - alpha) ** 2 * b.sigma2 + alpha ** 2 * noise, STRUCTURAL_EPSILON);

  return {
    mu: muNew,
    sigma2: sigma2New,
    tObs: nowMs,
  };
}
