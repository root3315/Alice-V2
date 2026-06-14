/**
 * Персистентность графа (ADR-33 Phase 2: Write-Back Cache) + снимок личности.
 *
 * Граф: инкрементальный write-back через dirty-tracking в graph_nodes + graph_edges.
 * Личность: полный снимок в personality_snapshots (без изменений).
 */
import { and, desc, eq, sql } from "drizzle-orm";
import { type BeliefDict, BeliefStore } from "../belief/store.js";
import type { ChatType, DunbarTier } from "../graph/entities.js";
import { requireChannelDefaultsInput } from "../graph/entity-defaults.js";
import { WorldModel } from "../graph/world-model.js";
import { createLogger } from "../utils/logger.js";
import { PersonalityVector } from "../voices/personality.js";
import { getDb, getSqlite } from "./connection.js";
import {
  canonicalEvents,
  graphEdges,
  graphNodes,
  personalitySnapshots,
  tickLog,
} from "./schema.js";

const log = createLogger("snapshot");

// -- Вспомогательные функции сериализации Infinity -----------------------------------------------------

/** Преобразует Infinity в attrs в "inf" для совместимости с JSON. */
function serializeAttrs(attrs: Record<string, unknown>): string {
  return JSON.stringify(attrs, (_key, value) => {
    if (value === Infinity) return "inf";
    if (value === -Infinity) return "-inf";
    return value;
  });
}

/** Восстанавливает "inf"/"-inf" из JSON обратно в Infinity. */
function deserializeAttrs(json: string): Record<string, unknown> {
  return JSON.parse(json, (_key, value) => {
    if (value === "inf") return Infinity;
    if (value === "-inf") return -Infinity;
    return value;
  });
}

const BELIEFS_KEY = "__beliefs__";

function isChatType(value: unknown): value is ChatType {
  return value === "private" || value === "group" || value === "supergroup" || value === "channel";
}

function defaultTierForChatType(chatType: ChatType): DunbarTier {
  return chatType === "private" ? 50 : chatType === "channel" ? 500 : 150;
}

function latestCanonicalChatType(channelId: string): ChatType | null {
  const db = getDb();
  const row = db
    .select({ payloadJson: canonicalEvents.payloadJson })
    .from(canonicalEvents)
    .where(and(eq(canonicalEvents.kind, "message"), eq(canonicalEvents.channelId, channelId)))
    .orderBy(desc(canonicalEvents.tick), desc(canonicalEvents.id))
    .limit(1)
    .get();
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.payloadJson) as { chatType?: unknown };
    return isChatType(parsed.chatType) ? parsed.chatType : null;
  } catch {
    return null;
  }
}

function repairLoadedChannelAttrs(
  id: string,
  attrs: Record<string, unknown>,
): Record<string, unknown> {
  if (attrs.chat_type !== "private") return attrs;
  if (!id.startsWith("channel:telegram:-")) return attrs;

  const chatType = latestCanonicalChatType(id);
  if (!chatType || chatType === "private") return attrs;

  return {
    ...attrs,
    chat_type: chatType,
    tier_contact:
      Number(attrs.tier_contact) === 50 ? defaultTierForChatType(chatType) : attrs.tier_contact,
  };
}

// -- Write-back графа ------------------------------------------------------------------

/**
 * ADR-33 Phase 2: Инкрементальный write-back dirty-узлов в SQLite.
 *
 * - dirty-узлы → UPSERT graph_nodes
 * - dirtyEdgesRebuild → DELETE ALL + batch INSERT graph_edges
 * - Аннотации → UPSERT специальной строки __annotations__
 * - Всё внутри одной SQLite-транзакции
 */
