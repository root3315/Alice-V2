/**
 * ADR-33 Phase 1: обслуживание базы данных + вспомогательные функции восстановления при перезапуске.
 * ADR-79 M2: GC графа (mark-sweep).
 */
import { desc, sql } from "drizzle-orm";
import {
  getRhythmProfilesUpdatedAtMs,
  rebuildRhythmProfiles,
  shouldRebuildRhythmProfiles,
} from "../diagnostics/rhythm-profile-rebuild.js";
import { findActiveConversation } from "../graph/queries.js";
import type { WorldModel } from "../graph/world-model.js";
import { factRetrievabilityFromNode } from "../mods/relationships.mod.js";
import { createLogger } from "../utils/logger.js";
import { runAnomalyCheck } from "./anomaly.js";
import { getDb, getSqlite } from "./connection.js";
import { actionLog, tickLog } from "./schema.js";
import {
  expireLegacyAutoTopicThreads,
  expireNarrativeOnlyOpenThreads,
  expireOrphanConversationThreads,
  expireOverdueThreads,
} from "./thread-lifecycle.js";

const log = createLogger("maintenance");

// ═══════════════════════════════════════════════════════════════════════════
// ADR-79 M2: константы GC графа
// ═══════════════════════════════════════════════════════════════════════════

/** Окно наблюдения GC — 8 ч (мс), с запасом для восстановления после временных блокировок. */
const GC_GRACE_MS = 8 * 3600 * 1000;

/** Порог оценки достижимости — кандидат на удаление после 5+ сбоев. */
const GC_SCORE_THRESHOLD = 0.05;

/** Исключение для близких контактов — tier ≤ 15 не подлежат GC. */
const GC_TIER_EXEMPT = 15;

/**
 * Восстанавливает lastActionTick из action_log.
 * Вызывается при запуске, чтобы избежать немедленного срабатывания авто-старта по простою после перезапуска.
 */
export function recoverLastActionTick(): number {
  const db = getDb();
  const row = db
    .select({ tick: actionLog.tick })
    .from(actionLog)
    .orderBy(desc(actionLog.tick))
    .limit(1)
    .get();
  const tick = row?.tick ?? 0;
  if (tick > 0) {
    log.info("Recovered lastActionTick from action_log", { tick });
  }
  return tick;
}

/**
 * ADR-79 M2: сборка мусора графа — двухфазный mark-sweep.
 *
 * Mark: score < GC_SCORE_THRESHOLD && failure_type === 'permanent' → устанавливает gc_candidate_ms
 * Sweep: если по истечении gc_candidate_ms + GC_GRACE_MS самовосстановления не произошло → removeEntity()
 * Исключения: близкие контакты tier ≤ 15, узлы каналов с активным conversation
 *
 * @returns Список ID удалённых узлов
 */
