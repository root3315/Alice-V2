/**
 * Strategy Mod — набор функций генерации подсказок.
 *
 * 11 видов логики генерации подсказок, вынесенных из onTickEnd (без personality_drift).
 * Каждая функция принимает ModContext<StrategyState> и возвращает StrategyHint[].
 */

function capitalizeFirst(s: string): string {
  return s.length > 0 ? s[0].toUpperCase() + s.slice(1) : s;
}

/**
 * Принцип EST: LLM потребляет дискретные категории, а не непрерывные скаляры.
 * Количество сообщений → семантическое описание.
 */
function msgCountLabel(n: number): string {
  if (n >= 100) return "a flood of";
  if (n >= 30) return "many";
  if (n >= 10) return "several";
  if (n >= 3) return "a few";
  return "a couple of";
}

import { eq, sql } from "drizzle-orm";
import { PromptBuilder } from "../../core/prompt-style.js";
import type { ModContext } from "../../core/types.js";
import { getDb } from "../../db/connection.js";
import { messageLog, narrativeThreads } from "../../db/schema.js";
import { ensureChannelId, extractNumericId, tierLabel } from "../../graph/constants.js";
import { safeDisplayName } from "../../graph/display.js";
import { estimateAgeS, estimateEventMs, readNodeMs } from "../../pressure/clock.js";
import { effectiveObligation } from "../../pressure/signal-decay.js";
import { humanDuration } from "../../utils/time-format.js";
import {
  CRISIS_FREQUENCY_RATIO,
  CRISIS_MIN_BASELINE,
  CRISIS_RECOVERY_RATIO,
  CRISIS_RECOVERY_Z,
  CRISIS_Z_THRESHOLD,
  emptyGroupState,
  extractKeywords,
  getSilenceThresholdS,
  MAX_RECENT_SPEAKERS,
  MAX_TOPIC_KEYWORDS,
  type StrategyHint,
  type StrategyState,
} from "./types.js";

// -- B2 fix: дополнение состояния группового чата из входящих сообщений -------------------------------------------

/**
 * Обновляет состояние группового чата из входящих сообщений в message_log.
 *
 * Проблема: GroupChatState обновляется только в listener SEND_MESSAGE, входящие сообщения пропускаются.
 * Исправление: onTickEnd читает недавние входящие сообщения и дополняет состояние группового чата.
 */
export function updateIncomingGroupState(ctx: ModContext<StrategyState>): void {
  try {
    const db = getDb();
    // ADR-110: используем createdAt вместо запроса по tick-окну (последние 60 секунд)
    const recentIncoming = db
      .select({
        chatId: messageLog.chatId,
        senderId: messageLog.senderId,
        senderName: messageLog.senderName,
        text: messageLog.text,
      })
      .from(messageLog)
      .where(
        sql`${messageLog.createdAt} >= ${Math.floor((ctx.nowMs - 60_000) / 1000)} AND ${messageLog.isOutgoing} = 0`,
      )
      .all();

    for (const msg of recentIncoming) {
      const channelId = msg.chatId;
      if (!channelId) continue;
      if (!ctx.state.groupStates[channelId]) {
        ctx.state.groupStates[channelId] = emptyGroupState();
      }
      const gs = ctx.state.groupStates[channelId];

      // Обновление говорящих (IRC-стиль: name ~senderId)
      if (msg.senderName) {
        // senderId имеет формат "contact:xxx" — извлекаем числовую часть как ~id
        const numId = msg.senderId ? extractNumericId(msg.senderId) : null;
        const tag = numId != null ? `${msg.senderName} @${numId}` : msg.senderName;
        // Дедупликация по senderId (чтобы избежать дублей при переименовании), при отсутствии senderId — по name
        const dedup = numId != null ? ` @${numId}` : msg.senderName;
        gs.recentSpeakers = gs.recentSpeakers.filter(
          (s) => !s.endsWith(dedup) && s !== msg.senderName,
        );
        gs.recentSpeakers.push(tag);
        if (gs.recentSpeakers.length > MAX_RECENT_SPEAKERS) {
          gs.recentSpeakers.shift();
        }
      }

      // Обновление ключевых слов
      if (msg.text) {
        const kw = extractKeywords(msg.text);
        gs.topicKeywords.push(...kw);
        if (gs.topicKeywords.length > MAX_TOPIC_KEYWORDS) {
          gs.topicKeywords = gs.topicKeywords.slice(-MAX_TOPIC_KEYWORDS);
        }
      }

      // Обновление счётчика сообщений (не Alice)
      gs.totalMessages++;
    }
  } catch {
    // Пропускаем, если БД недоступна
  }
}

