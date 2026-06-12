/**
 * D5 沉默四级谱 + CRISIS_OVERRIDE 测试 — computeVoINull 和 classifySilence 的边界条件。
 *
 * ADR-84: L5_SOCIAL_TABOO 已移除。论文 L5 是 Degraded Action（行动），
 * 不属于沉默谱。CRISIS_OVERRIDE 在 gate chain 中由 gateCrisisMode 处理。
 *
 * @see runtime/src/engine/silence.ts
 * @see paper-five-dim/ Definition 10: Silence Spectrum
 * @see paper-pomdp/ Def 5.3: Value of Information
 * @see docs/adr/84-theory-code-final-alignment.md
 */
import { describe, expect, it } from "vitest";
import { BeliefStore } from "../src/belief/store.js";
import { classifySilence, computeVoINull, type SilenceLevel } from "../src/engine/silence.js";

// -- 辅助：构建 BeliefStore --------------------------------------------------

/** 构建含指定实体 belief 的 store。 */
function makeBeliefs(
  entries: Array<{ entityId: string; attr: string; mu: number; sigma2: number; tObs: number }>,
): BeliefStore {
  const store = new BeliefStore();
  for (const e of entries) {
    store.set(e.entityId, e.attr, { mu: e.mu, sigma2: e.sigma2, tObs: e.tObs });
  }
  return store;
}

// ═══════════════════════════════════════════════════════════════════════════
// computeVoINull
// ═══════════════════════════════════════════════════════════════════════════

