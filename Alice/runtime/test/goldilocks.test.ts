/**
 * Goldilocks Window 单元测试。
 *
 * @see docs/adr/154-goldilocks-window/README.md
 */
import { describe, expect, it } from "vitest";
import { DUNBAR_TIER_THETA } from "../src/graph/constants.js";
import type { DunbarTier } from "../src/graph/entities.js";
import {
  computeGoldilocksUtility,
  goldilocksParams,
  proactiveCooldownForTier,
} from "../src/pressure/goldilocks.js";

const TIERS: DunbarTier[] = [5, 15, 50, 150, 500];
const ALPHA = 0.15;

describe("goldilocks", () => {
  // ── 1. goldilocksParams 参数正确性 ─────────────────────────────────────

  describe("goldilocksParams", () => {
    it("所有 tier 满足 tMin < tPeak < tMax", () => {
      for (const tier of TIERS) {
        const p = goldilocksParams(tier);
        expect(p.tMin).toBeLessThan(p.tPeak);
        expect(p.tPeak).toBeLessThan(p.tMax);
      }
    });

    it("tMax 等于 DUNBAR_TIER_THETA[tier]", () => {
      for (const tier of TIERS) {
        const p = goldilocksParams(tier);
        expect(p.tMax).toBe(DUNBAR_TIER_THETA[tier]);
      }
    });

    it("tauCool = α × θ_c", () => {
      for (const tier of TIERS) {
        const p = goldilocksParams(tier);
        expect(p.tauCool).toBeCloseTo(ALPHA * DUNBAR_TIER_THETA[tier], 6);
      }
    });

    it("tPeak 是 tMin 和 tMax 的几何均值", () => {
      for (const tier of TIERS) {
        const p = goldilocksParams(tier);
        expect(p.tPeak).toBeCloseTo(Math.sqrt(p.tMin * p.tMax), 6);
      }
    });

    it("sigmaLn = (ln(tMax) - ln(tMin)) / 4", () => {
      for (const tier of TIERS) {
        const p = goldilocksParams(tier);
        const expected = (Math.log(p.tMax) - Math.log(p.tMin)) / 4;
        expect(p.sigmaLn).toBeCloseTo(expected, 10);
      }
    });

    it("tier 5 参数与 ADR-154 参数表一致", () => {
      const p = goldilocksParams(5);
      // tauCool ≈ 1080s (18min)
      expect(p.tauCool).toBeCloseTo(1080, 0);
      // tMin ≈ 2484s (41min)
      expect(p.tMin).toBeCloseTo(1080 * Math.log(10), 0);
      // tMax = 7200s (2h)
      expect(p.tMax).toBe(7200);
    });
  });

  // ── 2. computeGoldilocksUtility 窗口行为 ───────────────────────────────

  describe("computeGoldilocksUtility", () => {
    it("窗口前 (t < tMin) → 0", () => {
      for (const tier of TIERS) {
        const p = goldilocksParams(tier);
        // 远在 tMin 之前
        expect(computeGoldilocksUtility(1, tier)).toBe(0);
        expect(computeGoldilocksUtility(p.tMin * 0.5, tier)).toBe(0);
        expect(computeGoldilocksUtility(p.tMin * 0.99, tier)).toBe(0);
      }
    });

    it("t = 0 → 0", () => {
      expect(computeGoldilocksUtility(0, 50)).toBe(0);
    });

    it("t < 0 → 0", () => {
      expect(computeGoldilocksUtility(-100, 50)).toBe(0);
    });

    it("窗口内峰值 (t = tPeak) → ≈ 1.0", () => {
      for (const tier of TIERS) {
        const p = goldilocksParams(tier);
        const u = computeGoldilocksUtility(p.tPeak, tier);
        expect(u).toBeCloseTo(1.0, 2);
      }
    });

    it("窗口边界效用值对称（对数域）", () => {
      for (const tier of TIERS) {
        const p = goldilocksParams(tier);
        const uMin = computeGoldilocksUtility(p.tMin, tier);
        const uMax = computeGoldilocksUtility(p.tMax, tier);
        // 在 ±2σ 处效用约 13.5%（exp(-0.5 × 4) ≈ 0.135）
        expect(uMin).toBeCloseTo(0.135, 1);
        expect(uMax).toBeCloseTo(0.135, 1);
        // 两者应近似相等（对数域对称）
        expect(Math.abs(uMin - uMax)).toBeLessThan(0.02);
      }
    });

    it("窗口后渐进衰减（不骤降）", () => {
      const tier: DunbarTier = 50;
      const p = goldilocksParams(tier);
      const uAtMax = computeGoldilocksUtility(p.tMax, tier);
      const uAfter1 = computeGoldilocksUtility(p.tMax * 1.5, tier);
      const uAfter2 = computeGoldilocksUtility(p.tMax * 2.0, tier);
      const uAfter3 = computeGoldilocksUtility(p.tMax * 3.0, tier);

      // 渐进衰减：单调递减且平滑
      expect(uAfter1).toBeLessThan(uAtMax);
      expect(uAfter2).toBeLessThan(uAfter1);
      expect(uAfter3).toBeLessThan(uAfter2);
      // 不骤降：紧挨 tMax 之后衰减不超过 50%
      expect(uAfter1).toBeGreaterThan(uAtMax * 0.3);
      // 远超 tMax 后趋近 0
      expect(uAfter3).toBeLessThan(0.05);
    });

    it("窗口内效用呈钟形（tMin 到 tPeak 上升，tPeak 到 tMax 下降）", () => {
      const tier: DunbarTier = 15;
      const p = goldilocksParams(tier);
      const t1 = p.tMin + (p.tPeak - p.tMin) * 0.3;
      const t2 = p.tMin + (p.tPeak - p.tMin) * 0.7;
      const t3 = p.tPeak;
      const t4 = p.tPeak + (p.tMax - p.tPeak) * 0.3;
      const t5 = p.tPeak + (p.tMax - p.tPeak) * 0.7;

      const u1 = computeGoldilocksUtility(t1, tier);
      const u2 = computeGoldilocksUtility(t2, tier);
      const u3 = computeGoldilocksUtility(t3, tier);
      const u4 = computeGoldilocksUtility(t4, tier);
      const u5 = computeGoldilocksUtility(t5, tier);

      // 上升段
      expect(u2).toBeGreaterThan(u1);
      expect(u3).toBeGreaterThan(u2);
      // 下降段
      expect(u4).toBeLessThan(u3);
      expect(u5).toBeLessThan(u4);
    });
  });

  // ── 3. proactiveCooldownForTier ────────────────────────────────────────

  describe("proactiveCooldownForTier", () => {
    it("与 DUNBAR_TIER_THETA 成比例", () => {
      for (const tier of TIERS) {
        expect(proactiveCooldownForTier(tier)).toBeCloseTo(ALPHA * DUNBAR_TIER_THETA[tier], 6);
      }
    });

    it("tier 越亲密冷却越短", () => {
      const cooldowns = TIERS.map((t) => proactiveCooldownForTier(t));
      for (let i = 1; i < cooldowns.length; i++) {
        expect(cooldowns[i]).toBeGreaterThan(cooldowns[i - 1]);
      }
    });
  });

  // ── 4. EMA 自适应：高频交互缩短 tMin ──────────────────────────────────

  describe("EMA 自适应", () => {
    it("高频交互者（ema << θ_c）的效用窗口提前打开", () => {
      const tier: DunbarTier = 50;
      const p = goldilocksParams(tier);
      // 无 EMA 时 tMin 处的效用
      const uNoEma = computeGoldilocksUtility(p.tMin * 0.7, tier);
      // 有高频 EMA（ema = θ_c * 0.1）时同一时间点的效用
      const uWithEma = computeGoldilocksUtility(p.tMin * 0.7, tier, p.tMax * 0.1);

      // 高频 EMA 应使窗口提前打开 → 同一时间点效用更高
      expect(uWithEma).toBeGreaterThan(uNoEma);
    });

    it("正常频率（ema ≈ θ_c）不改变窗口", () => {
      const tier: DunbarTier = 50;
      const p = goldilocksParams(tier);
      const uNoEma = computeGoldilocksUtility(p.tPeak, tier);
      const uNormalEma = computeGoldilocksUtility(p.tPeak, tier, p.tMax * 0.8);

      // ema/tMax = 0.8 > 0.5 → 不触发缩短
      expect(uNormalEma).toBeCloseTo(uNoEma, 2);
    });
  });

  // ── 5. σ² 不确定性加宽窗口 ────────────────────────────────────────────

  describe("σ² 不确定性", () => {
    it("高 σ² 加宽窗口（边界效用提升）", () => {
      const tier: DunbarTier = 50;
      const p = goldilocksParams(tier);
      // 在 tMin 处（正常情况效用 ≈ 0.135）
      const uNormal = computeGoldilocksUtility(p.tMin, tier);
      // 高 σ² 加宽窗口——tMin 处效用应提升（σ 变大，2σ 覆盖更宽）
      const uWide = computeGoldilocksUtility(p.tMin, tier, undefined, 0.6);

      expect(uWide).toBeGreaterThan(uNormal);
    });

    it("低 σ²（<= 0.3）不改变窗口", () => {
      const tier: DunbarTier = 50;
      const p = goldilocksParams(tier);
      const uNormal = computeGoldilocksUtility(p.tPeak, tier);
      const uLowSigma = computeGoldilocksUtility(p.tPeak, tier, undefined, 0.2);

      expect(uLowSigma).toBeCloseTo(uNormal, 6);
    });
  });

  // ── 6. Tier 间比较 ────────────────────────────────────────────────────

  describe("tier 间行为一致性", () => {
    it("所有 tier 的 tPeak 处效用接近 1.0", () => {
      for (const tier of TIERS) {
        const p = goldilocksParams(tier);
        expect(computeGoldilocksUtility(p.tPeak, tier)).toBeGreaterThan(0.98);
      }
    });

    it("亲密 tier 的窗口更早打开", () => {
      const p5 = goldilocksParams(5);
      const p500 = goldilocksParams(500);
      expect(p5.tMin).toBeLessThan(p500.tMin);
      expect(p5.tPeak).toBeLessThan(p500.tPeak);
    });
  });
});