// -- G7: экспорт graph-атрибута participation_ratio --------------------------------------

/** Экспортирует participationRatio в graph-атрибут (для динамического управления частотой в system1). */
export function syncParticipationToGraph(ctx: ModContext<StrategyState>): void {
  for (const [channelId, gs] of Object.entries(ctx.state.groupStates)) {
    if (ctx.graph.has(channelId)) {
      ctx.graph.updateChannel(channelId, { participation_ratio: gs.participationRatio });
    }
  }
}

// -- Функции генерации подсказок -----------------------------------------------------------

/** 1. Сканирование поддержания отношений — проверка времени молчания у близких контактов. */
export function generateRelationshipHints(ctx: ModContext<StrategyState>): StrategyHint[] {
  const hints: StrategyHint[] = [];
  for (const nodeId of ctx.graph.getEntitiesByType("contact")) {
    const attrs = ctx.graph.getContact(nodeId);
    const tier = Number(attrs.tier ?? 50);
    // ADR-110: пороговое значение теперь в секундах
    const thresholdS = getSilenceThresholdS(tier);

    // last_alice_action_ms записывается observer.mod в узел channel:xxx (DECLARE_ACTION target = ensureGraphId).
    // Здесь перебираем узлы contact:xxx, нужно проверять также соответствующий вариант channel:xxx.
    const chVariant = ensureChannelId(nodeId) ?? "";
    const lastInteractionMs = Math.max(
      readNodeMs(ctx.graph, nodeId, "last_alice_action_ms"),
      readNodeMs(ctx.graph, chVariant, "last_alice_action_ms"),
    );

    const silenceS = (ctx.nowMs - lastInteractionMs) / 1000;
    if (lastInteractionMs > 0 && silenceS > thresholdS) {
      const displayName = safeDisplayName(ctx.graph, nodeId);
      const label = tierLabel(tier);
      hints.push({
        type: "relationship_cooling",
        message: `Haven't talked to ${displayName} (${label}) in ${humanDuration(silenceS)}.`,
      });
    }
  }
  return hints;
}

/** 2. Детекция дисбаланса внимания — не слишком ли сконцентрированы недавние действия. */
export function generateAttentionHints(ctx: ModContext<StrategyState>): StrategyHint[] {
  const hints: StrategyHint[] = [];
  const recent = ctx.state.recentActions.slice(-10);
  if (recent.length >= 5) {
    const targetCounts: Record<string, number> = {};
    for (const a of recent) {
      if (a.target) {
        targetCounts[a.target] = (targetCounts[a.target] ?? 0) + 1;
      }
    }
    for (const [target, count] of Object.entries(targetCounts)) {
      const proportion = count / recent.length;
      if (proportion > 0.6) {
        const desc = proportion > 0.8 ? "almost all" : "most";
        const displayName = safeDisplayName(ctx.graph, target);
        hints.push({
          type: "attention_imbalance",
          message: `${capitalizeFirst(desc)} of recent actions directed at ${displayName}. Attention concentrated on one contact.`,
        });
      }
    }
  }
  return hints;
}

/** 3. Окно возможностей — определение только что вышедших онлайн контактов. */
export function generateOpportunityHints(ctx: ModContext<StrategyState>): StrategyHint[] {
  const hints: StrategyHint[] = [];
  for (const nodeId of ctx.graph.getEntitiesByType("contact")) {
    // ADR-110: получаем время returning через readNodeMs
    const returningMs = readNodeMs(ctx.graph, nodeId, "returning_ms");
    // ADR-110: 5 ticks × 60 = 300 секунд
    if (returningMs > 0 && (ctx.nowMs - returningMs) / 1000 <= 300) {
      const displayName = safeDisplayName(ctx.graph, nodeId);
      hints.push({
        type: "opportunity",
        message: `${displayName} just came back online — good moment to reconnect.`,
      });
    }
  }
  return hints;
}

