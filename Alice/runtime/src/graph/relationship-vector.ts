/**
 * Библиотека утилит для вектора отношений (ADR-178) — чистые функции без побочных эффектов.
 *
 * 5-мерный непрерывный вектор (familiarity/trust/affection/attraction/respect)
 * заменяет дискретную пару tier+relationType в качестве первичного представления отношений.
 *
 * @see docs/adr/178-relationship-vector-field.md
 */

import type { ContactAttrs, DunbarTier, RelationType } from "./entities.js";

// ═══════════════════════════════════════════════════════════════════════════
// Типы
// ═══════════════════════════════════════════════════════════════════════════

export interface RelationshipVector {
  familiarity: number;
  trust: number;
  affection: number;
  attraction: number;
  respect: number;
}

export type RVDimension = keyof RelationshipVector;

export const RV_DIMENSIONS: readonly RVDimension[] = [
  "familiarity",
  "trust",
  "affection",
  "attraction",
  "respect",
] as const;

export type RomanticPhase =
  | "none"
  | "tension"
  | "courtship"
  | "passion"
  | "bonding"
  | "cooling"
  | "estranged";

export type ChemistryLevel = "magnetic" | "electric" | "warm" | "comfortable" | "awkward" | "cold";

// ═══════════════════════════════════════════════════════════════════════════
// Константы
// ═══════════════════════════════════════════════════════════════════════════

/** Начальный вектор для нового контакта. */
export const INITIAL_RV: Readonly<RelationshipVector> = Object.freeze({
  familiarity: 0,
  trust: 0.3, // базовое доверие к незнакомцу
  affection: 0,
  attraction: 0,
  respect: 0.3, // базовая вежливая уважительность
});

/**
 * Параметры затухания λ по измерениям (период полужизни в секундах для экспоненциального затухания).
 * value(t+Δ) = value(t) × exp(-ln2 × Δ / halfLife)
 */
export const DIMENSION_DECAY: Readonly<Record<RVDimension, number>> = Object.freeze({
  familiarity: 30 * 86400, // период полужизни 30 дней — знакомость затухает медленнее всего
  trust: 60 * 86400, // 60 дней — доверие строится медленно и медленно угасает
  affection: 14 * 86400, // 14 дней — привязанность требует постоянной поддержки
  attraction: 7 * 86400, // 7 дней — влечение затухает быстрее всего
  respect: 45 * 86400, // 45 дней — уважение достаточно устойчиво
});

/** Прототипы отношений — типичные позиции каждого типа отношений в векторном пространстве. */
export const RELATIONSHIP_PROTOTYPES: Readonly<Record<RelationType, RelationshipVector>> =
  Object.freeze({
    romantic: { familiarity: 0.9, trust: 0.8, affection: 0.9, attraction: 0.8, respect: 0.7 },
    close_friend: { familiarity: 0.9, trust: 0.9, affection: 0.7, attraction: 0.1, respect: 0.8 },
    friend: { familiarity: 0.6, trust: 0.6, affection: 0.4, attraction: 0.1, respect: 0.6 },
    family: { familiarity: 0.8, trust: 0.7, affection: 0.6, attraction: 0, respect: 0.6 },
    colleague: { familiarity: 0.4, trust: 0.4, affection: 0.1, attraction: 0, respect: 0.5 },
    acquaintance: { familiarity: 0.2, trust: 0.3, affection: 0, attraction: 0, respect: 0.3 },
    unknown: { familiarity: 0, trust: 0.3, affection: 0, attraction: 0, respect: 0.3 },
  });

/** Отображение перечисления chemistry инструкции sense_chemistry в интенсивность стимула. */
export const CHEMISTRY_STIMULUS: Readonly<Record<ChemistryLevel, number>> = Object.freeze({
  magnetic: 0.8,
  electric: 0.6,
  warm: 0.4,
  comfortable: 0.2,
  awkward: -0.3,
  cold: -0.6,
});

/** Коэффициент сглаживания EMA скорости (чем меньше α, тем глаже). Требует калибровки в симуляции. */
export const RV_VELOCITY_ALPHA = 0.05;

