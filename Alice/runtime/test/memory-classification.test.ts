/**
 * 连续稳定性频谱测试。
 *
 * 验证 fact_type → 初始稳定性 S₀ 映射的正确性，
 * 以及统一 SM-2 遗忘曲线在 P2 中对不同 fact_type 的差异化效果。
 *
 * 取代原二值 semantic/episodic 分类测试。
 * @see docs/adr/151-algorithm-audit/research-online-calibration.md
 */
import { describe, expect, it } from "vitest";
import {
  FACT_TYPE_INITIAL_STABILITY,
  factTypeInitialStability,
  STABILITY_REINFORCE_FACTOR,
} from "../src/graph/constants.js";
import { WorldModel } from "../src/graph/world-model.js";
import { p2InformationPressure } from "../src/pressure/p2-information.js";

/** 将 tick 转为毫秒（测试用约定：1 tick = 60s）。 */
const tickMs = (tick: number) => tick * 60_000;

/** 天 → 毫秒。 */
const dayMs = (days: number) => days * 86_400_000;

/** 基准"当前时间"（1 年后的 epoch，足够大以支持 dayMs 回溯）。 */
const BASE_NOW = dayMs(365);

// -- factTypeInitialStability 映射 --------------------------------------------

describe("factTypeInitialStability 映射", () => {
  it("preference → 20（~1.5年半衰期）", () => {
    expect(factTypeInitialStability("preference")).toBe(20);
  });
  it("skill → 20（~1.5年半衰期）", () => {
    expect(factTypeInitialStability("skill")).toBe(20);
  });
  it("general → 14（~1年半衰期）", () => {
    expect(factTypeInitialStability("general")).toBe(14);
  });
  it("interest → 7（~6月半衰期）", () => {
    expect(factTypeInitialStability("interest")).toBe(7);
  });
  it("growth → 3（~2.7月半衰期）", () => {
    expect(factTypeInitialStability("growth")).toBe(3);
  });
  it("observation → 1（~27天半衰期）", () => {
    expect(factTypeInitialStability("observation")).toBe(1);
  });
  it("undefined → general（S=14）", () => {
    expect(factTypeInitialStability(undefined)).toBe(14);
  });
  it("未知 fact_type → DEFAULT_STABILITY（S=1，安全侧）", () => {
    expect(factTypeInitialStability("unknown_type")).toBe(1);
  });
  it("FACT_TYPE_INITIAL_STABILITY 覆盖所有 6 种 fact_type", () => {
    const types = ["interest", "preference", "skill", "growth", "observation", "general"];
    for (const t of types) {
      expect(FACT_TYPE_INITIAL_STABILITY[t]).toBeDefined();
    }
  });
  it("STABILITY_REINFORCE_FACTOR 为 1.2", () => {
    expect(STABILITY_REINFORCE_FACTOR).toBe(1.2);
  });
});

// -- P2: 连续稳定性频谱下的压力贡献 ------------------------------------------

