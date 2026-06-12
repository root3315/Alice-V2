/**
 * Tier Bias Correction 测试 — nearestTier + tierBiasCorrection + P3 集成。
 *
 * 验证 Social POMDP 的 tier 高估偏差校正：
 * - nearestTier: 连续值到离散 DunbarTier 的映射
 * - tierBiasCorrection: sigma2 驱动的向基线 150 回归
 * - P3 集成: 高 sigma2 联系人的压力应受校正影响
 *
 * @see paper/ §Social POMDP "Tier Overestimate Bias Correction"
 */
import { describe, expect, it } from "vitest";
import { nearestTier, TIER_SEQUENCE, tierBiasCorrection } from "../src/graph/constants.js";
import type { DunbarTier } from "../src/graph/entities.js";
import { WorldModel } from "../src/graph/world-model.js";
import { p3RelationshipCooling } from "../src/pressure/p3-relationship.js";

describe("Tier Bias Correction", () => {
  // -- nearestTier ------------------------------------------------------------

  describe("nearestTier", () => {
    it("精确匹配 → 返回该 tier", () => {
      for (const t of TIER_SEQUENCE) {
        expect(nearestTier(t)).toBe(t);
      }
    });

    it("中间值 → 返回最近 tier", () => {
      // 5 和 15 的中点是 10 → 最近是 5 或 15（距离相等时取先遍历的）
      // TIER_SEQUENCE = [5, 15, 50, 150, 500]，5 先遍历
      expect(nearestTier(10)).toBe(5); // |10-5|=5, |10-15|=5, 5 先命中

      // 30 → |30-5|=25, |30-15|=15, |30-50|=20 → 最近 15
      expect(nearestTier(30)).toBe(15);

      // 100 → |100-50|=50, |100-150|=50 → 50 先遍历
      expect(nearestTier(100)).toBe(50);

      // 300 → |300-150|=150, |300-500|=200 → 150
      expect(nearestTier(300)).toBe(150);
    });

    it("小于最小值 → 返回 5", () => {
      expect(nearestTier(0)).toBe(5);
      expect(nearestTier(-100)).toBe(5);
      expect(nearestTier(1)).toBe(5);
    });

    it("大于最大值 → 返回 500", () => {
      expect(nearestTier(999)).toBe(500);
      expect(nearestTier(600)).toBe(500);
      expect(nearestTier(1000)).toBe(500);
    });

    it("浮点数 → 返回最近整数 tier", () => {
      // 14.9 → |14.9-5|=9.9, |14.9-15|=0.1 → 15
      expect(nearestTier(14.9)).toBe(15);
      // 5.1 → |5.1-5|=0.1, |5.1-15|=9.9 → 5
      expect(nearestTier(5.1)).toBe(5);
    });
  });

  // -- tierBiasCorrection -----------------------------------------------------

  describe("tierBiasCorrection", () => {
    it("sigma2 为 undefined → 不校正", () => {
      expect(tierBiasCorrection(5, undefined)).toBe(5);
      expect(tierBiasCorrection(150, undefined)).toBe(150);
      expect(tierBiasCorrection(500, undefined)).toBe(500);
    });

    it("低 sigma2 (<= 0.3) → 不校正", () => {
      expect(tierBiasCorrection(5, 0.1)).toBe(5);
      expect(tierBiasCorrection(5, 0.3)).toBe(5);
      expect(tierBiasCorrection(500, 0.2)).toBe(500);
      expect(tierBiasCorrection(15, 0.0)).toBe(15);
    });

    it("高 sigma2 → 向 150 回归", () => {
      // tier=5, sigma2=0.5: effectiveTier = 5 + (150-5)*0.5 = 5 + 72.5 = 77.5 → nearestTier(77.5)
      // |77.5-50|=27.5, |77.5-150|=72.5 → 50
      const result = tierBiasCorrection(5, 0.5);
      expect(result).toBe(50);
    });

    it("tier=5 + sigma2=0.8 → 大幅向 150 回归", () => {
      // effectiveTier = 5 + (150-5)*0.8 = 5 + 116 = 121 → nearestTier(121)
      // |121-50|=71, |121-150|=29 → 150
      expect(tierBiasCorrection(5, 0.8)).toBe(150);
    });

    it("tier=150 + 任何 sigma2 → 不变（已在基线）", () => {
      // effectiveTier = 150 + (150-150)*x = 150，永远等于 150
      expect(tierBiasCorrection(150, 0.5)).toBe(150);
      expect(tierBiasCorrection(150, 0.8)).toBe(150);
      expect(tierBiasCorrection(150, 1.0)).toBe(150);
    });

    it("tier=500 + sigma2=0.5 → 向 150 回归", () => {
      // effectiveTier = 500 + (150-500)*0.5 = 500 - 175 = 325 → nearestTier(325)
      // |325-150|=175, |325-500|=175 → 150 先遍历
      expect(tierBiasCorrection(500, 0.5)).toBe(150);
    });

    it("sigma2 > 0.8 被截断到 0.8", () => {
      // sigma2=1.0 → regression = min(1.0, 0.8) = 0.8
      // tier=5: effectiveTier = 5 + 145*0.8 = 121 → 150
      expect(tierBiasCorrection(5, 1.0)).toBe(tierBiasCorrection(5, 0.8));

      // tier=500: effectiveTier = 500 + (-350)*0.8 = 220 → nearestTier(220)
      // |220-150|=70, |220-500|=280 → 150
      expect(tierBiasCorrection(500, 1.0)).toBe(tierBiasCorrection(500, 0.8));
    });

    it("返回值是合法 DunbarTier", () => {
      const validTiers: DunbarTier[] = [5, 15, 50, 150, 500];
      const testTiers: DunbarTier[] = [5, 15, 50, 150, 500];
      const testSigma2 = [0.0, 0.1, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0];

      for (const tier of testTiers) {
        for (const s2 of testSigma2) {
          const result = tierBiasCorrection(tier, s2);
          expect(validTiers).toContain(result);
        }
      }
    });

    it("tier=15 + sigma2=0.4 → 适度回归", () => {
      // effectiveTier = 15 + (150-15)*0.4 = 15 + 54 = 69 → nearestTier(69)
      // |69-50|=19, |69-150|=81 → 50
      expect(tierBiasCorrection(15, 0.4)).toBe(50);
    });

    it("tier=50 + sigma2=0.6 → 显著回归", () => {
      // effectiveTier = 50 + (150-50)*0.6 = 50 + 60 = 110 → nearestTier(110)
      // |110-50|=60, |110-150|=40 → 150
      expect(tierBiasCorrection(50, 0.6)).toBe(150);
    });
  });

  // -- P3 集成 -----------------------------------------------------------------

  describe("P3 集成", () => {
    /**
     * 构造两个图，一个 tier=5 + 低 sigma2（高确信亲密），一个 tier=5 + 高 sigma2（低确信亲密）。
     * 高 sigma2 的 P3 应更低：因为校正后 tier 向 150 回归，权重变小。
     */
    it("高 sigma2 联系人的 P3 应低于低 sigma2 的", () => {
      const tick = 100;

      // 图 A: tier=5, 低 sigma2 → 信任亲密度判断 → 权重高（w=5.0）
      const gA = new WorldModel();
      gA.tick = tick;
      gA.addContact("contact:1", { tier: 5, last_active_ms: 1 });
      gA.beliefs.set("contact:1", "tier", { mu: 5, sigma2: 0.1, tObs: tick });

      // 图 B: tier=5, 高 sigma2 → 不确定亲密度 → 校正后 tier 向 150 回归 → 权重低
      const gB = new WorldModel();
      gB.tick = tick;
      gB.addContact("contact:1", { tier: 5, last_active_ms: 1 });
      gB.beliefs.set("contact:1", "tier", { mu: 5, sigma2: 0.8, tObs: tick });

      const p3A = p3RelationshipCooling(gA, tick, Date.now());
      const p3B = p3RelationshipCooling(gB, tick, Date.now());

      // 高确信的 P3 应更高（tier=5 权重 5.0）
      // 低确信的 P3 应更低（校正后可能是 tier=150 权重 0.8）
      expect(p3A.total).toBeGreaterThan(p3B.total);
    });

    it("无 belief 的联系人不校正（使用原始 tier）", () => {
      const tick = 100;

      // 无 belief → sigma2 = undefined → 不校正
      const gNoBelief = new WorldModel();
      gNoBelief.tick = tick;
      gNoBelief.addContact("contact:1", { tier: 5, last_active_ms: 1 });

      // 有低 sigma2 belief → 不校正（sigma2 <= 0.3）
      const gLowSigma = new WorldModel();
      gLowSigma.tick = tick;
      gLowSigma.addContact("contact:1", { tier: 5, last_active_ms: 1 });
      gLowSigma.beliefs.set("contact:1", "tier", { mu: 5, sigma2: 0.1, tObs: tick });

      const p3NoBelief = p3RelationshipCooling(gNoBelief, tick, Date.now());
      const p3LowSigma = p3RelationshipCooling(gLowSigma, tick, Date.now());

      // 两者都不校正，P3 应该相同
      expect(p3NoBelief.total).toBeCloseTo(p3LowSigma.total, 5);
    });

    it("tier=150 联系人无论 sigma2 多高 P3 不变", () => {
      const tick = 100;

      const gLow = new WorldModel();
      gLow.tick = tick;
      gLow.addContact("contact:1", { tier: 150, last_active_ms: 1 });
      gLow.beliefs.set("contact:1", "tier", { mu: 150, sigma2: 0.1, tObs: tick });

      const gHigh = new WorldModel();
      gHigh.tick = tick;
      gHigh.addContact("contact:1", { tier: 150, last_active_ms: 1 });
      gHigh.beliefs.set("contact:1", "tier", { mu: 150, sigma2: 0.8, tObs: tick });

      const p3Low = p3RelationshipCooling(gLow, tick, Date.now());
      const p3High = p3RelationshipCooling(gHigh, tick, Date.now());

      // tier=150 是基线，校正公式 150+(150-150)*x = 150，所以 P3 相同
      expect(p3Low.total).toBeCloseTo(p3High.total, 5);
    });
  });
});