export function gcGraph(_currentTick: number, G: WorldModel, nowMs: number = Date.now()): string[] {
  const removed: string[] = [];

  // Сканируем все узлы channel и contact
  const candidates = [...G.getEntitiesByType("channel"), ...G.getEntitiesByType("contact")];

  for (const nodeId of candidates) {
    if (!G.has(nodeId)) continue;
    const nodeType = G.getNodeType(nodeId);

    // Извлекаем GC-атрибуты (по типу узла)
    let score = 1.0;
    let failureType: string | null = null;
    let gcCandidateMs: number | null = null;
    let tier = 999;

    if (nodeType === "channel") {
      const ch = G.getChannel(nodeId);
      score = ch.reachability_score ?? 1.0;
      failureType = ch.failure_type ?? null;
      gcCandidateMs = ch.gc_candidate_ms ?? null;
      tier = ch.tier_contact ?? 999;
    } else if (nodeType === "contact") {
      const ct = G.getContact(nodeId);
      tier = ct.tier;
      score = ct.reachability_score ?? 1.0;
      failureType = ct.failure_type ?? null;
      gcCandidateMs = ct.gc_candidate_ms ?? null;
    }

    // Проверка исключений: близкие контакты
    if (tier <= GC_TIER_EXEMPT) continue;

    // Проверка исключений: есть активный thread или conversation
    if (nodeType === "channel") {
      const activeConv = findActiveConversation(G, nodeId);
      if (activeConv) continue;
    }

    // Фаза Mark: низкий score + permanent failure → устанавливаем gc_candidate_ms
    if (score < GC_SCORE_THRESHOLD && failureType === "permanent") {
      if (gcCandidateMs == null) {
        if (nodeType === "channel") G.updateChannel(nodeId, { gc_candidate_ms: nowMs });
        else if (nodeType === "contact") G.updateContact(nodeId, { gc_candidate_ms: nowMs });
        log.info("GC marked candidate", { nodeId, score, failureType });
      } else if (nowMs - gcCandidateMs >= GC_GRACE_MS) {
        // Фаза Sweep: окно наблюдения истекло, самовосстановления нет → удаляем
        log.info("GC removing unreachable node", { nodeId, score, markedAt: gcCandidateMs });
        G.removeEntity(nodeId);
        removed.push(nodeId);
      }
    } else if (gcCandidateMs != null && score >= GC_SCORE_THRESHOLD) {
      // Восстановился, но gc_candidate_ms всё ещё установлен → снимаем метку
      if (nodeType === "channel") G.updateChannel(nodeId, { gc_candidate_ms: null });
      else if (nodeType === "contact") G.updateContact(nodeId, { gc_candidate_ms: null });
    }
  }

  // Очистка осиротевших conversation: узлы conversation, оставшиеся после GC channel
  for (const convId of G.getEntitiesByType("conversation")) {
    if (!G.has(convId)) continue;
    const convAttrs = G.getConversation(convId);
    if (convAttrs.channel && !G.has(convAttrs.channel)) {
      log.info("GC removing orphan conversation", { convId, orphanChannel: convAttrs.channel });
      G.removeEntity(convId);
      removed.push(convId);
    }
  }

  // Очистка осиротевших info_item: узлы фактов, оставшиеся после GC contact/channel
  for (const itemId of G.getEntitiesByType("fact")) {
    if (!G.has(itemId)) continue;
    const itemAttrs = G.getFact(itemId);
    const sourceContact = itemAttrs.source_contact;
    if (sourceContact && !G.has(sourceContact)) {
      log.info("GC removing orphan info_item", { itemId, orphanContact: sourceContact });
      G.removeEntity(itemId);
      removed.push(itemId);
    }
  }

  if (removed.length > 0) {
    log.info("GC cycle completed", { removed: removed.length, total: G.size });
  }

  return removed;
}

/**
 * ADR-117 D6: очистка устаревших узлов fact (retrievability < 0.01).
 * За один цикл удаляется не более 10, чтобы не блокировать массовым удалением.
 */
export function gcExpiredFacts(G: WorldModel, nowMs: number): string[] {
  const removed: string[] = [];
  const MAX_PER_CYCLE = 10;

  for (const itemId of G.getEntitiesByType("fact")) {
    if (removed.length >= MAX_PER_CYCLE) break;
    if (!G.has(itemId)) continue;

    const attrs = G.getFact(itemId);
    const r = factRetrievabilityFromNode(attrs, nowMs);
    if (r < 0.01) {
      log.info("Fact GC: removing expired fact", { itemId, retrievability: r.toFixed(4) });
      G.removeEntity(itemId);
      removed.push(itemId);
    }
  }

  if (removed.length > 0) {
    log.info("Fact GC cycle completed", { removed: removed.length });
  }
  return removed;
}

// ═══════════════════════════════════════════════════════════════════════════
// ADR-134 D3: Thread Expiry — сборка мусора призрачных тредов
// ═══════════════════════════════════════════════════════════════════════════

/** Время жизни треда: автоматическое устаревание через 7 дней. */
const THREAD_EXPIRY_S = 7 * 86_400;

/**
 * Помечает устаревший open thread (7 дней без активности) → status: "expired".
 * P4 не учитывает expired thread → устраняет призрачный P4.
 *
 * @see docs/adr/134-temporal-coherence.md §D3
 */
export function gcExpiredThreads(G: WorldModel, nowMs: number): number {
  let expired = 0;
  for (const tid of G.getEntitiesByType("thread")) {
    if (!G.has(tid)) continue;
    const attrs = G.getThread(tid);
    if (attrs.status !== "open") continue;
    // ADR-134 D3: на основе времени последней активности (обновляется advance/thread_review), fallback на время создания
    const lastActivityMs = attrs.last_activity_ms ?? (attrs.created_ms || nowMs);
    const idleS = (nowMs - lastActivityMs) / 1000;
    if (idleS > THREAD_EXPIRY_S) {
      G.updateThread(tid, { status: "expired" });
      expired++;
    }
  }
  return expired;
}

/**
 * Управление жизненным циклом логов: очистка устаревших записей, предотвращение бесконечного роста БД.
 * Рекомендуется вызывать каждые 100 tick.
 *
 * ADR-79 M2: необязательный WorldModel — включает GC графа.
 */
