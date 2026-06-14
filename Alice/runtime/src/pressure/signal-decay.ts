/**
 * Слой затухания сигналов — сенсорный регистр когнитивной архитектуры.
 *
 * Трёхуровневая когнитивная архитектура:
 *   Сенсорный слой (этот модуль)  — сырое наблюдение × временное затухание → эффективный сигнал
 *   Рабочий слой (BeliefStore)    — байесовская интеграция нескольких наблюдений (μ, σ², tObs)
 *   Эпизодический слой (info_item) — долгосрочное хранение + интервальные повторения
 *
 * Основные инварианты:
 *   Все считывания атрибутов графа, используемые для управляющих решений
 *   (переключение режимов, вентилирование, суждения System 1) MUST проходить
 *   через функции затухания этого модуля. Прямое чтение nodeAttrs с булевой
 *   оценкой является антипаттерном.
 *
 * Выбор ядра затухания — событийный сигнал vs сигнал памяти:
 *
 *   Все сигналы этого модуля (obligation, mention, risk, outcome, outgoing, unread)
 *   являются **событийно-управляемыми сигналами** — активируются конкретным событием и
 *   естественно затухают со временем.
 *   Правильная физическая модель — **экспоненциальное затухание** (кинетика первого порядка):
 *     S_eff(t) = neutral + (S_raw - neutral) × 2^(-t / τ_half)
 *
 *   Это отличается от гиперболы (1+βt)^(-ψ) Wickelgren (1974) — разные физические процессы:
 *   - Экспоненциальное затухание = постоянная скорость убывания (сенсорный регистр, выведение лекарств, радиоактивный распад)
 *   - Гипербола = накопление помех в следах памяти (предмет мета-анализа Rubin & Wenzel 1996)
 *
 *   В трёхуровневой модели Atkinson & Shiffrin (1968) сенсорный регистр
 *   характеризуется именно быстрым экспоненциальным затуханием
 *   (эксперимент Sperling 1960 с частичным отчётом: τ ≈ 250ms).
 *   Этот модуль распространяет данный механизм на слой социальных сигналов (τ = минуты~часы).
 *
 *   Свойство естественного затухания экспоненциального ядра: после 10 периодов полураспада
 *   остаток составляет 0.1% (2^-10 ≈ 0.001) — сигнал обнуляется сам, без жёсткого порога.
 *
 * Механизмы защиты:
 *   1. Все определения сигналов сосредоточены в этом файле — единый источник истины
 *   2. Каждый сигнал привязан к (valueKey, tsKey, halfLife) — временная метка не может быть пропущена
 *   3. Потребители могут импортировать только именованные функции — API принудительно обеспечивает временнóе осознание
 *
 * @see docs/adr/134-temporal-coherence.md — срок жизни сигнала и горизонт восприятия
 * @see docs/adr/126-obligation-field-decay.md
 * @see Atkinson & Shiffrin (1968) — трёхуровневая модель: сенсорный регистр = экспоненциальное затухание
 * @see Sperling (1960) — метод частичного отчёта: экспоненциальное затухание сенсорной памяти τ ≈ 250ms
 * @see Wickelgren (1974) — теория единого следа и уязвимости (сохранение памяти, не событийные сигналы)
 * @see Rubin & Wenzel (1996) — мета-анализ функций забывания за сто лет (сохранение памяти, не событийные сигналы)
 */

import { findActiveConversation } from "../graph/queries.js";
import type { WorldModel } from "../graph/world-model.js";
import { ChatTarget } from "../prompt/types.js";
import { readNodeMs } from "./clock.js";

// ═══════════════════════════════════════════════════════════════════════════
// Общее ядро затухания
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Экспоненциальное затухание событийного сигнала.
 *
 * S_eff(t) = neutral + (S_raw - neutral) × 2^(-ageS / halfLifeS)
 *
 * Свойства экспоненциального ядра:
 *   - Ровно через 1 период полураспада сигнал уменьшается вдвое (по определению)
 *   - После 10 периодов остаток 0.1% (естественное затухание, жёсткий порог не нужен)
 *   - Постоянная скорость убывания — соответствует кинетике первого порядка (сенсорная память, выведение лекарств)
 *
 * @param value - исходное значение сигнала
 * @param ageS - возраст наблюдения (секунды)
 * @param halfLifeS - период полураспада (секунды)
 * @param neutral - целевое значение затухания (по умолчанию 0)
 * @returns эффективное значение после затухания, стремящееся к neutral
 *
 * @see docs/adr/134-temporal-coherence.md §D1
 */