describe("computeVoINull", () => {
  it("无焦点实体 → VoI = 0", () => {
    const beliefs = new BeliefStore();
    const voi = computeVoINull([], beliefs, 100);
    expect(voi).toBe(0);
  });

  it("高不确定性 → VoI 高", () => {
    // sigma2 = 5.0（高不确定性）→ Kalman gain K = 5/(5+0.1) ≈ 0.98
    const beliefs = makeBeliefs([
      { entityId: "channel:a", attr: "tier", mu: 50, sigma2: 5.0, tObs: 90 },
      { entityId: "channel:a", attr: "mood", mu: 0, sigma2: 5.0, tObs: 90 },
    ]);
    const voi = computeVoINull(["channel:a"], beliefs, 100);
    // K_tier = 5/(5+0.1) ≈ 0.9804, K_mood same → sum ≈ 1.9608
    // result = (1.9608 / 1) * 0.05 ≈ 0.098
    expect(voi).toBeGreaterThan(0.09);
    expect(voi).toBeLessThan(0.11);
  });

  it("低不确定性 → VoI 低", () => {
    // sigma2 = 0.01（低不确定性）→ K = 0.01/(0.01+0.1) ≈ 0.091
    const beliefs = makeBeliefs([
      { entityId: "channel:a", attr: "tier", mu: 50, sigma2: 0.01, tObs: 99 },
      { entityId: "channel:a", attr: "mood", mu: 0, sigma2: 0.01, tObs: 99 },
    ]);
    const voi = computeVoINull(["channel:a"], beliefs, 100);
    // K_tier = 0.01/0.11 ≈ 0.0909, K_mood same → sum ≈ 0.1818
    // result = 0.1818 * 0.05 ≈ 0.009
    expect(voi).toBeGreaterThan(0.005);
    expect(voi).toBeLessThan(0.015);
  });

  it("高不确定性的 VoI > 低不确定性的 VoI", () => {
    const beliefsHigh = makeBeliefs([
      { entityId: "channel:a", attr: "tier", mu: 50, sigma2: 5.0, tObs: 90 },
      { entityId: "channel:a", attr: "mood", mu: 0, sigma2: 5.0, tObs: 90 },
    ]);
    const beliefsLow = makeBeliefs([
      { entityId: "channel:a", attr: "tier", mu: 50, sigma2: 0.01, tObs: 99 },
      { entityId: "channel:a", attr: "mood", mu: 0, sigma2: 0.01, tObs: 99 },
    ]);
    const voiHigh = computeVoINull(["channel:a"], beliefsHigh, 100);
    const voiLow = computeVoINull(["channel:a"], beliefsLow, 100);
    expect(voiHigh).toBeGreaterThan(voiLow);
  });

  it("多个焦点实体 → VoI 是每实体平均值（非简单累加）", () => {
    const beliefs = makeBeliefs([
      { entityId: "channel:a", attr: "tier", mu: 0, sigma2: 2.0, tObs: 0 },
      { entityId: "channel:a", attr: "mood", mu: 0, sigma2: 2.0, tObs: 0 },
      { entityId: "channel:b", attr: "tier", mu: 0, sigma2: 3.0, tObs: 0 },
      { entityId: "channel:b", attr: "mood", mu: 0, sigma2: 3.0, tObs: 0 },
    ]);
    const voiBoth = computeVoINull(["channel:a", "channel:b"], beliefs, 100);
    const voiA = computeVoINull(["channel:a"], beliefs, 100);
    const voiB = computeVoINull(["channel:b"], beliefs, 100);
    // 归一化到实体数量：voiBoth = mean(a, b) * scale
    // voiBoth 应介于 voiA 和 voiB 之间
    expect(voiBoth).toBeGreaterThanOrEqual(Math.min(voiA, voiB));
    expect(voiBoth).toBeLessThanOrEqual(Math.max(voiA, voiB));
  });

  it("实体不在 BeliefStore 中 → 使用默认高不确定性（sigma2 = 1.0）", () => {
    const beliefs = new BeliefStore(); // 空 store
    const voi = computeVoINull(["channel:unknown"], beliefs, 100);
    // getOrDefault 返回 sigma2 = 1.0
    // K = 1.0/(1.0+0.1) ≈ 0.909 for each → sum ≈ 1.818
    // result = 1.818 * 0.05 ≈ 0.091
    expect(voi).toBeGreaterThan(0.08);
    expect(voi).toBeLessThan(0.1);
  });

  it("sigma2Obs 参数影响 VoI 量级", () => {
    const beliefs = makeBeliefs([
      { entityId: "channel:a", attr: "tier", mu: 0, sigma2: 1.0, tObs: 0 },
      { entityId: "channel:a", attr: "mood", mu: 0, sigma2: 1.0, tObs: 0 },
    ]);
    // 低 sigma2Obs → K 更高 → VoI 更高（观测更精确，等一等更值得）
    const voiLowNoise = computeVoINull(["channel:a"], beliefs, 100, 0.01);
    const voiHighNoise = computeVoINull(["channel:a"], beliefs, 100, 1.0);
    expect(voiLowNoise).toBeGreaterThan(voiHighNoise);
  });

  it("sigma2 = 0 → VoI = 0（完全确定，无需观望）", () => {
    const beliefs = makeBeliefs([
      { entityId: "channel:a", attr: "tier", mu: 50, sigma2: 0, tObs: 100 },
      { entityId: "channel:a", attr: "mood", mu: 0, sigma2: 0, tObs: 100 },
    ]);
    const voi = computeVoINull(["channel:a"], beliefs, 100);
    expect(voi).toBe(0);
  });

  it("默认参数下 VoI 与 NSV 同量级（可真实触发 L4）", () => {
    // sigma2 = 1.0（默认不确定性）
    const beliefs = makeBeliefs([
      { entityId: "channel:a", attr: "tier", mu: 0, sigma2: 1.0, tObs: 0 },
      { entityId: "channel:a", attr: "mood", mu: 0, sigma2: 1.0, tObs: 0 },
    ]);
    const voi = computeVoINull(["channel:a"], beliefs, 100);
    // 与旧实现对比: sigma2*theta = 1.0*0.001 = 0.001（远小于 NSV）
    // 新实现: K = 1.0/1.1 ≈ 0.909 → sum ≈ 1.818 → result ≈ 0.091
    // 典型 NSV ≈ 0.01-0.1，VoI 终于在同一量级
    expect(voi).toBeGreaterThan(0.01);
    expect(voi).toBeLessThan(1.0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// classifySilence
// ═══════════════════════════════════════════════════════════════════════════

describe("classifySilence", () => {
  // ADR-84: isCrisis 参数已移除，crisis 由 gateCrisisMode 在 gate chain 中处理。

  it("VoI > bestNSV 且 bestNSV > 0 → L4 延迟", () => {
    const level = classifySilence(10.0, 0.1, 2.0, 5.0, false);
    expect(level).toBe("L4_DEFERRED");
  });

  it("VoI > bestNSV 但 bestNSV <= 0 → 不走 L4（因 bestNSV > 0 条件不满足）", () => {
    const level = classifySilence(10.0, 0.1, -1.0, 5.0, false);
    // bestNSV <= 0 → 走 L3
    expect(level).toBe("L3_STRATEGIC");
  });

  it("bestNSV <= 0 → L3 策略性", () => {
    const level = classifySilence(10.0, 0.1, 0, 0, false);
    expect(level).toBe("L3_STRATEGIC");
  });

  it("bestNSV = -0.5 → L3（负值也是 <= 0）", () => {
    const level = classifySilence(10.0, 0.1, -0.5, 0, false);
    expect(level).toBe("L3_STRATEGIC");
  });

  it("activeCooling 且 bestNSV > 0 → L2", () => {
    const level = classifySilence(10.0, 0.1, 3.0, 0, true);
    expect(level).toBe("L2_ACTIVE_COOLING");
  });

  it("默认 → L1（什么条件都不满足时兜底）", () => {
    const level = classifySilence(1.0, 5.0, 1.0, 0, false);
    expect(level).toBe("L1_LOW_PRESSURE");
  });

  // -- 优先级测试：L4 > L3 > L2 > L1 ----------------------------------

  it("优先级：L4 覆盖 L3（VoI 高 + bestNSV > 0 → L4 而非 L3）", () => {
    const level = classifySilence(10.0, 0.1, 0.5, 10.0, false);
    expect(level).toBe("L4_DEFERRED");
  });

  it("优先级：L4 覆盖 L2（VoI 高 + activeCooling → L4 而非 L2）", () => {
    const level = classifySilence(10.0, 0.1, 2.0, 10.0, true);
    expect(level).toBe("L4_DEFERRED");
  });

  it("优先级：L3 覆盖 L2（bestNSV <= 0 + activeCooling → L3 而非 L2）", () => {
    const level = classifySilence(10.0, 0.1, -1.0, 0, true);
    expect(level).toBe("L3_STRATEGIC");
  });

  // -- 边界精确值 -----------------------------------------------------------

  it("bestNSV 恰好等于 0 → L3（<= 0 边界）", () => {
    const level = classifySilence(10.0, 0.1, 0, 0, false);
    expect(level).toBe("L3_STRATEGIC");
  });

  it("voiNull 恰好等于 bestNSV 且 bestNSV > 0 → 不走 L4（> 而非 >=）", () => {
    const level = classifySilence(10.0, 0.1, 2.0, 2.0, false);
    expect(level).toBe("L1_LOW_PRESSURE");
  });

  // -- 输入参数（apiValue, effectiveFloor）当前未使用但签名保留 ----------------

  it("apiValue 和 effectiveFloor 不影响分类结果（当前实现未使用）", () => {
    const level1 = classifySilence(0, 0, 0, 0, false);
    const level2 = classifySilence(999, 999, 0, 0, false);
    expect(level1).toBe(level2);
  });

  // -- SilenceLevel 类型完整性 -----------------------------------------------

  it("返回值是合法的 SilenceLevel 字面量（四级谱 + CRISIS_OVERRIDE）", () => {
    // ADR-84: classifySilence 只返回四级谱，CRISIS_OVERRIDE 由 gateCrisisMode 返回
    const validLevels: SilenceLevel[] = [
      "L1_LOW_PRESSURE",
      "L2_ACTIVE_COOLING",
      "L3_STRATEGIC",
      "L4_DEFERRED",
      "CRISIS_OVERRIDE",
    ];

    // 构造 4 种场景覆盖 classifySilence 可返回的所有层级
    const scenarios: Array<[number, number, number, number, boolean]> = [
      [1, 1, 1, 0, false], // L1
      [1, 1, 1, 0, true], // L2
      [1, 1, 0, 0, false], // L3
      [1, 1, 1, 10, false], // L4
    ];

    const results = scenarios.map((args) => classifySilence(...args));

    // 每个结果都是合法层级
    for (const r of results) {
      expect(validLevels).toContain(r);
    }

    // classifySilence 覆盖了 4 个层级（CRISIS_OVERRIDE 由 gateCrisisMode 处理）
    const unique = new Set(results);
    expect(unique.size).toBe(4);
  });
});