describe("P2 连续稳定性频谱", () => {
  it("高稳定性 fact（preference S=20）短期内 P2 贡献极小", () => {
    const G = new WorldModel();
    G.tick = 100;
    // 10 天前创建，S=20 → R ≈ (1 + 10/(9×20))^-0.5 ≈ 0.973
    G.addFact("pref_fact", {
      importance: 0.8,
      stability: 20,
      last_access_ms: BASE_NOW - dayMs(10),
      volatility: 0,
      tracked: false,
      created_ms: BASE_NOW - dayMs(10),
      novelty: 0.5,
      fact_type: "preference",
    });

    const { contributions } = p2InformationPressure(G, 100, BASE_NOW);
    // memoryTerm = 0.8 × (1 - 0.973) ≈ 0.021 — 极小
    expect(contributions.pref_fact).toBeLessThan(0.05);
    expect(contributions.pref_fact).toBeGreaterThan(0);
  });

  it("低稳定性 fact（observation S=1）短期内 P2 贡献显著", () => {
    const G = new WorldModel();
    G.tick = 100;
    // 10 天前创建，S=1 → R ≈ (1 + 10/(9×1))^-0.5 ≈ 0.689
    G.addFact("obs_fact", {
      importance: 0.8,
      stability: 1,
      last_access_ms: BASE_NOW - dayMs(10),
      volatility: 0,
      tracked: false,
      created_ms: BASE_NOW - dayMs(10),
      novelty: 0.5,
      fact_type: "observation",
    });

    const { contributions } = p2InformationPressure(G, 100, BASE_NOW);
    // memoryTerm = 0.8 × (1 - 0.689) ≈ 0.249 — 显著
    expect(contributions.obs_fact).toBeGreaterThan(0.2);
  });

  it("相同属性不同 fact_type：preference P2 < observation P2", () => {
    const accessMs = BASE_NOW - dayMs(30); // 30 天前

    const GPref = new WorldModel();
    GPref.tick = 100;
    GPref.addFact("fact", {
      importance: 0.8,
      stability: 20,
      last_access_ms: accessMs,
      volatility: 0,
      tracked: false,
      created_ms: accessMs,
      novelty: 0.5,
      fact_type: "preference",
    });

    const GObs = new WorldModel();
    GObs.tick = 100;
    GObs.addFact("fact", {
      importance: 0.8,
      stability: 1,
      last_access_ms: accessMs,
      volatility: 0,
      tracked: false,
      created_ms: accessMs,
      novelty: 0.5,
      fact_type: "observation",
    });

    const pref = p2InformationPressure(GPref, 100, BASE_NOW);
    const obs = p2InformationPressure(GObs, 100, BASE_NOW);

    // preference P2 远低于 observation P2
    expect(pref.total).toBeLessThan(obs.total);
    // 且两者都 > 0（统一 SM-2，没有任何 fact 是 R=1.0 forever）
    expect(pref.total).toBeGreaterThan(0);
    expect(obs.total).toBeGreaterThan(0);
  });

  it("所有 fact_type 在足够长时间后都会产生 P2 压力", () => {
    // 即使 preference (S=20)，500 天后也应产生明显 P2
    const now = dayMs(700); // 足够大的基准
    const G = new WorldModel();
    G.tick = 100;
    G.addFact("old_pref", {
      importance: 0.8,
      stability: 20,
      last_access_ms: now - dayMs(500),
      volatility: 0,
      tracked: false,
      created_ms: now - dayMs(500),
      novelty: 0.5,
      fact_type: "preference",
    });

    const { contributions } = p2InformationPressure(G, 100, now);
    // R ≈ (1 + 500/(9×20))^-0.5 = (1 + 2.78)^-0.5 ≈ 0.515
    // memoryTerm = 0.8 × (1 - 0.515) ≈ 0.388
    expect(contributions.old_pref).toBeGreaterThan(0.3);
  });

  it("interest (S=7) 半衰期约 6 月（189 天后 R ≈ 0.5）", () => {
    const now = dayMs(300); // 足够大的基准
    const G = new WorldModel();
    G.tick = 100;
    G.addFact("interest_fact", {
      importance: 1.0,
      stability: 7,
      last_access_ms: now - dayMs(189),
      volatility: 0,
      tracked: false,
      created_ms: now - dayMs(189),
      novelty: 0.5,
      fact_type: "interest",
    });

    const { contributions } = p2InformationPressure(G, 100, now);
    // R ≈ (1 + 189/(9×7))^-0.5 = (1 + 3.0)^-0.5 = 0.5
    // memoryTerm = 1.0 × (1 - 0.5) = 0.5
    expect(contributions.interest_fact).toBeCloseTo(0.5, 1);
  });

  it("tracked fact 仍有 staleness（与 fact_type 无关）", () => {
    const G = new WorldModel();
    G.tick = 100;
    G.addFact("tracked_pref", {
      importance: 0.8,
      stability: 20,
      last_access_ms: tickMs(100), // 刚访问 → R ≈ 1.0 → memoryTerm ≈ 0
      volatility: 0.3,
      tracked: true,
      created_ms: tickMs(80), // 20 ticks ago
      novelty: 0.5,
      fact_type: "preference",
    });

    const { contributions } = p2InformationPressure(G, 100, tickMs(100));
    // staleness = 0.3 × (100-80) = 6.0, memoryTerm ≈ 0
    expect(contributions.tracked_pref).toBeCloseTo(6.0, 0);
  });

  it("P2 总值正确（混合不同 fact_type）", () => {
    const G = new WorldModel();
    G.tick = 100;
    G.addFact("pref", {
      importance: 0.8,
      stability: 20,
      last_access_ms: tickMs(50),
      volatility: 0,
      tracked: false,
      created_ms: tickMs(10),
      novelty: 0.5,
      fact_type: "preference",
    });
    G.addFact("obs", {
      importance: 0.5,
      stability: 1,
      last_access_ms: tickMs(90),
      volatility: 0,
      tracked: false,
      created_ms: tickMs(80),
      novelty: 0.5,
      fact_type: "observation",
    });

    const { total, contributions } = p2InformationPressure(G, 100, tickMs(100));
    // 两者都 > 0（统一 SM-2）
    expect(contributions.pref).toBeGreaterThan(0);
    expect(contributions.obs).toBeGreaterThan(0);
    expect(total).toBeCloseTo(contributions.pref + contributions.obs, 10);
  });
});

