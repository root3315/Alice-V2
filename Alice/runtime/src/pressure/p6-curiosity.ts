/**
 * P6 Curiosity (Любопытство) — неудовлетворённое epistemic pressure.
 *
 * Вычитающая формула novelty-deficit из статьи выражает идеальное свойство “любопытство снижается после получения информации”;
 * в рантайме нельзя подставлять prediction error / hunger как уже удовлетворённый novelty в
 * `η - mean(novelty)`. Эти сигналы в инженерном смысле — неудовлетворённое давление любопытства:
 * чем больше surprise и hunger, тем выше должен быть P6.
 *
 * Онлайн-реализация:
 *   curiositySignal = mean(topK(per-contact surprise, per-channel hunger))
 *   P6 = max(eta * tanh(curiositySignal), ambientCuriosity) ∈ [0, eta]
 *
 * contributions сохраняют гранулярность per-contact/per-channel для маршрутизации IAUS.
 *
 * @see paper/ Definition 3.3 (Curiosity)
 * @see paper/ Remark "Per-Contact Surprise as Novelty Realization"
 * @see paper/ Remark "Curiosity Saturation" — max(0,·) guarantees P6 ∈ [0, η]
 * @see docs/adr/112-pressure-dynamics-rehabilitation/ §D1, §D2
 * @see docs/adr/206-channel-information-flow/theory-impl-divergence-audit.md §P6
 */

import { DUNBAR_TIER_WEIGHT } from "../graph/constants.js";
import type { ContactAttrs, DunbarTier } from "../graph/entities.js";
import type { WorldModel } from "../graph/world-model.js";
import { elapsedS, readNodeMs } from "./clock.js";
import type { PressureResult } from "./p1-attention.js";

// -- ADR-206 W4: константы любопытства к каналу -----------------------------------------------

/**
 * Временная константа τ (секунды) информационного голода канала: hunger = 1 - exp(-t/τ).
 * При τ=21600s (6ч): 6ч без просмотра → ~63% восстановления голода, 12ч → ~86%.
 * @see docs/adr/206-channel-information-flow/206-channel-information-flow.md §5
 */
const CHANNEL_HUNGER_TAU_S = 21_600; // 6h

/**
 * Вес любопытства к каналу: базовый коэффициент относительно любопытства к контакту.
 * Канал — источник информации, а не социальный партнёр; вклад в любопытство ниже, чем от контакта.
 */
const CHANNEL_CURIOSITY_WEIGHT = 0.3;

/**
 * P6 агрегирует только наиболее сильные источники curiosity.
 * Любопытство — это указатель внимания; оно не должно линейно накапливаться от 500+ слабых контактов до постоянного максимума.
 */
const CURIOSITY_TOP_K = 8;

// -- Константы -------------------------------------------------------------------

/** Временная константа скидки информационного прироста (секунды): снижает любопытство к недавно активным контактам. */
export const TAU_CURIOSITY = 3000;

/** Максимальный вес tier (для нормализации w_tier ∈ (0, 1]). */
const MAX_TIER_WEIGHT = Math.max(...Object.values(DUNBAR_TIER_WEIGHT));

/**
 * Холодный старт σ_prediction: неопределённость предсказания для нового контакта.
 * Убывает с ростом interaction_count: σ = 1 / (1 + interaction_count / SIGMA_HALF_LIFE)
 * После 10 взаимодействий σ ≈ 0.5.
 */
const SIGMA_HALF_LIFE = 10;

/** Константа Данбара 150 (для нормализации ambient curiosity). */
const DUNBAR_150 = 150;

/** Временное окно окружающей знакомости (дни): полная знакомость достигается за 7 дней. */
const FAMILIARITY_DAYS = 7;

/**
 * Tier → ожидаемый интервал тишины (секунды).
 *
 * Калибровано для сценария **онлайн-мессенджера** (не очного общения).
 * @see Dunbar (2016) "Do online social media cut through the constraints
 *      that limit the size of offline social networks?"
 */
const TIER_EXPECTED_SILENCE_S: Record<DunbarTier, number> = {
  5: 14_400, // 4 часа
  15: 86_400, // 1 день
  50: 259_200, // 3 дня
  150: 1_209_600, // 14 дней
  500: 5_184_000, // 60 дней
};

/**
 * Tier → ожидаемая суточная частота сообщений.
 * Обратная величина к TIER_EXPECTED_SILENCE_S; используется для расчёта отклонения активности.
 */
