/**
 * Семантизация давления: числа → описание контекста на естественном языке.
 *
 * Числа давления — внутренний критерий сортировки кода, а не данные для LLM.
 * LLM нужны контекстные факты — "ты не разговаривала с Carol уже 3 дня",
 * а не "relationship cooling (P3=2.1)".
 *
 * Данные per-entity уже есть в AllPressures.contributions;
 * нужно лишь связать их с атрибутами графа для генерации естественного языка.
 *
 * Унификация конвейера D2 (Wave 5):
 * - SemanticTriple: структурированное представление Def 3.5 ⟨F,T,S⟩ из статьи
 * - generateSemanticTriples(): генерирует полный набор тройок (для внешних потребителей вроде VoI)
 * - buildSituationBriefing(): поддерживает рендеринг на основе фокусного набора + belief hedging
 *
 * ADR-194: двухголосый рендеринг (Two-voice rendering).
 * Текущий target — активный залог (obligation); остальные target — окружающий залог (ambient).
 * @see docs/adr/194-situation-briefing-inbox-anxiety.md
 *
 * @see docs/adr/57-social-cognition-architecture.md §9
 * @see paper-five-dim/ Def 3.5: Semantic Triple ⟨F,T,S⟩
 */
import type { BeliefStore } from "../belief/store.js";
import { ensureChannelId, extractNumericId } from "../graph/constants.js";
import { safeDisplayName } from "../graph/display.js";
import type { WorldModel } from "../graph/world-model.js";
import type { AllPressures } from "./aggregate.js";
import { elapsedS, readNodeMs } from "./clock.js";
import { effectiveObligation, effectiveOutgoing, effectiveUnread } from "./signal-decay.js";
import { DEFAULT_SATURATION_COST_CONFIG } from "./social-cost.js";

/** Секунд в сутках. */
const SECONDS_PER_DAY = 86_400;

/** Максимальное число строк сущностей в выводе. */
const MAX_ENTITY_LINES = 6;

/** Ключи измерений давления. */
const PRESSURE_KEYS = ["P1", "P2", "P3", "P4", "P5", "P6"] as const;
export type PressureKey = (typeof PRESSURE_KEYS)[number];

// -- D2 Trend: направление временной производной давления (Def 3.5 Semantic Triple ⟨F,T,S⟩ из статьи) -------

export type Trend = "rising" | "steady" | "falling";

/**
 * Вычислить направление временной производной давления.
 * Сравниваем текущее значение со средним по истории, определяя тенденцию измерения давления.
 * При истории менее 3 тиков по умолчанию steady (данных недостаточно для суждения о тренде).
 */
export function computeTrend(history: number[], currentValue: number): Trend {
  if (history.length < 3) return "steady";
  const mean = history.reduce((a, b) => a + b, 0) / history.length;
  if (mean < 1e-6) return currentValue > 1e-6 ? "rising" : "steady";
  if (currentValue > mean * 1.1) return "rising";
  if (currentValue < mean * 0.9) return "falling";
  return "steady";
}

/** Суффикс-модификатор Trend: встраивается в текст Signal, чтобы LLM воспринимал направление изменения.
 * ADR-196 F11: использовать естественный язык вместо технических терминов */
function trendSuffix(trend: Trend): string {
  if (trend === "rising") return " — and picking up";
  if (trend === "falling") return " — and calming down";
  return "";
}

/**
 * Обёртка генератора: добавляет модификатор Trend после исходного Signal.
 * Избегает поштучного изменения функций, сохраняя чистоту каждой lineP*.
 * ADR-194: добавлен проброс параметра ambient.
 */
function withTrend(
  fn: (eid: string, intensity: Intensity, G: WorldModel, nowMs: number, ambient: boolean) => string,
): (
  eid: string,
  intensity: Intensity,
  G: WorldModel,
  nowMs: number,
  trend: Trend,
  ambient: boolean,
) => string {
  return (eid, intensity, G, nowMs, trend, ambient) =>
    fn(eid, intensity, G, nowMs, ambient) + trendSuffix(trend);
}