export function decaySignal(value: number, ageS: number, halfLifeS: number, neutral = 0): number {
  if (ageS <= 0) return value;
  const decay = 2 ** (-ageS / halfLifeS);
  return neutral + (value - neutral) * decay;
}

// ═══════════════════════════════════════════════════════════════════════════
// Сигнал 1: Obligation (поле обязательства pending_directed)
// ═══════════════════════════════════════════════════════════════════════════

/** Период полураспада обязательства в приватном чате (секунды). */
export const OBLIGATION_HALFLIFE_PRIVATE = 3600;
/** Период полураспада обязательства в групповом чате (секунды). ADR-186: унифицировано до 3600s — срочность ответа не должна зависеть от контекста. */
export const OBLIGATION_HALFLIFE_GROUP = 3600;

export const OBLIGATION_THRESHOLDS = {
  /** Вход в режим: только свежее обязательство запускает patrol → conversation. */
  modeEnter: 0.3,
  /** Выход из режима: разрешён, когда обязательство достаточно затухло (гистерезис против осцилляций). */
  modeExit: 0.1,
  /** Обход вентилей: слегка устаревшее обязательство всё ещё позволяет обойти gate. */
  bypassGates: 0.2,
  /** Эскалация System 1: любое нетривиальное обязательство требует LLM. */
  system1: 0.1,
  /** Сигнал Mod: порог для observer/consolidation. */
  signal: 0.1,
} as const;

/**
 * Эффективное обязательство: pending_directed × экспоненциальное временное затухание (без пола).
 * Ω(h,t) = pending_directed(h) × 2^(-(t - t_last) / τ_half)
 */
export function effectiveObligation(G: WorldModel, channelId: string, nowMs: number): number {
  if (!G.has(channelId)) return 0;

  const attrs = G.getChannel(channelId);
  const directed = Number(attrs.pending_directed ?? 0);
  if (directed <= 0) return 0;

  const lastDirectedMs = readNodeMs(G, channelId, "last_directed_ms");
  if (lastDirectedMs <= 0) return directed;

  const ageS = Math.max(0, (nowMs - lastDirectedMs) / 1000);
  const chatType = attrs.chat_type;
  const halfLife = ChatTarget.isGroupChat(chatType)
    ? OBLIGATION_HALFLIFE_GROUP
    : OBLIGATION_HALFLIFE_PRIVATE;

  return decaySignal(directed, ageS, halfLife);
}

/** Удобный булев: эффективное обязательство > порога. По умолчанию θ = 0.1. */
export function hasObligation(
  G: WorldModel,
  channelId: string,
  nowMs: number,
  threshold: number = OBLIGATION_THRESHOLDS.signal,
): boolean {
  return effectiveObligation(G, channelId, nowMs) > threshold;
}

// ═══════════════════════════════════════════════════════════════════════════
// Сигнал 2: Mention (упоминание имени mentions_alice)
// ═══════════════════════════════════════════════════════════════════════════

/** Период полураспада упоминания имени (секунды). 15 минут — упоминание является мгновенным социальным сигналом. */
export const MENTION_HALFLIFE_S = 900;

/**
 * Эффективная интенсивность упоминания: mentions_alice × временное затухание.
 *
 * Потребляет mentions_alice (boolean → 1/0) и mentions_alice_ms (временная метка).
 * Через 15 минут затухает до 0.5, через 30 минут — до 0.25.
 *
 * @returns ∈ [0, 1], 0 = нет упоминания или полное затухание
 */
export function effectiveMention(G: WorldModel, channelId: string, nowMs: number): number {
  if (!G.has(channelId)) return 0;

  const attrs = G.getChannel(channelId);
  if (!attrs.mentions_alice) return 0;

  const mentionMs = readNodeMs(G, channelId, "mentions_alice_ms");
  if (mentionMs <= 0) return 1; // нет временной метки → считаем, что только что произошло

  const ageS = Math.max(0, (nowMs - mentionMs) / 1000);
  return decaySignal(1, ageS, MENTION_HALFLIFE_S);
}

