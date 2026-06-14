/**
 * Компонуемые gate-функции — выделены из evolve.ts.
 *
 * Каждый gate — чистая функция (тестируется изолированно), определяет, нужно ли ставить действие в очередь в текущем tick.
 * Возвращает GateVerdict: act (пропуск), silent (записать молчание), pass (не совпало, передать следующему gate).
 *
 * @see paper-five-dim §4.2 "Action Gating Pipeline"
 */

import { chatIdToContactId } from "../graph/constants.js";
import { findConversationForChannel } from "../graph/queries.js";
import type { WorldModel } from "../graph/world-model.js";
import { type ChannelClass, ChatTarget } from "../prompt/types.js";
import type { VoiceAction } from "../voices/personality.js";
import type { ActionCandidate } from "./iaus-scorer.js";

// -- Классификация каналов ----------------------------------------------------------------

// Тип ChannelClass импортируется из prompt/types.ts (ADR-237 унификация)
// @see ADR-237: ChatTargetType пятичленное разбиение → производная четырёхчленная ChannelClass

/**
 * Классифицирует Telegram chat_type в четырёхчленную ChannelClass.
 *
 * Используется для классификации исторических действий (есть только chatType + isBot, без isOwnedChannel).
 * Для оценки сценария (с полным контекстом) следует использовать ChatTargetType + toChannelClass из snapshot.ts.
 *
 * ADR-206: channel — отдельная категория, больше не входит в group.
 * group/supergroup → "group", channel → "channel".
 * isBot применяется только вне группы и канала: private + isBot → "bot".
 *
 * @see ADR-237: ChatTargetType — единственный источник истины для оценки сценариев
 * @see ADR-189 D1 → ADR-206 §3
 */
export function classifyChatType(chatType: string | undefined, isBot?: boolean): ChannelClass {
  if (ChatTarget.isGroupChat(chatType)) return "group";
  if (ChatTarget.isChannelChat(chatType)) return "channel";
  if (isBot === true) return "bot";
  return "private";
}

/** Определяет, является ли chat_type каналом. @see ADR-206 §3 */
export function isChannel(chatType: string | undefined): boolean {
  return ChatTarget.isChannelChat(chatType);
}

/**
 * Выводит атрибут is_bot соответствующего contact по channel ID.
 * channel:xxx → contact:xxx → contact.is_bot.
 * Если нет в графе или contact отсутствует — возвращает undefined (откат к private).
 * @see ADR-189 D1
 */
export function resolveIsBot(G: WorldModel, channelId: string): boolean | undefined {
  const cId = chatIdToContactId(channelId);
  if (!cId || !G.has(cId)) return undefined;
  const isBot = G.getContact(cId).is_bot;
  return typeof isBot === "boolean" ? isBot : undefined;
}

/**
 * Подсчитывает количество действий из recentActions по категориям ChannelClass.
 * target, отсутствующие в графе, откатываются к "private" (консервативно: более строгий cap).
 */
export function countActionsByClass(
  recentActions: ReadonlyArray<{ target: string | null }>,
  G: WorldModel,
): Record<ChannelClass, number> {
  const counts: Record<ChannelClass, number> = { private: 0, group: 0, channel: 0, bot: 0 };
  for (const a of recentActions) {
    if (!a.target) continue;
    const chatType = G.has(a.target) ? G.getChannel(a.target).chat_type : undefined;
    const isBot = resolveIsBot(G, a.target);
    counts[classifyChatType(chatType, isBot)]++;
  }
  return counts;
}

// -- Типы -------------------------------------------------------------------

// ADR-84: в теории L5 — Degraded Action (действие, не молчание), не входит в спектр молчания.
// CRISIS_OVERRIDE — инженерный предохранитель (аварийный стоп при аномальной частоте сообщений), не уровень теоретического спектра.
export type SilenceLevel =
  | "L1_LOW_PRESSURE" // API < floor
  | "L2_ACTIVE_COOLING" // подавление плотности действий
  | "L3_STRATEGIC" // V(a,n) ≤ 0
  | "L4_DEFERRED" // выжидание (реализация VoI)
  | "CRISIS_OVERRIDE"; // инженерный предохранитель: аварийный стоп при аномальной частоте