/** 4. Устаревшие нити — есть открытый thread, но давно не было beat. */
export function generateStaleThreadHints(ctx: ModContext<StrategyState>): StrategyHint[] {
  const hints: StrategyHint[] = [];
  try {
    const db = getDb();
    const staleThreads = db
      .select({
        id: narrativeThreads.id,
        title: narrativeThreads.title,
        lastBeatTick: narrativeThreads.lastBeatTick,
        createdTick: narrativeThreads.createdTick,
        createdAt: narrativeThreads.createdAt,
      })
      .from(narrativeThreads)
      .where(eq(narrativeThreads.status, "open"))
      .all();

    for (const t of staleThreads) {
      // ADR-110/166: единообразно используем estimateAgeS (приоритет wall-clock, fallback tick × 60)
      const lastBeatTick = t.lastBeatTick ?? t.createdTick;
      const staleDurationS = estimateAgeS(
        { createdAt: t.createdAt, tick: lastBeatTick },
        ctx.nowMs,
        ctx.tick,
      );
      // 20 ticks × 60 = 1200 секунд
      if (staleDurationS > 1200) {
        hints.push({
          type: "thread_stale",
          message: `Thread #${t.id} "${t.title}" has been inactive for ${humanDuration(staleDurationS)} without progress.`,
        });
      }
    }
  } catch {
    // Пропускаем, если БД недоступна
  }
  return hints;
}

/** 5. Ожидающие диалоги — conversation, где очередь за Alice. */
export function generatePendingConversationHints(ctx: ModContext<StrategyState>): StrategyHint[] {
  const hints: StrategyHint[] = [];
  for (const convId of ctx.graph.getEntitiesByType("conversation")) {
    const conv = ctx.graph.getConversation(convId);
    if (conv.turn_state === "alice_turn" && conv.state !== "cooldown") {
      const participantId = conv.participants[0];
      // Доступность: используем display_name вместо raw graph ID
      const participantName =
        participantId && ctx.graph.has(participantId)
          ? String(ctx.graph.getDynamic(participantId, "display_name") ?? participantId)
          : participantId;
      const convLabel = participantName ?? "someone";
      hints.push({
        type: "conversation_pending",
        message: `Conversation with ${convLabel} waiting for a response.`,
      });
    }
  }
  return hints;
}

/**
 * 6. Детекция кризиса — резкий рост частоты сообщений в канале (сценарий 6 GOAL.md).
 *
 * Детекция по Z-score (замена старого отношения частот): Z = (unread - μ) / σ, Z > 2.5 → кризис-кандидат.
 * Статистически значимее — в обычные активные периоды ложных срабатываний нет (старое отношение 4× часто ошибалось при малой базе).
 *
 * Детектируется **флуд сообщений** (статистически аномальный рост), а не семантический буллинг/атака.
 * Генерируемый hint — контекстная осведомлённость (сообщает LLM, что происходит в канале),
 * gateCrisisMode обеспечивает поведенческое ограничение (не спамить во флуде) — оба дополняют, не противоречат.
 * Поведенческая реакция Alice на личные атаки идёт через эмерджентный пайплайн: feel() + mood + persona.
 *
 * @see evolve.ts spikeContribs — ADR-191: тот же метод EMA + Z-score, прямой структурный путь через tauSpike → rCaution
 */