// -- tierScore 互惠系数 -------------------------------------------------------

import { tierScore } from "../src/mods/relationships.mod.js";

describe("tierScore 互惠系数", () => {
  const base = {
    interactionCount: 3,
    tier: 50,
    avgQuality: 0.5,
    factCount: 5,
    maxFacts: 20,
    threadInvolvement: 2,
    maxThreads: 15,
    trust: 0.5,
  };

  it("双方均衡（1:1）→ reciprocity = 1.0，不影响分数", () => {
    const withReciprocity = tierScore(
      base.interactionCount,
      base.tier,
      base.avgQuality,
      base.factCount,
      base.maxFacts,
      base.threadInvolvement,
      base.maxThreads,
      base.trust,
      5,
      5,
    );
    const withoutReciprocity = tierScore(
      base.interactionCount,
      base.tier,
      base.avgQuality,
      base.factCount,
      base.maxFacts,
      base.threadInvolvement,
      base.maxThreads,
      base.trust,
    );
    expect(withReciprocity).toBeCloseTo(withoutReciprocity, 10);
  });

  it("Alice 发起 4× → 分数减半", () => {
    const balanced = tierScore(
      base.interactionCount,
      base.tier,
      base.avgQuality,
      base.factCount,
      base.maxFacts,
      base.threadInvolvement,
      base.maxThreads,
      base.trust,
      5,
      5,
    );
    const asymmetric = tierScore(
      base.interactionCount,
      base.tier,
      base.avgQuality,
      base.factCount,
      base.maxFacts,
      base.threadInvolvement,
      base.maxThreads,
      base.trust,
      20,
      5,
    );
    // reciprocity = sqrt(5/20) = 0.5
    expect(asymmetric).toBeCloseTo(balanced * 0.5, 5);
  });

  it("对方发起更多 → reciprocity capped at 1.0（不过度加分）", () => {
    const balanced = tierScore(
      base.interactionCount,
      base.tier,
      base.avgQuality,
      base.factCount,
      base.maxFacts,
      base.threadInvolvement,
      base.maxThreads,
      base.trust,
      5,
      5,
    );
    const contactMoreActive = tierScore(
      base.interactionCount,
      base.tier,
      base.avgQuality,
      base.factCount,
      base.maxFacts,
      base.threadInvolvement,
      base.maxThreads,
      base.trust,
      5,
      20,
    );
    // reciprocity = min(1, sqrt(20/5)) = min(1, 2) = 1.0
    expect(contactMoreActive).toBeCloseTo(balanced, 10);
  });

  it("总互动 < 5 次 → 不激活（reciprocity = 1.0）", () => {
    const coldStart = tierScore(
      base.interactionCount,
      base.tier,
      base.avgQuality,
      base.factCount,
      base.maxFacts,
      base.threadInvolvement,
      base.maxThreads,
      base.trust,
      3,
      1, // total = 4 < 5
    );
    const noReciprocity = tierScore(
      base.interactionCount,
      base.tier,
      base.avgQuality,
      base.factCount,
      base.maxFacts,
      base.threadInvolvement,
      base.maxThreads,
      base.trust,
    );
    expect(coldStart).toBeCloseTo(noReciprocity, 10);
  });

  it("Alice 单方面高频 → 升级被抑制", () => {
    // 极端情况：Alice 发起 50 次，对方 0 次 → reciprocity = 0
    const oneSided = tierScore(
      base.interactionCount,
      base.tier,
      base.avgQuality,
      base.factCount,
      base.maxFacts,
      base.threadInvolvement,
      base.maxThreads,
      base.trust,
      50,
      0,
    );
    expect(oneSided).toBe(0);
  });
});