export function flushGraph(G: WorldModel): void {
  getDb();
  const sqlite = getSqlite();

  const dirtyNodes = G.getDirtyNodes();
  const needEdgeRebuild = G.needsEdgeRebuild();

  if (dirtyNodes.size === 0 && !needEdgeRebuild) {
    // Даже без dirty-узлов записываем убеждения (изменяются через отдельный API, не triggering dirtyNodes)
    flushBeliefs(sqlite, G);
    G.clearDirty();
    return;
  }

  const tx = sqlite.transaction(() => {
    // 1. UPSERT dirty-узлов
    if (dirtyNodes.size > 0) {
      const upsert = sqlite.prepare(`
        INSERT INTO graph_nodes (id, entity_type, attrs, updated_tick)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          entity_type = excluded.entity_type,
          attrs = excluded.attrs,
          updated_tick = excluded.updated_tick
      `);

      const deleteNode = sqlite.prepare("DELETE FROM graph_nodes WHERE id = ?");
      for (const nodeId of dirtyNodes) {
        if (!G.has(nodeId)) {
          // Узел удалён — удаляем из БД
          deleteNode.run(nodeId);
          continue;
        }
        const entry = G.getEntry(nodeId);
        const entityType = entry.type;
        // entity_type исключается из attrs — уже хранится как отдельный столбец
        const { entity_type: _et, ...rest } = entry.attrs;
        upsert.run(nodeId, entityType, serializeAttrs(rest as Record<string, unknown>), G.tick);
      }
    }

    // 2. Полное перестроение рёбер (только при наличии изменений)
    if (needEdgeRebuild) {
      sqlite.prepare("DELETE FROM graph_edges").run();
      const insertEdge = sqlite.prepare(`
        INSERT INTO graph_edges (src, dst, label, category, attrs)
        VALUES (?, ?, ?, ?, ?)
      `);
      for (const [src, dst, edge] of G.allEdges()) {
        const { label, category, ...rest } = edge;
        const attrsJson = Object.keys(rest).length > 0 ? serializeAttrs(rest) : null;
        insertEdge.run(src, dst, label, category, attrsJson);
      }
    }

    // 3. Убеждения (Social POMDP)
    flushBeliefs(sqlite, G);
  });

  tx();
  G.clearDirty();

  log.debug("Graph flushed", {
    tick: G.tick,
    dirtyNodes: dirtyNodes.size,
    edgesRebuilt: needEdgeRebuild,
  });
}

/** Сериализует убеждения и записывает в специальную строку __beliefs__. */
function flushBeliefs(sqlite: ReturnType<typeof getSqlite>, G: WorldModel): void {
  const beliefDict = G.beliefs.toDict();
  const hasBeliefs = Object.keys(beliefDict.entries).length > 0;

  if (hasBeliefs) {
    sqlite
      .prepare(
        `INSERT INTO graph_nodes (id, entity_type, attrs, updated_tick)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         attrs = excluded.attrs,
         updated_tick = excluded.updated_tick`,
      )
      .run(BELIEFS_KEY, "__meta__", JSON.stringify(beliefDict), G.tick);
  } else {
    // Убеждений нет → удаляем возможную старую строку
    sqlite.prepare("DELETE FROM graph_nodes WHERE id = ?").run(BELIEFS_KEY);
  }
}

// -- Загрузка графа ------------------------------------------------------------------

/**
 * ADR-33 Phase 2: Полная загрузка графа из реляционных таблиц SQLite.
 * Возвращает null, если данных нет (первый запуск).
 */