// ═══════════════════════════════════════════════════════════════════════════
// Сигнал 3: Risk (уровень риска risk_level)
// ═══════════════════════════════════════════════════════════════════════════

/** Период полураспада риска (секунды). 30 минут — семантически соответствует decayFactor(ageS/60, 10.0) в focus.ts. */
export const RISK_HALFLIFE_S = 1800;

const RISK_NUMERIC: Record<string, number> = {
  none: 0,
  low: 0.25,
  medium: 0.5,
  high: 1.0,
};

/**
 * Эффективная интенсивность риска: risk_level (категория → число) × временное затухание.
 *
 * Повторно используется проверенная семантика затухания из focus.ts — там риск корректно затухает,
 * но system1.ts и social-cost.ts это пропустили. Данная функция унифицирует все пути считывания.
 *
 * @returns ∈ [0, 1], 0 = нет риска или полное затухание
 */
export function effectiveRisk(G: WorldModel, channelId: string, nowMs: number): number {
  if (!G.has(channelId)) return 0;

  const attrs = G.getChannel(channelId);
  const riskLevel = String(attrs.risk_level ?? "none");
  const riskValue = RISK_NUMERIC[riskLevel] ?? 0;
  if (riskValue <= 0) return 0;

  const riskMs = readNodeMs(G, channelId, "risk_updated_ms");
  if (riskMs <= 0) return riskValue;

  const ageS = Math.max(0, (nowMs - riskMs) / 1000);
  return decaySignal(riskValue, ageS, RISK_HALFLIFE_S);
}

/**
 * Риск ниже порога "требует внимания". Заменяет булеву проверку isLowRisk().
 * Порог 0.3 = граница между "low"(0.25) и "medium"(0.5).
 * "none"(0) и "low"(0.25) считаются незначимыми, что соответствует семантике старого isLowRisk.
 */
export function isRiskNegligible(G: WorldModel, channelId: string, nowMs: number): boolean {
  return effectiveRisk(G, channelId, nowMs) < 0.3;
}

// ═══════════════════════════════════════════════════════════════════════════
// Сигнал 4: Outcome Quality (качество взаимодействия last_outcome_quality)
// ═══════════════════════════════════════════════════════════════════════════

/** Период полураспада качества взаимодействия (секунды). 1 час — прошлые плохие оценки не должны постоянно влиять на социальные издержки. */
export const OUTCOME_HALFLIFE_S = 3600;

/**
 * Эффективное качество взаимодействия: last_outcome_quality затухает к нейтральному значению (0.5).
 *
 * Q_eff(t) = 0.5 + (Q_raw - 0.5) × 2^(-ageS / halfLife)
 *
 * Свежая плохая оценка (0.2) → 0.2 (сильный сигнал)
 * Старая плохая оценка (0.2, 2ч) → стремится к 0.5 (нейтрально)
 *
 * @returns ∈ [0, 1], стремится к 0.5 (нейтрально)
 */
export function effectiveOutcomeQuality(G: WorldModel, channelId: string, nowMs: number): number {
  if (!G.has(channelId)) return 0.5;

  const attrs = G.getChannel(channelId);
  const quality = Number(attrs.last_outcome_quality ?? 0.5);

  const outcomeMs = readNodeMs(G, channelId, "last_outcome_ms");
  if (outcomeMs <= 0) return quality;

  const ageS = Math.max(0, (nowMs - outcomeMs) / 1000);
  return decaySignal(quality, ageS, OUTCOME_HALFLIFE_S, 0.5);
}

// ═══════════════════════════════════════════════════════════════════════════
// Сигнал 5: Outgoing Pressure (давление consecutive_outgoing — непрерывные исходящие)
// ═══════════════════════════════════════════════════════════════════════════

/** Период полураспада давления непрерывных исходящих (секунды). 24 часа — через сутки социальный контекст сброшен. */
export const OUTGOING_HALFLIFE_S = 86400;