// -- Разрешение имён сущностей ---------------------------------------------------------------

/** ADR-172: делегируем safeDisplayName — никогда не возвращает сырой graph ID. */
function entityDisplayName(eid: string, G: WorldModel): string {
  return safeDisplayName(G, eid);
}

// -- Градации интенсивности (процентиль внутри измерения) -----------------------------------------------------

export type Intensity = "low" | "mid" | "high";

// -- D2 Semantic Triple (структурированное представление Def 3.5 ⟨F,T,S⟩ из статьи) -----------------

/**
 * Семантическая тройка — структурированное описание измерения давления.
 *
 * Каждая тройка содержит:
 * - Factor (F): какое измерение давления (P1-P6)
 * - Trend (T): направление временной производной (rising/steady/falling)
 * - Signal (S): описание на естественном языке
 *
 * Дополнительные поля используются для сортировки и расчёта VoI.
 *
 * @see paper-five-dim/ Def 3.5: Semantic Triple ⟨F,T,S⟩
 */
export interface SemanticTriple {
  /** Factor: какое измерение давления. */
  factor: PressureKey;
  /** Trend: направление временной производной. */
  trend: Trend;
  /** Signal: описание на естественном языке. */
  signal: string;
  /** ID связанной сущности. */
  entityId: string;
  /** Исходная градация интенсивности давления. */
  intensity: Intensity;
  /** Неопределённость убеждения (из BeliefStore, опционально). Чем выше — тем неопределённее. */
  confidence?: number;
}

/**
 * Определить интенсивность по процентилю среди всех вкладов в одном измерении.
 * При одной сущности: ≥ порога → high; при нескольких — по рангу.
 */
function intensityInDimension(value: number, allValues: number[]): Intensity {
  if (allValues.length <= 1) return value > 0 ? "high" : "low";
  const sorted = [...allValues].sort((a, b) => b - a);
  // M1 fix: indexOf нестабилен для повторяющихся значений с плавающей точкой (-1 даёт percentile > 1).
  // Используем findIndex + <= сравнение, избегая проблем точности и неоднозначности дублей.
  const rank = sorted.findIndex((v) => v <= value);
  if (rank < 0) return "high"; // защита: значение не найдено (теоретически невозможно)
  const percentile = 1 - rank / (sorted.length - 1);
  if (percentile >= 0.75) return "high";
  if (percentile >= 0.35) return "mid";
  return "low";
}

// -- Генерация естественного языка по измерениям -----------------------------------------------------------

function lineP5(
  eid: string,
  intensity: Intensity,
  G: WorldModel,
  nowMs: number,
  ambient = false,
): string {
  const name = entityDisplayName(eid, G);
  if (!G.has(eid)) {
    return ambient ? `${name} sent you something.` : `${name} is waiting for your reply.`;
  }
  // ADR-194: окружающий залог — нейтральное уведомление, без намёка на обязательство действовать
  if (ambient) {
    switch (intensity) {
      case "low":
        return `${name} sent you something.`;
      case "mid":
        return `${name} mentioned you.`;
      case "high":
        return `${name} has been trying to reach you.`;
    }
  }
  const attrs = G.getChannel(eid);
  // ADR-124: использовать effectiveObligation вместо pending_directed
  // @see docs/adr/126-obligation-field-decay.md §D6
  const pending = effectiveObligation(G, eid, nowMs);
  const directedText = String(attrs.last_directed_text ?? "");
  // Смежная пара CA: цитируем сообщение собеседника, чтобы LLM знал, "на какой ответ ждут"
  const quote = directedText ? `${name} said "${directedText}"` : "";
  switch (intensity) {
    case "low":
      return quote ? `${quote}.` : `${name} messaged you.`;
    case "mid":
      return quote
        ? `${quote} \u2014 waiting for your reply.`
        : `${name} is waiting for your reply.`;
    case "high":
      if (quote) {
        return pending > 1
          ? `${quote} \u2014 several messages waiting for your reply.`
          : `${quote} \u2014 waiting for your reply.`;
      }
      return pending > 1
        ? `${name} has been waiting for a while \u2014 several messages unanswered.`
        : `${name} has been waiting for a while.`;
  }
}

