/**
 * ADR-124: effectiveObligation + hasObligation 单元测试。
 * ADR-134: 指数衰减核（2^(-t/τ)）替代双曲线（1/(1+t/τ)）。
 * @see docs/adr/124-engagement-exclusivity.md §Verification
 * @see docs/adr/134-temporal-coherence.md §D1
 */
import { describe, expect, it } from "vitest";
import type { ChatType } from "../src/graph/entities.js";
import { WorldModel } from "../src/graph/world-model.js";
import {
  effectiveObligation,
  hasObligation,
  OBLIGATION_HALFLIFE_GROUP,
  OBLIGATION_HALFLIFE_PRIVATE,
  OBLIGATION_THRESHOLDS,
} from "../src/pressure/signal-decay.js";

// -- 辅助 -------------------------------------------------------------------

function makeGraph(): WorldModel {
  const G = new WorldModel();
  G.addAgent("self");
  return G;
}

const NOW = Date.now();

function addChannel(
  G: WorldModel,
  id: string,
  opts: {
    chatType?: ChatType;
    pendingDirected?: number;
    lastDirectedMs?: number;
  } = {},
): void {
  G.addChannel(id, {
    chat_type: opts.chatType ?? "private",
    pending_directed: opts.pendingDirected ?? 0,
    last_directed_ms: opts.lastDirectedMs ?? 0,
  });
}

// -- 测试 -------------------------------------------------------------------

describe("effectiveObligation", () => {
  it("pending_directed=0 时返回 0", () => {
    const G = makeGraph();
    addChannel(G, "channel:1", { pendingDirected: 0 });
    expect(effectiveObligation(G, "channel:1", NOW)).toBe(0);
  });

  it("不存在的节点返回 0", () => {
    const G = makeGraph();
    expect(effectiveObligation(G, "channel:nonexistent", NOW)).toBe(0);
  });

  it("ageS=0 时返回 directed 原始值", () => {
    const G = makeGraph();
    addChannel(G, "channel:1", { pendingDirected: 3, lastDirectedMs: NOW });
    expect(effectiveObligation(G, "channel:1", NOW)).toBe(3);
  });

  it("ageS=halfLife 时返回 directed * 0.5（私聊 3600s）", () => {
    const G = makeGraph();
    const lastMs = NOW - OBLIGATION_HALFLIFE_PRIVATE * 1000;
    addChannel(G, "channel:1", { pendingDirected: 1, lastDirectedMs: lastMs, chatType: "private" });
    const result = effectiveObligation(G, "channel:1", NOW);
    expect(result).toBeCloseTo(0.5, 5);
  });

  it("ageS=halfLife 时返回 directed * 0.5（群聊 2400s）", () => {
    const G = makeGraph();
    const lastMs = NOW - OBLIGATION_HALFLIFE_GROUP * 1000;
    addChannel(G, "channel:g", { pendingDirected: 1, lastDirectedMs: lastMs, chatType: "group" });
    const result = effectiveObligation(G, "channel:g", NOW);
    expect(result).toBeCloseTo(0.5, 5);
  });

  it("supergroup 使用群聊半衰期", () => {
    const G = makeGraph();
    const lastMs = NOW - OBLIGATION_HALFLIFE_GROUP * 1000;
    addChannel(G, "channel:sg", {
      pendingDirected: 1,
      lastDirectedMs: lastMs,
      chatType: "supergroup",
    });
    const result = effectiveObligation(G, "channel:sg", NOW);
    expect(result).toBeCloseTo(0.5, 5);
  });

  it("指数衰减：10 小时后趋近 0（2^-10 ≈ 0.001）", () => {
    const G = makeGraph();
    // 10 小时 = 36000 秒 = 10 个半衰期 → Ω = 2^(-10) ≈ 0.000977
    const lastMs = NOW - 36000 * 1000;
    addChannel(G, "channel:1", { pendingDirected: 1, lastDirectedMs: lastMs, chatType: "private" });
    const result = effectiveObligation(G, "channel:1", NOW);
    expect(result).toBeCloseTo(2 ** -10, 3);
    expect(result).toBeLessThan(0.01); // 远小于任何有意义的阈值
  });

  it("无 last_directed_ms 时视为刚到达", () => {
    const G = makeGraph();
    addChannel(G, "channel:1", { pendingDirected: 2, lastDirectedMs: 0 });
    expect(effectiveObligation(G, "channel:1", NOW)).toBe(2);
  });

  it("多条 directed 消息正确缩放", () => {
    const G = makeGraph();
    addChannel(G, "channel:1", { pendingDirected: 5, lastDirectedMs: NOW });
    expect(effectiveObligation(G, "channel:1", NOW)).toBe(5);
  });
});