/** Прирост familiarity за одно взаимодействие (до применения потолочного демпфирования). */
export const FAMILIARITY_INTERACTION_DELTA = 0.02;

// ── ADR-178 (organic growth): автоматический прирост rv_* на каждом взаимодействии ──
// Проблема: rv_* писались ТОЛЬКО редко вызываемыми LLM-инструкциями (rate_outcome/feel/
// self_sense/sense_chemistry) → росли лишь у ~3 контактов (владелец + 2). Активные собеседники
// застревали на INITIAL_RV → tier 500. Решение: каждое входящее сообщение нежно подталкивает
// rv_* по уже существующим в графе сигналам (interaction_count, last_outcome_quality, mood_valence,
// взаимность). Малые α + потолочное/половое демпфирование growDimension гарантируют ПОСТЕПЕННОСТЬ:
// новый контакт не прыгает к trust 1.0, а тёплеет десятками взаимодействий, как реальный человек.
// @see docs/adr/178-relationship-vector-field.md

/** α авто-прироста trust по качеству исхода (консервативно: доверие строится медленно). */
export const TRUST_INTERACTION_ALPHA = 0.04;
/** α авто-прироста/спада affection по настроению контакта. */
export const AFFECTION_INTERACTION_ALPHA = 0.05;
/** α авто-прироста respect при устойчивом взаимном контакте. */
export const RESPECT_INTERACTION_ALPHA = 0.02;
/** Базовый положительный стимул affection за сам факт ответа (контакт вернулся → теплота). */
export const RECIPROCITY_AFFECTION_STIMULUS = 0.15;
/** Базовый положительный стимул respect за взаимный (reciprocated) контакт. */
export const RECIPROCITY_RESPECT_STIMULUS = 0.2;

/** Сигналы взаимодействия, доступные автоматически (без LLM-разметки), для interactionNudge. */
export interface InteractionSignals {
  /** Качество последнего исхода с контактом [-1,1] (rate_outcome / deferred-outcome). undefined → нейтрально. */
  outcomeQuality?: number;
  /** Настроение контакта [-1,1] (feel). undefined → нейтрально. */
  moodValence?: number;
  /** Контакт сам инициировал/вернулся в этом сообщении (взаимность). */
  reciprocated?: boolean;
}

// ═══════════════════════════════════════════════════════════════════════════
// Основные функции
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Экспоненциальное затухание: value × exp(-ln2 × elapsedMs / (halfLifeS × 1000)).
 */
export function decayDimension(value: number, halfLifeS: number, elapsedMs: number): number {
  if (elapsedMs <= 0 || halfLifeS <= 0) return value;
  const lambda = Math.LN2 / (halfLifeS * 1000);
  return value * Math.exp(-lambda * elapsedMs);
}

/**
 * Рост с потолочным демпфированием: value += α × stimulus × (1 - value).
 * stimulus > 0 — рост; stimulus < 0 — сжатие (демпфирование через value, а не 1-value).
 */
export function growDimension(value: number, alpha: number, stimulus: number): number {
  if (stimulus >= 0) {
    // Рост: тем медленнее, чем ближе к 1
    return Math.min(1, value + alpha * stimulus * (1 - value));
  }
  // Сжатие: тем медленнее, чем ближе к 0 (демпфирование через value)
  return Math.max(0, value + alpha * stimulus * value);
}

/**
 * EMA-обновление скорости: vel = α × delta + (1-α) × prevVel.
 */
export function updateVelocity(prevVel: number, delta: number, alpha: number): number {
  return alpha * delta + (1 - alpha) * prevVel;
}

