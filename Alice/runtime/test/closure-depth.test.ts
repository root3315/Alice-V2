/**
 * D4 ClosureDepth 测试 — captureGraphState + measureClosureDepth。
 *
 * 验证行动到图结构变化的反馈路径深度测量：
 * - captureGraphState: 正确捕获节点 ID、属性浅拷贝、边数量
 * - measureClosureDepth: 正确检测属性变更、新增/删除节点、边变化
 *
 * @see paper/ §Definition 7 "Closure Depth"
 */
import { describe, expect, it } from "vitest";
import { captureGraphState, measureClosureDepth } from "../src/engine/closure-depth.js";
import { WorldModel } from "../src/graph/world-model.js";

describe("D4 ClosureDepth", () => {
  // -- captureGraphState ------------------------------------------------------

  describe("captureGraphState", () => {
    it("捕获所有节点 ID", () => {
      const G = new WorldModel();
      G.addContact("c1");
      G.addContact("c2");
      G.addThread("t1");

      const capture = captureGraphState(G);

      expect(capture.nodeIds.size).toBe(3);
      expect(capture.nodeIds.has("c1")).toBe(true);
      expect(capture.nodeIds.has("c2")).toBe(true);
      expect(capture.nodeIds.has("t1")).toBe(true);
    });

    it("捕获节点属性（浅拷贝）", () => {
      const G = new WorldModel();
      G.addContact("c1", { tier: 50 });

      const capture = captureGraphState(G);
      const attrs = capture.attrs.get("c1");

      expect(attrs).toBeDefined();
      expect(attrs?.tier).toBe(50);
      expect(attrs?.entity_type).toBe("contact");

      // 修改原图不应影响 capture（nodeAttrs 返回浅拷贝）
      G.setDynamic("c1", "tier", 500);
      expect(capture.attrs.get("c1")?.tier).toBe(50);
    });

    it("捕获边数量", () => {
      const G = new WorldModel();
      G.addContact("c1");
      G.addContact("c2");
      G.addRelation("c1", "friend", "c2");
      G.addRelation("c1", "knows", "c2");

      const capture = captureGraphState(G);
      expect(capture.edgeCount).toBe(2);
    });

    it("空图的 capture", () => {
      const G = new WorldModel();
      const capture = captureGraphState(G);

      expect(capture.nodeIds.size).toBe(0);
      expect(capture.attrs.size).toBe(0);
      expect(capture.edgeCount).toBe(0);
    });
  });

  // -- measureClosureDepth ----------------------------------------------------

  describe("measureClosureDepth", () => {
    it("无变化 → maxDepth 0", () => {
      const G = new WorldModel();
      G.addContact("c1", { tier: 150 });
      G.addContact("c2");
      G.addRelation("c1", "friend", "c2");

      const before = captureGraphState(G);
      // 不做任何修改
      const result = measureClosureDepth(before, G);

      expect(result.maxDepth).toBe(0);
      expect(result.directChanges).toBe(0);
      expect(result.indirectChanges).toBe(0);
      expect(result.newNodes).toEqual([]);
      expect(result.deletedNodes).toEqual([]);
      expect(result.edgeDelta).toBe(0);
    });

    it("属性变更 → maxDepth 1", () => {
      const G = new WorldModel();
      G.addContact("c1", { tier: 150 });

      const before = captureGraphState(G);
      G.setDynamic("c1", "tier", 50);
      const result = measureClosureDepth(before, G);

      expect(result.maxDepth).toBe(1);
      expect(result.directChanges).toBe(1);
      expect(result.newNodes).toEqual([]);
      expect(result.deletedNodes).toEqual([]);
    });

    it("多节点属性变更 → directChanges 正确计数", () => {
      const G = new WorldModel();
      G.addContact("c1", { tier: 150 });
      G.addContact("c2", { tier: 50 });
      G.addContact("c3", { tier: 5 });

      const before = captureGraphState(G);
      G.setDynamic("c1", "tier", 5);
      G.setDynamic("c2", "tier", 500);
      // c3 不变
      const result = measureClosureDepth(before, G);

      expect(result.maxDepth).toBe(1);
      expect(result.directChanges).toBe(2);
    });

    it("新建节点 → maxDepth 1 + newNodes 包含 ID", () => {
      const G = new WorldModel();
      G.addContact("c1");

      const before = captureGraphState(G);
      G.addContact("c_new");
      const result = measureClosureDepth(before, G);

      expect(result.maxDepth).toBe(1);
      expect(result.newNodes).toContain("c_new");
      expect(result.directChanges).toBeGreaterThanOrEqual(1);
    });

    it("删除节点 → maxDepth 1 + deletedNodes 包含 ID", () => {
      const G = new WorldModel();
      G.addContact("c1");
      G.addContact("c2");

      const before = captureGraphState(G);
      G.removeEntity("c1");
      const result = measureClosureDepth(before, G);

      expect(result.maxDepth).toBe(1);
      expect(result.deletedNodes).toContain("c1");
      expect(result.directChanges).toBeGreaterThanOrEqual(1);
    });

    it("边增加 → edgeDelta > 0", () => {
      const G = new WorldModel();
      G.addContact("c1");
      G.addContact("c2");

      const before = captureGraphState(G);
      G.addRelation("c1", "friend", "c2");
      const result = measureClosureDepth(before, G);

      expect(result.maxDepth).toBe(1);
      expect(result.edgeDelta).toBe(1);
    });

    it("边删除（通过移除节点）→ edgeDelta > 0", () => {
      const G = new WorldModel();
      G.addContact("c1");
      G.addContact("c2");
      G.addRelation("c1", "friend", "c2");

      const before = captureGraphState(G);
      G.removeEntity("c2"); // 连带删除边
      const result = measureClosureDepth(before, G);

      expect(result.maxDepth).toBe(1);
      expect(result.edgeDelta).toBe(1);
      expect(result.deletedNodes).toContain("c2");
    });

    it("混合变更 → 正确统计", () => {
      const G = new WorldModel();
      G.addContact("c1", { tier: 150 });
      G.addContact("c2", { tier: 50 });
      G.addThread("t1");
      G.addRelation("c1", "friend", "c2");

      const before = captureGraphState(G);

      // 修改属性
      G.setDynamic("c1", "tier", 5);
      // 新建节点
      G.addContact("c3");
      // 删除节点（连带删除边）
      G.removeEntity("t1");
      // 新建边
      G.addRelation("c1", "knows", "c3");

      const result = measureClosureDepth(before, G);

      expect(result.maxDepth).toBe(1);
      // c1 属性变更(1) + c3 新建(1) + t1 删除(1) = 3+
      expect(result.directChanges).toBeGreaterThanOrEqual(3);
      expect(result.newNodes).toContain("c3");
      expect(result.deletedNodes).toContain("t1");
      // 边变化：原有 friend(1) → friend(1) + knows(1) - 0（t1 无边）= 净变化 1
      expect(result.edgeDelta).toBeGreaterThanOrEqual(1);
    });

    it("只有边变化无节点变化 → maxDepth 1", () => {
      const G = new WorldModel();
      G.addContact("c1");
      G.addContact("c2");

      const before = captureGraphState(G);
      G.addRelation("c1", "friend", "c2");
      G.addRelation("c1", "knows", "c2");
      const result = measureClosureDepth(before, G);

      expect(result.maxDepth).toBe(1);
      expect(result.directChanges).toBe(0); // 节点属性未变
      expect(result.edgeDelta).toBe(2);
    });

    it("indirectChanges 当前版本始终为 0（预留扩展）", () => {
      const G = new WorldModel();
      G.addContact("c1", { tier: 150 });

      const before = captureGraphState(G);
      G.setDynamic("c1", "tier", 5);
      const result = measureClosureDepth(before, G);

      expect(result.indirectChanges).toBe(0);
    });

    it("空图无变化 → maxDepth 0", () => {
      const G = new WorldModel();
      const before = captureGraphState(G);
      const result = measureClosureDepth(before, G);

      expect(result.maxDepth).toBe(0);
      expect(result.directChanges).toBe(0);
      expect(result.edgeDelta).toBe(0);
    });
  });
});
