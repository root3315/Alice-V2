/**
 * Python ↔ TypeScript 交叉验证。
 *
 * golden-pressures.json 由 simulation/cross_validate.py 生成，
 * 包含 Python 模拟对固定图状态计算的 P1-P6 + API + contributions。
 * 本测试用 TypeScript runtime 对同一图构造同一参数调用，验证数值一致。
 *
 * 如果此测试失败，说明两套实现存在分歧。
 *
 * 重新生成 golden values：
 *   cd runtime && npx tsx scripts/regenerate-golden.ts
 */
import { describe, expect, it } from "vitest";
import { WorldModel } from "../src/graph/world-model.js";
import { computeAllPressures } from "../src/pressure/aggregate.js";
import { p1AttentionDebt } from "../src/pressure/p1-attention.js";
import { p5ResponseObligation } from "../src/pressure/p5-response.js";
import { propagatePressures } from "../src/pressure/propagation.js";
import golden from "./golden-pressures.json";

/** 测试用 tick→ms 转换（约定：1 tick = 60s）。 */
function tickMs(tick: number): number {
  return tick * 60_000;
}

/** 与 Python cross_validate.py build_cross_validation_graph() 完全一致。 */
function buildGoldenGraph(): WorldModel {
  const G = new WorldModel();
  G.tick = 100;

  G.addAgent("self");

  G.addContact("alice", { tier: 5, last_active_ms: tickMs(95) });
  G.addContact("bob", { tier: 50, last_active_ms: tickMs(60) });
  G.addContact("carol", { tier: 150, last_active_ms: tickMs(1) });

  G.addChannel("channel:alice", {
    unread: 5,
    tier_contact: 5,
    chat_type: "private",
    pending_directed: 2,
    last_directed_ms: tickMs(98),
    last_incoming_ms: tickMs(100),
  });
  G.addChannel("channel:group", {
    unread: 10,
    tier_contact: 150,
    chat_type: "group",
    pending_directed: 0,
    last_incoming_ms: tickMs(100),
  });
  G.addChannel("channel:empty", {
    unread: 0,
    tier_contact: 50,
    chat_type: "private",
  });

  G.addThread("t_urgent", {
    weight: "major",
    status: "open",
    created_ms: tickMs(90),
    deadline: 110,
    deadline_ms: tickMs(110), // ADR-166: readNodeMs 需要显式 _ms 属性
  });
  G.addThread("t_minor", {
    weight: "minor",
    status: "open",
    created_ms: tickMs(50),
    deadline: Infinity,
  });
  G.addThread("t_done", {
    weight: "minor",
    status: "resolved",
    created_ms: tickMs(10),
  });

  G.addFact("i1", {
    importance: 0.8,
    stability: 2.0,
    last_access_ms: tickMs(90),
    volatility: 0.3,
    tracked: true,
    created_ms: tickMs(80),
    novelty: 0.7,
    fact_type: "observation", // episodic — 交叉验证 SM-2 衰减
  });
  G.addFact("i2", {
    importance: 0.5,
    stability: 1.0,
    last_access_ms: tickMs(50),
    volatility: 0.1,
    tracked: false,
    created_ms: tickMs(30),
    novelty: 0.2,
    fact_type: "observation", // episodic — 交叉验证 SM-2 衰减
  });

  G.addRelation("self", "friend", "alice");
  G.addRelation("self", "acquaintance", "bob");
  G.addRelation("self", "stranger", "carol");
  G.addRelation("self", "monitors", "channel:alice");
  G.addRelation("self", "monitors", "channel:group");
  G.addRelation("alice", "joined", "channel:alice");
  G.addRelation("bob", "joined", "channel:group");
  G.addRelation("t_urgent", "involves", "alice");
  G.addRelation("i1", "from", "channel:alice");

  return G;
}

const TOLERANCE = 6; // 小数位数精度（1e-6 级别）

