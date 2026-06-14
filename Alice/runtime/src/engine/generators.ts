/**
 * Эндогенные генераторы потоков — P4 Endogenous Thread Generation.
 *
 * Запускаются между perceive и pressure в конвейере evolve,
 * создают системные самозарождающиеся потоки, обрабатываемые существующим путём P4 → конкуренция голосов → gate → действие.
 * Ноль новых измерений давления, ноль новых конвейеров.
 *
 * - Clock ρ: периодические потоки (утренний дайджест, еженедельная рефлексия)
 * - Deferred δ: отложенные оценки (истечение испытательного срока для новых групп)
 *
 * ADR-191: Anomaly α удалён. Сигнал всплеска скорости обрабатывается напрямую через tauSpike → rCaution.
 *
 * @see docs/adr/115-evolve-observability/ — поведенческие пробелы, выявленные аудитом ADR-115
 * @see paper/ §7.X Endogenous Thread Generation
 */

import { eq } from "drizzle-orm";
import type { Config } from "../config.js";
import { type getDb, getSqlite } from "../db/connection.js";
import { narrativeThreads } from "../db/schema.js";
import {
  recordThreadLifecycleEvent,
  threadDbId,
  threadP4Contribution,
} from "../db/thread-lifecycle.js";
import { safeDisplayName } from "../graph/display.js";
import type { ThreadWeight } from "../graph/entities.js";
import type { WorldModel } from "../graph/world-model.js";
import { createLogger } from "../utils/logger.js";

/** Тип экземпляра Drizzle DB (согласован с возвращаемым значением getDb()). */
type DrizzleDb = ReturnType<typeof getDb>;

const log = createLogger("generators");

// ═══════════════════════════════════════════════════════════════════════════
// createThreadInGraph — общая функция создания потока
// ═══════════════════════════════════════════════════════════════════════════

/** Weight → числовое значение. Единственный источник истины; threads.mod.ts импортирует эту константу. */
export const WEIGHT_MAP: Record<string, number> = {
  trivial: 0.2,
  subtle: 0.2,
  minor: 0.5,
  major: 2.0,
  critical: 4.0,
};

/** Маппинг строки weight из DB → ThreadWeight. DB хранит старые строки, граф-слой использует новый тип. */
const GRAPH_WEIGHT: Record<string, ThreadWeight> = {
  trivial: "subtle",
  subtle: "subtle",
  minor: "minor",
  major: "major",
  critical: "major",
};

/**
 * Создаёт нарративный поток в DB + графе.
 * Общая логика, вынесенная из threads.mod self_topic_begin.
 *
 * @returns ID нового потока в DB
 */
export function createThreadInGraph(
  db: DrizzleDb,
  G: WorldModel,
  tick: number,
  nowMs: number,
  params: {
    title: string;
    weight: "trivial" | "minor" | "major" | "critical";
    deadlineMs?: number;
    involves?: Array<{ nodeId: string; role: string }>;
    source: "conversation" | "system" | "auto";
    frame?: string;
    sourceChannel?: string;
  },
): number {
  const { title, weight, deadlineMs, involves, source, frame, sourceChannel } = params;

  // Синхронизация FTS выполняется автоматически триггерами SQLite.
  // @see runtime/drizzle/0017_fts5_triggers.sql
  const horizon =
    deadlineMs != null ? Math.max(1, Math.round((deadlineMs - nowMs) / 60_000)) : null;
  const deadlineTick = horizon != null ? tick + horizon : null;
  const [row] = db
    .insert(narrativeThreads)
    .values({
      title,
      tensionFrame: frame ?? null,
      tensionStake: null,
      status: "open",
      weight,
      source,
      involves: involves ? JSON.stringify(involves) : null,
      createdTick: tick,
      horizon,
      deadlineTick,
    })
    .returning({ id: narrativeThreads.id })
    .all();

  // Узел графа (операция в памяти, не требует защиты транзакцией DB)
  const threadNodeId = `thread_${row.id}`;
  const w = WEIGHT_MAP[weight] ?? 0.5;
  G.addThread(threadNodeId, {
    title,
    status: "open",
    weight: GRAPH_WEIGHT[weight] ?? "minor",
    w,
    created_ms: nowMs,
    deadline: deadlineTick ?? Number.POSITIVE_INFINITY,
    source,
    source_channel: sourceChannel,
    last_activity_ms: nowMs,
    deadline_ms: deadlineMs ?? undefined,
  });

  // Связываем задействованные сущности
  if (involves) {
    for (const inv of involves) {
      if (G.has(inv.nodeId)) {
        G.addRelation(threadNodeId, "involves", inv.nodeId);
      }
    }
  }

  log.debug("Thread created", { id: row.id, title, source, weight });
  return row.id;
}

