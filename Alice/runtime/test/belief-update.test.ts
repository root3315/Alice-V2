import { describe, expect, it } from "vitest";
import { BeliefStore } from "../src/belief/store.js";
import type { BeliefTriple } from "../src/belief/types.js";
import { updateBelief } from "../src/belief/update.js";

describe("updateBelief", () => {
  const base: BeliefTriple = { mu: 0.5, sigma2: 0.3, tObs: 10 };

  describe("structural 通道", () => {
    it("直接覆写 mu", () => {
      const result = updateBelief(base, 0.9, "structural", 20);
      expect(result.mu).toBe(0.9);
    });

    it("sigma2 → 接近 0（ε = 0.01）", () => {
      const result = updateBelief(base, 0.9, "structural", 20);
      expect(result.sigma2).toBeCloseTo(0.01, 5);
      expect(result.sigma2).toBeGreaterThan(0);
    });

    it("更新 tObs 到当前 tick", () => {
      const result = updateBelief(base, 0.9, "structural", 42);
      expect(result.tObs).toBe(42);
    });

    it("不修改原对象", () => {
      updateBelief(base, 0.9, "structural", 20);
      expect(base.mu).toBe(0.5);
      expect(base.sigma2).toBe(0.3);
    });
  });

  describe("semantic 通道", () => {
    it("EMA 融合: mu 向观测值移动", () => {
      const result = updateBelief(base, 1.0, "semantic", 20, { alpha: 0.3 });
      // mu' = (1-0.3)*0.5 + 0.3*1.0 = 0.35 + 0.3 = 0.65
      expect(result.mu).toBeCloseTo(0.65, 5);
    });

    it("alpha=1 → mu 完全跟随观测", () => {
      const result = updateBelief(base, 1.0, "semantic", 20, { alpha: 1.0 });
      expect(result.mu).toBeCloseTo(1.0, 5);
    });

    it("alpha=0 → mu 不变", () => {
      // alpha=0 是边界情况，EMA 权重为 0 → 完全忽略观测
      const result = updateBelief(base, 1.0, "semantic", 20, { alpha: 0 });
      expect(result.mu).toBeCloseTo(0.5, 5);
    });

    it("sigma2 按 EMA 公式更新", () => {
      const alpha = 0.3;
      const noise = 0.1;
      const result = updateBelief(base, 1.0, "semantic", 20, { alpha, noise });
      // σ²' = (1-α)²·σ² + α²·noise = 0.49*0.3 + 0.09*0.1 = 0.147 + 0.009 = 0.156
      expect(result.sigma2).toBeCloseTo((1 - alpha) ** 2 * base.sigma2 + alpha ** 2 * noise, 5);
    });

    it("连续 semantic 更新收敛", () => {
      let b = base;
      for (let i = 0; i < 100; i++) {
        b = updateBelief(b, 1.0, "semantic", 20 + i);
      }
      // 多次观测同一值 → mu 趋近 1.0
      expect(b.mu).toBeCloseTo(1.0, 1);
      // 方差趋近稳定（小值）
      expect(b.sigma2).toBeLessThan(base.sigma2);
    });

    it("使用默认 alpha 和 noise", () => {
      const result = updateBelief(base, 1.0, "semantic", 20);
      // 默认 alpha=0.3, noise=0.1
      expect(result.mu).toBeCloseTo(0.65, 5);
      expect(result.tObs).toBe(20);
    });
  });

  describe("双通道切换", () => {
    it("semantic 后 structural → 覆盖为精确值", () => {
      const afterSemantic = updateBelief(base, 0.8, "semantic", 20);
      const afterStructural = updateBelief(afterSemantic, 0.95, "structural", 21);
      expect(afterStructural.mu).toBe(0.95);
      expect(afterStructural.sigma2).toBeCloseTo(0.01, 5);
    });

    it("structural 后 semantic → 从精确值开始融合", () => {
      const afterStructural = updateBelief(base, 0.95, "structural", 20);
      const afterSemantic = updateBelief(afterStructural, 0.7, "semantic", 21, { alpha: 0.3 });
      // mu' = 0.7*0.95 + 0.3*0.7 = 0.665 + 0.21 = 0.875
      expect(afterSemantic.mu).toBeCloseTo((1 - 0.3) * 0.95 + 0.3 * 0.7, 5);
    });
  });
});

describe("BeliefStore", () => {
  it("get/set 基本操作", () => {
    const store = new BeliefStore();
    store.set("alice", "mood", { mu: 0.7, sigma2: 0.1, tObs: 5 });
    const b = store.get("alice", "mood");
    expect(b).toBeDefined();
    expect(b?.mu).toBe(0.7);
  });

  it("getOrDefault 不存在时返回默认", () => {
    const store = new BeliefStore();
    const b = store.getOrDefault("unknown", "mood", 0.5);
    expect(b.mu).toBe(0.5);
    expect(b.sigma2).toBe(1.0); // 高不确定性
    expect(b.tObs).toBe(0);
  });

  it("entropy 计算正确", () => {
    const store = new BeliefStore();
    store.set("a", "x", { mu: 0, sigma2: 0.5, tObs: 0 });
    const h = store.entropy("a", "x");
    expect(h).toBeCloseTo(0.5 * Math.log(2 * Math.PI * Math.E * 0.5), 5);
  });

  it("entropy: 不存在时使用默认方差", () => {
    const store = new BeliefStore();
    const h = store.entropy("nonexistent", "x");
    expect(h).toBeCloseTo(0.5 * Math.log(2 * Math.PI * Math.E * 1.0), 5);
  });

  it("序列化/反序列化 round-trip", () => {
    const store = new BeliefStore();
    store.set("a", "x", { mu: 0.5, sigma2: 0.2, tObs: 10 });
    store.set("b", "y", { mu: -0.3, sigma2: 0.8, tObs: 20 });

    const dict = store.toDict();
    const restored = BeliefStore.fromDict(dict);

    expect(restored.get("a", "x")?.mu).toBe(0.5);
    expect(restored.get("b", "y")?.mu).toBe(-0.3);
    expect(restored.size).toBe(2);
  });

  it("decayAll 执行批量衰减", () => {
    const store = new BeliefStore();
    store.set("a", "x", { mu: 1.0, sigma2: 0.1, tObs: 0 });
    store.set("b", "y", { mu: 0.8, sigma2: 0.2, tObs: 0 });
    // F4: nowMs 单位为墙钟 ms。DEFAULT_BELIEF_DECAY.halfLife=86400s（1天）。
    // 400_000_000 ms = 400000s ≈ 4.63 天 → 2^(-4.63) ≈ 0.040
    store.decayAll(400_000_000);
    // 衰减后 mu 趋近 muPrior(0)
    expect(store.get("a", "x")?.mu).toBeCloseTo(0, 1);
    expect(store.get("b", "y")?.mu).toBeCloseTo(0, 1);
  });
});
