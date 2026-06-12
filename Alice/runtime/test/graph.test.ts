/**
 * WorldModel 单元测试——验证节点/边操作与序列化 round-trip。
 */
import { describe, expect, it } from "vitest";
import { THREAD_WEIGHTS } from "../src/graph/constants.js";
import { WorldModel } from "../src/graph/world-model.js";

describe("WorldModel", () => {
  // -- 节点操作 ---------------------------------------------------------------

  it("添加 contact 节点并设置默认属性", () => {
    const G = new WorldModel();
    G.addContact("alice", { display_name: "Alice" });

    expect(G.has("alice")).toBe(true);
    expect(G.size).toBe(1);

    const attrs = G.getContact("alice");
    expect(attrs.entity_type).toBe("contact");
    expect(attrs.tier).toBe(150);
    expect(attrs.last_active_ms).toBe(0);
    expect(attrs.auth_level).toBe(0);
    expect(attrs.interaction_count).toBe(0);
    expect(attrs.display_name).toBe("Alice");
  });

  it("添加 thread 节点并计算 w 权重", () => {
    const G = new WorldModel();
    G.tick = 10;
    G.addThread("t1", { weight: "major" });

    const attrs = G.getThread("t1");
    expect(attrs.entity_type).toBe("thread");
    expect(attrs.weight).toBe("major");
    expect(attrs.w).toBe(THREAD_WEIGHTS.major); // 2.0
    expect(attrs.status).toBe("open");
    expect(typeof attrs.created_ms).toBe("number");
    expect(attrs.deadline).toBe(Infinity);
  });

  it("添加 channel 节点默认属性", () => {
    const G = new WorldModel();
    G.addChannel("ch1", { chat_type: "private" });

    const attrs = G.getChannel("ch1");
    expect(attrs.entity_type).toBe("channel");
    expect(attrs.unread).toBe(0);
    expect(attrs.tier_contact).toBe(150);
    expect(attrs.chat_type).toBe("private");
    expect(attrs.pending_directed).toBe(0);
    expect(attrs.last_directed_ms).toBe(0);
  });

  it("添加 fact 节点默认属性", () => {
    const G = new WorldModel();
    G.tick = 5;
    G.addFact("i1");

    const attrs = G.getFact("i1");
    expect(attrs.entity_type).toBe("fact");
    expect(attrs.importance).toBe(0.5);
    expect(attrs.stability).toBe(1.0);
    expect(typeof attrs.last_access_ms).toBe("number");
    expect(attrs.volatility).toBe(0.5);
    expect(attrs.tracked).toBe(false);
    expect(typeof attrs.created_ms).toBe("number");
    expect(attrs.novelty).toBe(1.0);
  });

  it("getEntitiesByType 按类型过滤", () => {
    const G = new WorldModel();
    G.addContact("c1");
    G.addContact("c2");
    G.addChannel("ch1", { chat_type: "private" });
    G.addThread("t1");

    expect(G.getEntitiesByType("contact")).toEqual(["c1", "c2"]);
    expect(G.getEntitiesByType("channel")).toEqual(["ch1"]);
    expect(G.getEntitiesByType("thread")).toEqual(["t1"]);
    expect(G.getEntitiesByType("agent")).toEqual([]);
  });

  it("setDynamic 修改属性", () => {
    const G = new WorldModel();
    G.addContact("c1");
    G.setDynamic("c1", "tier", 50);
    expect(G.getContact("c1").tier).toBe(50);
  });

  it("getContact 返回浅拷贝，修改不影响内部", () => {
    const G = new WorldModel();
    G.addContact("c1");
    const attrs = G.getContact("c1");
    (attrs as unknown as Record<string, unknown>).tier = 999;
    expect(G.getContact("c1").tier).toBe(150); // 内部不受影响
  });

  it("访问不存在的节点抛异常", () => {
    const G = new WorldModel();
    expect(() => G.getEntry("nonexistent")).toThrow("Node not found");
    expect(() => G.setDynamic("nonexistent", "x", 1)).toThrow("Node not found");
  });

  // -- 边操作 -----------------------------------------------------------------

  it("addRelation 添加有向边", () => {
    const G = new WorldModel();
    G.addContact("alice");
    G.addContact("bob");
    G.addRelation("alice", "friend", "bob");

    expect(G.edgeCount).toBe(1);
    expect(G.getNeighbors("alice")).toEqual(["bob"]);
    expect(G.getPredecessors("bob")).toEqual(["alice"]);
    // 反方向不存在
    expect(G.getNeighbors("bob")).toEqual([]);
    expect(G.getPredecessors("alice")).toEqual([]);
  });

  it("label 过滤邻居", () => {
    const G = new WorldModel();
    G.addContact("a");
    G.addContact("b");
    G.addChannel("ch", { chat_type: "private" });
    G.addRelation("a", "friend", "b");
    G.addRelation("a", "monitors", "ch");

    expect(G.getNeighbors("a")).toEqual(["b", "ch"]);
    expect(G.getNeighbors("a", "friend")).toEqual(["b"]);
    expect(G.getNeighbors("a", "monitors")).toEqual(["ch"]);
    expect(G.getNeighbors("a", "owner")).toEqual([]);
  });

  it("同对节点间允许多条边", () => {
    const G = new WorldModel();
    G.addContact("a");
    G.addContact("b");
    G.addRelation("a", "friend", "b");
    G.addRelation("a", "knows", "b");

    expect(G.edgeCount).toBe(2);
    // getNeighbors 去重（同一 dst 只出现一次）
    expect(G.getNeighbors("a")).toEqual(["b"]);
  });

  it("allEdges 遍历所有边", () => {
    const G = new WorldModel();
    G.addContact("a");
    G.addContact("b");
    G.addChannel("ch", { chat_type: "private" });
    G.addRelation("a", "friend", "b");
    G.addRelation("a", "monitors", "ch");
    G.addRelation("b", "joined", "ch");

    const edges = [...G.allEdges()];
    expect(edges).toHaveLength(3);

    const labels = edges.map(([, , e]) => e.label).sort();
    expect(labels).toEqual(["friend", "joined", "monitors"]);
  });

  it("边的 category 由 labelToCategory 自动设置", () => {
    const G = new WorldModel();
    G.addContact("a");
    G.addContact("b");
    G.addRelation("a", "friend", "b");
    G.addRelation("a", "monitors", "b");
    G.addRelation("a", "unknown_label", "b");

    const edges = [...G.allEdges()];
    const categories = edges.map(([, , e]) => e.category);
    expect(categories).toContain("social"); // friend
    expect(categories).toContain("spatial"); // monitors
    expect(categories).toContain("ownership"); // unknown_label → 默认 ownership
  });

  // -- 序列化 round-trip ------------------------------------------------------

  it("toDict/fromDict round-trip 保持数据一致", () => {
    const G = new WorldModel();
    G.tick = 42;

    G.addAgent("self");
    G.addContact("alice", { display_name: "Alice", tier: 15 });
    G.addContact("bob");
    G.addChannel("ch1", { chat_type: "private", unread: 3 });
    G.addThread("t1", { weight: "major", deadline: Infinity });
    G.addFact("i1", { importance: 0.9, tracked: true });

    G.addRelation("self", "owner", "ch1");
    G.addRelation("self", "friend", "alice");
    G.addRelation("self", "acquaintance", "bob");
    G.addRelation("alice", "joined", "ch1");
    G.addRelation("t1", "involves", "alice", { priority: 1 });

    const dict = G.serialize();
    const G2 = WorldModel.deserialize(dict);

    // tick
    expect(G2.tick).toBe(42);

    // 节点数量
    expect(G2.size).toBe(G.size);

    // 所有节点属性一致
    for (const nodeId of ["self", "alice", "bob", "ch1", "t1", "i1"]) {
      expect(G2.has(nodeId)).toBe(true);
      const a1 = G.getEntry(nodeId);
      const a2 = G2.getEntry(nodeId);
      expect(a2).toEqual(a1);
    }

    // 边数量
    expect(G2.edgeCount).toBe(G.edgeCount);

    // 边内容一致
    const edges1 = [...G.allEdges()].map(([s, d, e]) => ({ s, d, label: e.label }));
    const edges2 = [...G2.allEdges()].map(([s, d, e]) => ({ s, d, label: e.label }));
    expect(edges2).toEqual(edges1);

    // Infinity round-trip
    expect(G2.getThread("t1").deadline).toBe(Infinity);
  });

  it("toDict 将 Infinity 序列化为 'inf'", () => {
    const G = new WorldModel();
    G.addThread("t1", { deadline: Infinity });

    const dict = G.serialize();
    const threadNode = dict.nodes.find((n) => n.id === "t1");
    expect(threadNode?.deadline).toBe("inf");
  });

  it("边的额外属性在 round-trip 中保留", () => {
    const G = new WorldModel();
    G.addContact("a");
    G.addContact("b");
    G.addRelation("a", "promised", "b", { strength: 0.7, context: "meeting" });

    const dict = G.serialize();
    const G2 = WorldModel.deserialize(dict);

    const edges = [...G2.allEdges()];
    expect(edges).toHaveLength(1);
    const [, , edge] = edges[0];
    expect(edge.label).toBe("promised");
    expect(edge.category).toBe("causal");
    expect(edge.strength).toBe(0.7);
    expect(edge.context).toBe("meeting");
  });

  // -- 空图边界情况 -----------------------------------------------------------

  it("空图 round-trip", () => {
    const G = new WorldModel();
    const dict = G.serialize();
    expect(dict.tick).toBe(0);
    expect(dict.nodes).toEqual([]);
    expect(dict.edges).toEqual([]);

    const G2 = WorldModel.deserialize(dict);
    expect(G2.tick).toBe(0);
    expect(G2.size).toBe(0);
    expect(G2.edgeCount).toBe(0);
  });

  it("不存在邻居时返回空数组", () => {
    const G = new WorldModel();
    G.addContact("lonely");
    expect(G.getNeighbors("lonely")).toEqual([]);
    expect(G.getPredecessors("lonely")).toEqual([]);
    // 完全不存在的节点
    expect(G.getNeighbors("ghost")).toEqual([]);
    expect(G.getPredecessors("ghost")).toEqual([]);
  });
});