/**
 * Эффективное давление непрерывных исходящих: consecutive_outgoing × временное затухание.
 *
 * 4 сообщения за 5 минут → крайне высокая навязчивость
 * 4 сообщения через 24 часа → затухает до 2 (повторный контакт допустим)
 *
 * Примечание: исходный счётчик обнуляется при ответе собеседника (mapper.ts); затухание влияет только в случае отсутствия ответа.
 *
 * @returns ∈ [0, +∞), 0 = нет непрерывных исходящих или полное затухание
 */
export function effectiveOutgoing(G: WorldModel, channelId: string, nowMs: number): number {
  if (!G.has(channelId)) return 0;

  const attrs = G.getChannel(channelId);
  const outgoing = Number(attrs.consecutive_outgoing ?? 0);
  if (outgoing <= 0) return 0;

  const lastOutgoingMs = readNodeMs(G, channelId, "last_outgoing_ms");
  if (lastOutgoingMs <= 0) return outgoing;

  const ageS = Math.max(0, (nowMs - lastOutgoingMs) / 1000);
  return decaySignal(outgoing, ageS, OUTGOING_HALFLIFE_S);
}

// ═══════════════════════════════════════════════════════════════════════════
// Сигнал 6: Unread Freshness (свежесть непрочитанных сообщений P1)
// ═══════════════════════════════════════════════════════════════════════════

/** Период полураспада свежести непрочитанных P1 (секунды). 1 час — соответствует obligation в приватном чате. */
export const UNREAD_FRESHNESS_HALFLIFE_S = 3600;

/**
 * Коэффициент усиления тонического внимания.
 *
 * tonic = κ × ln(1 + rawUnread) обеспечивает постоянное базовое восприятие,
 * не давая старым накопленным сообщениям стать невидимыми из-за затухания phasic (EWMS).
 *
 * @see docs/adr/176-tonic-phasic-attention.md
 * @see Posner & Petersen (1990) — декомпозиция tonic/phasic внимания
 */
export const KAPPA_TONIC = 1.0;

/**
 * Эффективное число непрочитанных: max(phasic, tonic).
 *
 * - Phasic (настороженность): EWMS × экспоненциальное затухание — управляется стимулом, быстро возникает и быстро затухает.
 * - Tonic (устойчивое): κ × ln(1 + rawUnread) — восприятие покрытия, логарифмическое масштабирование Вебера–Фехнера.
 *
 * max() вместо sum(): избегаем двойного подсчёта свежих сообщений. Для новых сообщений используется phasic (сигнал выше),
 * для старых накоплений — tonic (берёт на себя управление, когда phasic затухает ниже порога tonic).
 *
 * @see docs/adr/176-tonic-phasic-attention.md
 * @see docs/adr/134-temporal-coherence.md §D2
 * @see docs/adr/150-ewms-exact-unread-decay.md
 */
export function effectiveUnread(G: WorldModel, channelId: string, nowMs: number): number {
  if (!G.has(channelId)) return 0;
  const attrs = G.getChannel(channelId);
  const rawUnread = attrs.unread ?? 0;
  if (rawUnread <= 0) return 0;

  // Phasic: EWMS × экспоненциальное затухание (ADR-150)
  const ewms = Number(attrs.unread_ewms ?? 0);
  const ewmsMs = Number(attrs.unread_ewms_ms ?? 0);
  let phasic = 0;
  if (ewms > 0 && ewmsMs > 0) {
    const ageS = Math.max(0, (nowMs - ewmsMs) / 1000);
    phasic = ewms * decaySignal(1.0, ageS, UNREAD_FRESHNESS_HALFLIFE_S);
  }

  // Tonic: логарифмическое восприятие Вебера–Фехнера (ADR-176)
  const tonic = KAPPA_TONIC * Math.log(1 + rawUnread);

  return Math.max(phasic, tonic);
}

// ═══════════════════════════════════════════════════════════════════════════
// Сигнал 7: Act Silence (временное затухание последовательных тишин ACT)
// ═══════════════════════════════════════════════════════════════════════════

