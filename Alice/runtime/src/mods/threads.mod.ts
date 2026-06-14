/**
 * Threads Mod — управление нарративными нитями.
 *
 * Соответствует mod narrative-tree нарративного движка (система Arc-Beat):
 * - Thread ≈ Arc (топик/нить отношений, с tension + status + weight)
 * - Beat ≈ ключевое событие-такт (с причинными связями causedBy / spawns)
 *
 * Инструкции: self_topic_begin, self_topic_advance, self_topic_resolve, affect_thread, thread_review
 * Запросы: openTopics, printTopicsAbout, topicUpdates
 * contribute: список активных нитей → бакет section
 *
 * Ссылка: narrative-engine/mods/narrative-tree/index.ts
 * Ссылка: narrative-framework-paper §5 (P_τ priority)
 */
import { desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { createMod } from "../core/mod-builder.js";
import { PromptBuilder } from "../core/prompt-style.js";
import type { ContributionItem, ModContext } from "../core/types.js";
import { readModState, readPressureApi, section } from "../core/types.js";
import { getDb } from "../db/connection.js";
import { narrativeBeats, narrativeThreads } from "../db/schema.js";
import { snoozeThreadLifecycle } from "../db/thread-lifecycle.js";
import { createThreadInGraph, resolveThreadInGraph, WEIGHT_MAP } from "../engine/generators.js";
import { resolveDisplayName, safeDisplayName } from "../graph/display.js";
import { estimateEventMs } from "../pressure/clock.js";
import { humanDuration, humanDurationAgo } from "../utils/time-format.js";

// -- Типы --------------------------------------------------------------------

interface Involvement {
  nodeId: string;
  role: string;
  facts?: string[];
}

// WEIGHT_MAP импортируется из generators.ts (единственный источник истины)

/** ADR-23: расширенные социальные типы Beat (совместимы с kernel|ambient). ADR-181: +prudence/breakthrough. */
export const BEAT_TYPES = [
  "kernel",
  "ambient",
  "observation",
  "engagement",
  "assistance",
  "misstep",
  "connection",
  "insight",
  "prudence",
  "breakthrough",
] as const;

export type BeatType = (typeof BEAT_TYPES)[number];

// -- ADR-241: константы затухания релевантности ------------------------------------------------

/** ADR-241: порог релевантности — нити ниже этого значения не инжектируются в prompt. */
// Обоснование: при периоде полуспада 7 дней minor нить (w=0.5) через 7 дней relevance ≈ 0.25, через 14 ≈ 0.125.
// major нить (w=2.0) через 14 дней ≈ 1.0, через 28 ≈ 0.5.
const RELEVANCE_THRESHOLD = 0.15;

/** ADR-241: порог метки Stale — отображать метку [stale] при приближении к порогу фильтрации. */
// 2× RELEVANCE_THRESHOLD, предупреждение примерно за 2-3 дня.
const STALE_THRESHOLD = RELEVANCE_THRESHOLD * 2;

// -- Вспомогательные функции -----------------------------------------------------------------

function parseInvolves(raw: string | null): Involvement[] {
  if (!raw) return [];
  try {
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

/** Фильтрует записи involves с пустым/undefined nodeId. */
function validInvolves(involves: Involvement[]): Involvement[] {
  return involves.filter((i) => i.nodeId != null && i.nodeId !== "" && i.nodeId !== "undefined");
}

/** Рендерит involves как список отображаемых имён для LLM (доступность: display_name вместо raw nodeId). */
function renderInvolves(involves: Involvement[], ctx: ModContext): string {
  const valid = validInvolves(involves);
  if (valid.length === 0) return "";
  return valid
    .map((i) => {
      // ADR-172: единообразно используем safeDisplayName — никогда не возвращаем raw graph ID
      const name = safeDisplayName(ctx.graph, i.nodeId);
      return `${name}(${i.role})`;
    })
    .join(", ");
}

/**
 * ADR-110: давление нити (упрощённый P_τ, уравнение P1 из статьи).
 * ADR-64 VI-1: log(1 + ageS/86400) × w + activity_decay.
 * Используется wall-clock время в секундах.
 */
function threadPressure(
  createdMs: number,
  lastBeatMs: number | null,
  weight: string,
  nowMs: number,
): number {
  const ageS = Math.max(1, (nowMs - createdMs) / 1000);
  const w = WEIGHT_MAP[weight] ?? 0.5;
  // ADR-64 VI-1: логарифмический рост вместо age^1.5, предотвращает взрыв у длинных нитей
  const agingPressure = Math.log(1 + ageS / 86400) * w;
  const sinceBeatS = Math.max(0, (nowMs - (lastBeatMs ?? createdMs)) / 1000);
  const activityDecay = sinceBeatS > 300 ? Math.log(sinceBeatS / 60) * w * 0.1 : 0;
  return agingPressure + activityDecay;
}

/**
 * ADR-241: релевантность нити (затухание с периодом полуспада) — используется для фильтрации, не для сортировки.
 *
 * threadPressure растёт со временем ("срочность обработки") — правильно использовать для сортировки.
 * threadRelevance убывает с временем бездействия ("текущая релевантность") — используется для фильтрации длительно неактивных нитей.
 *
 * Период полуспада 7 дней: minor нить через 7 дней ≈ 0.25, через 14 ≈ 0.125 (ниже RELEVANCE_THRESHOLD).
 * @see docs/adr/241-thread-weight-decay.md
 * @see docs/adr/89-impression-formation-system.md (ссылка на период полуспада)
 */
export function threadRelevance(
  createdMs: number,
  lastBeatMs: number | null,
  weight: string,
  nowMs: number,
): number {
  const w = WEIGHT_MAP[weight] ?? 0.5;
  const baseMs = lastBeatMs ?? createdMs;
  const inactiveS = Math.max(0, (nowMs - baseMs) / 1000);
  // Период полуспада 7 дней (604800 секунд)
  const DECAY_HALF_LIFE_S = 7 * 86400;
  const decayFactor = 2 ** (-inactiveS / DECAY_HALF_LIFE_S);
  return w * decayFactor;
}

// -- Состояние Mod -----------------------------------------------------------------

interface ThreadsState {
  /** Кэш: число активных нитей (обновляется в onTickEnd). */
  activeCount: number;
  /** Кэш: максимальное давление нити. */
  maxPressure: number;
}

// -- Определение Mod -----------------------------------------------------------------

export const threadsMod = createMod<ThreadsState>("threads", {
  category: "mechanic",
  description: "Управление нарративными линиями (Arc-Beat)",
  topics: ["threads"],
  initialState: { activeCount: 0, maxPressure: 0 },
})
  .instruction("begin_topic", {
    params: z.object({
      title: z.string().min(1).max(200).describe("Название линии"),
      frame: z.string().max(200).optional().describe("Рамка напряжения"),
      stake: z.string().max(200).optional().describe("Что на кону / важность"),
      weight: z
        .enum(["trivial", "minor", "major", "critical"])
        .optional()
        .describe("Вес: trivial|minor|major|critical"),
      involves: z
        .array(z.object({ nodeId: z.string(), role: z.string() }))
        .optional()
        .describe("Участвующие сущности [{nodeId, role}]"),
      horizon: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Горизонт прогноза (ticks), для P_prospect"),
    }),
    description: "Создать новую нарративную линию",
    examples: ['self_topic_begin({ title: "Weekend hiking plan", weight: "major", horizon: 10 })'],
    affordance: {
      priority: "sensor",
      whenToUse: "Starting a new conversation thread worth tracking",
      whenNotToUse: "Casual small talk that doesn't need a thread",
    },
    impl(ctx, args) {
      const db = getDb();
      // ADR-204 C10: nodeId в involves может быть display_name, разбирается на стороне кода
      const rawInvolves = Array.isArray(args.involves)
        ? (args.involves as Involvement[])
        : undefined;
      const involves = rawInvolves?.map((i) => ({
        ...i,
        nodeId: resolveDisplayName(ctx.graph, i.nodeId) ?? i.nodeId,
      }));
      const horizon = args.horizon != null ? Number(args.horizon) : null;
      const weight = (args.weight ? String(args.weight) : "minor") as
        | "trivial"
        | "minor"
        | "major"
        | "critical";

      // ADR-104: читаем текущую цель действия из relationships mod как source_channel
      const relState = readModState(ctx, "relationships");
      const sourceChannel = relState?.targetNodeId ?? undefined;

      // ADR-115: делегируем в общую функцию createThreadInGraph
      const deadlineMs = horizon != null ? ctx.nowMs + horizon * 60 * 1000 : undefined; // horizon в минутах
      const threadId = createThreadInGraph(db, ctx.graph, ctx.tick, ctx.nowMs, {
        title: String(args.title),
        weight,
        deadlineMs,
        involves,
        source: "conversation",
        frame: args.frame ? String(args.frame) : undefined,
        sourceChannel,
      });

      // Синхронизация FTS-индекса инкапсулирована в createThreadInGraph
      return threadId;
    },
  })
  // ADR-66 F8: BEAT → advance ("Beat" — термин нарративного фреймворка, непонятный LLM).
  .instruction("advance_topic", {
    params: z.object({
      threadId: z.number().int().positive().describe("ID темы"),
      content: z.string().min(1).max(1000).describe("Новое развитие — что произошло, как изменилась ситуация"),
      beatType: z
        .enum([
          "kernel",
          "ambient",
          "observation",
          "engagement",
          "assistance",
          "misstep",
          "connection",
          "insight",
          "prudence",
          "breakthrough",
        ])
        .optional()
        .describe(
          "Тип развития: kernel|ambient|observation|engagement|assistance|misstep|connection|insight|prudence|breakthrough. prudence=взвешенная осторожность привела к лучшему результату; breakthrough=рискованный социальный шаг получил положительный отклик",
        ),
      causedBy: z.array(z.number().int()).optional().describe("Причинные источники (thread/beat IDs)"),
      spawns: z.array(z.number().int()).optional().describe("IDs порождённых новых тем"),
    }),
    description: "Записать новое развитие темы (что произошло, как изменилась ситуация)",
    examples: [
      'self_topic_advance({ threadId: 3, content: "decided on the route", beatType: "engagement" })',
    ],
    affordance: {
      priority: "sensor",
      whenToUse: "Progressing narrative threads with new developments",
      whenNotToUse: "No active threads or nothing new happened",
    },
    impl(ctx, args) {
      const db = getDb();
      const threadId = Number(args.threadId);
      const rawCausedBy = args.causedBy;
      const causedBy = rawCausedBy
        ? JSON.stringify(typeof rawCausedBy === "string" ? [rawCausedBy] : rawCausedBy)
        : null;
      const spawns = args.spawns ? JSON.stringify(args.spawns) : null;
      const [row] = db
        .insert(narrativeBeats)
        .values({
          threadId,
          tick: ctx.tick,
          content: String(args.content),
          beatType: String(args.beatType ?? "ambient"),
          causedBy,
          spawns,
        })
        .returning({ id: narrativeBeats.id })
        .all();
      // Обновление last_beat_tick (не затрагивает FTS-индексируемые столбцы title/summary, rebuild не нужен)
      db.update(narrativeThreads)
        .set({ lastBeatTick: ctx.tick })
        .where(eq(narrativeThreads.id, threadId))
        .run();
      // ADR-134 D3: обновление времени активности узла графа (срок действия нити основан на последней активности, не на создании)
      const threadNodeId = `thread_${threadId}`;
      if (ctx.graph.has(threadNodeId)) {
        ctx.graph.updateThread(threadNodeId, { last_activity_ms: ctx.nowMs });
      }
      return row.id;
    },
  })
  .instruction("resolve_topic", {
    params: z.object({
      threadId: z.number().int().positive().describe("ID линии"),
    }),
    description: "Пометить линию как завершённую",
    affordance: {
      whenToUse: "Close a thread that's been completed or is no longer relevant",
      whenNotToUse: "When the thread still has unfinished business",
      priority: "on-demand",
      category: "threads",
    },
    impl(ctx, args) {
      const db = getDb();
      const threadId = Number(args.threadId);
      // ADR-191: делегируем в resolveThreadInGraph — единственный источник истины для пути resolve
      // (симметрично self_topic_begin → createThreadInGraph)
      const threadNodeId = `thread_${threadId}`;
      if (ctx.graph.has(threadNodeId)) {
        resolveThreadInGraph(db, ctx.graph, threadNodeId, ctx.tick, ctx.nowMs);
      } else {
        // Узел в графе отсутствует (возможно GC'd) → обновляем только БД
        db.update(narrativeThreads)
          .set({ status: "resolved", resolvedTick: ctx.tick })
          .where(eq(narrativeThreads.id, threadId))
          .run();
      }
      return true;
    },
  })
  /**
   * ADR-64 VI-2: обновление нарративного резюме нити.
   * LLM вызывает в Reflection для генерации резюме нитей с несколькими beat.
   */
  .instruction("thread_review", {
    params: z.object({
      threadId: z.number().int().positive().describe("ID линии"),
      summary: z.string().trim().min(1).max(500).describe("Нарративное резюме линии (2-3 предложения)"),
    }),
    description: "Обновить нарративное резюме линии (для периодического обзора)",
    affordance: {
      whenToUse: "Write a summary for a thread with many updates",
      whenNotToUse: "When the thread is new or already has a fresh summary",
      priority: "on-demand",
      category: "threads",
    },
    impl(ctx, args) {
      const threadId = Number(args.threadId);
      const summary = String(args.summary);

      // Обновление БД
      const db = getDb();
      // FTS-синхронизация выполняется автоматически триггером AFTER UPDATE OF title, summary.
      // @see runtime/drizzle/0017_fts5_triggers.sql
      db.update(narrativeThreads)
        .set({ summary, summaryTick: ctx.tick })
        .where(eq(narrativeThreads.id, threadId))
        .run();

      // Синхронное обновление узла графа
      const threadNodeId = `thread_${threadId}`;
      if (ctx.graph.has(threadNodeId)) {
        ctx.graph.updateThread(threadNodeId, { summary, last_activity_ms: ctx.nowMs });
      }

      return { success: true, threadId, summaryTick: ctx.tick };
    },
  })
  .instruction("update_topic_lifecycle", {
    params: z.object({
      threadId: z.number().int().positive().describe("ID линии"),
      outcome: z.enum(["renewed", "snoozed"]).describe("renewed=продолжать отслеживать; snoozed=отложить напоминание"),
      minutes: z.number().int().positive().max(10_080).describe("Новый срок напоминания/дедлайна в минутах, максимум 7 дней"),
      reason: z.string().min(1).max(300).describe("Почему продлеваем или откладываем"),
    }),
    description: "Продлить или отложить ещё не завершённую тему",
    affordance: {
      whenToUse: "The thread is still relevant, but the right next check should happen later",
      whenNotToUse: "When the thread is complete; use resolve_topic instead",
      priority: "on-demand",
      category: "threads",
    },
    impl(ctx, args) {
      return snoozeThreadLifecycle({
        G: ctx.graph,
        threadId: Number(args.threadId),
        tick: ctx.tick,
        nowMs: ctx.nowMs,
        minutes: Number(args.minutes),
        reason: String(args.reason),
        outcome: args.outcome as "renewed" | "snoozed",
      });
    },
  })
  .instruction("affect_thread", {
    params: z.object({
      threadId: z.number().int().positive().describe("ID линии"),
      entityId: z.string().min(1).describe("ID сущности"),
      role: z.string().min(1).describe("Роль"),
      facts: z.array(z.string()).optional().describe("Список фактов"),
    }),
    description: "Отметить участие сущности в линии + записать факты",
    affordance: {
      whenToUse: "Link a person to a thread and record their role or facts",
      whenNotToUse: "When the person is already properly linked",
      priority: "on-demand",
      category: "threads",
    },
    impl(_ctx, args) {
      const db = getDb();
      const threadId = Number(args.threadId);
      const row = db
        .select({ involves: narrativeThreads.involves })
        .from(narrativeThreads)
        .where(eq(narrativeThreads.id, threadId))
        .get();
      if (!row) return false;

      const involves = parseInvolves(row.involves);
      const facts: string[] | undefined = Array.isArray(args.facts) ? args.facts : undefined;
      const existing = involves.find((inv) => inv.nodeId === String(args.entityId));
      if (existing) {
        existing.role = String(args.role);
        if (facts) {
          existing.facts = [...new Set([...(existing.facts ?? []), ...facts])];
        }
      } else {
        involves.push({
          nodeId: String(args.entityId),
          role: String(args.role),
          facts,
        });
      }

      // involves не входит в FTS-индексируемые столбцы (title/summary), rebuild не нужен
      db.update(narrativeThreads)
        .set({ involves: JSON.stringify(involves) })
        .where(eq(narrativeThreads.id, threadId))
        .run();
      return true;
    },
  })
  .query("open_topics", {
    params: z.object({}),
    description: "Получить все активные линии (по убыванию давления)",
    affordance: {
      priority: "capability",
      category: "threads",
      whenToUse: "Check active conversation threads before responding",
      whenNotToUse: "Simple greetings or casual chat",
    },
    returns:
      "Array<{ id: number; title: string; status: string; weight: string; pressure: number }>",
    returnHint: "[{id, title, status, weight, urgency}]",
    impl(ctx) {
      const db = getDb();
      const rows = db
        .select()
        .from(narrativeThreads)
        .where(inArray(narrativeThreads.status, ["open", "active"]))
        .all();
      return rows
        .map((r) => ({
          ...r,
          involves: validInvolves(parseInvolves(r.involves)).map((i) => ({
            ...i,
            // ADR-190: единообразно используем safeDisplayName — никогда не возвращаем raw graph ID
            displayName: safeDisplayName(ctx.graph, i.nodeId),
          })),
          pressure: threadPressure(
            estimateEventMs({ createdAt: r.createdAt, tick: r.createdTick }, ctx.nowMs, ctx.tick),
            r.lastBeatTick != null
              ? estimateEventMs({ tick: r.lastBeatTick }, ctx.nowMs, ctx.tick)
              : null,
            r.weight,
            ctx.nowMs,
          ),
          // ADR-241: relevance используется для определения dormant (затухание с периодом полуспада)
          relevance: threadRelevance(
            estimateEventMs({ createdAt: r.createdAt, tick: r.createdTick }, ctx.nowMs, ctx.tick),
            r.lastBeatTick != null
              ? estimateEventMs({ tick: r.lastBeatTick }, ctx.nowMs, ctx.tick)
              : null,
            r.weight,
            ctx.nowMs,
          ),
        }))
        .sort((a, b) => b.pressure - a.pressure);
    },
    format(result) {
      const rows = result as Array<Record<string, unknown>>;
      if (rows.length === 0) return ["(no open topics)"];
      return rows.map((r) => {
        const parts = [`#${r.id} "${r.title}" [${r.status}] ${r.weight}`];
        // ADR-241: relevance (убывающий) для определения dormant, pressure (растущий) для определения urgency
        const rel = Number(r.relevance ?? r.pressure ?? 0);
        if (rel < RELEVANCE_THRESHOLD) {
          parts.push("dormant");
        } else if (r.pressure != null) {
          const p = Number(r.pressure);
          const urgency = p > 1.0 ? "high urgency" : p > 0.5 ? "moderate" : "low";
          parts.push(urgency);
        }
        const involves = r.involves as
          | Array<{ displayName?: string; nodeId: string; role?: string }>
          | undefined;
        if (involves?.length)
          parts.push(
            `involves: ${involves.map((i) => `${i.displayName ?? i.nodeId} as ${i.role ?? "participant"}`).join(", ")}`,
          );
        if (r.horizon) parts.push(`~${humanDuration(Number(r.horizon) * 60)} ahead`); // horizon в минутах → секунды
        return parts.join(", ");
      });
    },
  })
  .query("topic_updates", {
    params: z.object({
      threadId: z.number().int().positive().describe("ID линии"),
      count: z.number().int().positive().default(5).describe("Максимум записей"),
    }),
    description: "Получить последние beats линии",
    affordance: {
      whenToUse: "Review recent progress on a specific thread",
      whenNotToUse: "When thread updates are already visible",
      priority: "capability",
      category: "threads",
    },
    returns:
      "Array<{ id: number; threadId: number; tick: number; content: string; beatType: string; causedBy: string[] | null; spawns: string[] | null }>",
    returnHint: "[{beatType, content, timeAgo, causedBy?, spawns?}]",
    impl(ctx, args) {
      const db = getDb();
      return db
        .select()
        .from(narrativeBeats)
        .where(eq(narrativeBeats.threadId, Number(args.threadId)))
        .orderBy(desc(narrativeBeats.id))
        .limit(Number(args.count))
        .all()
        .reverse()
        .map((r) => ({
          ...r,
          agoLabel: humanDurationAgo(Math.max(0, (ctx.nowMs - r.createdAt.getTime()) / 1000)),
        }));
    },
    format(result) {
      const rows = result as Array<Record<string, unknown>>;
      if (rows.length === 0) return ["(no updates)"];
      return rows.map((r) => {
        const timeLabel = r.agoLabel ? String(r.agoLabel) : "earlier";
        const parts = [`[${timeLabel}] [${r.beatType}] ${r.content}`];
        const causedBy = r.causedBy as string[] | null;
        if (causedBy?.length) parts.push(`\u2190 ${causedBy.join(", ")}`);
        const spawns = r.spawns as string[] | null;
        if (spawns?.length) parts.push(`\u2192 ${spawns.join(", ")}`);
        return parts.join(" ");
      });
    },
  })
  .onTickEnd((ctx) => {
    const db = getDb();
    const rows = db
      .select()
      .from(narrativeThreads)
      .where(inArray(narrativeThreads.status, ["open", "active"]))
      .all();
    ctx.state.activeCount = rows.length;
    ctx.state.maxPressure = rows.reduce(
      (max, r) =>
        Math.max(
          max,
          threadPressure(
            estimateEventMs({ createdAt: r.createdAt, tick: r.createdTick }, ctx.nowMs, ctx.tick),
            r.lastBeatTick != null
              ? estimateEventMs({ tick: r.lastBeatTick }, ctx.nowMs, ctx.tick)
              : null,
            r.weight,
            ctx.nowMs,
          ),
        ),
      0,
    );
  })
  .contribute((ctx): ContributionItem[] => {
    const db = getDb();
    const rows = db
      .select()
      .from(narrativeThreads)
      .where(inArray(narrativeThreads.status, ["open", "active"]))
      .all();

    if (rows.length === 0) return [];

    // ADR-66 F10: нити сортируются с приоритетом текущего собеседника
    const relState = readModState(ctx, "relationships");
    const targetNodeId = relState?.targetNodeId ?? null;

    const allThreads = rows
      .map((r) => {
        const createdMs = estimateEventMs(
          { createdAt: r.createdAt, tick: r.createdTick },
          ctx.nowMs,
          ctx.tick,
        );
        const lastBeatMs =
          r.lastBeatTick != null
            ? estimateEventMs({ tick: r.lastBeatTick }, ctx.nowMs, ctx.tick)
            : null;
        return {
          ...r,
          involves: parseInvolves(r.involves),
          pressure: threadPressure(createdMs, lastBeatMs, r.weight, ctx.nowMs),
          // ADR-241: relevance для фильтрации (затухание с периодом полуспада), pressure для сортировки (растущий)
          relevance: threadRelevance(createdMs, lastBeatMs, r.weight, ctx.nowMs),
        };
      })
      // ADR-241: фильтрация по релевантности — автоматически исключаем нити с длительным отсутствием активности
      .filter((t) => t.relevance >= RELEVANCE_THRESHOLD)
      .sort((a, b) => b.pressure - a.pressure);

    // Разделение: нити с участием текущего собеседника показываются первыми
    let threads: typeof allThreads;
    if (targetNodeId) {
      const relevant = allThreads.filter((t) =>
        t.involves.some((inv) => inv.nodeId === targetNodeId),
      );
      const background = allThreads.filter(
        (t) => !t.involves.some((inv) => inv.nodeId === targetNodeId),
      );
      threads = [...relevant.slice(0, 5), ...background].slice(0, 8);
    } else {
      threads = allThreads.slice(0, 8);
    }

    const m = new PromptBuilder();
    const needsReview: string[] = [];

    for (const t of threads) {
      // ADR-64 III-1/III-2: tick → человеко-читаемое время, pressure → качественная метка
      // @see docs/adr/64-runtime-theory-alignment-audit.md
      const urgencyLabel =
        t.pressure > 1.0 ? "high urgency" : t.pressure > 0.5 ? "moderate" : "low";
      // ADR-115: эндогенные нити помечаются [system], ADR-226: автоматические кластеры помечаются [auto]
      const threadNodeId = `thread_${t.id}`;
      const threadSource = ctx.graph.has(threadNodeId)
        ? ctx.graph.getDynamic(threadNodeId, "source")
        : undefined;
      const sourceTag =
        threadSource === "system" ? " [system]" : threadSource === "auto" ? " [auto]" : "";
      // ADR-110 + ADR-69: атрибуция — "you last advanced" замыкает петлю причинно-следственного восприятия
      const lastBeatMs =
        t.lastBeatTick != null
          ? estimateEventMs({ tick: t.lastBeatTick }, ctx.nowMs, ctx.tick)
          : null;
      const lastAdvanced =
        lastBeatMs != null
          ? ` — you last advanced ${humanDurationAgo((ctx.nowMs - lastBeatMs) / 1000)}`
          : "";
      // ADR-241: метка Stale — отображать [stale] когда relevance приближается к порогу фильтрации
      const isStale = t.relevance < STALE_THRESHOLD;
      const staleTag = isStale ? " [stale]" : "";
      // ADR-241: вычисление числа дней без активности
      const baseActivityMs =
        lastBeatMs ?? (typeof t.createdAt === "number" ? t.createdAt : t.createdAt.getTime());
      const inactiveMs = ctx.nowMs - baseActivityMs;
      const inactiveDays = Math.round(inactiveMs / (24 * 3600 * 1000));
      const inactiveTag = inactiveDays > 0 ? ` — inactive ${inactiveDays}d` : "";
      m.line(
        `[#${t.id}] "${t.title}"${sourceTag} (${t.weight}, ${urgencyLabel})${staleTag}${lastAdvanced}${inactiveTag}`,
      );
      if (t.tensionFrame) m.kv("frame", t.tensionFrame);
      if (t.deadlineTick != null) {
        const deadlineMs =
          estimateEventMs({ tick: t.deadlineTick }, ctx.nowMs, ctx.tick) || ctx.nowMs;
        const remainingS = Math.max(0, (deadlineMs - ctx.nowMs) / 1000);
        const remainingHuman = humanDuration(remainingS);
        // Нити-обязательства (title начинается с "Commitment:") предупреждают за 1 час, остальные — за 5 минут
        const isCommitment = typeof t.title === "string" && t.title.startsWith("Commitment:");
        const urgentThresholdS = isCommitment ? 3600 : 300;
        const urgentTag = remainingS <= urgentThresholdS ? " — URGENT" : "";
        m.kv("deadline", `~${remainingHuman} left${urgentTag}`);
      }
      const involvesStr = renderInvolves(t.involves, ctx);
      if (involvesStr) {
        m.kv("involves", involvesStr);
      }

      // ADR-64 VI-2: приоритет summary, fallback на последний beat
      if (t.summary) {
        m.kv("summary", t.summary);
        // Показывать только самый последний beat после summary (при наличии)
        const latestBeat = db
          .select()
          .from(narrativeBeats)
          .where(eq(narrativeBeats.threadId, t.id))
          .orderBy(desc(narrativeBeats.id))
          .limit(1)
          .all();
        if (latestBeat.length > 0) {
          const b = latestBeat[0];
          const beatMs = estimateEventMs({ tick: b.tick }, ctx.nowMs, ctx.tick) || ctx.nowMs;
          const beatAgoS = (ctx.nowMs - beatMs) / 1000;
          m.kv(`latest[${humanDurationAgo(beatAgoS)}]`, b.content);
        }
      } else {
        // Нет summary — fallback на последние 2 beat
        const beats = db
          .select()
          .from(narrativeBeats)
          .where(eq(narrativeBeats.threadId, t.id))
          .orderBy(desc(narrativeBeats.id))
          .limit(2)
          .all()
          .reverse();
        for (const b of beats) {
          const bMs = estimateEventMs({ tick: b.tick }, ctx.nowMs, ctx.tick) || ctx.nowMs;
          const beatAgoS = (ctx.nowMs - bMs) / 1000;
          // ADR-84 W3: рендер beatType + причинная цепочка causedBy/spawns
          const typeTag = b.beatType && b.beatType !== "ambient" ? ` ${b.beatType}:` : ":";
          let causalSuffix = "";
          if (b.causedBy) {
            try {
              const ids = z.array(z.string()).parse(JSON.parse(b.causedBy));
              if (ids.length > 0) causalSuffix += ` (from ${ids.map((id) => `#${id}`).join(", ")})`;
            } catch {
              /* malformed JSON — skip */
            }
          }
          if (b.spawns) {
            try {
              const ids = z.array(z.string()).parse(JSON.parse(b.spawns));
              if (ids.length > 0) causalSuffix += ` (→ ${ids.map((id) => `#${id}`).join(", ")})`;
            } catch {
              /* malformed JSON — skip */
            }
          }
          m.line(`beat[${humanDurationAgo(beatAgoS)}]${typeTag} ${b.content}${causalSuffix}`);
        }
      }

      // ADR-64 VI-2: определение нитей, требующих thread_review
      const beatCount = db
        .select({ count: sql<number>`count(*)` })
        .from(narrativeBeats)
        .where(eq(narrativeBeats.threadId, t.id))
        .get();
      const totalBeats = beatCount?.count ?? 0;
      // ADR-110: 21600 секунд (6 часов)
      const summaryMs =
        t.summaryTick != null
          ? estimateEventMs({ tick: t.summaryTick }, ctx.nowMs, ctx.tick)
          : null;
      const summaryStale =
        summaryMs != null
          ? totalBeats > 0 && (ctx.nowMs - summaryMs) / 1000 > 21600
          : totalBeats >= 5;
      if (summaryStale) {
        needsReview.push(`#${t.id} "${t.title}"`);
      }
    }

    // ADR-210: сугубо фактическая перспектива — не использовать "Your"
    const items = [section("threads", m.build(), "Narrative threads", 30, 70)];

    // ADR-64 VI-2: подсказка thread review
    // ADR-81: гейтинг по давлению — инжектировать директивные подсказки по ведению записей при низком давлении
    // @see docs/adr/81-reflection-separation.md §Mod вклад переключён с голосового гейтинга на гейтинг по давлению
    if (needsReview.length > 0 && readPressureApi(ctx) < 0.6) {
      items.push(
        section(
          "thread-review-hint",
          [
            PromptBuilder.of("These threads haven't been summarized in a while:"),
            ...needsReview.map((t) => PromptBuilder.of(`→ ${t}`)),
          ],
          undefined,
          31,
          65,
        ),
      );
    }

    return items;
  })
  .build();