describe("hasObligation", () => {
  it("默认阈值 (signal=0.1)：新鲜义务返回 true", () => {
    const G = makeGraph();
    addChannel(G, "channel:1", { pendingDirected: 1, lastDirectedMs: NOW });
    expect(hasObligation(G, "channel:1", NOW)).toBe(true);
  });

  it("默认阈值：完全衰减后返回 false", () => {
    const G = makeGraph();
    const lastMs = NOW - 100_000 * 1000; // 远古
    addChannel(G, "channel:1", { pendingDirected: 1, lastDirectedMs: lastMs });
    expect(hasObligation(G, "channel:1", NOW)).toBe(false);
  });

  it("自定义阈值正确工作", () => {
    const G = makeGraph();
    // 1.5h old, private: Ω = 2^(-5400/3600) = 2^(-1.5) ≈ 0.354
    const lastMs = NOW - 5400 * 1000;
    addChannel(G, "channel:1", { pendingDirected: 1, lastDirectedMs: lastMs, chatType: "private" });

    // modeEnter (0.3) → 0.354 > 0.3 → true
    expect(hasObligation(G, "channel:1", NOW, OBLIGATION_THRESHOLDS.modeEnter)).toBe(true);

    // 2h old: Ω = 2^(-2) = 0.25
    const lastMs2h = NOW - 7200 * 1000;
    G.setDynamic("channel:1", "last_directed_ms", lastMs2h);
    // modeEnter (0.3) → 0.25 < 0.3 → false
    expect(hasObligation(G, "channel:1", NOW, OBLIGATION_THRESHOLDS.modeEnter)).toBe(false);
    // bypassGates (0.2) → 0.25 > 0.2 → true
    expect(hasObligation(G, "channel:1", NOW, OBLIGATION_THRESHOLDS.bypassGates)).toBe(true);
  });

  it("pending_directed=0 始终返回 false", () => {
    const G = makeGraph();
    addChannel(G, "channel:1", { pendingDirected: 0 });
    expect(hasObligation(G, "channel:1", NOW, 0)).toBe(false);
  });
});

describe("滞回性质", () => {
  it("θ_enter > θ_bypass > θ_exit — 阈值体系正确", () => {
    expect(OBLIGATION_THRESHOLDS.modeEnter).toBeGreaterThan(OBLIGATION_THRESHOLDS.bypassGates);
    expect(OBLIGATION_THRESHOLDS.bypassGates).toBeGreaterThan(OBLIGATION_THRESHOLDS.modeExit);
  });

  it("0.1 < Ω < 0.3 → 已在 conversation 的不退出，patrol 的不进入", () => {
    const G = makeGraph();
    // 2h old, private: Ω = 2^(-7200/3600) = 2^(-2) = 0.25
    const lastMs = NOW - 7200 * 1000;
    addChannel(G, "channel:1", { pendingDirected: 1, lastDirectedMs: lastMs, chatType: "private" });
    const omega = effectiveObligation(G, "channel:1", NOW);

    // 验证在滞回区间内
    expect(omega).toBeGreaterThan(OBLIGATION_THRESHOLDS.modeExit);
    expect(omega).toBeLessThan(OBLIGATION_THRESHOLDS.modeEnter);

    // patrol 不进入：Ω < θ_enter
    expect(omega > OBLIGATION_THRESHOLDS.modeEnter).toBe(false);
    // conversation 不退出：Ω > θ_exit
    expect(omega < OBLIGATION_THRESHOLDS.modeExit).toBe(false);
  });
});

describe("指数衰减时间线（ADR-134）", () => {
  // 私聊 directed=1 的指数衰减时间线：Ω = 2^(-ageS / 3600)
  const cases = [
    { label: "0s", ageS: 0, expectedOmega: 1.0 },
    { label: "30min", ageS: 1800, expectedOmega: 2 ** -0.5 },
    { label: "1h", ageS: 3600, expectedOmega: 0.5 },
    { label: "2h", ageS: 7200, expectedOmega: 0.25 },
    { label: "3h", ageS: 10800, expectedOmega: 0.125 },
    { label: "6h", ageS: 21600, expectedOmega: 2 ** -6 },
    { label: "10h", ageS: 36000, expectedOmega: 2 ** -10 },
  ];

  for (const { label, ageS, expectedOmega } of cases) {
    it(`t=${label}: Ω ≈ ${expectedOmega.toFixed(4)}`, () => {
      const G = makeGraph();
      const lastMs = NOW - ageS * 1000;
      addChannel(G, "channel:1", {
        pendingDirected: 1,
        lastDirectedMs: lastMs,
        chatType: "private",
      });
      expect(effectiveObligation(G, "channel:1", NOW)).toBeCloseTo(expectedOmega, 3);
    });
  }
});