/**
 * ADR-178 (organic growth): чистый расчёт авто-прироста rv_* на ОДНО взаимодействие.
 *
 * Раньше rv_* двигались только редкими LLM-инструкциями → росли у горстки контактов.
 * Теперь каждое осмысленное взаимодействие (входящий ответ собеседника) подталкивает вектор
 * на малую ограниченную величину, опираясь на сигналы, уже присутствующие в графе:
 *   - familiarity: всегда +FAMILIARITY_INTERACTION_DELTA (частота/счётчик взаимодействий)
 *   - trust:       по outcomeQuality (положит. → рост, отрицат. → спад, к негативу чувствительнее)
 *   - affection:   по moodValence + бонус за взаимность (контакт ответил/вернулся)
 *   - respect:     малый плюс при взаимном устойчивом контакте
 *   - attraction:  НЕ трогаем (остаётся за sense_chemistry — это явное суждение LLM)
 *
 * Чистая функция (без side effects): возвращает НОВЫЙ вектор. Все измерения клампятся в [0,1]
 * через growDimension (демпфирование у потолка/пола) → новый контакт тёплеет постепенно,
 * а не прыгает к 1.0. Decay в onTickEnd по-прежнему балансирует рост (рост не монотонный).
 *
 * Конструктивно: при reciprocated && нейтральных сигналах affection всё равно слегка растёт
 * (тёплый эффект от самого факта общения), trust почти стоит (нужен явный положительный исход),
 * respect медленно растёт. Это даёт «прогрев» обычных активных контактов без переоценки доверия.
 */
export function interactionNudge(
  v: Readonly<RelationshipVector>,
  signals: InteractionSignals,
): RelationshipVector {
  const next: RelationshipVector = { ...v };

  // familiarity — растёт с каждым взаимодействием (частотный/счётный сигнал)
  next.familiarity = growDimension(next.familiarity, FAMILIARITY_INTERACTION_DELTA, 1);

  // trust — по качеству исхода; к негативу чувствительнее (доверие хрупко)
  if (signals.outcomeQuality != null && signals.outcomeQuality !== 0) {
    const q = signals.outcomeQuality;
    const stimulus = q >= 0 ? q : q * 1.6;
    next.trust = growDimension(next.trust, TRUST_INTERACTION_ALPHA, stimulus);
  }

  // affection — по настроению контакта + бонус за взаимность
  let affectionStimulus = signals.moodValence ?? 0;
  if (signals.reciprocated) affectionStimulus += RECIPROCITY_AFFECTION_STIMULUS;
  if (affectionStimulus !== 0) {
    next.affection = growDimension(next.affection, AFFECTION_INTERACTION_ALPHA, affectionStimulus);
  }

  // respect — малый плюс при взаимном контакте (устойчивое двустороннее общение → уважение)
  if (signals.reciprocated) {
    next.respect = growDimension(
      next.respect,
      RESPECT_INTERACTION_ALPHA,
      RECIPROCITY_RESPECT_STIMULUS,
    );
  }

  return next;
}

/**
 * Выводит уровень Данбара из familiarity (используется в Phase 3; в Phase 1-2 существующий tier не заменяется).
 */
export function deriveTier(familiarity: number): DunbarTier {
  if (familiarity >= 0.8) return 5;
  if (familiarity >= 0.6) return 15;
  if (familiarity >= 0.4) return 50;
  if (familiarity >= 0.2) return 150;
  return 500;
}

/**
 * Выводит тип отношений из вектора — берёт тип, ближайший к прототипу (евклидово расстояние).
 */
export function deriveRelationType(v: RelationshipVector): RelationType {
  let bestType: RelationType = "unknown";
  let bestDist = Infinity;
  for (const [type, proto] of Object.entries(RELATIONSHIP_PROTOTYPES)) {
    let sumSq = 0;
    for (const dim of RV_DIMENSIONS) {
      const diff = v[dim] - proto[dim];
      sumSq += diff * diff;
    }
    if (sumSq < bestDist) {
      bestDist = sumSq;
      bestType = type as RelationType;
    }
  }
  return bestType;
}

/**
 * Выводит романтическую фазу из вектора + скорости.
 *
 * Определение фазы основано на комбинации attraction + affection:
 * - none:      attraction < 0.1
 * - tension:   attraction >= 0.1, affection < 0.3
 * - courtship: attraction >= 0.3, affection in [0.3, 0.6)
 * - passion:   attraction >= 0.5, affection >= 0.6
 * - bonding:   attraction >= 0.3, affection >= 0.7, vel_attraction ≤ 0 (стабильно)
 * - cooling:   attraction снижается (vel_attraction < -0.01), affection >= 0.3
 * - estranged: attraction был высоким, теперь низкий; affection тоже снижается
 */