export function loadGraphFromDb(): WorldModel | null {
  const db = getDb();

  const nodeRows = db.select().from(graphNodes).all();
  if (nodeRows.length === 0) return null;

  const G = new WorldModel();
  let beliefsJson: string | null = null;
  let maxTick = 0;

  // 1. Загрузка узлов
  for (const row of nodeRows) {
    // Пропускаем устаревшие строки __annotations__ (совместимость со старой БД)
    if (row.id === "__annotations__") continue;
    if (row.id === BELIEFS_KEY) {
      beliefsJson = row.attrs;
      continue;
    }
    const attrs = deserializeAttrs(row.attrs);
    // ADR-154: маршрутизация через типизированный add (addEntity удалён)
    const et = row.entityType === "info_item" ? "fact" : row.entityType;
    switch (et) {
      case "agent":
        G.addAgent(row.id, attrs as Record<string, unknown>);
        break;
      case "contact":
        G.addContact(row.id, attrs as Record<string, unknown>);
        break;
      case "channel":
        G.addChannel(
          row.id,
          requireChannelDefaultsInput(row.id, repairLoadedChannelAttrs(row.id, attrs)),
        );
        break;
      case "thread":
        G.addThread(row.id, attrs as Record<string, unknown>);
        break;
      case "fact":
        G.addFact(row.id, attrs as Record<string, unknown>);
        break;
      case "conversation":
        G.addConversation(row.id, attrs as Record<string, unknown>);
        break;
    }
    if (row.updatedTick > maxTick) maxTick = row.updatedTick;
  }

  // 2. Загрузка рёбер
  const edgeRows = db.select().from(graphEdges).all();
  for (const row of edgeRows) {
    const extraAttrs = row.attrs ? deserializeAttrs(row.attrs) : {};
    G.addRelation(row.src, row.label, row.dst, extraAttrs);
  }

  // 3. Восстановление убеждений (Social POMDP)
  if (beliefsJson) {
    const beliefDict = JSON.parse(beliefsJson) as BeliefDict;
    const restored = BeliefStore.fromDict(beliefDict);
    G.beliefs.restoreFrom(restored);
  }

  // 6. Восстановление tick (исправление M2: берём max tick также из tick_log, на случай неточности graph_nodes)
  const maxTickFromTickLog = db
    .select({ tick: tickLog.tick })
    .from(tickLog)
    .orderBy(desc(tickLog.tick))
    .limit(1)
    .get();
  G.tick = Math.max(maxTick, maxTickFromTickLog?.tick ?? 0);

  // 7. Сброс dirty-флагов (только что загружено из БД, память == SQLite)
  G.clearDirty();

  log.info("Graph loaded from DB", {
    tick: maxTick,
    nodes: G.size,
    edges: G.edgeCount,
  });

  return G;
}

// -- Снимок личности (неизменяемый) ---------------------------------------------------------

/**
 * Сохранение снимка вектора личности.
 */
export function savePersonalitySnapshot(tick: number, personality: PersonalityVector): void {
  const db = getDb();
  db.insert(personalitySnapshots)
    .values({
      tick,
      weights: JSON.stringify(personality.weights),
    })
    .run();
}

/**
 * Загрузка последнего вектора личности.
 */
export function loadLatestPersonality(): PersonalityVector | null {
  const db = getDb();
  const rows = db
    .select()
    .from(personalitySnapshots)
    .orderBy(desc(personalitySnapshots.tick))
    .limit(1)
    .all();

  if (rows.length === 0) return null;
  return new PersonalityVector(JSON.parse(rows[0].weights));
}

// -- Совместимость: миграция из устаревшего graph_snapshots -------------------------------------------

/**
 * Миграция данных из устаревшей таблицы graph_snapshots в graph_nodes + graph_edges.
 * Выполняется только если graph_nodes пуст, а в graph_snapshots есть данные.
 */
export function migrateFromSnapshots(): boolean {
  const db = getDb();
  const sqlite = getSqlite();

  // Проверяем, нужна ли миграция
  const nodeCount = db.select({ count: sql<number>`count(*)` }).from(graphNodes).get();
  if (nodeCount && nodeCount.count > 0) return false; // Данные уже есть, миграция не нужна

  // Проверяем наличие данных в старой таблице
  const hasOldData = sqlite.prepare("SELECT COUNT(*) as count FROM graph_snapshots").get() as
    | { count: number }
    | undefined;
  if (!hasOldData || hasOldData.count === 0) return false;

  // Берём последний снимок
  const row = sqlite
    .prepare("SELECT graph_json FROM graph_snapshots ORDER BY tick DESC LIMIT 1")
    .get() as { graph_json: string } | undefined;
  if (!row) return false;

  // Парсим старый JSON-снимок и записываем в новую таблицу
  const data = JSON.parse(row.graph_json);
  const G = WorldModel.deserialize(data);
  G.markEdgesDirty(); // H12: иначе flushGraph пропустит ВСЕ рёбра (deserialize строит их без dirty-флага)
  flushGraph(G);

  log.info("Migrated from graph_snapshots to graph_nodes/graph_edges", {
    nodes: G.size,
    edges: G.edgeCount,
  });

  return true;
}