/** Числовой контекст, переносимый вердиктом молчания — замкнутый набор вместо Record<string, number>. */
export interface SilenceValues {
  netValue?: number;
  deltaP?: number;
  socialCost?: number;
  apiValue?: number;
  /** ADR-252: ActionQueue queued item count at resource-plane suppression time. */
  queueQueued?: number;
  /** ADR-252: ActionQueue processing target count at resource-plane suppression time. */
  queueProcessing?: number;
  /** ADR-252: queued + processing, used as sink occupancy pressure. */
  queueActive?: number;
  /** ADR-252: queue/ACT saturation ratio used by backpressure. */
  queueSaturation?: number;
  /** ADR-252: threshold that triggered queue backpressure. */
  queueBackpressureThreshold?: number;
  /** IAUS pre-filter: total channel targets considered before target whitelist. */
  iausFilterTotalChannels?: number;
  /** IAUS pre-filter: targets allowed after target whitelist. */
  iausFilterEligibleTargets?: number;
  /** IAUS pre-filter: count for the dominant empty-pool reason. */
  iausFilterTopReasonCount?: number;
}

export type GateVerdict =
  | { type: "act"; candidate: ActionCandidate }
  | { type: "silent"; level: SilenceLevel; reason: string; values?: SilenceValues }
  | { type: "pass" };

/**
 * Комбинатор gate-цепочки: побеждает первый вердикт, не равный "pass".
 * @see paper-five-dim/ §4.2: Gate Pipeline
 */
export function runGateChain(gates: Array<() => GateVerdict>): GateVerdict {
  for (const gate of gates) {
    const v = gate();
    if (v.type !== "pass") return v;
  }
  return { type: "pass" };
}

// -- Gate-функции ---------------------------------------------------------------

/**
 * Gate: холостой самозапуск — запускает выбранный голос при длительном отсутствии действий.
 * ADR-81: больше не хардкодит reflection, использует уже выбранный голос.
 *
 * Миграция dt: idleThresholdS в секундах, idleSinceActionS — разница в секундах реального времени.
 * @see paper-five-dim §4.2 "Idle Self-Start"
 */
export function gateIdleSelfStart(
  idleSinceActionS: number,
  idleThresholdS: number,
  selectedAction: VoiceAction,
  target: string | null,
  focalEntities: string[],
): GateVerdict {
  if (idleSinceActionS >= idleThresholdS) {
    return {
      type: "act",
      candidate: {
        action: selectedAction,
        target,
        focalEntities: target != null ? focalEntities : [],
        netValue: 0,
        deltaP: 0,
        socialCost: 0,
      },
    };
  }
  return { type: "pass" };
}

/**
 * Gate: кризисный режим — блокирует только не-социальные обязательные действия в самом кризисном канале.
 *
 * Границы дизайна: этот gate — **предохранитель от флуда** (аномальная частота → подавление спама),
 * он не обрабатывает сценарий «Алису атакуют/буллят». Эмоциональная реакция на личные нападки реализована
 * через другой конвейер эмерджентности: LLM семантическое восприятие → feel() → модуляция голоса настроением → эмерджентное поведение.
 * Оба конвейера независимы и взаимодополняющи, не путать.
 * @see soul.mod.ts "When someone is upset" — ориентиры персоны для реакции на атаки
 *
 * ADR-84 исправление: старая логика `!isCrisisTarget || !hasDirected` затрагивала некризисные каналы.
 * Новая логика: некризисный канал → сразу pass; кризисный канал + shouldBypassGates → pass (сквозной);
 * кризисный канал + не-обязательное действие → CRISIS_OVERRIDE.
 *
 * @see docs/adr/84-theory-code-final-alignment.md
 */
export function gateCrisisMode(
  _G: WorldModel,
  target: string | null,
  crisisChannels: string[],
  shouldBypassGates: boolean,
): GateVerdict {
  if (crisisChannels.length === 0 || !target) return { type: "pass" };
  const isCrisisTarget = crisisChannels.includes(target);
  // некризисный канал → не затронут (исправление проблемы коллатерального урона в старой логике)
  if (!isCrisisTarget) return { type: "pass" };
  // кризисный канал + directed/continuation — сквозной
  if (shouldBypassGates) return { type: "pass" };
  // кризисный канал + не-обязательное действие → аварийный стоп
  return { type: "silent", level: "CRISIS_OVERRIDE", reason: "crisis_mode" };
}