export function deriveRomanticPhase(
  v: RelationshipVector,
  vel: Record<RVDimension, number>,
): RomanticPhase {
  const { attraction, affection } = v;

  if (attraction < 0.1) return "none";

  // Приоритетное обнаружение охлаждения/отчуждения
  if (vel.attraction < -0.01 && affection >= 0.3) {
    if (vel.affection < -0.005) return "estranged";
    return "cooling";
  }

  // Нормальная прогрессия фаз
  if (attraction >= 0.5 && affection >= 0.6) {
    // Высокое влечение + высокая привязанность: passion или bonding
    if (vel.attraction <= 0 && affection >= 0.7) return "bonding";
    return "passion";
  }

  if (attraction >= 0.3 && affection >= 0.3) return "courtship";
  if (affection < 0.3) return "tension";

  return "tension";
}

// ═══════════════════════════════════════════════════════════════════════════
// Чтение ContactAttrs
// ═══════════════════════════════════════════════════════════════════════════

/** Читает вектор отношений из ContactAttrs; пропущенные значения заполняются из INITIAL_RV. */
export function readRV(attrs: Partial<ContactAttrs>): RelationshipVector {
  return {
    familiarity: attrs.rv_familiarity ?? INITIAL_RV.familiarity,
    trust: attrs.rv_trust ?? INITIAL_RV.trust,
    affection: attrs.rv_affection ?? INITIAL_RV.affection,
    attraction: attrs.rv_attraction ?? INITIAL_RV.attraction,
    respect: attrs.rv_respect ?? INITIAL_RV.respect,
  };
}

/** Читает вектор скорости из ContactAttrs; пропущенные значения равны 0. */
export function readVelocity(attrs: Partial<ContactAttrs>): Record<RVDimension, number> {
  return {
    familiarity: attrs.rv_vel_familiarity ?? 0,
    trust: attrs.rv_vel_trust ?? 0,
    affection: attrs.rv_vel_affection ?? 0,
    attraction: attrs.rv_vel_attraction ?? 0,
    respect: attrs.rv_vel_respect ?? 0,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Рендеринг промпта
// ═══════════════════════════════════════════════════════════════════════════

/** Значение измерения → семантическая метка. */
function dimensionLabel(value: number): string {
  if (value >= 0.8) return "very high";
  if (value >= 0.6) return "high";
  if (value >= 0.4) return "moderate";
  if (value >= 0.2) return "low";
  return "very low";
}

/** velocity → метка тренда. */
function trendLabel(vel: number): string | null {
  if (vel > 0.02) return "rising";
  if (vel > 0.005) return "slightly rising";
  if (vel < -0.02) return "falling";
  if (vel < -0.005) return "slightly falling";
  return null; // стабильно — не рендерить
}

/**
 * Рендерит вектор отношений как семантические факты (читаемые LLM).
 * Рендерит только измерения, отличные от начальных значений — исключает информационный шум.
 */
export function renderRelationshipFacts(
  v: RelationshipVector,
  vel: Record<RVDimension, number>,
  displayName: string,
): string | null {
  const facts: string[] = [];

  for (const dim of RV_DIMENSIONS) {
    const value = v[dim];
    const initial = INITIAL_RV[dim];
    // Рендерить только измерения, отклонившиеся от начального значения
    if (Math.abs(value - initial) < 0.05) continue;

    const label = dimensionLabel(value);
    const trend = trendLabel(vel[dim]);
    const trendStr = trend ? ` (${trend})` : "";
    facts.push(`${dim}: ${label}${trendStr}`);
  }

  if (facts.length === 0) return null;

  const phase = deriveRomanticPhase(v, vel);
  const phaseStr = phase !== "none" ? `, romantic phase: ${phase}` : "";

  // Однострочный вывод — вставляется вызывающей стороной через PromptBuilder.of(); многострочный не поддерживается
  return `relationship with ${displayName}: ${facts.join(", ")}${phaseStr}`;
}