function lineP1(
  eid: string,
  intensity: Intensity,
  G: WorldModel,
  nowMs: number,
  ambient = false,
): string {
  const name = entityDisplayName(eid, G);
  if (!G.has(eid)) return `A few new messages in ${name}.`;
  // ADR-134 D5: использовать effectiveUnread для согласованности с расчётом P1
  const unread = Math.round(effectiveUnread(G, eid, nowMs));
  // ADR-194: окружающий залог — нейтральный факт, не провоцирует порыв "разобрать"
  if (ambient) {
    switch (intensity) {
      case "low":
        return `${name} has some new messages.`;
      case "mid":
        return `${name} has been chatting.`;
      case "high":
        return `${name} is pretty active right now.`;
    }
  }
  switch (intensity) {
    case "low":
      return `A few new messages in ${name}.`;
    case "mid":
      return `Several unread messages in ${name}.`;
    case "high":
      return `${name} is buzzing \u2014 ${unread > 50 ? "a flood of" : "many"} unread messages piling up.`;
  }
}

/**
 * Найти last_outgoing_text из приватного channel, соответствующего сущности contact.
 * Правило именования: contact:telegram:X → channel:telegram:X (приватный чат разделяет native ID).
 */
function findLastOutgoingText(eid: string, G: WorldModel): string {
  // contact:telegram:123 → channel:telegram:123
  const channelId = ensureChannelId(eid);
  if (!channelId || !G.has(channelId)) return "";
  return G.getChannel(channelId).last_outgoing_text ?? "";
}

function lineP3(
  eid: string,
  intensity: Intensity,
  G: WorldModel,
  nowMs: number,
  ambient = false,
): string {
  const name = entityDisplayName(eid, G);
  if (!G.has(eid)) return `It's been a while since you talked to ${name}.`;

  // ADR-104: P3 contributions содержат сущности двух типов — contact (охлаждение приватного чата) и channel (отсутствие в группе).
  const nodeType = G.getNodeType(eid);
  if (nodeType === "channel") {
    return lineP3Group(eid, name, intensity, G, nowMs, ambient);
  }

  const lastActiveMs = readNodeMs(G, eid, "last_active_ms");
  // Защита: last_active_ms=0 означает "никогда не взаимодействовали" — не должны вычислять дни с эпохи
  if (lastActiveMs <= 0) return `You haven't talked to ${name} yet.`;
  const days = Math.floor(elapsedS(nowMs, lastActiveMs) / SECONDS_PER_DAY);
  // Опора ④: цитируем последнее сказанное Алисой, чтобы LLM знал, на чём прервался диалог
  const lastSaid = findLastOutgoingText(eid, G);
  const suffix = lastSaid ? ` Last time, you said "${lastSaid}"` : "";
  switch (intensity) {
    case "low":
      return `It's been a while since you talked to ${name}.${suffix}`;
    case "mid":
      return days > 0
        ? `You haven't talked to ${name} in ${days} day${days > 1 ? "s" : ""}.${suffix}`
        : `It's been a while since you talked to ${name}.${suffix}`;
    case "high":
      return days > 0
        ? `${name} is drifting \u2014 no contact in ${days} day${days > 1 ? "s" : ""}.${suffix}`
        : `${name} is drifting away.${suffix}`;
  }
}