/**
 * Gate: жёсткий предел — chat-type-aware превышение частоты действий.
 *
 * Личные чаты и группы используют независимые счётчики и лимиты, не конкурируя за квоту.
 * Цели directed/continuation пропускают этот gate (аналогично другим gate).
 *
 * @param classActionCount - количество действий в окне для той же категории (private/group), что и текущий target
 * @param classCap         - жёсткий предел действий для данной категории
 * @see ADR-113 F15: Rate cap не разграничивает группы и личку
 */
export function gateRateCap(
  classActionCount: number,
  classCap: number,
  apiValue: number,
  shouldBypassGates: boolean,
): GateVerdict {
  if (shouldBypassGates) return { type: "pass" };
  if (classActionCount >= classCap) {
    return {
      type: "silent",
      level: "L2_ACTIVE_COOLING",
      reason: "rate_cap",
      values: { apiValue },
    };
  }
  return { type: "pass" };
}

/**
 * Gate: нижний порог API — не действовать при слишком низком давлении (циркадная модуляция).
 * Цели bypass пропускают этот gate.
 *
 * @see paper-five-dim/ Axiom 4: silence when aggregate pressure below threshold
 */
export function gateAPIFloor(
  apiValue: number,
  effectiveFloor: number,
  circadian: number,
  bypassGates: boolean,
  bestV: number,
): GateVerdict {
  if (bypassGates) return { type: "pass" };
  // исправление аудита: диапазон API — [0, 7) (P1-P6 + P_prospect), множитель 6 → 7.
  if (apiValue < effectiveFloor * 7 * circadian) {
    return {
      type: "silent",
      level: "L1_LOW_PRESSURE",
      reason: "api_floor",
      values: { netValue: bestV, apiValue },
    };
  }
  return { type: "pass" };
}

/**
 * Gate: завершающийся разговор — блокирует последующие действия на данный target после leave().
 *
 * После того как Алиса сказала «пока», она не должна продолжать писать,
 * если только собеседник не отправил новое directed-сообщение после closing
 * (это позволяет собеседнику снова вовлечь Алису).
 *
 * Исправление F3: условие сквозного прохода основано на **сравнении временных меток** (last_directed_ms > closing_since_ms),
 * а не на накопленном effectiveObligation. В старой реализации остаточное pending_directed
 * до closing могло случайно пробиться через обещание прощания.
 */
export function gateClosingConversation(G: WorldModel, target: string | null): GateVerdict {
  if (!target || !G.has(target)) return { type: "pass" };
  const convId = findConversationForChannel(G, target);
  if (!convId || !G.has(convId)) return { type: "pass" };

  const convAttrs = G.getConversation(convId);
  if (convAttrs.state === "closing") {
    // F3: точное сравнение временных меток — сквозной проход только для новых directed-сообщений после closing
    const closingSinceMs = convAttrs.closing_since_ms ?? convAttrs.last_activity_ms ?? 0;
    const lastDirectedMs = G.getChannel(target).last_directed_ms ?? 0;
    if (lastDirectedMs > closingSinceMs) return { type: "pass" };
    return {
      type: "silent",
      level: "L2_ACTIVE_COOLING",
      reason: "closing_conversation",
    };
  }
  return { type: "pass" };
}

/**
 * Gate: осведомлённость о разговоре — корректирует gate действий на основе состояния диалога.
 * @see paper/ ADR-26 §3 "Conversation State Machine"
 */
export function gateConversationAware(
  G: WorldModel,
  target: string | null,
): { lambdaMultiplier: number; silenceBoost: boolean } {
  if (!target || !G.has(target)) return { lambdaMultiplier: 1.0, silenceBoost: false };
  const convId = findConversationForChannel(G, target);
  if (!convId || !G.has(convId)) return { lambdaMultiplier: 1.0, silenceBoost: false };

  const convAttrs = G.getConversation(convId);
  if (convAttrs.state === "active" && convAttrs.turn_state === "alice_turn") {
    return { lambdaMultiplier: 0.5, silenceBoost: false }; // снижаем lambda — легче пройти gate
  }
  if (convAttrs.state === "closing") {
    return { lambdaMultiplier: 1.0, silenceBoost: true }; // естественное завершение
  }
  if (convAttrs.state === "cooldown") {
    return { lambdaMultiplier: 2.0, silenceBoost: false }; // период охлаждения блокирует инициативу
  }
  return { lambdaMultiplier: 1.0, silenceBoost: false };
}