const TIER_EXPECTED_DAILY_RATE: Record<DunbarTier, number> = {
  5: 6.0, // ~6 сообщений/день
  15: 1.0, // ~1 сообщение/день
  50: 0.33, // ~1 сообщение/3 дня
  150: 0.07, // ~1 сообщение/2 недели
  500: 0.016, // ~1 сообщение/2 месяца
};

// -- Curiosity history buffer ------------------------------------------------
// Отслеживает aggregate curiosity pressure за последние k тиков для лёгкого сглаживания.
// В продакшне буфер хранится в EvolveState — это исключает загрязнение общим состоянием модуля при нескольких экземплярах/тестах.

export type CuriosityHistory = number[];

/** Создать пустой экземпляр истории curiosity. */
export function createCuriosityHistory(): CuriosityHistory {
  return [];
}

/**
 * Старая тестовая вспомогательная функция оставлена как no-op: P6 больше не использует историю на уровне модуля.
 * В новых тестах передавайте явный history.
 */
export function resetNoveltyHistory(): void {
  // no-op
}

// -- Сигнал surprise -----------------------------------------------------------

/** σ_prediction: неопределённость предсказания. */
function sigmaPrediction(interactionCount: number): number {
  return 1.0 / (1.0 + interactionCount / SIGMA_HALF_LIFE);
}

/**
 * Сигнал 1: отклонение тишины (временное измерение).
 * @see Dunbar (2010) "How Many Friends Does One Person Need?"
 */
function silenceDeviation(attrs: ContactAttrs, nowMs: number): number {
  const lastActiveMs = attrs.last_active_ms ?? 0;
  if (lastActiveMs === 0) return 0;

  const actualSilenceS = elapsedS(nowMs, lastActiveMs);
  const expectedSilenceS = TIER_EXPECTED_SILENCE_S[attrs.tier] ?? 604_800;

  return Math.abs(actualSilenceS - expectedSilenceS) / expectedSilenceS;
}

/**
 * Сигнал 2: отклонение частоты активности (размерность величины, логарифмический закон Вебера–Фехнера).
 * @see Weber-Fechner law
 */
function activityRateDeviation(attrs: ContactAttrs, graphAgeDays: number): number {
  const interactionCount = attrs.interaction_count ?? 0;
  if (interactionCount < 2 || graphAgeDays < 1) return 0;

  const actualDailyRate = interactionCount / graphAgeDays;
  const expectedDailyRate = TIER_EXPECTED_DAILY_RATE[attrs.tier] ?? 0.14;

  const ratio = actualDailyRate / expectedDailyRate;
  return Math.abs(Math.log(Math.max(ratio, 0.01)));
}

/**
 * Итоговое значение surprise (ограничено ∈ [0, 1]).
 *
 * surprise = σ + (1 - σ) × tanh(signalMean)
 *
 * @see Friston (2010) "The free-energy principle: a unified brain theory?"
 */
function computeSurprise(attrs: ContactAttrs, nowMs: number, graphAgeDays: number): number {
  const sigma = sigmaPrediction(attrs.interaction_count ?? 0);

  const s1 = silenceDeviation(attrs, nowMs);
  const s2 = activityRateDeviation(attrs, graphAgeDays);

  const signalMean = (s1 + s2) / 2;

  return sigma + (1 - sigma) * Math.tanh(signalMean);
}

// -- Главная функция P6 ---------------------------------------------------------------

/**
 * Давление любопытства P6 (онлайн-версия pressure-field).
 *
 * per-contact prediction error и per-channel hunger — неудовлетворённое curiosity pressure.
 * Итог отображается через tanh в [0, η], гарантируя, что зрелый граф не насытится из-за большого числа сущностей.
 *
 * @param G - граф-компаньон
 * @param nowMs - текущее время стены (миллисекунды)
 * @param eta - базовый уровень ambient curiosity (config.eta, по умолчанию 0.6)
 * @param k - окно сглаживания curiosity (config.k, по умолчанию 20)
 */
export function p6Curiosity(G: WorldModel, nowMs: number, eta = 0.6, k = 20): PressureResult {
  return p6CuriosityWithHistory(G, nowMs, eta, k);
}