/** Суб-измерение P3 отсутствия в группе: как давно Алиса не говорила в группе. */
function lineP3Group(
  eid: string,
  name: string,
  intensity: Intensity,
  G: WorldModel,
  nowMs: number,
  ambient = false,
): string {
  const lastAliceMs = readNodeMs(G, eid, "last_alice_action_ms");
  if (lastAliceMs <= 0) return `You haven't spoken in ${name} yet.`;
  const days = Math.floor(elapsedS(nowMs, lastAliceMs) / SECONDS_PER_DAY);
  // ADR-194: окружающий залог — не создаём чувство вины за отсутствие
  if (ambient) {
    switch (intensity) {
      case "low":
        return `${name} has been going on without you.`;
      case "mid":
        return `${name} has been active lately.`;
      case "high":
        return `${name} is active.`;
    }
  }
  switch (intensity) {
    case "low":
      return `You've been quiet in ${name} for a while.`;
    case "mid":
      return days > 0
        ? `You haven't said anything in ${name} in ${days} day${days > 1 ? "s" : ""}.`
        : `You've been quiet in ${name} for a while.`;
    case "high":
      return days > 0
        ? `${name} is active but you've been absent for ${days} day${days > 1 ? "s" : ""}.`
        : `${name} is active but you've been absent.`;
  }
}

function lineP4(eid: string, intensity: Intensity, G: WorldModel): string {
  const name = entityDisplayName(eid, G);
  switch (intensity) {
    case "low":
    case "mid":
      return `Thread "${name}" hasn't been touched in a while.`;
    case "high":
      return `Thread "${name}" has gone stale.`;
  }
}

function lineP6(
  eid: string,
  intensity: Intensity,
  G: WorldModel,
  _nowMs: number,
  ambient = false,
): string {
  const name = entityDisplayName(eid, G);
  switch (intensity) {
    case "low":
      return `Something stirring around ${name}.`;
    case "mid":
      return `Something new happening around ${name}.`;
    case "high":
      // ADR-194: окружающий залог — убрать призыв к действию "worth checking out"
      return ambient
        ? `A lot going on around ${name} lately.`
        : `A lot of fresh activity around ${name} \u2014 worth checking out.`;
  }
}

function lineP2(
  eid: string,
  intensity: Intensity,
  G: WorldModel,
  _nowMs: number,
  ambient = false,
): string {
  const name = entityDisplayName(eid, G);
  switch (intensity) {
    case "low":
      return `Some new details about ${name}.`;
    case "mid":
      return `There's new information about ${name}.`;
    case "high":
      // ADR-194: окружающий залог — убрать формулировку задания "you haven't processed"
      return ambient
        ? `There's been new information about ${name}.`
        : `Important new information about ${name} that you haven't processed.`;
  }
}

const LINE_GENERATORS: Record<
  PressureKey,
  (
    eid: string,
    intensity: Intensity,
    G: WorldModel,
    nowMs: number,
    trend: Trend,
    ambient: boolean,
  ) => string
> = {
  P5: withTrend(lineP5),
  P1: withTrend(lineP1),
  P3: withTrend(lineP3),
  P4: withTrend(lineP4),
  P6: withTrend(lineP6),
  P2: withTrend(lineP2),
};

// -- Качественный обзор -------------------------------------------------------------------

// ADR-194: качественный обзор переведён из кадра перегрузки в окружающий кадр — "мир крутится", а не "ты перегружена"
function qualitativeOverall(api: number): string {
  if (api < 0.5) return "Everything is calm right now.";
  if (api < 1.5) return "A few things on your mind.";
  if (api < 3.0) return "A few things going on in other chats.";
  if (api < 4.5) return "Other chats have been active.";
  return "The world's been busy while you're here.";
}

// -- Основные функции -------------------------------------------------------------------

interface EntityPressureEntry {
  entityId: string;
  dominantKey: PressureKey;
  dominantValue: number;
}

/** Опции D2 фокусного набора + belief (добавлены в Wave 5, обратно совместимы). */
export interface SituationBriefingOptions {
  /** Набор ID фокусных сущностей. Фокусные сущности рендерятся приоритетно (даже если значение давления не самое высокое). */
  focalEntities?: string[];
  /** BeliefStore. При высоком sigma^2 добавляется hedging language (размытые формулировки). */
  beliefs?: BeliefStore;
  /**
   * Target текущего action scope (channel entity ID).
   * ADR-194: сущности, отличные от этого target, используют окружающий залог (ambient=true),
   * чтобы формулировки obligation не создавали тревогу входящих.
   */
  actionTarget?: string;
}

