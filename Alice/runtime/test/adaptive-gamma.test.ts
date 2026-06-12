/**
 * adaptiveGamma 单元测试。
 *
 * 验证自适应均值回归系数根据 self 节点的 personality_health 状态正确调整：
 * - "alert" → baseGamma × 3（加速回归）
 * - 其他值或无 self 节点 → baseGamma（不变）
 *
 * @see docs/adr/45-real-data-validation.md §3.6
 */
import { describe, expect, test } from "vitest";
import { adaptiveGamma } from "../src/engine/act/index.js";
import { WorldModel } from "../src/graph/world-model.js";

describe("adaptiveGamma", () => {
  test("self 节点不存在 → 返回 baseGamma", () => {
    const G = new WorldModel();
    // 空图，没有 self 节点
    expect(adaptiveGamma(G, 0.05)).toBe(0.05);
  });

  test("personality_health 未设置 → 返回 baseGamma", () => {
    const G = new WorldModel();
    G.addAgent("self");
    // agent 节点默认没有 personality_health 属性
    expect(adaptiveGamma(G, 0.05)).toBe(0.05);
  });

  test("personality_health='healthy' → 返回 baseGamma", () => {
    const G = new WorldModel();
    G.addAgent("self", { personality_health: "healthy" });
    expect(adaptiveGamma(G, 0.05)).toBe(0.05);
  });

  test("personality_health='alert' → 返回 baseGamma × 3", () => {
    const G = new WorldModel();
    G.addAgent("self", { personality_health: "alert" });
    expect(adaptiveGamma(G, 0.05)).toBeCloseTo(0.15);
  });

  test("personality_health='warning' → 返回 baseGamma（非 alert）", () => {
    const G = new WorldModel();
    G.addAgent("self", { personality_health: "warning" });
    expect(adaptiveGamma(G, 0.05)).toBe(0.05);
  });

  test("baseGamma=0 时 alert 也返回 0", () => {
    const G = new WorldModel();
    G.addAgent("self", { personality_health: "alert" });
    expect(adaptiveGamma(G, 0)).toBe(0);
  });

  test("不同 baseGamma 值的乘法正确性", () => {
    const G = new WorldModel();
    G.addAgent("self", { personality_health: "alert" });
    expect(adaptiveGamma(G, 0.1)).toBeCloseTo(0.3);
    expect(adaptiveGamma(G, 1.0)).toBeCloseTo(3.0);
  });
});
