/**
 * ADR-23 Wave 3: 自观察层 — 行为模式检测 + 持久化。
 *
 * ADR-81: renderSelfObservation 已删除（内容由 observer.mod + strategy.mod 覆盖）。
 * 保留 persistBehavioralInsights 供 evolve.ts 周期调用（每 60 ticks）。
 *
 * @see docs/adr/81-reflection-separation.md §自观察层迁移
 * @see paper-five-dim/ §6.3 "Self-Observation Write-Back"
 */
import { desc, sql } from "drizzle-orm";
import type { Dispatcher } from "../core/dispatcher.js";
import { typedQuery } from "../core/query-helpers.js";
import { getDb } from "../db/connection.js";
import { actionLog, messageLog } from "../db/schema.js";
import { chatIdToContactId } from "../graph/constants.js";

// -- 类型 --------------------------------------------------------------------

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

// -- 数据采集函数 ---------------------------------------------------------------

/** 近期出站行为。 */
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

/** 每联系人 outbound/inbound 比。 */
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

// -- M5: 行为模式检测 ---------------------------------------------------------

interface BehaviorPattern {
  actionRepetitionRate: number;
  dominantAction: string | null;
  avgResponseGap: number;
}

/**
 * M5: 行为模式检测 — 论文 D3-R 要求的 pattern detection query。
 *
 * 检测近期行为中的重复模式。
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
 * M5: 关系趋势检测 — tier 变化轨迹。
 * ADR-198: trust 统一由 rv_trust 管理，趋势改为基于 tier_direction 图属性。
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

    // tier_direction 由 onTickEnd 的 tier 演化设置（upgrade/downgrade/undefined）
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

// -- C4 Write-Back: 自观察持久化 -----------------------------------------------

/**
 * C4 Write-Back Loop: 将显著行为模式持久化为 self facts。
 *
 * ADR-81: 从 reflect.ts 迁移到 evolve.ts 周期调用（每 60 ticks）。
 * 只在检测到显著偏离（重复率 > 60%，关系趋势变化）时写入，
 * 避免噪声事实淹没有意义的自知。
 *
 * @see paper-five-dim/ §6.3 "Self-Observation Write-Back"
 */
export function persistBehavioralInsights(
  tick: number,
  dispatcher: Dispatcher,
  chatIds: string[],
): number {
  let insightCount = 0;

  // 1. 行为重复模式 → self fact
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
      // 非致命——写入失败不影响主循环
    }
  }

  // 2. 关系趋势变化 → self fact
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
      // 非致命
    }
  }

  return insightCount;
}