describe("Python ↔ TypeScript 交叉验证", () => {
  const G = buildGoldenGraph();
  const p = golden.params;
  // ADR-110: params 已经是 TypeScript 原生单位（秒/per-second），无需转换
  const result = computeAllPressures(G, golden.n, {
    kappa: p.kappa as [number, number, number, number, number, number],
    threadAgeScale: p.thread_age_scale,
    mu: p.mu,
    d: p.d,

    deltaDeadline: p.delta_deadline,
    kSteepness: p.k_steepness,
    kappaProspect: p.kappa_prospect,
    nowMs: tickMs(golden.n),
  });

  it("P1 注意力债务一致", () => {
    expect(result.P1).toBeCloseTo(golden.pressures.P1, TOLERANCE);
  });

  it("P2 信息压力一致", () => {
    expect(result.P2).toBeCloseTo(golden.pressures.P2, TOLERANCE);
  });

  it("P3 关系冷却一致", () => {
    expect(result.P3).toBeCloseTo(golden.pressures.P3, TOLERANCE);
  });

  it("P4 线程发散一致", () => {
    expect(result.P4).toBeCloseTo(golden.pressures.P4, TOLERANCE);
  });

  it("P5 回应义务一致", () => {
    expect(result.P5).toBeCloseTo(golden.pressures.P5, TOLERANCE);
  });

  it("P6 好奇心一致", () => {
    expect(result.P6).toBeCloseTo(golden.pressures.P6, TOLERANCE);
  });

  it("P_prospect 前瞻性压力一致", () => {
    expect(result.P_prospect).toBeCloseTo(golden.pressures.P_prospect, TOLERANCE);
  });

  it("API 归一化一致（含 P_prospect 加法项）", () => {
    expect(result.API).toBeCloseTo(golden.pressures.API, TOLERANCE);
  });

  // Contributions 逐条验证
  it("P1 contributions 一致", () => {
    for (const [eid, val] of Object.entries(golden.contributions.P1)) {
      expect(result.contributions.P1[eid]).toBeCloseTo(val as number, TOLERANCE);
    }
  });

  it("P2 contributions 一致", () => {
    for (const [eid, val] of Object.entries(golden.contributions.P2)) {
      expect(result.contributions.P2[eid]).toBeCloseTo(val as number, TOLERANCE);
    }
  });

  it("P3 contributions 一致", () => {
    for (const [eid, val] of Object.entries(golden.contributions.P3)) {
      expect(result.contributions.P3[eid]).toBeCloseTo(val as number, TOLERANCE);
    }
  });

  it("P4 contributions 一致", () => {
    for (const [eid, val] of Object.entries(golden.contributions.P4)) {
      expect(result.contributions.P4[eid]).toBeCloseTo(val as number, TOLERANCE);
    }
  });

  it("P5 contributions 一致", () => {
    for (const [eid, val] of Object.entries(golden.contributions.P5)) {
      expect(result.contributions.P5[eid]).toBeCloseTo(val as number, TOLERANCE);
    }
  });

  it("P6 contributions 一致", () => {
    for (const [eid, val] of Object.entries(golden.contributions.P6)) {
      expect(result.contributions.P6[eid]).toBeCloseTo(val as number, TOLERANCE);
    }
  });

  // Laplacian 传播验证（使用传播前的本地值）
  it("传播后有效压力一致", () => {
    const localContribs = (golden as Record<string, unknown>).local_contributions as Record<
      string,
      Record<string, number>
    >;
    const localAll: Record<string, number> = {};
    for (const pk of ["P1", "P2", "P3", "P4", "P5", "P6"]) {
      for (const [eid, val] of Object.entries(localContribs[pk])) {
        localAll[eid] = (localAll[eid] ?? 0) + val;
      }
    }
    const pEff = propagatePressures(G, localAll, p.mu, tickMs(golden.n));

    for (const [eid, expectedVal] of Object.entries(golden.propagation.p_eff)) {
      expect(pEff[eid]).toBeCloseTo(expectedVal as number, TOLERANCE);
    }
  });

  // NOTE: v5 声部响度公式变更（焦点集 mean(R_v) 替代 tanh 激活），
  // v4 golden values 不再适用。新的响度验证在 voices.test.ts 覆盖。
});

// ═══════════════════════════════════════════════════════════════════════════
// ADR-23 Wave 5 交叉验证：非默认值场景
// ═══════════════════════════════════════════════════════════════════════════

const wave5 = (golden as Record<string, unknown>).wave5 as {
  activity_relevance: { P1_total: number; "P1_channel:group": number };
};

describe("Wave 5 交叉验证 — 非默认值", () => {
  it("Wave 5.2: activity_relevance=0.5 调制 P1", () => {
    const G = buildGoldenGraph();
    G.setDynamic("channel:group", "activity_relevance", 0.5);
    const r = p1AttentionDebt(G, tickMs(golden.n));
    expect(r.total).toBeCloseTo(wave5.activity_relevance.P1_total, TOLERANCE);
    expect(r.contributions["channel:group"]).toBeCloseTo(
      wave5.activity_relevance["P1_channel:group"],
      TOLERANCE,
    );
  });

  // NOTE: Wave 5.1 (risk_boost), 5.4a/b (mood) 的 v4 loudness 测试已移除。
  // v5 中 risk/mood 改为逐实体（R_Caution），覆盖在 voices.test.ts 和 focus.test.ts。

  it("Wave 5.5: ADR-222 — 惯性加成已删除，last_alice_action_ms 不再影响 P5", () => {
    const G = buildGoldenGraph();
    G.setDynamic("channel:alice", "last_alice_action_ms", tickMs(98));
    const r = p5ResponseObligation(G, golden.n, tickMs(golden.n));
    // ADR-222: 惯性加成 ×1.5 已删除。设置 last_alice_action_ms 不改变 P5。
    // P5 应等于基线值（golden.pressures.P5 = 19.543...），而非旧值 29.314...
    const baseline = p5ResponseObligation(buildGoldenGraph(), golden.n, tickMs(golden.n));
    expect(r.total).toBeCloseTo(baseline.total, TOLERANCE);
  });
});
