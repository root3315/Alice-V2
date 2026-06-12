import { describe, expect, it } from "vitest";
import { computeNetSocialValue, computeNSVBeta } from "../src/pressure/social-value.js";

describe("computeNSVBeta", () => {
  it("beta=0 退化到旧行为", () => {
    const deltaP = 2.0;
    const socialCost = 0.5;
    const lambda = 1.5;
    const entropy = 999; // 不管多大，beta=0 时无影响

    const nsvBeta = computeNSVBeta(deltaP, socialCost, lambda, entropy, 0, 0, 0);
    const nsvOld = computeNetSocialValue(deltaP, socialCost, lambda);
    expect(nsvBeta).toBeCloseTo(nsvOld, 10);
  });

  it("高 entropy 目标 → NSV 降低", () => {
    const deltaP = 2.0;
    const socialCost = 0.3;
    const lambda = 1.0;
    const beta = 0.5;

    const lowEntropy = 0.1;
    const highEntropy = 2.0;

    const nsvLow = computeNSVBeta(deltaP, socialCost, lambda, lowEntropy, beta, 0, 0);
    const nsvHigh = computeNSVBeta(deltaP, socialCost, lambda, highEntropy, beta, 0, 0);

    expect(nsvHigh).toBeLessThan(nsvLow);
  });

  it("公式验证: ΔP - λ·C - β·H", () => {
    const deltaP = 3.0;
    const socialCost = 0.5;
    const lambda = 2.0;
    const entropy = 1.5;
    const beta = 0.8;

    const expected = 3.0 - 2.0 * 0.5 - 0.8 * 1.5; // 3.0 - 1.0 - 1.2 = 0.8
    expect(computeNSVBeta(deltaP, socialCost, lambda, entropy, beta, 0, 0)).toBeCloseTo(
      expected,
      10,
    );
  });

  it("高不确定性可以翻转决策（正 → 负）", () => {
    const deltaP = 1.0;
    const socialCost = 0.3;
    const lambda = 1.0;
    const beta = 1.0;

    // 无不确定性: 1.0 - 0.3 = 0.7 > 0 → 行动
    const nsvCertain = computeNSVBeta(deltaP, socialCost, lambda, 0, beta, 0, 0);
    expect(nsvCertain).toBeGreaterThan(0);

    // 高不确定性: 1.0 - 0.3 - 1.0*1.5 = -0.8 < 0 → 沉默
    const nsvUncertain = computeNSVBeta(deltaP, socialCost, lambda, 1.5, beta, 0, 0);
    expect(nsvUncertain).toBeLessThan(0);
  });

  it("entropy=0 时等于原始 NSV", () => {
    const deltaP = 2.0;
    const socialCost = 0.4;
    const lambda = 1.2;
    const beta = 0.5;

    const nsvBeta = computeNSVBeta(deltaP, socialCost, lambda, 0, beta, 0, 0);
    const nsvOld = computeNetSocialValue(deltaP, socialCost, lambda);
    expect(nsvBeta).toBeCloseTo(nsvOld, 10);
  });
});
