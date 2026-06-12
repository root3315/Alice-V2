/**
 * 焦点集计算单元测试 (ADR-26 §2, ADR-181)。
 *
 * 测试覆盖:
 * - R_v 相关函数正确性
 * - K 计算: focalSetSize
 * - 焦点集排序、primaryTarget、meanRelevance
 * - R_Caution 基于熵 + 风险信号
 * - normalizedEntropy 正确性
 * - 空 tensionMap 退化
 */
import { describe, expect, it } from "vitest";
import type { TensionVector } from "../src/graph/tension.js";
import { WorldModel } from "../src/graph/world-model.js";
import {
  computeFocalSets,
  focalSetSize,
  normalizedEntropy,
  rCaution,
  rCuriosity,
  rDiligence,
  rSociability,
} from "../src/voices/focus.js";

/** 测试用 tick→ms 转换（约定：1 tick = 60s）。 */
function tickMs(tick: number): number {
  return tick * 60_000;
}

// -- 辅助 -------------------------------------------------------------------

function makeTension(partial: Partial<TensionVector> = {}): TensionVector {
  return {
    tau1: 0,
    tau2: 0,
    tau3: 0,
    tau4: 0,
    tau5: 0,
    tau6: 0,
    tauP: 0,
    tauRisk: 0,
    tauAttraction: 0,
    tauSpike: 0,
    ...partial,
  };
}

function makeTensionMap(entries: [string, Partial<TensionVector>][]): Map<string, TensionVector> {
  const map = new Map<string, TensionVector>();
  for (const [id, partial] of entries) {
    map.set(id, makeTension(partial));
  }
  return map;
}

// -- R_v 函数 ----------------------------------------------------------------

describe("R_v 相关函数 (ADR-181: 加权均值)", () => {
  it("R_Diligence = WeightedMean([τ₁,τ₄,τ₅,τ_P], [1.0,0.7,1.0,0.5])", () => {
    const t = makeTension({ tau1: 10, tau4: 5, tau5: 3, tauP: 2 });
    // (1.0×10 + 0.7×5 + 1.0×3 + 0.5×2) / (1.0+0.7+1.0+0.5) = 17.5/3.2 ≈ 5.469
    expect(rDiligence(t)).toBeCloseTo(17.5 / 3.2, 2);
  });

  it("R_Curiosity = WeightedMean([τ₂,τ₆], [0.8,1.0])", () => {
    const t = makeTension({ tau2: 7, tau6: 3 });
    // (0.8×7 + 1.0×3) / (0.8+1.0) = 8.6/1.8 ≈ 4.778
    expect(rCuriosity(t)).toBeCloseTo(8.6 / 1.8, 2);
  });

  it("R_Sociability = WeightedMean([τ₃,τ₅], [1.0,0.6])", () => {
    const t = makeTension({ tau3: 15 });
    // (1.0×15 + 0.6×0) / (1.0+0.6) = 15/1.6 ≈ 9.375
    expect(rSociability(t)).toBeCloseTo(15 / 1.6, 2);
  });

  it("R_Sociability 含 τ₅ 分量", () => {
    const t = makeTension({ tau3: 10, tau5: 5 });
    // (1.0×10 + 0.6×5) / 1.6 = 13/1.6 ≈ 8.125
    expect(rSociability(t)).toBeCloseTo(13 / 1.6, 2);
  });

  it("零张力 → 所有 R_v = 0", () => {
    const t = makeTension();
    expect(rDiligence(t)).toBe(0);
    expect(rCuriosity(t)).toBe(0);
    expect(rSociability(t)).toBe(0);
  });
});

// -- normalizedEntropy -------------------------------------------------------

describe("normalizedEntropy", () => {
  it("零张力 → 熵 = 0", () => {
    expect(normalizedEntropy(makeTension())).toBe(0);
  });

  it("单维度非零 → 熵 = 0（目标完全集中）", () => {
    expect(normalizedEntropy(makeTension({ tau1: 5 }))).toBeCloseTo(0, 10);
  });

  it("所有维度相等 → 熵 ≈ 1（最大冲突）", () => {
    const t = makeTension({ tau1: 1, tau2: 1, tau3: 1, tau4: 1, tau5: 1, tau6: 1, tauP: 1 });
    expect(normalizedEntropy(t)).toBeCloseTo(1.0, 2);
  });

  it("两维度相等 → 熵 > 0 但 < 1", () => {
    const t = makeTension({ tau1: 5, tau3: 5 });
    const H = normalizedEntropy(t);
    expect(H).toBeGreaterThan(0);
    expect(H).toBeLessThan(1);
  });

  it("负值取绝对值", () => {
    const t1 = makeTension({ tau1: -3, tau2: 3 });
    const t2 = makeTension({ tau1: 3, tau2: 3 });
    expect(normalizedEntropy(t1)).toBeCloseTo(normalizedEntropy(t2), 10);
  });
});

