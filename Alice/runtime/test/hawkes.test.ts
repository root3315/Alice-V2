/**
 * Per-contact Hawkes 自激过程单元测试。
 *
 * @see docs/adr/153-per-contact-hawkes/README.md
 */
import { describe, expect, it } from "vitest";
import type { DunbarTier } from "../src/graph/entities.js";
import {
  computeHawkesLambdaDiscount,
  effectiveMu,
  getDefaultParams,
  HAWKES_GROUP_MODIFIERS,
  HAWKES_TIER_DEFAULTS,
  type HawkesState,
  initialState,
  MU_CALIBRATION_THRESHOLD,
  queryIntensity,
  updateOnEvent,
} from "../src/pressure/hawkes.js";

const EPS = 1e-10;

describe("hawkes", () => {
  // ── 1. queryIntensity 基础 ───────────────────────────────────────────────
  it("无事件时 λ = μ（纯基线）", () => {
    const params = HAWKES_TIER_DEFAULTS[50];
    const state = initialState();
    const result = queryIntensity(params, state, Date.now());

    expect(result.lambda).toBeCloseTo(params.mu, 10);
    expect(result.excitation).toBe(0);
    expect(result.normalizedHeat).toBe(0);
    expect(result.mu).toBe(params.mu);
  });

  // ── 2. updateOnEvent + query ────────────────────────────────────────────
  it("一次事件后 λ = μ + α", () => {
    const params = HAWKES_TIER_DEFAULTS[5];
    const t0 = 1_000_000;

    const state = updateOnEvent(params, initialState(), t0);
    // 紧接着查询（Δt = 0）
    const result = queryIntensity(params, state, t0);

    expect(result.lambda).toBeCloseTo(params.mu + params.alpha, 10);
    expect(result.excitation).toBeCloseTo(params.alpha, 10);
  });

  // ── 3. 衰减验证 ─────────────────────────────────────────────────────────
  it("半衰期后激发量减半", () => {
    const params = HAWKES_TIER_DEFAULTS[15];
    const halfLifeS = Math.LN2 / params.beta;
    const t0 = 1_000_000;

    const state = updateOnEvent(params, initialState(), t0);
    const tHalf = t0 + halfLifeS * 1000; // 一个半衰期后

    const result = queryIntensity(params, state, tHalf);
    // excitation 应约为 alpha / 2
    expect(result.excitation).toBeCloseTo(params.alpha / 2, 6);
  });

  // ── 4. 递归一致性 — N 次事件递归 vs 暴力枚举 ────────────────────────────
  it("递归更新与暴力求和一致（相对误差 < 1e-10）", () => {
    const params = HAWKES_TIER_DEFAULTS[5];
    const N = 20;
    const t0 = 1_000_000;
    const interval = 30_000; // 30 秒间隔

    // 递归方式
    let state: HawkesState = initialState();
    const eventTimes: number[] = [];
    for (let i = 0; i < N; i++) {
      const t = t0 + i * interval;
      eventTimes.push(t);
      state = updateOnEvent(params, state, t);
    }

    const tQuery = t0 + N * interval; // 最后一次事件后再等一个 interval
    const recursive = queryIntensity(params, state, tQuery);

    // 暴力求和方式
    const dtQueryS = (tQuery - eventTimes[eventTimes.length - 1]) / 1000;
    let bruteForceExcitation = 0;
    for (const te of eventTimes) {
      const age = (tQuery - te) / 1000;
      bruteForceExcitation += params.alpha * Math.exp(-params.beta * age);
    }
    const bruteForce = params.mu + bruteForceExcitation;

    // 允许极小浮点误差
    const relError = Math.abs(recursive.lambda - bruteForce) / Math.max(bruteForce, EPS);
    expect(relError).toBeLessThan(1e-10);
  });

  // ── 5. 分枝比安全 — 所有 tier 的 α/β < 1 ──────────────────────────────
  it("所有 tier 的分枝比 α/β < 1（含群组修正）", () => {
    const tiers: DunbarTier[] = [5, 15, 50, 150, 500];

    for (const tier of tiers) {
      // 私聊
      const priv = getDefaultParams(tier, false);
      const privRatio = priv.alpha / priv.beta;
      expect(privRatio).toBeLessThan(1);
      expect(privRatio).toBeGreaterThan(0);

      // 群组
      const group = getDefaultParams(tier, true);
      const groupRatio = group.alpha / group.beta;
      expect(groupRatio).toBeLessThan(1);
      expect(groupRatio).toBeGreaterThan(0);
      // 群组分枝比应小于私聊（αDiscount=0.3, βMultiplier=1.5 → ratio × 0.2）
      expect(groupRatio).toBeLessThan(privRatio);
    }
  });

  // ── 6. getDefaultParams — 私聊 vs 群组参数差异 ──────────────────────────
  it("群组参数: α 更小, β 更大, μ 不变", () => {
    const tier: DunbarTier = 50;
    const priv = getDefaultParams(tier, false);
    const group = getDefaultParams(tier, true);

    // μ 不变
    expect(group.mu).toBe(priv.mu);
    // α 乘以 alphaDiscount
    expect(group.alpha).toBeCloseTo(priv.alpha * HAWKES_GROUP_MODIFIERS.alphaDiscount, 10);
    // β 乘以 betaMultiplier
    expect(group.beta).toBeCloseTo(priv.beta * HAWKES_GROUP_MODIFIERS.betaMultiplier, 10);
  });

  // ── 7. computeHawkesLambdaDiscount — normalizedHeat 映射 ───────────────
  it("discount ∈ [0.7, 1.0]，heat=0 → 1.0，heat=1 → 0.7", () => {
    // 零热度 → 无折扣
    expect(
      computeHawkesLambdaDiscount({
        lambda: 0.001,
        mu: 0.001,
        excitation: 0,
        normalizedHeat: 0,
      }),
    ).toBe(1.0);

    // 满热度 → 最大折扣
    expect(
      computeHawkesLambdaDiscount({
        lambda: 0.01,
        mu: 0.001,
        excitation: 0.009,
        normalizedHeat: 1.0,
      }),
    ).toBeCloseTo(0.7, 10);

    // 半热度 → 中间折扣
    expect(
      computeHawkesLambdaDiscount({
        lambda: 0.005,
        mu: 0.001,
        excitation: 0.004,
        normalizedHeat: 0.5,
      }),
    ).toBeCloseTo(0.85, 10);
  });

  // ── 8. 冷启动 — lastEventMs=0 退化为基线 ──────────────────────────────
  it("冷启动: lastEventMs=0 退化为纯基线 μ", () => {
    const params = HAWKES_TIER_DEFAULTS[150];

    // lambdaCarry > 0 但 lastEventMs = 0 → 冷启动保护
    const state: HawkesState = { lambdaCarry: 999, lastEventMs: 0 };
    const result = queryIntensity(params, state, Date.now());

    expect(result.lambda).toBe(params.mu);
    expect(result.excitation).toBe(0);
    expect(result.normalizedHeat).toBe(0);
  });

  // ── 9. 群组仅 directed — 非 directed 不应更新群组 Hawkes（集成逻辑） ──
  // 这个测试验证的是 getDefaultParams 的群组参数语义正确性，
  // mapper.ts 中的过滤逻辑由 mapper.test.ts 覆盖。
  it("群组参数分枝比低于私聊（反映 directed-only 过滤的保守设计）", () => {
    for (const tier of [5, 15, 50, 150, 500] as DunbarTier[]) {
      const privRatio = HAWKES_TIER_DEFAULTS[tier].alpha / HAWKES_TIER_DEFAULTS[tier].beta;
      const group = getDefaultParams(tier, true);
      const groupRatio = group.alpha / group.beta;
      // 群组分枝比 = 私聊分枝比 × alphaDiscount / betaMultiplier
      const expected =
        (privRatio * HAWKES_GROUP_MODIFIERS.alphaDiscount) / HAWKES_GROUP_MODIFIERS.betaMultiplier;
      expect(groupRatio).toBeCloseTo(expected, 10);
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Phase 2: effectiveMu — 在线校准 + 昼夜调制
  // @see docs/adr/153-per-contact-hawkes/README.md §8
  // @see simulation/experiments/exp_hawkes_phase2_validation.py 验证 4/5
  // ═══════════════════════════════════════════════════════════════════════════

  // ── 10. effectiveMu 在线校准 — 充分事件后收敛到观测率 ──────────────────
  it("effectiveMu: 充分观测后 μ 收敛到观测率", () => {
    const tierMu = HAWKES_TIER_DEFAULTS[50].mu; // ~9.3e-5
    const firstEventMs = 1_000_000; // 正时间戳（避免冷启动守卫 firstEventMs > 0）
    const nowMs = firstEventMs + 3600_000; // 1 小时后
    const eventCount = 100; // >> MU_CALIBRATION_THRESHOLD

    const durationS = (nowMs - firstEventMs) / 1000;
    const observedMu = eventCount / durationS; // 100 / 3600 ≈ 0.0278
    const mu = effectiveMu(tierMu, eventCount, firstEventMs, nowMs);

    // w = min(1, 100/30) = 1 → 完全信任观测值
    expect(mu).toBeCloseTo(observedMu, 6);
  });

  // ── 11. effectiveMu 在线校准 — 少事件时偏向先验 ───────────────────────
  it("effectiveMu: 事件不足时偏向 tier 先验", () => {
    const tierMu = HAWKES_TIER_DEFAULTS[5].mu; // 5.6e-4
    const firstEventMs = 1_000_000;
    const nowMs = firstEventMs + 600_000; // 10 分钟后
    const eventCount = 5; // < MU_CALIBRATION_THRESHOLD

    const durationS = (nowMs - firstEventMs) / 1000;
    const w = eventCount / MU_CALIBRATION_THRESHOLD; // 5/30 ≈ 0.167
    const observedMu = eventCount / durationS; // 5/600 ≈ 0.00833
    const expected = tierMu * (1 - w) + observedMu * w;
    const mu = effectiveMu(tierMu, eventCount, firstEventMs, nowMs);

    expect(mu).toBeCloseTo(expected, 10);
    // 应比纯观测值更靠近 tier 先验
    expect(Math.abs(mu - tierMu)).toBeLessThan(Math.abs(observedMu - tierMu));
  });

  // ── 12. effectiveMu 冷启动 — 无观测数据回退到 tier μ ──────────────────
  it("effectiveMu: 冷启动（无事件/短持续期）退化为 tierMu", () => {
    const tierMu = HAWKES_TIER_DEFAULTS[150].mu;

    // 无事件
    expect(effectiveMu(tierMu)).toBe(tierMu);
    expect(effectiveMu(tierMu, 0)).toBe(tierMu);
    expect(effectiveMu(tierMu, undefined, undefined, undefined)).toBe(tierMu);

    // 持续期 < 60s → 跳过校准
    expect(effectiveMu(tierMu, 10, 0, 30_000)).toBe(tierMu);
  });

  // ── 13. effectiveMu 昼夜调制 — circadianFactor 缩放 μ ─────────────────
  it("effectiveMu: 昼夜调制按 factor/1.5 缩放", () => {
    const tierMu = HAWKES_TIER_DEFAULTS[50].mu;

    // 峰值时段: factor = 0.5 → μ × 0.5/1.5 = μ/3
    const muPeak = effectiveMu(tierMu, undefined, undefined, undefined, 0.5);
    expect(muPeak).toBeCloseTo(tierMu * (0.5 / 1.5), 10);

    // 低谷时段: factor = 2.5 → μ × 2.5/1.5 = μ × 5/3
    const muTrough = effectiveMu(tierMu, undefined, undefined, undefined, 2.5);
    expect(muTrough).toBeCloseTo(tierMu * (2.5 / 1.5), 10);

    // 均值: factor = 1.5 → μ × 1.0 = μ
    const muMean = effectiveMu(tierMu, undefined, undefined, undefined, 1.5);
    expect(muMean).toBeCloseTo(tierMu, 10);

    // 动态范围: 峰谷比 = 5
    expect(muTrough / muPeak).toBeCloseTo(5, 6);
  });

  // ── 14. effectiveMu 组合 — 校准 + 昼夜同时生效 ────────────────────────
  it("effectiveMu: 在线校准与昼夜调制可组合", () => {
    const tierMu = HAWKES_TIER_DEFAULTS[50].mu;
    const firstEventMs = 1_000_000;
    const nowMs = firstEventMs + 3600_000; // 1 小时后
    const eventCount = 60; // w = min(1, 60/30) = 1
    const circadianFactor = 2.0;

    const durationS = (nowMs - firstEventMs) / 1000;
    const observedMu = eventCount / durationS;
    // w=1 → μ = observedMu，然后乘以 circadian/1.5
    const expected = observedMu * (circadianFactor / 1.5);
    const mu = effectiveMu(tierMu, eventCount, firstEventMs, nowMs, circadianFactor);

    expect(mu).toBeCloseTo(expected, 6);
  });
});