export function generateCrisisHints(ctx: ModContext<StrategyState>): StrategyHint[] {
  const hints: StrategyHint[] = [];
  const EMA_ALPHA = 0.1;

  for (const channelId of ctx.graph.getEntitiesByType("channel")) {
    const attrs = ctx.graph.getChannel(channelId);
    const unread = attrs.unread ?? 0;

    // Инициализация окна частоты
    if (!ctx.state.messageFrequency[channelId]) {
      ctx.state.messageFrequency[channelId] = {
        recentCount: unread,
        baseline: unread,
        variance: 0,
        lastTick: ctx.tick,
        lastMs: ctx.nowMs,
      };
      continue;
    }

    const window = ctx.state.messageFrequency[channelId];
    // ADR-110: используем ms для определения прошедшего времени
    const msDelta = ctx.nowMs - (window.lastMs ?? 0);
    if (msDelta <= 0) continue;

    // Обновление среднего EMA + дисперсии (онлайн-алгоритм Велфорда, аналогично generators.ts)
    const diff = unread - window.baseline;
    window.baseline = window.baseline + EMA_ALPHA * diff;
    const prevVariance = window.variance ?? 0;
    window.variance = (1 - EMA_ALPHA) * (prevVariance + EMA_ALPHA * diff * diff);
    window.recentCount = unread;
    window.lastTick = ctx.tick;
    window.lastMs = ctx.nowMs;

    const isCrisis = !!ctx.state.crisisChannels[channelId];
    const hasVariance = (window.variance ?? 0) >= 1.0;

    // Вычисление Z-score (при достаточной дисперсии, иначе fallback на старое отношение частот)
    // biome-ignore lint/style/noNonNullAssertion: hasVariance guards non-null
    const z = hasVariance ? (unread - window.baseline) / Math.sqrt(window.variance!) : 0;

    if (!isCrisis) {
      // Детекция кризиса
      const isCrisisCandidate = hasVariance
        ? z > CRISIS_Z_THRESHOLD
        : // Fallback: старое отношение частот (когда данных о дисперсии недостаточно)
          unread > CRISIS_MIN_BASELINE &&
          window.baseline > 0 &&
          unread / Math.max(window.baseline, 1) >= CRISIS_FREQUENCY_RATIO;

      if (isCrisisCandidate) {
        ctx.state.crisisChannels[channelId] = ctx.tick;
        if (ctx.state.crisisChannelsMs) ctx.state.crisisChannelsMs[channelId] = ctx.nowMs;
        const displayName = safeDisplayName(ctx.graph, channelId);
        hints.push({
          type: "crisis_detected",
          message: `Unusual activity spike in ${displayName} (${unread > 50 ? "a flood of" : "many"} unread messages). Someone may need support.`,
        });
      }
    } else {
      // Восстановление после кризиса
      const isRecovered = hasVariance
        ? z < CRISIS_RECOVERY_Z
        : unread <= 0 || unread / Math.max(window.baseline, 1) < CRISIS_RECOVERY_RATIO;

      if (isRecovered) {
        const detectedMs = ctx.state.crisisChannelsMs?.[channelId] ?? 0;
        delete ctx.state.crisisChannels[channelId];
        if (ctx.state.crisisChannelsMs) delete ctx.state.crisisChannelsMs[channelId];
        const displayName = safeDisplayName(ctx.graph, channelId);
        const durationS = detectedMs > 0 ? (ctx.nowMs - detectedMs) / 1000 : 0;
        hints.push({
          type: "crisis_detected",
          message: `Activity in ${displayName} has calmed down (the spike lasted ${humanDuration(durationS)}).`,
        });
      }
    }
  }
  return hints;
}

/** 7. Восприятие атмосферы группового чата (сценарий 4) — определение активных групп + M2 ротация окна дрейфа темы. */
export function generateGroupAtmosphereHints(ctx: ModContext<StrategyState>): StrategyHint[] {
  const hints: StrategyHint[] = [];
  for (const channelId of ctx.graph.getEntitiesByType("channel")) {
    const attrs = ctx.graph.getChannel(channelId);
    if (attrs.chat_type !== "group" && attrs.chat_type !== "supergroup") continue;

    const unread = attrs.unread ?? 0;
    if (unread < 5) continue; // Учитываем только активные группы

    const displayName = safeDisplayName(ctx.graph, channelId);
    // ADR-110: получаем время last_alice_action через readNodeMs
    const lastAliceActionMs = readNodeMs(ctx.graph, channelId, "last_alice_action_ms");
    const silenceSinceAliceS = (ctx.nowMs - lastAliceActionMs) / 1000;

    // ADR-110: 15 ticks × 60 = 900 секунд
    if (lastAliceActionMs > 0 && silenceSinceAliceS > 900 && unread >= 10) {
      hints.push({
        type: "group_atmosphere",
        message: `${displayName} is lively (${unread > 50 ? "a flood of" : "many"} new messages) and you haven't participated for ${humanDuration(silenceSinceAliceS)}.`,
      });
    }

    // M2: FIFO-ротация окна ключевых слов темы (соответствует MAX_TOPIC_KEYWORDS в listener/updateIncomingGroupState)
    const gs = ctx.state.groupStates[channelId];
    if (gs && gs.topicKeywords.length > MAX_TOPIC_KEYWORDS) {
      gs.topicKeywords = gs.topicKeywords.slice(-MAX_TOPIC_KEYWORDS);
    }
  }
  return hints;
}