// -- R_Caution (ADR-181: 熵公式) --------------------------------------------

describe("R_Caution (ADR-181 熵公式)", () => {
  it("零张力 → 零输出（乘法 uncertainty 不产生虚假保底）", () => {
    // 审计修复: 从 additive → multiplicative。zero signal × (1+u) = 0。
    expect(rCaution(makeTension(), 0.5)).toBeCloseTo(0, 10);
  });

  it("单维度张力 → 低 H → 低 caution（仅 risk 通道）", () => {
    // 单维度 → H≈0 → α_c·H·norm ≈ 0, signal ≈ 0
    const t = makeTension({ tau1: 5 });
    const result = rCaution(t, 0.3);
    expect(result).toBeCloseTo(0, 1); // H=0 → signal≈0 → 0 × (1+0.3) ≈ 0
  });

  it("多维度分散 → 高 H → 高 caution", () => {
    const t = makeTension({ tau1: 3, tau2: 3, tau3: 3, tau4: 3, tau5: 3, tau6: 3, tauP: 3 });
    const result = rCaution(t, 0);
    // H ≈ 1, norm = tanh(‖τ‖/10) > 0 → α_c·1·norm > 0
    expect(result).toBeGreaterThan(0.3);
  });

  it("tauRisk 高 → caution 高", () => {
    const t = makeTension({ tauRisk: 0.6 });
    const result = rCaution(t, 0);
    // α_r=0.8 × 0.6 = 0.48
    expect(result).toBeCloseTo(0.48, 2);
  });

  it("高冲突 + 高风险 + uncertainty 叠加", () => {
    const t = makeTension({ tau1: 3, tau3: 3, tau5: 3, tauRisk: 0.5 });
    const result = rCaution(t, 0.5);
    // signal = α_c·H·norm + α_r·risk = 0.7*H*norm + 0.4 ≈ 0.588
    // result = signal × (1+0.5) ≈ 0.882
    expect(result).toBeGreaterThan(0.5);
  });

  it("零风险 + 零 uncertainty → 纯冲突信号", () => {
    const t = makeTension({ tau1: 5, tau3: 5, tau5: 5 });
    const result = rCaution(t, 0);
    expect(result).toBeGreaterThan(0);
  });
});

// -- focalSetSize ------------------------------------------------------------

describe("focalSetSize", () => {
  it("0 实体 → 0", () => {
    expect(focalSetSize(0)).toBe(0);
  });

  it("1 实体 → 2 (下界)", () => {
    expect(focalSetSize(1)).toBe(2);
  });

  it("3 实体 → 2", () => {
    expect(focalSetSize(3)).toBe(2);
  });

  it("6 实体 → 2", () => {
    expect(focalSetSize(6)).toBe(2);
  });

  it("9 实体 → 3", () => {
    expect(focalSetSize(9)).toBe(3);
  });

  it("15 实体 → 5 (上界)", () => {
    expect(focalSetSize(15)).toBe(5);
  });

  it("100 实体 → 5 (上界 capped)", () => {
    expect(focalSetSize(100)).toBe(5);
  });
});

// -- computeFocalSets --------------------------------------------------------

