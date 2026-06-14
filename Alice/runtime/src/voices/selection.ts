/**
 * Выбор действия (softmax с адаптивным τ).
 * Соответствует Python voices.py select_action().
 */
import { std } from "../utils/math.js";
import { VOICE_BY_INDEX, type VoiceAction } from "./personality.js";

/**
 * Softmax с адаптивной температурой.
 *
 * Адаптация температуры:
 * - высокая дифференциация голосов (std большой) → низкая температура → почти детерминированный выбор
 * - низкая дифференциация голосов (std малый) → высокая температура → больше исследования
 *
 * τ = 0.1 + 0.3 / (1 + std(L) · 10)
 *
 * @see paper-five-dim/ Def 3.6
 */
function voiceSoftmax(loudness: number[]): { probs: number[]; tau: number } {
  const spread = std(loudness);
  const tau = 0.1 + 0.3 / (1.0 + spread * 10.0);
  const maxL = Math.max(...loudness);
  const shifted = loudness.map((l) => l - maxL);
  const logProbs = shifted.map((s) => Math.max(-50.0, Math.min(0.0, s / tau)));
  const exps = logProbs.map(Math.exp);
  const probSum = exps.reduce((a, b) => a + b, 0);
  const probs =
    probSum > 0 ? exps.map((e) => e / probSum) : loudness.map(() => 1.0 / loudness.length);
  return { probs, tau };
}

/**
 * Вероятностный выбор действия.
 *
 * @returns [индекс победившего голоса, название типа действия]
 */
export function selectAction(
  loudness: number[],
  /** Случайное число в [0,1) для тестов; null — использовать Math.random() */
  randomOverride: number | null = null,
): [number, VoiceAction] {
  // защита от пустого массива (не должно происходить, но предотвращает Math.max(...[]) = -Infinity)
  if (loudness.length === 0) return [0, VOICE_BY_INDEX[0]];

  const { probs } = voiceSoftmax(loudness);

  // взвешенный случайный выбор
  const r = randomOverride ?? Math.random();
  let cumulative = 0;
  let winner = probs.length - 1; // хвост числа с плавающей точкой уходит к последнему голосу
  for (let i = 0; i < probs.length; i++) {
    cumulative += probs[i];
    if (r < cumulative) {
      winner = i;
      break;
    }
  }

  return [winner, VOICE_BY_INDEX[winner]];
}