/** 8. Распознавание паттернов поведения (трёхуровневое усиление M4) — многомерная детекция поведенческих паттернов. */
export function generateBehaviorPatternHints(ctx: ModContext<StrategyState>): StrategyHint[] {
  const hints: StrategyHint[] = [];
  if (ctx.state.recentActions.length < 10) return hints;

  const last10 = ctx.state.recentActions.slice(-10);

  // 8a. Монотонность голоса (один и тот же intent повторяется)
  const intentCounts: Record<string, number> = {};
  for (const a of last10) {
    if (a.intent) {
      intentCounts[a.intent] = (intentCounts[a.intent] ?? 0) + 1;
    }
  }
  for (const [intent, count] of Object.entries(intentCounts)) {
    if (count >= 6) {
      const proportion = count >= 8 ? "almost all" : "most";
      hints.push({
        type: "behavior_pattern",
        message: `"${intent}" has been ${proportion} of recent actions. Messages following a similar pattern.`,
      });
    }
  }

  // 8b. Детекция ритмического паттерна — регулярность интервалов между действиями
  // Ссылка: Buzsáki (2006) Rhythms of the Brain — периодический паттерн есть ритм
  if (last10.length >= 5) {
    // ADR-110/166: единообразно используем estimateEventMs для вычисления интервалов
    const gaps: number[] = [];
    for (let i = 1; i < last10.length; i++) {
      const msI = estimateEventMs(last10[i], ctx.nowMs, ctx.tick);
      const msIPrev = estimateEventMs(last10[i - 1], ctx.nowMs, ctx.tick);
      const gapS = msI > 0 && msIPrev > 0 ? (msI - msIPrev) / 1000 : 0;
      gaps.push(gapS);
    }
    const meanGap = gaps.reduce((s, g) => s + g, 0) / gaps.length;
    const variance = gaps.reduce((s, g) => s + (g - meanGap) ** 2, 0) / gaps.length;
    const stdGap = Math.sqrt(variance);
    // CV (коэффициент вариации) < 0.3 → высокая регулярность
    const cv = meanGap > 0 ? stdGap / meanGap : 0;
    if (cv < 0.3 && meanGap > 0) {
      hints.push({
        type: "behavior_pattern",
        message: `Rhythmic pattern: acting at very regular intervals (roughly every ${humanDuration(Math.round(meanGap))}).`,
      });
    }
  }

  // 8c. Детекция повторений у разных контактов — один и тот же intent для 3+ разных целей
  // Ссылка: Goffman (1959) "Представление себя другим в повседневной жизни" — одинаковая стратегия с разными людьми = "формульность"
  const intentTargets: Record<string, Set<string>> = {};
  for (const a of last10) {
    if (a.intent && a.target) {
      if (!intentTargets[a.intent]) intentTargets[a.intent] = new Set();
      intentTargets[a.intent].add(a.target);
    }
  }
  for (const [intent, targets] of Object.entries(intentTargets)) {
    if (targets.size >= 3) {
      hints.push({
        type: "behavior_pattern",
        message: `Same approach ("${intent}") used with ${targets.size} different contacts recently.`,
      });
    }
  }

  return hints;
}

/**
 * 9. Ночная сводка (усиление сценария 1) — структурированная сводка по каналам.
 *
 * Генерируется при возобновлении активности Alice после длительного перерыва:
 * - Сортировка по приоритету: directed (личный чат/ответ) > mention (@упоминание в группе) > background
 * - Для каждого канала: число сообщений, количество directed/mention
 * - Детали берутся из message_log, graph-атрибуты — запасной вариант
 *
 * @see docs/adr/53-audit-gap-closure.md
 */
