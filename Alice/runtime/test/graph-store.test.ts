/**
 * ADR-33 Phase 2: 图 Write-Back Cache 测试。
 *
 * 验证 flushGraph / loadGraphFromDb 的往返一致性、dirty-tracking、
 * Infinity 序列化、注解持久化。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDb, getDb, initDb } from "../src/db/connection.js";
import { canonicalEvents } from "../src/db/schema.js";
import { flushGraph, loadGraphFromDb } from "../src/db/snapshot.js";
import { WorldModel } from "../src/graph/world-model.js";

const TEST_DB = ":memory:";

/** 加载图并断言非空。 */
function mustLoad(): WorldModel {
  const G = loadGraphFromDb();
  expect(G).not.toBeNull();
  return G as WorldModel;
}

describe("Graph Write-Back Cache (ADR-33 Phase 2)", () => {
  beforeEach(() => {
    initDb(TEST_DB);
  });

  afterEach(() => {
    closeDb();
  });

  // -- 往返一致性 -------------------------------------------------------------

  it("flush + load 节点往返一致", () => {
    const G = new WorldModel();
    G.tick = 42;
    G.addAgent("self");
    G.addContact("alice", { display_name: "Alice", tier: 15 });
    G.addContact("bob");
    G.addChannel("ch1", { chat_type: "private", unread: 3 });

    flushGraph(G);

    const G2 = mustLoad();
    expect(G2.tick).toBe(42);
    expect(G2.size).toBe(G.size);

    // 所有节点属性一致
    for (const nodeId of ["self", "alice", "bob", "ch1"]) {
      expect(G2.has(nodeId)).toBe(true);
      expect(G2.getEntry(nodeId)).toEqual(G.getEntry(nodeId));
    }
  });

  it("flush + load 边往返一致", () => {
    const G = new WorldModel();
    G.tick = 10;
    G.addContact("a");
    G.addContact("b");
    G.addChannel("ch", { chat_type: "private" });
    G.addRelation("a", "friend", "b");
    G.addRelation("a", "monitors", "ch");
    G.addRelation("b", "joined", "ch");

    flushGraph(G);

    const G2 = mustLoad();
    expect(G2.edgeCount).toBe(3);

    // 边内容一致
    const labels1 = [...G.allEdges()].map(([s, d, e]) => `${s}-${e.label}-${d}`).sort();
    const labels2 = [...G2.allEdges()].map(([s, d, e]) => `${s}-${e.label}-${d}`).sort();
    expect(labels2).toEqual(labels1);
  });

  it("边的额外属性在 flush/load 中保留", () => {
    const G = new WorldModel();
    G.addContact("a");
    G.addContact("b");
    G.addRelation("a", "promised", "b", { strength: 0.7, context: "meeting" });

    flushGraph(G);

    const G2 = mustLoad();
    const edges = [...G2.allEdges()];
    expect(edges).toHaveLength(1);
    const [, , edge] = edges[0];
    expect(edge.label).toBe("promised");
    expect(edge.strength).toBe(0.7);
    expect(edge.context).toBe("meeting");
  });

  // -- Infinity 序列化 --------------------------------------------------------

  it("Infinity 属性在 flush/load 中保持", () => {
    const G = new WorldModel();
    G.tick = 5;
    G.addThread("t1", { weight: "major", deadline: Infinity });

    flushGraph(G);

    const G2 = mustLoad();
    expect(G2.getThread("t1").deadline).toBe(Infinity);
  });

  // -- Dirty-tracking --------------------------------------------------------

  it("首次 flush 写入所有节点", () => {
    const G = new WorldModel();
    G.addContact("a");
    G.addContact("b");

    expect(G.isDirty()).toBe(true);
    expect(G.getDirtyNodes().size).toBe(2);

    flushGraph(G);

    // flush 后 dirty 应被清除
    expect(G.isDirty()).toBe(false);
    expect(G.getDirtyNodes().size).toBe(0);

    // 数据已写入
    const G2 = mustLoad();
    expect(G2.size).toBe(2);
  });

  it("增量 flush 只写 dirty 节点", () => {
    const G = new WorldModel();
    G.addContact("a", {});
    G.addContact("b", {});
    flushGraph(G);

    // 仅修改 a
    G.setDynamic("a", "trust", 0.9);
    expect(G.getDirtyNodes().size).toBe(1);
    expect(G.getDirtyNodes().has("a")).toBe(true);

    flushGraph(G);

    const G2 = mustLoad();
    expect(G2.getDynamic("a", "trust")).toBe(0.9);
    expect(G2.getDynamic("b", "trust")).toBeUndefined(); // b 不受影响
  });

  it("无变更时 flush 不报错", () => {
    const G = new WorldModel();
    G.addContact("a");
    flushGraph(G);

    // 二次 flush，无变更
    expect(G.isDirty()).toBe(false);
    expect(() => flushGraph(G)).not.toThrow();
  });

  it("addRelation 标记 dirtyEdgesRebuild", () => {
    const G = new WorldModel();
    G.addContact("a");
    G.addContact("b");
    flushGraph(G);

    G.addRelation("a", "friend", "b");
    expect(G.needsEdgeRebuild()).toBe(true);

    flushGraph(G);

    expect(G.needsEdgeRebuild()).toBe(false);
    const G2 = mustLoad();
    expect(G2.edgeCount).toBe(1);
  });

  // -- 空图 ------------------------------------------------------------------

  it("空表 loadGraphFromDb 返回 null", () => {
    const G = loadGraphFromDb();
    expect(G).toBeNull();
  });

  // -- 加载后 dirty 清除 ------------------------------------------------------

  it("loadGraphFromDb 后 dirty 标记为空", () => {
    const G = new WorldModel();
    G.addContact("a");
    G.addRelation("a", "friend", "a");
    flushGraph(G);

    const G2 = mustLoad();
    expect(G2.isDirty()).toBe(false);
    expect(G2.getDirtyNodes().size).toBe(0);
    expect(G2.needsEdgeRebuild()).toBe(false);
  });

  it("loadGraphFromDb 用 canonical message 修正历史误标的 Telegram 群类型", () => {
    const G = new WorldModel();
    G.tick = 10;
    G.addChannel("channel:telegram:-1003892656176", {
      chat_type: "private",
      tier_contact: 50,
      display_name: "在花小茶馆",
    });
    flushGraph(G);

    getDb()
      .insert(canonicalEvents)
      .values({
        kind: "message",
        tick: 11,
        channelId: "channel:telegram:-1003892656176",
        directed: false,
        payloadJson: JSON.stringify({
          kind: "message",
          channelId: "channel:telegram:-1003892656176",
          chatType: "supergroup",
        }),
      })
      .run();

    const G2 = mustLoad();
    const channel = G2.getChannel("channel:telegram:-1003892656176");
    expect(channel.chat_type).toBe("supergroup");
    expect(channel.tier_contact).toBe(150);
    expect(G2.isDirty()).toBe(false);
  });

  // -- conversation 节点（ADR-26）--------------------------------------------

  it("conversation 节点 flush/load 往返一致", () => {
    const G = new WorldModel();
    G.tick = 30;
    G.addConversation("conversation:1", {
      channel: "channel:123",
      participants: ["alice", "bob"],
      state: "active",
      turn_state: "alice_turn",
      pace: 3,
      message_count: 10,
      alice_message_count: 5,
    });

    flushGraph(G);

    const G2 = mustLoad();
    const attrs = G2.getConversation("conversation:1");
    expect(attrs.entity_type).toBe("conversation");
    expect(attrs.channel).toBe("channel:123");
    expect(attrs.participants).toEqual(["alice", "bob"]);
    expect(attrs.state).toBe("active");
    expect(attrs.turn_state).toBe("alice_turn");
    expect(attrs.message_count).toBe(10);
  });

  // -- 完整场景 round-trip ---------------------------------------------------

  it("完整场景：多种节点 + 边 + 注解的 flush/load 往返", () => {
    const G = new WorldModel();
    G.tick = 100;

    G.addAgent("self", { mood_valence: 0.5, mood_set_ms: 90 });
    G.addContact("alice", { display_name: "Alice", tier: 5 });
    G.addContact("bob", { tier: 150 });
    G.addChannel("channel:alice", { chat_type: "private", unread: 2 });
    G.addChannel("channel:group", { chat_type: "supergroup", unread: 15 });
    G.addThread("t1", { weight: "major", deadline: Infinity });
    G.addFact("info1", { importance: 0.9, tracked: true });
    G.addConversation("conv1", {
      channel: "channel:alice",
      state: "active",
      participants: ["alice"],
    });

    G.addRelation("self", "owner", "channel:alice");
    G.addRelation("self", "friend", "alice");
    G.addRelation("self", "acquaintance", "bob");
    G.addRelation("alice", "joined", "channel:alice");
    G.addRelation("bob", "joined", "channel:group");
    G.addRelation("t1", "involves", "alice", { priority: 1 });

    flushGraph(G);

    const G2 = mustLoad();
    expect(G2.tick).toBe(100);
    expect(G2.size).toBe(G.size);
    expect(G2.edgeCount).toBe(G.edgeCount);

    // 验证节点属性
    expect(G2.getContact("alice").tier).toBe(5);
    expect(G2.getChannel("channel:group").unread).toBe(15);
    expect(G2.getThread("t1").deadline).toBe(Infinity);
    expect(G2.getFact("info1").tracked).toBe(true);
    expect(G2.getAgent("self").mood_valence).toBe(0.5);
  });
});