export function p6CuriosityWithHistory(
  G: WorldModel,
  nowMs: number,
  eta = 0.6,
  k = 20,
  history?: CuriosityHistory,
): PressureResult {
  const contacts = G.getEntitiesByType("contact");
  const contactCount = contacts.length;
  const graphAgeDays = G.getGraphAgeMs(nowMs) / 86_400_000;

  // ── Вычисление per-contact surprise (Remark из статьи: конкретизация novelty) ──────

  const contributions: Record<string, number> = {};

  for (const cid of contacts) {
    const attrs = G.getContact(cid);

    const wTier = DUNBAR_TIER_WEIGHT[attrs.tier] / MAX_TIER_WEIGHT;
    const surprise = computeSurprise(attrs, nowMs, graphAgeDays);

    // γ: скидка информационного прироста (снижение для недавно активных контактов)
    const lastActiveMs = readNodeMs(G, cid, "last_active_ms");
    if (lastActiveMs <= 0) continue; // никогда не взаимодействовали → пропустить
    const timeSinceLastS = elapsedS(nowMs, lastActiveMs);
    const gamma = 1 - Math.exp(-timeSinceLastS / TAU_CURIOSITY);

    const curiosity = wTier * surprise * gamma;
    if (curiosity > 0) {
      contributions[cid] = curiosity;
    }
  }

  // ── ADR-206 W4: любопытство к каналу (информационный голод) ──────────────────────────
  for (const chId of G.getEntitiesByType("channel")) {
    const attrs = G.getChannel(chId);
    if (attrs.chat_type !== "channel") continue;

    const unread = attrs.unread ?? 0;
    if (unread === 0) continue;

    const lastReadMs = Number(attrs.last_read_ms ?? 0);
    const sinceReadS = lastReadMs > 0 ? elapsedS(nowMs, lastReadMs) : 0;
    const effectiveSinceS =
      sinceReadS > 0 ? sinceReadS : elapsedS(nowMs, Number(attrs.last_activity_ms ?? 0));
    if (effectiveSinceS <= 0) continue;

    const hunger = 1 - Math.exp(-effectiveSinceS / CHANNEL_HUNGER_TAU_S);
    const unreadSignal = Math.log1p(unread);

    const chCuriosity = CHANNEL_CURIOSITY_WEIGHT * hunger * unreadSignal;
    if (chCuriosity > 0) {
      contributions[chId] = chCuriosity;
    }
  }

  // ── Aggregate pressure: bounded, source-count safe ──────────────────────
  // Сначала берём Top-K, затем агрегируем по среднему: так P6 отражает “есть ли сильный источник любопытства”, а не размер графа.
  const strongestSources = Object.entries(contributions)
    .sort(([, a], [, b]) => b - a)
    .slice(0, CURIOSITY_TOP_K);
  const curiositySignal =
    strongestSources.length > 0
      ? strongestSources.reduce((sum, [, value]) => sum + value, 0) / strongestSources.length
      : 0;
  const curiosityThisTick = eta * Math.tanh(curiositySignal);

  const activeHistory = history ?? [curiosityThisTick];
  if (history) {
    history.push(curiosityThisTick);
    if (history.length > k) history.shift();
  }

  const smoothedCuriosity = activeHistory.reduce((a, b) => a + b, 0) / activeHistory.length;

  // D2: страховка Ambient Curiosity (при холодном старте curiosityHistory пуст, P6=η)
  const contactFamiliarity = Math.min(1, contactCount / DUNBAR_150);
  const timeFamiliarity = Math.min(1, graphAgeDays / FAMILIARITY_DAYS);
  const familiarity = contactFamiliarity * timeFamiliarity;
  const ambientCuriosity = eta * (1 - familiarity);

  const finalTotal = Math.max(smoothedCuriosity, ambientCuriosity);

  // Масштабируем Top-K contributions так, чтобы их сумма = finalTotal (для маршрутизации IAUS)
  const routedContributions = Object.fromEntries(strongestSources);
  const rawContribSum = Object.values(routedContributions).reduce((a, b) => a + b, 0);
  if (rawContribSum > 0 && finalTotal > 0) {
    const scale = finalTotal / rawContribSum;
    for (const key of Object.keys(routedContributions)) {
      routedContributions[key] *= scale;
    }
  } else if (rawContribSum > 0 && finalTotal === 0) {
    // При P6=0 очищаем contributions (любопытство удовлетворено, маршрутизация не нужна)
    for (const key of Object.keys(routedContributions)) {
      routedContributions[key] = 0;
    }
  }

  return { total: finalTotal, contributions: routedContributions };
}