export function runMaintenance(
  currentTick: number,
  G?: WorldModel,
  options: {
    rhythmProfileRebuild?: {
      intervalMs: number;
      timezoneOffset: number;
    };
  } = {},
): ReturnType<typeof runAnomalyCheck> {
  const db = getDb();
  const TICK_RETENTION = 5000; // хранить последние 5000 tick
  const SNAPSHOT_RETENTION = 10; // хранить последние 10 снапшотов графа

  const cutoffTick = currentTick - TICK_RETENTION;

  maybeRebuildRhythmProfiles(options.rhythmProfileRebuild);

  // ADR-79 M2: GC графа (запускается даже при cutoffTick <= 0 — у GC собственное окно наблюдения)
  if (G) {
    try {
      gcGraph(currentTick, G);
    } catch (e) {
      log.warn("Graph GC failed", e);
    }
    // ADR-262 Wave 4D: open threads leave P4 through typed lifecycle events.
    try {
      const expiredUnresolved = expireOverdueThreads(G, currentTick, Date.now());
      if (expiredUnresolved > 0)
        log.info("Expired unresolved threads", { count: expiredUnresolved });
    } catch (e) {
      log.warn("Thread lifecycle expiry failed", e);
    }
    try {
      const expiredAutoTopics = expireLegacyAutoTopicThreads(G, currentTick, Date.now());
      if (expiredAutoTopics > 0)
        log.info("Expired legacy auto topic threads", { count: expiredAutoTopics });
    } catch (e) {
      log.warn("Legacy auto topic lifecycle expiry failed", e);
    }
    try {
      const expiredOrphanConversations = expireOrphanConversationThreads(
        G,
        currentTick,
        Date.now(),
      );
      if (expiredOrphanConversations > 0)
        log.info("Expired orphan conversation threads", { count: expiredOrphanConversations });
    } catch (e) {
      log.warn("Orphan conversation lifecycle expiry failed", e);
    }
    try {
      const repairedPhantoms = expireNarrativeOnlyOpenThreads(G, currentTick, Date.now());
      if (repairedPhantoms > 0)
        log.info("Expired narrative-only threads", { count: repairedPhantoms });
    } catch (e) {
      log.warn("Thread lifecycle phantom repair failed", e);
    }
    // ADR-134 D3: legacy graph-only thread GC remains a fallback after typed lifecycle events.
    try {
      const expiredThreads = gcExpiredThreads(G, Date.now());
      if (expiredThreads > 0) log.info("Expired threads", { count: expiredThreads });
    } catch (e) {
      log.warn("Thread GC failed", e);
    }
  }

  if (cutoffTick <= 0) return runAnomalyCheck(currentTick, G); // ещё недостаточно данных — очистку пропускаем, но аномалии проверяем

  try {
    // Очищаем старые записи tick_log
    db.delete(tickLog).where(sql`${tickLog.tick} < ${cutoffTick}`).run();

    // Очищаем старые записи action_log
    db.delete(actionLog).where(sql`${actionLog.tick} < ${cutoffTick}`).run();

    // M3 исправление: удаляем лишние снапшоты одним SQL-запросом, устраняя N+1
    const sqlite = getSqlite();
    const result = sqlite
      .prepare(
        `DELETE FROM graph_snapshots WHERE id NOT IN (
          SELECT id FROM graph_snapshots ORDER BY tick DESC LIMIT ?
        )`,
      )
      .run(SNAPSHOT_RETENTION);

    log.debug("Maintenance completed", {
      currentTick,
      cutoffTick,
      snapshotsRemoved: result.changes,
    });
  } catch (e) {
    log.warn("Maintenance failed", e);
  }

  // Проверка аномалий (запускается при каждом обслуживании)
  return runAnomalyCheck(currentTick, G);
}

function maybeRebuildRhythmProfiles(
  options: { intervalMs: number; timezoneOffset: number } | undefined,
): void {
  if (!options || options.intervalMs <= 0) return;

  const sqlite = getSqlite();
  const nowMs = Date.now();
  const updatedAtMs = getRhythmProfilesUpdatedAtMs(sqlite);
  if (!shouldRebuildRhythmProfiles({ updatedAtMs, nowMs, intervalMs: options.intervalMs })) return;

  try {
    const result = rebuildRhythmProfiles(sqlite, {
      nowMs,
      timezoneOffset: options.timezoneOffset,
      dryRun: false,
    });
    const confident = result.profiles.filter(
      (profile) => profile.confidence === "medium" || profile.confidence === "high",
    ).length;
    log.info("Rhythm profiles rebuilt", {
      profiles: result.profiles.length,
      confident,
      sourceRows: result.stats.rowsRead,
      timezoneOffset: options.timezoneOffset,
    });
  } catch (e) {
    log.warn("Rhythm profile rebuild failed", e);
  }
}