// -- D2 hedging language (неопределённость убеждения → размытые формулировки) --------------------------

/** Порог sigma^2: выше этого значения считается "высокой неопределённостью". */
const SIGMA2_HIGH = 0.5;
/** Порог sigma^2: ниже этого значения считается "высокой уверенностью". */
const SIGMA2_LOW = 0.15;

/**
 * Добавить hedging-модификатор к тексту сигнала на основе sigma^2 убеждения.
 *
 * - Высокий sigma^2 (> 0.5): префикс "You vaguely recall..."
 * - Низкий sigma^2 (< 0.15): префикс "You're pretty sure — "
 * - Промежуточный: текст без изменений
 *
 * @see paper-pomdp/ §3: Belief Uncertainty
 */
function applyHedging(signal: string, sigma2: number): string {
  if (sigma2 > SIGMA2_HIGH) {
    return `You vaguely recall — ${signal}`;
  }
  if (sigma2 < SIGMA2_LOW) {
    return `You're pretty sure — ${signal}`;
  }
  return signal;
}

/**
 * Получить суммарный sigma^2 сущности из BeliefStore (берём максимум из tier и mood).
 * Берём максимум, так как высокая неопределённость в любом измерении должна запускать hedging.
 */
function entitySigma2(eid: string, beliefs: BeliefStore | undefined): number | undefined {
  if (!beliefs) return undefined;
  const bTier = beliefs.getOrDefault(eid, "tier");
  const bMood = beliefs.getOrDefault(eid, "mood");
  return Math.max(bTier.sigma2, bMood.sigma2);
}

// -- Логика сбора (вынесена из buildSituationBriefing для совместного использования с generateSemanticTriples)

/** Собрать все (entity, pressureKey, value) и отображение значений измерений. */
function collectEntityPressures(p: AllPressures): {
  entityMap: Map<string, { key: PressureKey; value: number }[]>;
  dimensionValues: Record<PressureKey, number[]>;
} {
  const entityMap = new Map<string, { key: PressureKey; value: number }[]>();
  const dimensionValues: Record<PressureKey, number[]> = {
    P1: [],
    P2: [],
    P3: [],
    P4: [],
    P5: [],
    P6: [],
  };

  for (const pk of PRESSURE_KEYS) {
    const contribs = p.contributions[pk];
    if (!contribs) continue;
    for (const [eid, val] of Object.entries(contribs)) {
      if (val <= 0) continue;
      let arr = entityMap.get(eid);
      if (!arr) {
        arr = [];
        entityMap.set(eid, arr);
      }
      arr.push({ key: pk, value: val });
      dimensionValues[pk].push(val);
    }
  }

  return { entityMap, dimensionValues };
}

/** Построить отображение суммарных значений измерений (используется для расчёта trend). */
function dimTotalsFrom(p: AllPressures): Record<PressureKey, number> {
  return { P1: p.P1, P2: p.P2, P3: p.P3, P4: p.P4, P5: p.P5, P6: p.P6 };
}

/**
 * Сгенерировать полный набор семантических тройок.
 *
 * Преобразует per-entity вклады шестимерного поля давления в структурированные тройки ⟨F,T,S⟩.
 * Используется для внутреннего рендеринга и внешними потребителями (например, расчёт VoI в D5).
 *
 * @see paper-five-dim/ Def 3.5: Semantic Triple ⟨F,T,S⟩
 */