/** Период полураспада тишины ACT (секунды). 30 минут — временные ошибки Telegram не должны постоянно блокировать канал. */
export const ACT_SILENCE_HALFLIFE_S = 1800;

/** Безопасный порог последовательных тишин действий. При превышении effectiveActSilences пропускаем кандидата directed_override. */
export const ACT_SILENCE_SAFETY_THRESHOLD = 5;

/**
 * Порог кулдауна тишины. Когда effectiveActSilences >= этого значения, причина тишины помечается как "silence_cooldown".
 * @see docs/adr/157-signal-decay-integrity.md §Fix 4
 */
export const SILENCE_COOLDOWN_THRESHOLD = 3;

/**
 * Эффективное число тишин ACT: consecutive_act_silences × временное затухание.
 *
 * ADR-136: заменяет старый жёсткий gate `actSilences >= 3`. После последовательных сбоев система
 * автоматически восстанавливается в течение полупериода 30 минут — успешная отправка для "разблокировки" больше не нужна.
 *
 * Потребляет consecutive_act_silences и last_act_silence_ms (временная метка).
 *
 * @returns непрерывное значение ≥ 0. 3 сбоя + 30 минут → ~1.5.
 *
 * @see docs/adr/136-constrained-vmax/README.md §2.3 σ_fail
 */
export function effectiveActSilences(
  G: WorldModel,
  channelId: string,
  nowMs: number,
  halfLifeS = ACT_SILENCE_HALFLIFE_S,
): number {
  if (!G.has(channelId)) return 0;

  const attrs = G.getChannel(channelId);
  const silences = Number(attrs.consecutive_act_silences ?? 0);
  if (silences <= 0) return 0;

  const lastSilenceMs = readNodeMs(G, channelId, "last_act_silence_ms");
  if (lastSilenceMs <= 0) return silences; // нет временной метки → не затухает

  const ageS = Math.max(0, (nowMs - lastSilenceMs) / 1000);
  return decaySignal(silences, ageS, halfLifeS);
}

// ═══════════════════════════════════════════════════════════════════════════
// Сигнал 8: Aversion (экспоненциальное затухание социального избегания)
// ═══════════════════════════════════════════════════════════════════════════

/** Временная константа затухания избегания группового чата (секунды). Атмосфера в группе меняется быстро — 2 часа. */
const AVERSION_TAU_GROUP_S = 2 * 3600;
/** Временная константа затухания избегания приватного чата (секунды). Личные эмоции длятся дольше — 8 часов. */
const AVERSION_TAU_PRIVATE_S = 8 * 3600;

/**
 * ADR-217: эффективная интенсивность избегания ∈ [0, 1].
 *
 * Экспоненциальное затухание: aversion(t) = A × exp(-age / τ)
 * τ различается по chat_type: групповой чат 2ч, приватный 8ч.
 *
 * Не сбрасывается directed-сообщениями (полностью отделено от act_silences).
 * Пути восстановления: естественное временное затухание + явное снятие через LLM.
 *
 * @see docs/adr/217-pressure-field-aversion-gap.md §Вариант D
 */
export function effectiveAversion(G: WorldModel, channelId: string, nowMs: number): number {
  if (!G.has(channelId)) return 0;

  const attrs = G.getChannel(channelId);
  const raw = Number(attrs.aversion ?? 0);
  if (raw <= 0) return 0;

  const eventMs = Number(attrs.aversion_ms ?? 0);
  if (eventMs <= 0) return raw; // нет временной метки → не затухает

  const ageS = Math.max(0, (nowMs - eventMs) / 1000);
  const chatType = attrs.chat_type;
  const tau = chatType === "private" ? AVERSION_TAU_PRIVATE_S : AVERSION_TAU_GROUP_S;

  return raw * Math.exp(-ageS / tau);
}

// ═══════════════════════════════════════════════════════════════════════════
// Сигнал 9: Resting (Алиса намеренно отдыхает/спит)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Когда Алиса активно выбирает отдых, обычные кандидаты действий должны быть приостановлены.
 *
 * Это структурированный факт состояния, а не вывод из текста вроде “спокойной ночи”.
 * Запись в self.resting_until_ms производится только когда LLM явно возвращает afterward=resting.
 */