describe("computeFocalSets", () => {
  it("空 tensionMap → 空焦点集", () => {
    const G = new WorldModel();
    G.tick = 100;
    const tensionMap = new Map<string, TensionVector>();
    const result = computeFocalSets(tensionMap, G, 100, { nowMs: tickMs(100) });

    for (const voice of ["diligence", "curiosity", "sociability", "caution"] as const) {
      expect(result[voice].entities).toHaveLength(0);
      expect(result[voice].primaryTarget).toBeNull();
      expect(result[voice].meanRelevance).toBe(0);
    }
  });

  it("单实体 → 该实体成为所有声部的 primaryTarget", () => {
    const G = new WorldModel();
    G.tick = 100;
    G.addChannel("e1", { chat_type: "private" });
    const tensionMap = makeTensionMap([["e1", { tau1: 5, tau2: 3, tau3: 2 }]]);
    const result = computeFocalSets(tensionMap, G, 100, { uncertainty: 0, nowMs: tickMs(100) });

    for (const voice of ["diligence", "curiosity", "sociability", "caution"] as const) {
      expect(result[voice].primaryTarget).toBe("e1");
      expect(result[voice].entities).toContain("e1");
    }
  });

  it("targetWhitelist 只保留白名单实体参与焦点竞争", () => {
    const G = new WorldModel();
    G.tick = 100;
    G.addChannel("e1", { chat_type: "private" });
    G.addChannel("e2", { chat_type: "private" });
    const tensionMap = makeTensionMap([
      ["e1", { tau1: 20, tau2: 20, tau3: 20, tau5: 20 }],
      ["e2", { tau1: 5, tau2: 5, tau3: 5, tau5: 5 }],
    ]);

    const result = computeFocalSets(tensionMap, G, 100, {
      uncertainty: 0,
      nowMs: tickMs(100),
      targetWhitelist: new Set(["e2"]),
    });

    for (const voice of ["diligence", "curiosity", "sociability"] as const) {
      expect(result[voice].primaryTarget).toBe("e2");
      expect(result[voice].entities).toEqual(["e2"]);
    }
  });

  it("targetWhitelist 过滤掉全部实体时返回空焦点集", () => {
    const G = new WorldModel();
    G.tick = 100;
    G.addChannel("e1", { chat_type: "private" });
    const tensionMap = makeTensionMap([["e1", { tau1: 5, tau3: 3 }]]);

    const result = computeFocalSets(tensionMap, G, 100, {
      uncertainty: 0,
      nowMs: tickMs(100),
      targetWhitelist: new Set(["e404"]),
    });

    for (const voice of ["diligence", "curiosity", "sociability", "caution"] as const) {
      expect(result[voice].entities).toEqual([]);
      expect(result[voice].primaryTarget).toBeNull();
      expect(result[voice].meanRelevance).toBe(0);
    }
  });

  it("top-K 按 R_v 降序排列", () => {
    const G = new WorldModel();
    G.tick = 100;
    G.addChannel("e1", { chat_type: "private" });
    G.addChannel("e2", { chat_type: "private" });
    G.addChannel("e3", { chat_type: "private" });
    // R_Diligence (加权均值): e1 最高, e2 最低, e3 中间
    const tensionMap = makeTensionMap([
      ["e1", { tau1: 10, tau4: 10, tau5: 10 }],
      ["e2", { tau1: 5, tau4: 3, tau5: 2 }],
      ["e3", { tau1: 8, tau4: 7, tau5: 5 }],
    ]);
    const result = computeFocalSets(tensionMap, G, 100, { uncertainty: 0, nowMs: tickMs(100) });
    // K = max(2, min(5, ceil(3/3))) = 2 → top-2
    expect(result.diligence.entities).toHaveLength(2);
    expect(result.diligence.entities[0]).toBe("e1"); // 最高
    expect(result.diligence.entities[1]).toBe("e3"); // 第二
    expect(result.diligence.primaryTarget).toBe("e1");
  });

  it("meanRelevance = mean(top-K R_v)", () => {
    const G = new WorldModel();
    G.tick = 100;
    G.addChannel("e1", { chat_type: "private" });
    G.addChannel("e2", { chat_type: "private" });
    G.addChannel("e3", { chat_type: "private" });
    // R_Sociability: e1=10, e2=20, e3=30
    const tensionMap = makeTensionMap([
      ["e1", { tau3: 10 }],
      ["e2", { tau3: 20 }],
      ["e3", { tau3: 30 }],
    ]);
    const result = computeFocalSets(tensionMap, G, 100, { uncertainty: 0, nowMs: tickMs(100) });
    // K=2, top-2: e3(WM([30,0])=18.75), e2(WM([20,0])=12.5), mean = 15.625
    expect(result.sociability.meanRelevance).toBeCloseTo((30 / 1.6 + 20 / 1.6) / 2, 10);
  });

  it("ADR-181: R_Caution 使用张力熵 + tauRisk", () => {
    const G = new WorldModel();
    G.tick = 100;
    G.addChannel("e1", { chat_type: "private" });
    G.addChannel("e2", { chat_type: "private" });
    // e1: 高 tauRisk → 高 R_Caution
    // e2: 无信号 → 低 R_Caution
    const tensionMap = makeTensionMap([
      ["e1", { tauRisk: 0.6 }],
      ["e2", {}],
    ]);
    const result = computeFocalSets(tensionMap, G, 100, { uncertainty: 0, nowMs: tickMs(100) });
    // e1: α_r(0.8) × 0.6 = 0.48 > 0
    // e2: R_Caution = 0 → 过滤排除（或 fallback）
    expect(result.caution.primaryTarget).toBe("e1");
    expect(result.caution.meanRelevance).toBeGreaterThan(0.4);
  });

  it("H2: reaction_boost_ms 提升 R_Sociability", () => {
    const G = new WorldModel();
    G.tick = 100;
    G.addContact("c1", { reaction_boost_ms: tickMs(100) });
    G.addContact("c2"); // 无 reaction
    const tensionMap = makeTensionMap([
      ["c1", { tau3: 5 }],
      ["c2", { tau3: 5 }],
    ]);
    const result = computeFocalSets(tensionMap, G, 100, { uncertainty: 0, nowMs: tickMs(100) });
    // c1 有 reaction: base=5/1.6≈3.125, boost=0.5/(1+0/300)=0.5 → total≈3.625
    // c2 无 reaction: total=5/1.6≈3.125
    expect(result.sociability.primaryTarget).toBe("c1");
    expect(result.sociability.meanRelevance).toBeCloseTo((5 / 1.6 + 0.5 + 5 / 1.6) / 2, 10);
  });

  it("H2: reaction boost 随时间衰减", () => {
    const G = new WorldModel();
    G.tick = 100;
    G.addContact("c1", { reaction_boost_ms: tickMs(90) }); // ageS=600
    const tensionMap = makeTensionMap([["c1", { tau3: 5 }]]);
    const result = computeFocalSets(tensionMap, G, 100, { uncertainty: 0, nowMs: tickMs(100) });
    // boost = 0.5 / (1 + 600/300) = 0.5 / 3 ≈ 0.167
    expect(result.sociability.meanRelevance).toBeCloseTo(5 / 1.6 + 0.5 / 3, 2);
  });

  it("M2: returning_ms 显著提升 R_Sociability", () => {
    const G = new WorldModel();
    G.tick = 100;
    G.addContact("c1", { returning_ms: tickMs(100) });
    G.addContact("c2"); // 无 returning
    const tensionMap = makeTensionMap([
      ["c1", { tau3: 3 }],
      ["c2", { tau3: 3 }],
    ]);
    const result = computeFocalSets(tensionMap, G, 100, { uncertainty: 0, nowMs: tickMs(100) });
    // c1: base=3/1.6≈1.875, returning boost=2.0/(1+0/600)=2.0 → total≈3.875
    // c2: total=3/1.6≈1.875
    expect(result.sociability.primaryTarget).toBe("c1");
    expect(result.sociability.meanRelevance).toBeCloseTo((3 / 1.6 + 2.0 + 3 / 1.6) / 2, 10);
  });

  it("M2: returning boost 随时间衰减", () => {
    const G = new WorldModel();
    G.tick = 100;
    G.addContact("c1", { returning_ms: tickMs(90) }); // ageS=600
    const tensionMap = makeTensionMap([["c1", { tau3: 3 }]]);
    const result = computeFocalSets(tensionMap, G, 100, { uncertainty: 0, nowMs: tickMs(100) });
    // boost = 2.0 / (1 + 600/600) = 2.0 / 2 = 1.0
    expect(result.sociability.meanRelevance).toBeCloseTo(3 / 1.6 + 1.0, 10);
  });

  it("S12: recently_cleared_ms 抑制 R_Diligence", () => {
    const G = new WorldModel();
    G.tick = 100;
    G.addChannel("ch1", { chat_type: "private", recently_cleared_ms: tickMs(100) }); // 刚清除
    const tensionMap = makeTensionMap([["ch1", { tau1: 10, tau4: 5, tau5: 3, tauP: 2 }]]);
    const result = computeFocalSets(tensionMap, G, 100, { uncertainty: 0, nowMs: tickMs(100) });
    // ageS=0, damping=0/180=0 → R_Diligence≈5.47*0=0
    expect(result.diligence.meanRelevance).toBeCloseTo(0, 10);
  });

  it("S12: recently_cleared 3 ticks 后抑制消失", () => {
    const G = new WorldModel();
    G.tick = 100;
    G.addChannel("ch1", { chat_type: "private", recently_cleared_ms: tickMs(97) }); // ageS=180
    const tensionMap = makeTensionMap([["ch1", { tau1: 10, tau4: 5, tau5: 3, tauP: 2 }]]);
    const result = computeFocalSets(tensionMap, G, 100, { uncertainty: 0, nowMs: tickMs(100) });
    // ageS=180, damping=min(1.0, 180/180)=1.0 → R_Diligence=17.5/3.2*1.0≈5.47
    expect(result.diligence.meanRelevance).toBeCloseTo(17.5 / 3.2, 10);
  });

  it("uncertainty 放大有信号实体的 R_Caution", () => {
    const G = new WorldModel();
    G.tick = 100;
    G.addChannel("e1", { chat_type: "private" });
    // 多维度张力 → 非零 signal → uncertainty 乘法放大
    const tensionMap = makeTensionMap([["e1", { tau1: 3, tau3: 3, tau5: 3 }]]);

    const low = computeFocalSets(tensionMap, G, 100, { uncertainty: 0, nowMs: tickMs(100) });
    const high = computeFocalSets(tensionMap, G, 100, { uncertainty: 1.0, nowMs: tickMs(100) });
    expect(high.caution.meanRelevance).toBeGreaterThan(low.caution.meanRelevance);
  });
});