// ═══════════════════════════════════════════════════════════════════════════
// resolveThreadInGraph — общая функция разрешения потока
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Разрешает нарративный поток в DB + графе.
 * Симметрична createThreadInGraph — единственный источник истины для пути resolve.
 *
 * @see docs/adr/190-behavioral-audit-performative-trap.md
 */
export function resolveThreadInGraph(
  db: DrizzleDb,
  G: WorldModel,
  threadNodeId: string,
  tick: number,
  nowMs: number,
): void {
  const attrs = G.getThread(threadNodeId);
  const dbId = threadDbId(threadNodeId);
  const tx = getSqlite().transaction(() => {
    recordThreadLifecycleEvent({
      threadNodeId,
      tick,
      occurredAtMs: nowMs,
      previousStatus: attrs.status,
      outcome: "resolved",
      reason: "explicit_resolve_topic",
      deadlineMs: attrs.deadline_ms ?? null,
      p4Before: threadP4Contribution(nowMs, attrs.created_ms, attrs.w),
      metadata: { title: attrs.title ?? threadNodeId },
    });
    if (dbId != null) {
      db.update(narrativeThreads)
        .set({ status: "resolved", resolvedTick: tick })
        .where(eq(narrativeThreads.id, dbId))
        .run();
    }
  });
  tx();
  G.updateThread(threadNodeId, { status: "resolved" });
}

// ═══════════════════════════════════════════════════════════════════════════
// Фреймворк генераторов
// ═══════════════════════════════════════════════════════════════════════════

/** Контекст выполнения генератора. */
export interface GeneratorContext {
  G: WorldModel;
  db: DrizzleDb;
  tick: number;
  nowMs: number;
  config: Config;
  /** Per-channel счётчик сообщений, возвращённый perceive. */
  channelCounts: Map<string, number>;
  /** Per-channel статистика EMA, поддерживаемая между tick. */
  channelRateEma: Map<string, { ema: number; variance: number }>;
  /** ADR-225: текущий режим агента — в dormant периодические потоки не создаются. */
  mode?: import("../utils/time.js").AgentMode;
}

/**
 * Запускает все эндогенные генераторы потоков.
 * Вызывается после perceive и до pressure в конвейере evolve.
 *
 * Защитный мониторинг: предупреждение при создании нескольких потоков за один tick.
 * Генераторы сами имеют идемпотентную защиту (hasOpenThread / hasDeferredThreadFor),
 * этот мониторинг — дополнение для наблюдаемости; аномальные логи могут триггерить оперативные алерты.
 */