export function isSelfResting(G: WorldModel, nowMs: number): boolean {
  if (!G.has("self")) return false;
  const untilMs = Number(G.getAgent("self").resting_until_ms ?? 0);
  return untilMs > nowMs;
}

// ═══════════════════════════════════════════════════════════════════════════
// Сигнал продолжения диалога (общее определение)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Определение продолжения диалога: целевой канал находится в alice_turn активного разговора и нет явного социального обязательства.
 *
 * Эта функция используется в трёх местах (evolve.ts ×2, iaus-scorer.ts ×1),
 * устраняя inline-дублирование как источник проблем сопровождения.
 *
 * Условия возврата true (все должны выполняться):
 * 1. target существует в графе
 * 2. Последний говорящий не является ботом (alice_turn после бота не означает социального ожидания)
 * 3. Нет действующего явного обязательства (effectiveObligation ≤ bypassGates)
 * 4. На target есть активный разговор (state ∈ {pending, opening, active})
 * 5. turn_state разговора === "alice_turn"
 */
export function isConversationContinuation(G: WorldModel, target: string, nowMs: number): boolean {
  if (!G.has(target)) return false;
  if (G.getChannel(target).last_sender_is_bot === true) return false;
  if (effectiveObligation(G, target, nowMs) > OBLIGATION_THRESHOLDS.bypassGates) return false;
  const convId = findActiveConversation(G, target);
  if (!convId || !G.has(convId)) return false;
  return G.getConversation(convId).turn_state === "alice_turn";
}

// ─── ADR-222: Habituation (адаптивное затухание) ──────────────────────────────

/**
 * ADR-222: фактор адаптивного затухания ρ_H = 1/(1 + α·H_eff).
 *
 * H_eff = H · 2^(-elapsed/halfLife) — эффективное состояние адаптации после временного затухания.
 * Убывающий отклик на повторяющиеся стимулы — универсальное физическое ограничение от сетчатки до коры.
 *
 * Изоморфно модели делительной нормализации: R = E/(σ+E) (Carandini & Heeger 2012).
 * Гипербола 1/(1+αH) является частным случаем при n=1.
 *
 * @param H - накопленное значение адаптации (каждое действие +1.0, экспоненциальное затухание)
 * @param habituationMs - время стены последнего обновления (ms)
 * @param nowMs - текущее время (ms)
 * @param alpha - интенсивность адаптации (по умолчанию 0.5)
 * @param halfLifeS - период полураспада (секунды, по умолчанию 1800 = 30 минут)
 * @returns мультипликативный коэффициент затухания ∈ (0, 1]
 *
 * @see docs/adr/222-habituation-truth-model.md
 * @see Carandini & Heeger (2012) — Normalization as a canonical neural computation
 */
export function computeHabituationFactor(
  H: number,
  habituationMs: number,
  nowMs: number,
  alpha = 0.5,
  halfLifeS = 1800,
): number {
  if (H <= 0 || habituationMs <= 0) return 1.0;
  const ageS = Math.max(0, (nowMs - habituationMs) / 1000);
  const effectiveH = H * 2 ** (-ageS / halfLifeS);
  if (effectiveH < 0.01) return 1.0; // числовое обнуление
  return 1 / (1 + alpha * effectiveH);
}

// ═══════════════════════════════════════════════════════════════════════════
// ADR-225: Dormant Mode — поддержка циркадного ритма
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Определить, находится ли данный местный час в quiet window.
 * Поддерживает пересечение полуночи (start > end, например 23-7).
 * @see docs/adr/225-dormant-mode.md
 */
export function isInQuietWindow(localHour: number, start: number, end: number): boolean {
  if (start <= end) {
    // Без пересечения полуночи (например 1-6)
    return localHour >= start && localHour < end;
  }
  // С пересечением полуночи (например 23-7)
  return localHour >= start || localHour < end;
}

/**
 * Фактор модуляции dormant ρ_C.
 * В dormant-режиме давление по всем измерениям ×0.1 (включая P5 — обязательства не накапливаются во сне).
 * Вне dormant-режима возвращает 1.0 (без модуляции).
 */
export const DORMANT_PRESSURE_FACTOR = 0.1;