export function generateSemanticTriples(
  p: AllPressures,
  G: WorldModel,
  _tick: number,
  nowMs: number,
  beliefs?: BeliefStore,
): SemanticTriple[] {
  const { entityMap, dimensionValues } = collectEntityPressures(p);
  const dimTotals = dimTotalsFrom(p);
  const triples: SemanticTriple[] = [];

  // Для каждой сущности генерируем тройку по каждому измерению с ненулевым вкладом
  for (const [eid, contribs] of entityMap) {
    for (const { key: pk, value } of contribs) {
      const intensity = intensityInDimension(value, dimensionValues[pk]);
      const dimHistory = p.pressureHistory?.[pk] ?? [];
      const trend = computeTrend(dimHistory, dimTotals[pk]);
      const generator = LINE_GENERATORS[pk];
      // ADR-194: тройки используются для расчёта VoI, всегда применяем активный залог (ambient=false)
      const signal = generator(eid, intensity, G, nowMs, trend, false);
      const sigma2 = entitySigma2(eid, beliefs);

      triples.push({
        factor: pk,
        trend,
        signal,
        entityId: eid,
        intensity,
        confidence: sigma2 !== undefined ? 1 - sigma2 : undefined,
      });
    }
  }

  return triples;
}

/**
 * Преобразовать шестимерное поле давления в per-entity описание контекста на естественном языке.
 *
 * Логика:
 * 1. Из contributions собираем тройки (entityId, pressureKey, value)
 * 2. Группируем по entity — для каждой entity берём измерение с максимальным вкладом как "доминирующее"
 * 3. Сортируем по убыванию максимального вклада (наиболее срочное — первым)
 *    - D2 Wave 5: focalEntities идут первыми (даже если значение давления не максимальное)
 * 4. Берём top-6 сущностей, для каждой генерируем одно предложение на естественном языке
 *    - D2 Wave 5: при высоком belief sigma^2 добавляем hedging language
 * 5. В конце добавляем качественный обзор
 *
 * Единственная роль чисел: сортировка и интенсивность тона. В выходной текст не попадают.
 *
 * @param p шестимерный результат давления
 * @param G граф-компаньон
 * @param tick текущий тик
 * @param options опции D2 фокусного набора + belief (опционально, обратно совместимо)
 *
 * @see paper-five-dim/ Def 3.5: Semantic Triple ⟨F,T,S⟩
 * @see paper-five-dim/ Definition 7.1: Context Assembly
 */
