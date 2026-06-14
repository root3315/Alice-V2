/**
 * Чистые математические вспомогательные функции — взаимно однозначно соответствуют вспомогательным функциям в Python simulation/pressure.py.
 */

// -- Типы измерений ---------------------------------------------------------

/** 4-мерный вектор весов личности [diligence, curiosity, sociability, caution]. ADR-81: Reflection удалён. */
export type PersonalityWeights = [number, number, number, number];

/** 7-мерный вектор напряжений [tau1, tau2, tau3, tau4, tau5, tau6, tauP]. */
export type TensionDims = [number, number, number, number, number, number, number];

/** 6-мерный вектор давлений [P1, P2, P3, P4, P5, P6]. */
export type PressureDims = [number, number, number, number, number, number];

/**
 * Функция охлаждения Sigmoid (линейная временная область).
 * Соответствует Python: 1 / (1 + exp(-beta * (x - theta)))
 *
 * @deprecated P3 перенесён на logSigmoid (логарифмическая временная область). Оставлен для других измерений или регрессионных тестов.
 */
export function sigmoid(x: number, beta: number, theta: number): number {
  const exponent = -beta * (x - theta);
  // clip для предотвращения переполнения
  const clipped = Math.max(-50, Math.min(50, exponent));
  return 1.0 / (1.0 + Math.exp(clipped));
}

/**
 * Sigmoid в логарифмической области — специально для охлаждения отношений P3.
 *
 * Закон Вебера-Фехнера: способность человека воспринимать изменения времени пропорциональна логарифму времени.
 * Отображает вход sigmoid из линейного времени в логарифмическое, сохраняя инкрементальную различимость при длительном молчании.
 *
 * cooling(t) = σ(β_r · (ln(1 + t/τ₀) - ln(1 + θ/τ₀)))
 *
 * Свойства:
 * - при t = θ: σ = 0.5 (точка перегиба не меняется)
 * - при t << θ: σ ≈ 0 (короткое молчание — без давления)
 * - при t >> θ: σ → 1 (ограничено, теорема Homeostasis в безопасности)
 * - логарифмическое сжатие сохраняет различие между 1ч и 1д (старая формула отображала оба в ~1.0)
 *
 * @param silenceS длительность молчания (секунды)
 * @param betaR крутизна sigmoid в логарифмической области (рекомендуется 2.5)
 * @param thetaS ожидаемый интервал между взаимодействиями (секунды)
 * @param tau0 гранулярность восприятия времени (секунды, рекомендуется 600)
 *
 * @see docs/adr/111-log-time-sigmoid/README.md
 */
export function logSigmoid(silenceS: number, betaR: number, thetaS: number, tau0: number): number {
  const sLog = Math.log(1 + silenceS / tau0);
  const muC = Math.log(1 + thetaS / tau0);
  const exponent = -betaR * (sLog - muC);
  const clipped = Math.max(-50, Math.min(50, exponent));
  return 1.0 / (1.0 + Math.exp(clipped));
}

/**
 * Нормализация tanh, clip до [0, 1).
 * Соответствует Python: np.tanh(np.clip(x / kappa, 0, None))
 */
export function tanhNormalize(value: number, kappa: number): number {
  if (kappa <= 0) return 0;
  const ratio = Math.max(0, value / kappa);
  return Math.tanh(ratio);
}

/**
 * Численно стабильный softmax.
 * Соответствует Python: shifted = L - L.max(); exp(shifted/tau) / sum(exp(shifted/tau))
 */
export function softmax(values: number[], tau: number): number[] {
  if (values.length === 0) return [];
  // исправление M6: ищем max циклом, чтобы избежать переполнения стека Math.max(...values) на больших массивах
  let maxVal = -Infinity;
  for (const v of values) if (v > maxVal) maxVal = v;
  const shifted = values.map((v) => (v - maxVal) / tau);
  const exps = shifted.map(Math.exp);
  const sum = exps.reduce((a, b) => a + b, 0);
  return exps.map((e) => e / sum);
}

/**
 * Извлекаемость P2 (кривая забывания).
 * Соответствует Python: (1 + (n - last_access) / (9 * stability))^d
 */
export function retrievability(
  tick: number,
  lastAccess: number,
  stability: number,
  d: number,
): number {
  const gap = Math.max(0, tick - lastAccess);
  const denom = 9.0 * Math.max(stability, 1e-6);
  return (1.0 + gap / denom) ** d;
}

/**
 * Фактор временного затухания: 1/(1 + age/halfLife). age=0 → 1.0, age=halfLife → 0.5.
 * M3 DRY: унифицирует написанные вручную формулы затухания в focus.ts / system1.ts / propagation.ts.
 * halfLife=Infinity → без затухания (1/(1+0) = 1.0).
 */
export function decayFactor(age: number, halfLife: number): number {
  if (halfLife < 0) throw new Error(`decayFactor: halfLife must be >= 0, got ${halfLife}`);
  if (halfLife === 0) return age <= 0 ? 1.0 : 0.0;
  return 1.0 / (1.0 + Math.max(0, age) / halfLife);
}

/**
 * Стандартный sigmoid: σ(x) = 1 / (1 + exp(-x)), с защитой от переполнения.
 * m1 DRY: унифицирует локальный sigmoid в p-prospect.ts.
 */
export function standardSigmoid(x: number): number {
  const clamped = Math.max(-50, Math.min(50, x));
  return 1 / (1 + Math.exp(-clamped));
}

/**
 * Расстояние L2.
 */
export function l2Distance(a: number[], b: number[]): number {
  // исправление M7: при несовпадении размерностей выбрасываем ошибку, а не молча усекаем
  if (a.length !== b.length) {
    throw new Error(`l2Distance: mismatched dimensions ${a.length} vs ${b.length}`);
  }
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const diff = a[i] - b[i];
    sum += diff * diff;
  }
  return Math.sqrt(sum);
}

/**
 * Стандартное отклонение.
 */
export function std(values: number[]): number {
  if (values.length === 0) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

/**
 * Нормализует массив так, чтобы его сумма равнялась 1.
 */
export function normalize(values: number[]): number[] {
  if (values.length === 0) return [];
  const sum = values.reduce((a, b) => a + b, 0);
  if (sum <= 0) return values.map(() => 1.0 / values.length);
  return values.map((v) => v / sum);
}

/**
 * ADR-117 D4: Гауссовый jitter по Бокс-Мюллеру.
 * σ = 0.15 → 95% времени укладывается в ±30%, крайние значения ограничиваются Math.max(100).
 */
export function applyJitter(delayMs: number): number {
  const u1 = Math.random();
  const u2 = Math.random();
  const z = Math.sqrt(-2 * Math.log(u1 || 1e-10)) * Math.cos(2 * Math.PI * u2);
  const jittered = delayMs * (1 + 0.15 * z);
  return Math.max(100, Math.round(jittered));
}