export function generateOvernightBriefingHints(ctx: ModContext<StrategyState>): StrategyHint[] {
  const allActions = ctx.state.recentActions;
  const lastAction = allActions.length > 0 ? allActions[allActions.length - 1] : null;
  // ADR-110: используем ms для вычисления времени молчания
  const lastActionMs = lastAction?.ms ?? 0;
  const lastActionTick = lastAction?.tick ?? 0;
  const inactiveDurationS = estimateAgeS(
    { ms: lastActionMs, tick: lastActionTick },
    ctx.nowMs,
    ctx.tick,
  );

  // Alice молчала более 3600 секунд (1 час) и есть записи о действиях
  if (inactiveDurationS <= 3600 || lastActionTick === 0) return [];

  // Попытка получить подробную статистику по каналам из message_log
  interface ChannelSummary {
    chatId: string;
    displayName: string;
    total: number;
    directed: number;
    chatType: string;
  }

  const channelSummaries: ChannelSummary[] = [];
  let usedDb = false;

  try {
    const db = getDb();
    // ADR-110: используем createdAt вместо запроса по tick-окну
    const cutoffMs = lastActionMs > 0 ? lastActionMs : ctx.nowMs - inactiveDurationS * 1000;
    const rows = db
      .select({
        chatId: messageLog.chatId,
        total: sql<number>`count(*)`,
        directed: sql<number>`sum(case when ${messageLog.isDirected} = 1 then 1 else 0 end)`,
      })
      .from(messageLog)
      .where(
        sql`${messageLog.createdAt} > ${Math.floor(cutoffMs / 1000)} AND ${messageLog.isOutgoing} = 0`,
      )
      .groupBy(messageLog.chatId)
      .all();

    for (const row of rows) {
      if (row.total === 0) continue;
      const chatId = row.chatId;
      const displayName = safeDisplayName(ctx.graph, chatId);
      const chatType = ctx.graph.has(chatId)
        ? String(ctx.graph.getDynamic(chatId, "chat_type") ?? "unknown")
        : "unknown";
      channelSummaries.push({
        chatId,
        displayName,
        total: row.total,
        directed: row.directed ?? 0,
        chatType,
      });
    }
    // Считаем успешным только если БД действительно вернула данные, иначе fallback на graph-атрибуты
    usedDb = channelSummaries.length > 0;
  } catch {
    // БД недоступна, fallback на graph-атрибуты
  }

  // Fallback: базовая статистика из graph-атрибутов
  if (!usedDb) {
    for (const channelId of ctx.graph.getEntitiesByType("channel")) {
      const attrs = ctx.graph.getChannel(channelId);
      const unread = attrs.unread ?? 0;
      // ADR-124: используем effectiveObligation вместо pending_directed
      // @see docs/adr/126-obligation-field-decay.md §D6
      const directed = effectiveObligation(ctx.graph, channelId, ctx.nowMs);
      if (unread > 0) {
        const displayName = safeDisplayName(ctx.graph, channelId);
        const chatType = String(attrs.chat_type ?? "unknown");
        channelSummaries.push({
          chatId: channelId,
          displayName,
          total: unread,
          directed,
          chatType,
        });
      }
    }
  }

  if (channelSummaries.length === 0) return [];

  const totalMessages = channelSummaries.reduce((s, c) => s + c.total, 0);
  const totalDirected = channelSummaries.reduce((s, c) => s + c.directed, 0);
  if (totalMessages <= 5 && totalDirected === 0) return [];

  // Классификация: priority (есть directed-сообщения) vs background
  const priority = channelSummaries.filter((c) => c.directed > 0);
  const background = channelSummaries.filter((c) => c.directed === 0);

  // Сортировка: priority по количеству directed по убыванию; background по общему числу по убыванию
  priority.sort((a, b) => b.directed - a.directed);
  background.sort((a, b) => b.total - a.total);

  // Формирование структурированной сводки
  const m = new PromptBuilder();
  m.line(
    `OVERNIGHT BRIEFING (silent for ${humanDuration(inactiveDurationS)}, ${msgCountLabel(totalMessages)} messages accumulated):`,
  );

  if (priority.length > 0) {
    m.heading("Priority");
    m.list(
      priority.map((ch) => {
        // Личный чат → "directed messages"; групповой → "@mention/reply"; неизвестный → "directed"
        const label =
          ch.chatType === "private"
            ? "directed messages"
            : ch.chatType === "group" || ch.chatType === "supergroup"
              ? "@mention/reply"
              : "directed";
        return `${ch.displayName}: ${msgCountLabel(ch.directed)} ${label}, ${msgCountLabel(ch.total)} messages total`;
      }),
    );
  }

  if (background.length > 0) {
    m.heading("Background");
    m.list(
      background.slice(0, 10).map((ch) => {
        // Ограничение background — не более 10 записей, чтобы не раздувать контекст
        return `${ch.displayName}: ${msgCountLabel(ch.total)} messages, no directed`;
      }),
    );
    if (background.length > 10) {
      const overflow = background.slice(10).reduce((s, c) => s + c.total, 0);
      m.line(`... and ${background.length - 10} more chats (${overflow} messages)`);
    }
  }

  if (totalDirected > 0) {
    m.line(`There are ${totalDirected} directed messages and @mentions waiting.`);
  }

  return [
    {
      type: "overnight_briefing",
      message: m.build().join("\n"),
    },
  ];
}