export function runGenerators(ctx: GeneratorContext): void {
  const threadsBefore = ctx.G.getEntitiesByType("thread").length;
  clockGenerator(ctx);
  // ADR-191: anomalyGenerator удалён — сигнал всплеска скорости обрабатывается напрямую через tauSpike → rCaution
  deferredGenerator(ctx);
  const created = ctx.G.getEntitiesByType("thread").length - threadsBefore;
  if (created > 2) {
    log.warn("Generators created multiple threads in single tick", {
      tick: ctx.tick,
      threadsCreated: created,
    });
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Общие вспомогательные функции
// ═══════════════════════════════════════════════════════════════════════════

/** Идемпотентная проверка: есть ли в графе открытый поток с таким же именем. */
function hasOpenThread(G: WorldModel, title: string): boolean {
  for (const tid of G.getEntitiesByType("thread")) {
    const attrs = G.getThread(tid);
    if (attrs.status === "open" && attrs.title === title) return true;
  }
  return false;
}

// ═══════════════════════════════════════════════════════════════════════════
// Clock Generator (ρ) — периодические потоки
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Генератор периодических потоков.
 * - Каждый день в digestHour создаёт поток morning_digest
 * - Каждую неделю в reflectionDay в reflectionHour создаёт поток weekly_reflection
 */
function clockGenerator(ctx: GeneratorContext): void {
  // ADR-225: в dormant-режиме периодические потоки не создаются (создадутся при пробуждении обычным tick)
  if (ctx.mode === "dormant") return;

  const localHour = new Date(ctx.nowMs).getHours();
  const localDay = new Date(ctx.nowMs).getDay(); // 0=воскресенье

  // ADR-172: системные потоки маршрутизируются в личку оператора
  const operatorChannel = ctx.config.operatorChannelId || undefined;

  // Утренний дайджест: каждый день в digestHour, если нет открытого потока с тем же именем
  if (localHour === ctx.config.generators.digestHour && !hasOpenThread(ctx.G, "morning_digest")) {
    createThreadInGraph(ctx.db, ctx.G, ctx.tick, ctx.nowMs, {
      title: "morning_digest",
      weight: "major",
      deadlineMs: ctx.nowMs + 4 * 3600_000,
      source: "system",
      sourceChannel: operatorChannel,
      // ADR-172: frame больше не упоминает "for the operator" — маршрутизация обеспечивается sourceChannel
      frame:
        "Summarize overnight events. Include any pending promises or commitments approaching their deadline.",
      involves: operatorChannel ? [{ nodeId: operatorChannel, role: "recipient" }] : undefined,
    });
    log.info("Clock ρ: morning_digest created", { sourceChannel: operatorChannel });
  }

  // Еженедельная рефлексия: каждую неделю в reflectionDay в reflectionHour
  if (
    localDay === ctx.config.generators.reflectionDay &&
    localHour === ctx.config.generators.reflectionHour &&
    !hasOpenThread(ctx.G, "weekly_reflection")
  ) {
    createThreadInGraph(ctx.db, ctx.G, ctx.tick, ctx.nowMs, {
      title: "weekly_reflection",
      weight: "major",
      deadlineMs: ctx.nowMs + 12 * 3600_000,
      source: "system",
      sourceChannel: operatorChannel,
      frame: "Review this week's interactions and extract patterns",
      involves: operatorChannel ? [{ nodeId: operatorChannel, role: "recipient" }] : undefined,
    });
    log.info("Clock ρ: weekly_reflection created", { sourceChannel: operatorChannel });
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Deferred Generator (δ) — отложенные оценки
// ═══════════════════════════════════════════════════════════════════════════

/** ADR-190: идемпотентная проверка — есть ли открытый evaluate-поток для указанного канала (по рёбрам involves). */
function hasDeferredThreadFor(G: WorldModel, channelId: string): boolean {
  for (const tid of G.getEntitiesByType("thread")) {
    const attrs = G.getThread(tid);
    if (attrs.status !== "open") continue;
    if (typeof attrs.title !== "string" || !attrs.title.startsWith("evaluate_")) continue;
    const neighbors = G.getNeighbors(tid, "involves");
    if (neighbors.includes(channelId)) return true;
  }
  return false;
}

/**
 * Генератор отложенных оценок.
 * Проверяет атрибут deferred_eval_ms на узлах channel и создаёт evaluate-поток по истечении срока.
 */
function deferredGenerator(ctx: GeneratorContext): void {
  for (const chId of ctx.G.getEntitiesByType("channel")) {
    const attrs = ctx.G.getChannel(chId);
    const evalMs = attrs.deferred_eval_ms;
    if (!evalMs || ctx.nowMs < evalMs) continue;
    // ADR-190: идемпотентность теперь определяется по рёбрам involves
    if (hasDeferredThreadFor(ctx.G, chId)) continue;

    // ADR-190: в названии safeDisplayName вместо raw channelId
    const chName = safeDisplayName(ctx.G, chId);
    createThreadInGraph(ctx.db, ctx.G, ctx.tick, ctx.nowMs, {
      title: `evaluate_${chName}`,
      weight: "minor",
      deadlineMs: ctx.nowMs + 24 * 3600_000,
      source: "system",
      frame: "Evaluate whether to stay in or leave this group",
      involves: [{ nodeId: chId, role: "evaluation_target" }],
    });

    // Сбрасываем метку (чтобы не повторять)
    ctx.G.updateChannel(chId, { deferred_eval_ms: null });
    log.info("Deferred δ: evaluation thread created", { chId });
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Channel Rate EMA — per-channel экспоненциальное скользящее среднее скорости сообщений (непрерывное время)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * ADR-166: временная константа EMA непрерывного времени (секунды).
 *
 * Дискретный EMA `x[n] = α·s + (1-α)·x[n-1]` предполагает равномерный шаг.
 * Непрерывный эквивалент: `α(dt) = 1 - exp(-dt / τ)`
 * Из номинальных параметров: τ = -dt_base / ln(1 - α_base)
 *
 * α_base = 0.1, dt_base = 60s → τ = -60 / ln(0.9) ≈ 569.6s
 *
 * Проверка:
 * - dt=60s:  α(60)  = 0.100 (деградация к старому поведению ✓)
 * - dt=3s:   α(3)   = 0.005 (conversation: низкая чувствительность)
 * - dt=300s: α(300) = 0.410 (patrol idle: высокая чувствительность)
 *
 * @see docs/adr/166-wallclock-purification.md §8
 */
const EMA_TAU_S = -60 / Math.log(1 - 0.1); // ≈ 569.6

/**
 * Обновляет per-channel EMA скорости сообщений.
 * Использует онлайн-алгоритм Уэлфорда для отслеживания среднего и дисперсии.
 *
 * ADR-166: α адаптируется по реальной длительности tick (в реальном времени), поддерживая постоянный период полураспада.
 *
 * @param dtS Реальные секунды реального времени текущего tick.
 *            При dt=60s деградирует к старому поведению (α=0.1); при dt=3s α≈0.005.
 */
export function updateChannelRateEma(
  emaMap: Map<string, { ema: number; variance: number }>,
  channelCounts: Map<string, number>,
  dtS: number,
): void {
  // Адаптивный α непрерывного времени: период полураспада постоянен ≈ 395s, независимо от интервала tick
  const clampedDt = Math.max(1, Math.min(dtS, 600));
  const alpha = 1 - Math.exp(-clampedDt / EMA_TAU_S);

  // Обновляем каналы с сообщениями
  for (const [chId, count] of channelCounts) {
    const prev = emaMap.get(chId);
    if (!prev) {
      emaMap.set(chId, { ema: count, variance: 0 });
    } else {
      const diff = count - prev.ema;
      const newEma = prev.ema + alpha * diff;
      // EMA дисперсии: exponential moving variance (с тем же α(dt))
      const newVariance = (1 - alpha) * (prev.variance + alpha * diff * diff);
      emaMap.set(chId, { ema: newEma, variance: newVariance });
    }
  }

  // Каналы, не появившиеся в этом tick: затухание count=0 + очистка мёртвых записей
  for (const [chId, prev] of emaMap) {
    if (!channelCounts.has(chId)) {
      const diff = 0 - prev.ema;
      const newEma = prev.ema + alpha * diff;
      const newVariance = (1 - alpha) * (prev.variance + alpha * diff * diff);
      // Среднее и дисперсия оба близки к нулю → удаляем запись (предотвращаем бесконечное накопление для каналов, прошедших GC)
      if (Math.abs(newEma) < 0.01 && newVariance < 0.01) {
        emaMap.delete(chId);
      } else {
        emaMap.set(chId, { ema: newEma, variance: newVariance });
      }
    }
  }
}
