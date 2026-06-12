/**
 * Circadian 调制器测试。
 *
 * circadianMultiplier(hour, timezoneOffset, userPeakHour) 返回 API 门控乘数：
 *   peakHour → 0.5 (最活跃)
 *   peakHour ± 12h → 2.5 (最安静)
 *   过渡平滑
 *
 * ADR-47 G5: userPeakHour 参数使峰值可学习。
 */
import { describe, expect, it } from "vitest";
import { circadianMultiplier } from "../src/engine/evolve.js";

describe("circadianMultiplier", () => {
  it("14:00 最活跃 — 乘数最低（默认峰值）", () => {
    expect(circadianMultiplier(14)).toBeCloseTo(0.5, 1);
  });

  it("02:00 最安静 — 乘数最高（默认峰值）", () => {
    expect(circadianMultiplier(2)).toBeCloseTo(2.5, 1);
  });

  it("08:00 和 20:00 — 对称中间值", () => {
    const m8 = circadianMultiplier(8);
    const m20 = circadianMultiplier(20);
    // 两者应该相同（cos 对称性）
    expect(m8).toBeCloseTo(m20, 1);
    // 值在 baseLine 附近
    expect(m8).toBeCloseTo(1.5, 0);
  });

  it("相邻小时平滑过渡（差值 < 0.35）", () => {
    for (let h = 0; h < 24; h++) {
      const next = (h + 1) % 24;
      const diff = Math.abs(circadianMultiplier(next) - circadianMultiplier(h));
      expect(diff).toBeLessThan(0.35);
    }
  });

  it("所有小时值在 [0.5, 2.5] 范围内", () => {
    for (let h = 0; h < 24; h++) {
      const m = circadianMultiplier(h);
      expect(m).toBeGreaterThanOrEqual(0.5 - 0.01);
      expect(m).toBeLessThanOrEqual(2.5 + 0.01);
    }
  });

  // ADR-47 G5: 学习型节律 — userPeakHour 参数测试
  describe("G5: userPeakHour 学习型节律", () => {
    it("userPeakHour=20 → 20:00 最活跃（乘数最低 0.5）", () => {
      expect(circadianMultiplier(20, 0, 20)).toBeCloseTo(0.5, 1);
    });

    it("userPeakHour=20 → 08:00 最安静（乘数最高 2.5）", () => {
      expect(circadianMultiplier(8, 0, 20)).toBeCloseTo(2.5, 1);
    });

    it("userPeakHour=0 → 00:00 最活跃，12:00 最安静", () => {
      expect(circadianMultiplier(0, 0, 0)).toBeCloseTo(0.5, 1);
      expect(circadianMultiplier(12, 0, 0)).toBeCloseTo(2.5, 1);
    });

    it("不传 userPeakHour 时保持默认行为（14:00 峰值）", () => {
      // 显式 undefined 等同于不传
      expect(circadianMultiplier(14, 0, undefined)).toBeCloseTo(0.5, 1);
      expect(circadianMultiplier(2, 0, undefined)).toBeCloseTo(2.5, 1);
    });

    it("userPeakHour 与 timezoneOffset 组合正确", () => {
      // UTC 10:00 + offset +8 = 本地 18:00, peakHour=18 → 最活跃
      expect(circadianMultiplier(10, 8, 18)).toBeCloseTo(0.5, 1);
    });

    it("userPeakHour 时 [0.5, 2.5] 范围不变", () => {
      for (let h = 0; h < 24; h++) {
        const m = circadianMultiplier(h, 0, 20);
        expect(m).toBeGreaterThanOrEqual(0.5 - 0.01);
        expect(m).toBeLessThanOrEqual(2.5 + 0.01);
      }
    });
  });
});