/** 10. Напоминание о дедлайне обязательства (сценарий 3) — проверка thread с horizon, приближающимся к истечению. */
export function generateCommitmentHints(ctx: ModContext<StrategyState>): StrategyHint[] {
  const hints: StrategyHint[] = [];
  try {
    const db = getDb();
    const urgentThreads = db
      .select({
        id: narrativeThreads.id,
        title: narrativeThreads.title,
        horizon: narrativeThreads.horizon,
        createdTick: narrativeThreads.createdTick,
        createdAt: narrativeThreads.createdAt,
      })
      .from(narrativeThreads)
      .where(eq(narrativeThreads.status, "open"))
      .all();

    for (const t of urgentThreads) {
      if (!t.horizon) continue;
      // horizon в единицах tick, 1 tick ≈ 60s
      const horizonS = t.horizon * 60;
      const createdMs = estimateEventMs(
        { createdAt: t.createdAt, tick: t.createdTick },
        ctx.nowMs,
        ctx.tick,
      );
      const deadlineMs = createdMs + horizonS * 1000;
      const remainingS = (deadlineMs - ctx.nowMs) / 1000;
      // Дедлайн близко (осталось < 20% horizon или < 600 секунд)
      if (remainingS > 0 && (remainingS < horizonS * 0.2 || remainingS < 600)) {
        hints.push({
          type: "commitment_due",
          message: `Thread #${t.id} "${t.title}" is approaching its deadline (${humanDuration(remainingS)} remaining).`,
        });
      }
    }
  } catch {
    // Пропускаем, если БД недоступна
  }
  return hints;
}

/**
 * Осознание бот-инструментов — сканирование контактов с меткой is_bot.
 *
 * ADR-196 F5: включаем только ботов, активных за последние 7 дней, не более 3 записей.
 * В групповых чатах фильтруется естественно через ENTITY_SCOPED visibility filter по имени сущности;
 * в личных чатах активность + cap снижают шум от нерелевантных ботов.
 */
export function generateBotToolHints(ctx: ModContext<StrategyState>): StrategyHint[] {
  const RECENCY_MS = 7 * 24 * 3600 * 1000;
  const cutoff = ctx.nowMs - RECENCY_MS;
  const hints: StrategyHint[] = [];
  for (const contactId of ctx.graph.getEntitiesByType("contact")) {
    const attrs = ctx.graph.getContact(contactId);
    if (attrs.is_bot !== true) continue;
    if ((attrs.last_active_ms ?? 0) < cutoff) continue;
    const displayName = safeDisplayName(ctx.graph, contactId);
    hints.push({
      type: "opportunity",
      message: `${displayName} is a bot — you can use it as a tool (send commands, read responses).`,
    });
    if (hints.length >= 3) break;
  }
  return hints;
}
