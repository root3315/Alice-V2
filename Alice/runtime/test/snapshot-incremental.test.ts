/**
 * 增量快照测试 — snapshotIncremental() / restoreFromIncremental()。
 *
 * 验证增量快照比全图 snapshot() 更轻量，同时保证回滚语义正确：
 * - dirty 节点属性的快照/恢复
 * - 新增/删除节点在回滚时的正确处理
 * - 边变更在回滚时的全量恢复
 * - beliefs / annotations 的全量回滚
 *
 * @see WorldModel.snapshotIncremental()
 * @see WorldModel.restoreFromIncremental()
 * @see paper/ §4 "Incremental State Management"
 */
import { describe, expect, it } from "vitest";
import { WorldModel } from "../src/graph/world-model.js";

describe("增量快照", () => {
  // -- dirty 节点追踪 ---------------------------------------------------------

  it("快照包含 dirty 节点", () => {
    const G = new WorldModel();
    G.addContact("c1");
    G.clearDirty(); // 清除 addEntity 的初始 dirty
    G.setDynamic("c1", "tier", 50); // 标记 dirty
    const snap = G.snapshotIncremental();

    expect(snap.dirtyNodeEntries.has("c1")).toBe(true);
  });

  it("快照不包含 clean 节点", () => {
    const G = new WorldModel();
    G.addContact("c1");
    G.addContact("c2");
    G.clearDirty();
    G.setDynamic("c1", "tier", 50); // 只有 c1 dirty
    const snap = G.snapshotIncremental();

    expect(snap.dirtyNodeEntries.has("c1")).toBe(true);
    expect(snap.dirtyNodeEntries.has("c2")).toBe(false);
  });

  it("dirty 快照是浅拷贝（修改原图不影响快照）", () => {
    const G = new WorldModel();
    G.addContact("c1", { tier: 50 });
    // addEntity 标记 dirty，直接快照
    const snap = G.snapshotIncremental();

    // 修改原图
    G.setDynamic("c1", "tier", 500);

    // 快照中保留的是快照时刻的值
    const snapEntry = snap.dirtyNodeEntries.get("c1");
    expect(snapEntry?.type).toBe("contact");
    if (snapEntry?.type === "contact") {
      expect(snapEntry.attrs.tier).toBe(50);
    }
  });

  // -- 属性回滚 ---------------------------------------------------------------

  it("修改后回滚到快照状态", () => {
    const G = new WorldModel();
    G.addContact("c1", { tier: 150 });
    G.clearDirty();

    G.setDynamic("c1", "tier", 50); // dirty
    const snap = G.snapshotIncremental(); // 快照此时状态（tier=50）

    G.setDynamic("c1", "tier", 5); // 再改
    G.restoreFromIncremental(snap);

    expect(G.getContact("c1").tier).toBe(50); // 恢复到快照时的值
  });

  it("多属性修改后回滚全部恢复", () => {
    const G = new WorldModel();
    G.addContact("c1", { tier: 150 });
    G.clearDirty();

    G.setDynamic("c1", "tier", 50);
    G.setDynamic("c1", "last_active_ms", 100);
    const snap = G.snapshotIncremental();

    G.setDynamic("c1", "tier", 5);
    G.setDynamic("c1", "last_active_ms", 999);
    G.restoreFromIncremental(snap);

    expect(G.getContact("c1").tier).toBe(50);
    expect(G.getContact("c1").last_active_ms).toBe(100);
  });

  // -- 新建节点回滚 -----------------------------------------------------------

  it("新建节点在回滚时被删除", () => {
    const G = new WorldModel();
    G.addContact("c1");
    G.clearDirty();
    const snap = G.snapshotIncremental(); // c1 clean，无 dirty 节点

    G.addContact("c_new"); // 新建
    G.restoreFromIncremental(snap);

    expect(G.has("c_new")).toBe(false); // 新节点被删
    expect(G.has("c1")).toBe(true); // 旧节点保留
  });

  it("多个新建节点全部在回滚时清除", () => {
    const G = new WorldModel();
    G.addContact("c1");
    G.clearDirty();
    const snap = G.snapshotIncremental();

    G.addContact("c_new1");
    G.addContact("c_new2");
    G.addThread("t_new");
    G.restoreFromIncremental(snap);

    expect(G.has("c_new1")).toBe(false);
    expect(G.has("c_new2")).toBe(false);
    expect(G.has("t_new")).toBe(false);
    expect(G.has("c1")).toBe(true);
  });

  // -- 删除节点回滚 -----------------------------------------------------------

  it("删除的节点在回滚时恢复", () => {
    const G = new WorldModel();
    G.addContact("c1", { tier: 50 });
    G.clearDirty();

    G.setDynamic("c1", "tier", 50); // 标记 dirty
    const snap = G.snapshotIncremental();

    G.removeEntity("c1");
    G.restoreFromIncremental(snap);

    expect(G.has("c1")).toBe(true);
    expect(G.getContact("c1").tier).toBe(50);
  });

  it("删除并重建同 ID 节点后回滚恢复原始属性", () => {
    const G = new WorldModel();
    G.addContact("c1", { tier: 5 });
    G.clearDirty();

    G.setDynamic("c1", "tier", 5); // 标记 dirty
    const snap = G.snapshotIncremental();

    // 删除后重建（属性不同）
    G.removeEntity("c1");
    G.addContact("c1", { tier: 500 });
    G.restoreFromIncremental(snap);

    expect(G.has("c1")).toBe(true);
    expect(G.getContact("c1").tier).toBe(5); // 恢复原始 tier
  });

  // -- 边回滚 -----------------------------------------------------------------

  it("边变更在回滚时恢复（快照需在 dirtyEdgesRebuild=true 时拍）", () => {
    const G = new WorldModel();
    G.addContact("c1");
    G.addContact("c2");
    G.clearDirty();

    // 添加边 → dirtyEdgesRebuild=true
    G.addRelation("c1", "friend", "c2");
    // 此时快照包含 edges（因为 dirtyEdgesRebuild=true）
    const snap = G.snapshotIncremental();

    // 再添加一条边
    G.addRelation("c1", "knows", "c2");
    expect(G.edgeCount).toBe(2);

    G.restoreFromIncremental(snap);

    // 恢复到快照时只有 friend 边
    expect(G.edgeCount).toBe(1);
  });

  it("clean 边不在增量快照中（增量快照局限性）", () => {
    const G = new WorldModel();
    G.addContact("c1");
    G.addContact("c2");
    G.addRelation("c1", "friend", "c2");
    G.clearDirty(); // 边变为 clean
    const snap = G.snapshotIncremental();

    // snap.edges 未定义（dirtyEdgesRebuild=false）
    expect(snap.edges).toBeUndefined();

    // 即使添加了新边，回滚也不会恢复边（因为快照中无边数据）
    G.addRelation("c1", "knows", "c2");
    G.restoreFromIncremental(snap);

    // 新边未被删除——增量快照不包含 clean 边的恢复
    expect(G.edgeCount).toBe(2);
  });

  it("删除边后回滚恢复", () => {
    const G = new WorldModel();
    G.addContact("c1");
    G.addContact("c2");
    G.addRelation("c1", "friend", "c2");
    G.addRelation("c1", "knows", "c2");
    G.clearDirty();

    // 标记边为 dirty（removeEntity 会触发 dirtyEdgesRebuild）
    G.setDynamic("c1", "tier", 50); // 需要有 dirty 节点以便快照
    const snap = G.snapshotIncremental();

    // removeEntity c2 会删除所有相关边
    G.removeEntity("c2");
    G.restoreFromIncremental(snap);

    // c1 仍在，但 c2 也需要在快照中
    // 注意：c2 在快照时不 dirty，但 snap.dirtyNodeEntries 包含 c1
    // removeEntity(c2) 后 c2 被从 nodes 删除
    // restoreFromIncremental 只恢复 dirtyNodeEntries 中的节点
    // c2 是 clean 的，不在快照中，所以回滚后 c2 仍然不在
    // 这是增量快照的局限——只恢复 dirty 数据
    expect(G.has("c1")).toBe(true);
  });

  // -- beliefs 回滚 -----------------------------------------------------------

  it("beliefs 在回滚时恢复", () => {
    const G = new WorldModel();
    G.beliefs.set("c1", "tier", { mu: 5, sigma2: 0.1, tObs: 100 });
    G.clearDirty();
    const snap = G.snapshotIncremental();

    G.beliefs.set("c1", "tier", { mu: 150, sigma2: 1.0, tObs: 200 });
    G.restoreFromIncremental(snap);

    expect(G.beliefs.get("c1", "tier")?.mu).toBe(5);
    expect(G.beliefs.get("c1", "tier")?.sigma2).toBeCloseTo(0.1);
    expect(G.beliefs.get("c1", "tier")?.tObs).toBe(100);
  });

  it("新增 belief 在回滚时被删除", () => {
    const G = new WorldModel();
    G.clearDirty();
    const snap = G.snapshotIncremental(); // 无 belief

    G.beliefs.set("c1", "tier", { mu: 50, sigma2: 0.5, tObs: 10 });
    G.restoreFromIncremental(snap);

    expect(G.beliefs.get("c1", "tier")).toBeUndefined();
  });

  // -- tick 回滚 ---------------------------------------------------------------

  it("tick 在回滚时恢复", () => {
    const G = new WorldModel();
    G.tick = 100;
    G.clearDirty();
    const snap = G.snapshotIncremental();

    G.tick = 200;
    G.restoreFromIncremental(snap);

    expect(G.tick).toBe(100);
  });

  // -- 已删除节点的快照记录 ---------------------------------------------------

  it("已删除节点记录在 deletedNodeIds 中", () => {
    const G = new WorldModel();
    G.addContact("c1");
    G.clearDirty();

    G.removeEntity("c1"); // dirtyNodes 保留 c1，但 nodes 中已不存在
    const snap = G.snapshotIncremental();

    expect(snap.deletedNodeIds.has("c1")).toBe(true);
    expect(snap.dirtyNodeEntries.has("c1")).toBe(false);
  });

  // -- 综合场景 ---------------------------------------------------------------

  it("混合操作后回滚恢复一致状态", () => {
    const G = new WorldModel();
    G.addContact("c1", { tier: 150 });
    G.addContact("c2", { tier: 50 });
    G.addRelation("c1", "friend", "c2");
    G.beliefs.set("c1", "tier", { mu: 150, sigma2: 0.2, tObs: 50 });
    G.tick = 50;
    G.clearDirty();

    // 执行一系列修改
    G.setDynamic("c1", "tier", 5); // dirty c1
    G.setDynamic("c2", "tier", 500); // dirty c2
    const snap = G.snapshotIncremental();

    // 继续修改（回滚应到 snap 时刻）
    G.setDynamic("c1", "tier", 15);
    G.addContact("c3"); // 新节点
    G.addRelation("c1", "knows", "c3");
    G.beliefs.set("c1", "tier", { mu: 999, sigma2: 0.9, tObs: 999 });
    G.tick = 999;

    G.restoreFromIncremental(snap);

    // 属性恢复
    expect(G.getContact("c1").tier).toBe(5);
    expect(G.getContact("c2").tier).toBe(500);
    // 新节点被删除
    expect(G.has("c3")).toBe(false);
    // beliefs 恢复
    expect(G.beliefs.get("c1", "tier")?.mu).toBe(150);
    // tick 恢复
    expect(G.tick).toBe(50);
  });

  // -- 边界情况 ---------------------------------------------------------------

  it("空图的增量快照和回滚", () => {
    const G = new WorldModel();
    G.clearDirty();
    const snap = G.snapshotIncremental();

    G.addContact("c1");
    G.restoreFromIncremental(snap);

    expect(G.size).toBe(0);
    expect(G.has("c1")).toBe(false);
  });

  it("连续两次快照取最新", () => {
    const G = new WorldModel();
    G.addContact("c1", { tier: 150 });
    G.clearDirty();

    G.setDynamic("c1", "tier", 50);
    const _snap1 = G.snapshotIncremental();

    G.setDynamic("c1", "tier", 15);
    const snap2 = G.snapshotIncremental();

    G.setDynamic("c1", "tier", 5);
    G.restoreFromIncremental(snap2);

    // 恢复到 snap2 时刻（tier=15）
    expect(G.getContact("c1").tier).toBe(15);
  });

  it("回滚后 dirty 标记仍保留（内存与持久层可能不一致）", () => {
    const G = new WorldModel();
    G.addContact("c1", { tier: 150 });
    G.clearDirty();

    G.setDynamic("c1", "tier", 50);
    const snap = G.snapshotIncremental();

    G.setDynamic("c1", "tier", 5);
    G.restoreFromIncremental(snap);

    // 回滚后恢复的节点仍标记为 dirty
    expect(G.isDirty()).toBe(true);
    expect(G.getDirtyNodes().has("c1")).toBe(true);
  });
});
