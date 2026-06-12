/**
 * BeliefStore 测试。
 * @see docs/adr/123-crystallization-substrate-generalization.md §D1, §D2
 */
import { describe, expect, it } from "vitest";
import { BeliefStore } from "../src/belief/store.js";
import { TRAIT_BELIEF_DECAY } from "../src/belief/types.js";

describe("BeliefStore.update()", () => {
  it("更新信念并返回新 BeliefTriple", () => {
    const store = new BeliefStore();
    const result = store.update("alice", "trait:warmth", 0.7, "semantic", 10);
    expect(result.mu).toBeGreaterThan(0);
    expect(result.tObs).toBe(10);
    expect(store.get("alice", "trait:warmth")).toEqual(result);
  });

  it("structural 通道覆写 mu", () => {
    const store = new BeliefStore();
    store.update("alice", "tier", 50, "structural", 5);
    const result = store.get("alice", "tier");
    expect(result?.mu).toBe(50);
    expect(result?.sigma2).toBeCloseTo(0.01, 5);
  });
});

describe("registerDomainDecay() + decayAll()", () => {
  /**
   * F4 墙钟迁移后：
   * - decayAll(nowMs) 参数为墙钟 ms
   * - halfLife 单位为秒
   * - 内部: dtS = (nowMs - tObs) / 1000
   */

  it("注册的域使用专属衰减参数", () => {
    const store = new BeliefStore();
    store.set("alice", "trait:warmth", { mu: 0.8, sigma2: 0.05, tObs: 0 });
    store.set("alice", "mood", { mu: 0.5, sigma2: 0.05, tObs: 0 });

    store.registerDomainDecay("trait:", TRAIT_BELIEF_DECAY);
    // 50000 秒 ≈ 14 小时 ≈ 1.74 个 trait 半衰期（28800s），0.58 个默认半衰期（86400s）
    store.decayAll(50_000_000);

    // biome-ignore lint/style/noNonNullAssertion: guarded by test assertion
    const trait = store.get("alice", "trait:warmth")!;
    // biome-ignore lint/style/noNonNullAssertion: guarded by test assertion
    const mood = store.get("alice", "mood")!;

    // trait (halfLife=28800s) 衰减更快, mood (halfLife=86400s) 衰减更慢
    expect(trait.mu).toBeLessThan(mood.mu);
  });

  it("未注册的域使用默认参数", () => {
    const store = new BeliefStore();
    store.set("alice", "unknown:x", { mu: 0.8, sigma2: 0.05, tObs: 0 });

    // dtS = 50000000 / 1000 = 50000s, DEFAULT halfLife = 86400s
    store.decayAll(50_000_000);

    // biome-ignore lint/style/noNonNullAssertion: guarded by test assertion
    const result = store.get("alice", "unknown:x")!;
    // mu_eff = 0 + (0.8 - 0) * 2^(-50000/86400)
    expect(result.mu).toBeCloseTo(0.8 * 2 ** (-50000 / 86400), 3);
  });

  it("多个域注册各自独立", () => {
    const store = new BeliefStore();
    // halfLife 单位为秒
    const fastDecay = { halfLife: 100, muPrior: 0, sigma2Inf: 1.0, theta: 0.001 };
    const slowDecay = { halfLife: 10000, muPrior: 0, sigma2Inf: 1.0, theta: 0.001 };

    store.registerDomainDecay("fast:", fastDecay);
    store.registerDomainDecay("slow:", slowDecay);

    store.set("e", "fast:x", { mu: 1.0, sigma2: 0.05, tObs: 0 });
    store.set("e", "slow:y", { mu: 1.0, sigma2: 0.05, tObs: 0 });

    // 500 秒 → 500_000 ms
    // fast: dtS=500s / halfLife=100s → 5 个半衰期 → 2^(-5) ≈ 0.031
    // slow: dtS=500s / halfLife=10000s → 0.05 个半衰期 → 2^(-0.05) ≈ 0.966
    store.decayAll(500_000);

    // biome-ignore lint/style/noNonNullAssertion: guarded by test assertion
    const fast = store.get("e", "fast:x")!;
    // biome-ignore lint/style/noNonNullAssertion: guarded by test assertion
    const slow = store.get("e", "slow:y")!;

    expect(fast.mu).toBeLessThan(0.1);
    expect(slow.mu).toBeGreaterThan(0.95);
  });
});

describe("toDict() / fromDict() 序列化", () => {
  it("toDict 返回结构化格式", () => {
    const store = new BeliefStore();
    store.update("alice", "trait:warmth", 0.7, "semantic", 10);
    const dict = store.toDict();
    expect(dict.entries).toBeDefined();
    expect(dict.entries["alice::trait:warmth"]).toBeDefined();
  });

  it("round-trip: fromDict 恢复信念", () => {
    const store = new BeliefStore();
    store.update("alice", "trait:warmth", 0.7, "semantic", 10);
    store.update("bob", "mood", 0.3, "semantic", 11);

    const dict = store.toDict();
    const restored = BeliefStore.fromDict(dict);

    const storeEntry = store.get("alice", "trait:warmth");
    expect(storeEntry).toBeDefined();
    // biome-ignore lint/style/noNonNullAssertion: guarded by test assertion
    expect(restored.get("alice", "trait:warmth")?.mu).toBeCloseTo(storeEntry!.mu);
    expect(restored.size).toBe(2);
  });

  it("fromDict 优雅忽略旧 JSON 中的多余字段", () => {
    // 旧格式包含 changelog、windows、drifts
    const oldDict = {
      entries: { "alice::mood": { mu: 0.5, sigma2: 0.1, tObs: 10 } },
      changelog: [
        {
          key: "alice::mood",
          oldMu: 0,
          newMu: 0.5,
          oldSigma2: 1,
          newSigma2: 0.1,
          observation: 0.5,
          channel: "semantic",
          ms: 10,
        },
      ],
      windows: { "alice::mood": [0.5] },
      drifts: [],
    };

    // 不应 throw
    const store = BeliefStore.fromDict(oldDict as never);
    expect(store.get("alice", "mood")?.mu).toBe(0.5);
  });
});

describe("restoreFrom()", () => {
  it("恢复信念", () => {
    const source = new BeliefStore();
    source.update("alice", "trait:warmth", 0.7, "semantic", 10);

    const target = new BeliefStore();
    target.restoreFrom(source);

    const sourceEntry = source.get("alice", "trait:warmth");
    expect(sourceEntry).toBeDefined();
    // biome-ignore lint/style/noNonNullAssertion: guarded by test assertion
    expect(target.get("alice", "trait:warmth")?.mu).toBeCloseTo(sourceEntry!.mu);
  });
});

describe("clear()", () => {
  it("清除所有信念", () => {
    const store = new BeliefStore();
    store.update("alice", "trait:warmth", 0.7, "semantic", 10);
    store.clear();
    expect(store.size).toBe(0);
  });
});
