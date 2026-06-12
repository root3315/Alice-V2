/**
 * 图持久化（ADR-33 Phase 2: Write-Back Cache）+ 人格快照。
 *
 * 图：dirty-tracking 增量写回到 graph_nodes + graph_edges。
 * 人格：全量快照到 personality_snapshots（不变）。
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

// -- Infinity 序列化辅助 -----------------------------------------------------

/** 将 attrs 中的 Infinity 转为 "inf" 以兼容 JSON。 */
function serializeAttrs(attrs: Record<string, unknown>): string {
  return JSON.stringify(attrs, (_key, value) => {
    if (value === Infinity) return "inf";
    if (value === -Infinity) return "-inf";
    return value;
  });
}

/** 将 JSON 中的 "inf"/"-inf" 还原为 Infinity。 */
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

// -- 图写回 ------------------------------------------------------------------

/**
 * ADR-33 Phase 2: 增量写回 dirty 节点到 SQLite。
 *
 * - dirty 节点 → UPSERT graph_nodes
 * - dirtyEdgesRebuild → DELETE ALL + batch INSERT graph_edges
 * - 注解 → UPSERT __annotations__ 特殊行
 * - 全部包在一个 SQLite transaction 里
 */
export function flushGraph(G: WorldModel): void {
  getDb();
  const sqlite = getSqlite();

  const dirtyNodes = G.getDirtyNodes();
  const needEdgeRebuild = G.needsEdgeRebuild();

  if (dirtyNodes.size === 0 && !needEdgeRebuild) {
    // 即使无 dirty 节点，也写信念（通过独立 API 变更，不触发 dirtyNodes）
    flushBeliefs(sqlite, G);
    G.clearDirty();
    return;
  }

  const tx = sqlite.transaction(() => {
    // 1. UPSERT dirty 节点
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
          // 节点已删除，从 DB 清除
          deleteNode.run(nodeId);
          continue;
        }
        const entry = G.getEntry(nodeId);
        const entityType = entry.type;
        // entity_type 从 attrs 中排除——已存为独立列
        const { entity_type: _et, ...rest } = entry.attrs;
        upsert.run(nodeId, entityType, serializeAttrs(rest as Record<string, unknown>), G.tick);
      }
    }

    // 2. 边全量重建（仅在有变更时）
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

    // 3. 信念（Social POMDP）
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

/** 将信念序列化写入 __beliefs__ 特殊行。 */
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
    // 无信念 → 删除可能的旧行
    sqlite.prepare("DELETE FROM graph_nodes WHERE id = ?").run(BELIEFS_KEY);
  }
}

// -- 图加载 ------------------------------------------------------------------

/**
 * ADR-33 Phase 2: 从 SQLite 关系表全量加载图。
 * 返回 null 表示无数据（首次启动）。
 */
export function loadGraphFromDb(): WorldModel | null {
  const db = getDb();

  const nodeRows = db.select().from(graphNodes).all();
  if (nodeRows.length === 0) return null;

  const G = new WorldModel();
  let beliefsJson: string | null = null;
  let maxTick = 0;

  // 1. 加载节点
  for (const row of nodeRows) {
    // 跳过已废弃的 __annotations__ 行（旧 DB 兼容）
    if (row.id === "__annotations__") continue;
    if (row.id === BELIEFS_KEY) {
      beliefsJson = row.attrs;
      continue;
    }
    const attrs = deserializeAttrs(row.attrs);
    // ADR-154: typed add 路由（addEntity 已移除）
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

  // 2. 加载边
  const edgeRows = db.select().from(graphEdges).all();
  for (const row of edgeRows) {
    const extraAttrs = row.attrs ? deserializeAttrs(row.attrs) : {};
    G.addRelation(row.src, row.label, row.dst, extraAttrs);
  }

  // 3. 恢复信念（Social POMDP）
  if (beliefsJson) {
    const beliefDict = JSON.parse(beliefsJson) as BeliefDict;
    const restored = BeliefStore.fromDict(beliefDict);
    G.beliefs.restoreFrom(restored);
  }

  // 6. 恢复 tick（M2 修复: 从 tick_log 也取 max tick，防止仅 graph_nodes 不准确）
  const maxTickFromTickLog = db
    .select({ tick: tickLog.tick })
    .from(tickLog)
    .orderBy(desc(tickLog.tick))
    .limit(1)
    .get();
  G.tick = Math.max(maxTick, maxTickFromTickLog?.tick ?? 0);

  // 7. 清除 dirty 标记（刚从 DB 加载，内存 == SQLite）
  G.clearDirty();

  log.info("Graph loaded from DB", {
    tick: maxTick,
    nodes: G.size,
    edges: G.edgeCount,
  });

  return G;
}

// -- 人格快照（不变）---------------------------------------------------------

/**
 * 保存人格向量快照。
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
 * 加载最新的人格向量。
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

// -- 兼容：旧 graph_snapshots 迁移 -------------------------------------------

/**
 * 从旧 graph_snapshots 表迁移数据到 graph_nodes + graph_edges。
 * 仅在 graph_nodes 为空且 graph_snapshots 有数据时执行。
 */
export function migrateFromSnapshots(): boolean {
  const db = getDb();
  const sqlite = getSqlite();

  // 检查是否需要迁移
  const nodeCount = db.select({ count: sql<number>`count(*)` }).from(graphNodes).get();
  if (nodeCount && nodeCount.count > 0) return false; // 已有数据，不迁移

  // 检查旧表是否有数据
  const hasOldData = sqlite.prepare("SELECT COUNT(*) as count FROM graph_snapshots").get() as
    | { count: number }
    | undefined;
  if (!hasOldData || hasOldData.count === 0) return false;

  // 取最新快照
  const row = sqlite
    .prepare("SELECT graph_json FROM graph_snapshots ORDER BY tick DESC LIMIT 1")
    .get() as { graph_json: string } | undefined;
  if (!row) return false;

  // 解析旧 JSON 快照并写入新表
  const data = JSON.parse(row.graph_json);
  const G = WorldModel.deserialize(data);
  flushGraph(G);

  log.info("Migrated from graph_snapshots to graph_nodes/graph_edges", {
    nodes: G.size,
    edges: G.edgeCount,
  });

  return true;
}
