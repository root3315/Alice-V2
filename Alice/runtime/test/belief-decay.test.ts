import { describe, expect, it } from "vitest";
import { decayBelief } from "../src/belief/decay.js";
import type { BeliefDecayParams, BeliefTriple } from "../src/belief/types.js";

/**
 * F4 墙钟迁移后：
 * - tObs 和 nowMs 均为墙钟 ms
 * - halfLife、theta 单位为秒
 * - 内部: dtS = (nowMs - tObs) / 1000
 */
const params: BeliefDecayParams = {
  halfLife: 100, // 100 秒
  muPrior: 0,
  sigma2Inf: 1.0,
  theta: 0.01, // per second
};

/** 辅助: tObs=0 时，将秒转为 nowMs。 */
const sec = (s: number) => s * 1000;

describe("decayBelief", () => {
  it("nowMs=tObs → 不衰减", () => {
    const b: BeliefTriple = { mu: 0.8, sigma2: 0.1, tObs: 50_000 };
    const result = decayBelief(b, 50_000, params);
    expect(result.mu).toBeCloseTo(0.8);
    expect(result.sigma2).toBeCloseTo(0.1);
    expect(result.tObs).toBe(50_000);
  });

  it("nowMs < tObs → 不衰减（未来观测不影响）", () => {
    const b: BeliefTriple = { mu: 0.8, sigma2: 0.1, tObs: 50_000 };
    const result = decayBelief(b, 30_000, params);
    expect(result.mu).toBeCloseTo(0.8);
    expect(result.sigma2).toBeCloseTo(0.1);
  });

  it("nowMs >> tObs → mu → muPrior, sigma2 → sigma2Inf", () => {
    const b: BeliefTriple = { mu: 1.0, sigma2: 0.01, tObs: 0 };
    // 10000 秒 = 100 个半衰期，2^(-100) ≈ 0
    const result = decayBelief(b, sec(10_000), params);
    expect(result.mu).toBeCloseTo(params.muPrior, 2);
    expect(result.sigma2).toBeCloseTo(params.sigma2Inf, 2);
  });

  it("半衰期正确: dt=halfLife → mu 衰减一半", () => {
    const b: BeliefTriple = { mu: 1.0, sigma2: 0.01, tObs: 0 };
    // dtS = halfLife = 100s → decay = 2^(-1) = 0.5
    const result = decayBelief(b, sec(params.halfLife), params);
    expect(result.mu).toBeCloseTo(0.5, 5);
  });

  it("两个半衰期 → mu 衰减到 1/4", () => {
    const b: BeliefTriple = { mu: 1.0, sigma2: 0.01, tObs: 0 };
    const result = decayBelief(b, sec(params.halfLife * 2), params);
    expect(result.mu).toBeCloseTo(0.25, 5);
  });

  it("非零 muPrior → mu 衰减到 muPrior", () => {
    const p: BeliefDecayParams = { ...params, muPrior: 0.5 };
    const b: BeliefTriple = { mu: 1.0, sigma2: 0.01, tObs: 0 };
    const result = decayBelief(b, sec(p.halfLife), p);
    // μ_eff = 0.5 + (1.0 - 0.5) * 0.5 = 0.75
    expect(result.mu).toBeCloseTo(0.75, 5);
  });

  it("不修改原对象（immutable）", () => {
    const b: BeliefTriple = { mu: 0.8, sigma2: 0.1, tObs: 0 };
    const result = decayBelief(b, sec(100), params);
    expect(b.mu).toBe(0.8);
    expect(b.sigma2).toBe(0.1);
    expect(result).not.toBe(b);
  });

  it("sigma2 单调递增（OU 过程）", () => {
    const b: BeliefTriple = { mu: 0.8, sigma2: 0.05, tObs: 0 };
    const r1 = decayBelief(b, sec(50), params);
    const r2 = decayBelief(b, sec(100), params);
    const r3 = decayBelief(b, sec(200), params);
    expect(r1.sigma2).toBeGreaterThan(0.05);
    expect(r2.sigma2).toBeGreaterThan(r1.sigma2);
    expect(r3.sigma2).toBeGreaterThan(r2.sigma2);
    expect(r3.sigma2).toBeLessThanOrEqual(params.sigma2Inf);
  });
});
