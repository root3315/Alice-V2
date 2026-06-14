/**
 * ADR-23 Wave 3: слой самонаблюдения — обнаружение поведенческих паттернов + персистентность.
 *
 * ADR-81: renderSelfObservation удалён (содержимое покрывается observer.mod + strategy.mod).
 * Сохранён persistBehavioralInsights для периодического вызова из evolve.ts (каждые 60 тиков).
 *
 * @see docs/adr/81-reflection-separation.md §миграция-слоя-самонаблюдения
 * @see paper-five-dim/ §6.3 "Self-Observation Write-Back"
 */
import { desc, sql } from "drizzle-orm";
import type { Dispatcher } from "../core/dispatcher.js";
import { typedQuery } from "../core/query-helpers.js";
import { getDb } from "../db/connection.js";
import { actionLog, messageLog } from "../db/schema.js";
import { chatIdToContactId } from "../graph/constants.js";

// -- Типы --------------------------------------------------------------------

interface OutboundAction {
  tick: number;
  voice: string;
  actionType: string;
  chatId: string | null;
  success: boolean;
}

interface InteractionPattern {
  chatId: string;
  outbound: number;
  inbound: number;
  ratio: number;
}

interface RelationshipTrend {
  contactId: string;
  displayName: string;
  tierDirection: "stable" | "improving" | "declining";
}

// -- Функции сбора данных -------------------------------------------------------

/** Недавние исходящие действия. */
export function gatherOutboundActions(tick: number, window = 50): OutboundAction[] {
  const db = getDb();
  return db
    .select({
      tick: actionLog.tick,
      voice: actionLog.voice,
      actionType: actionLog.actionType,
      chatId: actionLog.chatId,
      success: actionLog.success,
    })
    .from(actionLog)
    .where(sql`${actionLog.tick} >= ${tick - window}`)
    .orderBy(desc(actionLog.tick))
    .limit(20)
    .all()
    .reverse();
}

/** Соотношение outbound/inbound по каждому контакту. */
export function gatherInteractionPatterns(tick: number, window = 100): InteractionPattern[] {
  const db = getDb();
  const messages = db
    .select({
      chatId: messageLog.chatId,
      isOutgoing: messageLog.isOutgoing,
    })
    .from(messageLog)
    .where(sql`${messageLog.tick} >= ${tick - window}`)
    .all();

  const chatStats = new Map<string, { outbound: number; inbound: number }>();
  for (const m of messages) {
    const stats = chatStats.get(m.chatId) ?? { outbound: 0, inbound: 0 };
    if (m.isOutgoing) stats.outbound++;
    else stats.inbound++;
    chatStats.set(m.chatId, stats);
  }

  return [...chatStats.entries()].map(([chatId, stats]) => ({
    chatId,
    outbound: stats.outbound,
    inbound: stats.inbound,
    ratio: stats.inbound > 0 ? stats.outbound / stats.inbound : stats.outbound > 0 ? Infinity : 0,
  }));
}

// -- M5: обнаружение поведенческих паттернов ---------------------------------

interface BehaviorPattern {
  actionRepetitionRate: number;
  dominantAction: string | null;
  avgResponseGap: number;
}

/**
 * M5: обнаружение поведенческих паттернов — запрос pattern detection, требуемый статьёй D3-R.
 *
 * Обнаруживает повторяющиеся паттерны в недавнем поведении.
 */
export function gatherBehaviorPatterns(tick: number, window = 50): BehaviorPattern {
  const actions = gatherOutboundActions(tick, window);
  if (actions.length === 0) {
    return { actionRepetitionRate: 0, dominantAction: null, avgResponseGap: 0 };
  }

  const typeCounts = new Map<string, number>();
  for (const a of actions) {
    typeCounts.set(a.actionType, (typeCounts.get(a.actionType) ?? 0) + 1);
  }

  let dominantAction: string | null = null;
  let maxCount = 0;
  for (const [type, count] of typeCounts) {
    if (count > maxCount) {
      maxCount = count;
      dominantAction = type;
    }
  }

  const actionRepetitionRate = actions.length > 0 ? maxCount / actions.length : 0;

  let totalGap = 0;
  let gapCount = 0;
  for (let i = 1; i < actions.length; i++) {
    totalGap += actions[i].tick - actions[i - 1].tick;
    gapCount++;
  }
  const avgResponseGap = gapCount > 0 ? totalGap / gapCount : 0;

  return { actionRepetitionRate, dominantAction, avgResponseGap };
}

/**
 * M5: обнаружение трендов отношений — траектория изменений tier.
 * ADR-198: trust централизованно управляется через rv_trust, тренд переведён на граф-атрибут tier_direction.
 */
export function gatherRelationshipTrends(
  dispatcher: Dispatcher,
  chatIds: string[],
): RelationshipTrend[] {
  const trends: RelationshipTrend[] = [];
  for (const chatId of chatIds) {
    const contactId = chatIdToContactId(chatId);
    if (!contactId) continue;

    const profile = typedQuery(dispatcher, "contact_profile", { contactId });
    if (!profile) continue;

    // tier_direction устанавливается эволюцией tier в onTickEnd (upgrade/downgrade/undefined)
    const rawDirection = (profile as Record<string, unknown>).tierDirection;
    let tierDirection: "stable" | "improving" | "declining" = "stable";
    if (rawDirection === "upgrade") tierDirection = "improving";
    else if (rawDirection === "downgrade") tierDirection = "declining";

    trends.push({
      contactId: profile.contactId,
      displayName: profile.displayName,
      tierDirection,
    });
  }
  return trends;
}

// -- C4 Write-Back: персистентность самонаблюдения ----------------------------

/**
 * C4 Write-Back Loop: сохраняет значимые поведенческие паттерны как self facts.
 *
 * ADR-81: перенесено из reflect.ts в периодический вызов evolve.ts (каждые 60 тиков).
 * Запись происходит только при обнаружении значимого отклонения (повторяемость > 60%, изменение трендов отношений),
 * чтобы шумовые факты не заглушали осмысленное самопознание.
 *
 * @see paper-five-dim/ §6.3 "Self-Observation Write-Back"
 */
export function persistBehavioralInsights(
  tick: number,
  dispatcher: Dispatcher,
  chatIds: string[],
): number {
  let insightCount = 0;

  // 1. паттерн повторяющихся действий → self fact
  const behavior = gatherBehaviorPatterns(tick);
  if (behavior.dominantAction && behavior.actionRepetitionRate > 0.6) {
    try {
      dispatcher.dispatch("note", {
        contactId: "self",
        content: `I've been doing a lot of ${behavior.dominantAction} lately`,
        type: "observation",
        importance: 0.4,
      });
      insightCount++;
    } catch {
      // не критично — сбой записи не влияет на главный цикл
    }
  }

  // 2. изменение тренда отношений → self fact
  const trends = gatherRelationshipTrends(dispatcher, chatIds);
  for (const t of trends) {
    if (t.tierDirection === "stable") continue;
    const direction = t.tierDirection === "improving" ? "improving" : "declining";
    try {
      dispatcher.dispatch("note", {
        contactId: "self",
        content: `Relationship with ${t.displayName} is ${direction}`,
        type: "observation",
        importance: 0.5,
      });
      insightCount++;
    } catch {
      // не критично
    }
  }

  return insightCount;
}