export function buildSituationBriefing(
  p: AllPressures,
  G: WorldModel,
  _tick: number,
  nowMs: number,
  options?: SituationBriefingOptions,
): string[] {
  const focalSet = options?.focalEntities ? new Set(options.focalEntities) : null;
  const beliefs = options?.beliefs;
  // ADR-187 D1: обрезка обзора — предварительно вычисляем numeric ID actionTarget
  const actionTarget = options?.actionTarget ?? null;
  const actionTargetNum = actionTarget ? extractNumericId(actionTarget) : null;

  // 1. Собираем все (entity, key, value)
  const { entityMap, dimensionValues } = collectEntityPressures(p);

  // 2. Группируем по entity, берём измерение с максимальным вкладом
  const entries: EntityPressureEntry[] = [];
  for (const [eid, contribs] of entityMap) {
    let best = contribs[0];
    for (let i = 1; i < contribs.length; i++) {
      if (contribs[i].value > best.value) best = contribs[i];
    }
    entries.push({ entityId: eid, dominantKey: best.key, dominantValue: best.value });
  }

  // 3. Сортировка: focal-сущности приоритетны (сохраняем внутреннюю сортировку по убыванию давления), затем non-focal по убыванию давления
  if (focalSet && focalSet.size > 0) {
    const focalEntries: EntityPressureEntry[] = [];
    const nonFocalEntries: EntityPressureEntry[] = [];
    for (const e of entries) {
      if (focalSet.has(e.entityId)) {
        focalEntries.push(e);
      } else {
        nonFocalEntries.push(e);
      }
    }
    // Каждая группа по убыванию давления
    focalEntries.sort((a, b) => b.dominantValue - a.dominantValue);
    nonFocalEntries.sort((a, b) => b.dominantValue - a.dominantValue);
    // focal — первыми
    entries.length = 0;
    entries.push(...focalEntries, ...nonFocalEntries);
  } else {
    // Нет фокусного набора: исходная логика, чистая сортировка по убыванию давления
    entries.sort((a, b) => b.dominantValue - a.dominantValue);
  }

  // 4. Берём top-N, генерируем естественный язык (D2 Trend: встраиваем T из ⟨F,T,S⟩)
  const lines: string[] = [];
  const topN = entries.slice(0, MAX_ENTITY_LINES);
  const dimTotals = dimTotalsFrom(p);

  // ADR-196 F6: анонимные сущности (без display_name/title) объединяются в суммарную строку, экономя токены
  let anonymousCount = 0;

  for (const entry of topN) {
    // ADR-196 F6: пропускаем анонимные сущности, накапливаем счётчик
    if (G.has(entry.entityId)) {
      const dn = G.getDynamic(entry.entityId, "display_name");
      const title = G.getDynamic(entry.entityId, "title");
      if (!dn && !title) {
        anonymousCount++;
        continue;
      }
    }

    // ADR-194: определяем, является ли сущность текущим action target — это решает, какой залог использовать.
    // Текущий target — залог obligation (действенный), остальные — ambient (только восприятие).
    let ambient = false;
    if (actionTarget && entry.entityId !== actionTarget) {
      const entityNum = extractNumericId(entry.entityId);
      // Приватный чат: channel:X и contact:X разделяют numeric ID → считаем одним target
      const isCurrentTarget =
        actionTargetNum != null && entityNum != null && actionTargetNum === entityNum;
      ambient = !isCurrentTarget;
    }

    const generator = LINE_GENERATORS[entry.dominantKey];
    const intensity = intensityInDimension(entry.dominantValue, dimensionValues[entry.dominantKey]);
    const dimHistory = p.pressureHistory?.[entry.dominantKey] ?? [];
    const trend = computeTrend(dimHistory, dimTotals[entry.dominantKey]);
    let line = generator(entry.entityId, intensity, G, nowMs, trend, ambient);

    // D2 Wave 5: belief hedging — размытые формулировки, управляемые sigma^2
    const sigma2 = entitySigma2(entry.entityId, beliefs);
    if (sigma2 !== undefined) {
      line = applyHedging(line, sigma2);
    }

    lines.push(line);
  }

  // ADR-196 F6: анонимные сущности объединяются в одну суммарную строку
  if (anonymousCount > 0) {
    lines.push(
      `${anonymousCount} other chat${anonymousCount !== 1 ? "s" : ""} ${anonymousCount !== 1 ? "are" : "is"} also active.`,
    );
  }

  // 5. Опора ④: обнаружение anti-bombing (теория смены очередей: серия без ответа = монологовая бомбардировка)
  // ADR-113 правка: 5+ сообщений в группе по-прежнему считается флудом, порог снижен с 8 до 5
  // ADR-157: выводится из outgoing cap в saturation cost — bombing = превышение лимита
  // @see runtime/src/pressure/social-cost.ts SaturationCostConfigSchema
  const BOMBING_THRESHOLD_PRIVATE = DEFAULT_SATURATION_COST_CONFIG.outgoingCapPrivate + 1;
  const BOMBING_THRESHOLD_GROUP = DEFAULT_SATURATION_COST_CONFIG.outgoingCapGroup + 1;
  for (const chId of G.getEntitiesByType("channel")) {
    const chAttrs = G.getChannel(chId);
    // ADR-126: использовать effectiveOutgoing (затухание с полупериодом 24ч)
    const consecutive = effectiveOutgoing(G, chId, nowMs);
    const chChatType = chAttrs.chat_type;
    const threshold =
      chChatType === "group" || chChatType === "supergroup"
        ? BOMBING_THRESHOLD_GROUP
        : BOMBING_THRESHOLD_PRIVATE;
    if (consecutive >= threshold) {
      const chName = entityDisplayName(chId, G);
      lines.push(`You've sent several messages to ${chName} without a reply — consider waiting.`);
    }
  }

  // 6. Качественный обзор
  lines.push(qualitativeOverall(p.API));

  return lines;
}
