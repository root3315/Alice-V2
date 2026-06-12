/**
 * ADR-185 §1: Desire 中间层单元测试。
 *
 * 覆盖:
 * 1. deriveDesires — 空 map、阈值过滤、各维度超阈值、排序、截断、urgency clamp
 * 2. findTopDesireForTarget — 匹配/无匹配
 *
 * @see runtime/src/engine/desire.ts
 */
import { describe, expect, it } from "vitest";
import { type Desire, deriveDesires, findTopDesireForTarget } from "../src/engine/desire.js";
import type { TensionVector } from "../src/graph/tension.js";
import { WorldModel } from "../src/graph/world-model.js";

// ═══════════════════════════════════════════════════════════════════════════
// 辅助
// ═══════════════════════════════════════════════════════════════════════════

const BASE_NOW_MS = 600_000_000;

function tension(overrides: Partial<TensionVector> = {}): TensionVector {
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
    ...overrides,
  };
}

function buildGraph(
  channels: Array<{
    id: string;
    pendingDirected?: number;
    displayName?: string;
  }>,
): WorldModel {
  const G = new WorldModel();
  G.tick = 100;
  G.addAgent("self");
  for (const ch of channels) {
    G.addChannel(ch.id, {
      unread: 0,
      tier_contact: 150,
      chat_type: "private",
      pending_directed: ch.pendingDirected ?? 0,
      last_directed_ms: ch.pendingDirected ? BASE_NOW_MS - 1000 : 0,
      reachability_score: 1.0,
    });
    if (ch.displayName) {
      G.setDynamic(ch.id, "display_name", ch.displayName);
    }
  }
  return G;
}

// ═══════════════════════════════════════════════════════════════════════════
// deriveDesires
// ═══════════════════════════════════════════════════════════════════════════

describe("deriveDesires", () => {
  it("空 tensionMap → 空数组", () => {
    const G = buildGraph([]);
    const result = deriveDesires(new Map(), G, BASE_NOW_MS);
    expect(result).toEqual([]);
  });

  it("低于阈值 → 不产生 desire", () => {
    const G = buildGraph([{ id: "channel:a" }]);
    // 所有维度低于各自阈值
    const tm = new Map([
      [
        "channel:a",
        tension({
          tau1: 0.1, // < 0.5 (reduce_backlog)
          tau3: 0.1, // < 0.3 (reconnect)
          tau4: 0.1, // < 0.4 (resolve_thread)
          tau6: 0.1, // < 0.3 (explore)
        }),
      ],
    ]);
    // pending_directed=0 → effectiveObligation ≈ 0 < 0.2 (fulfill_duty)
    const result = deriveDesires(tm, G, BASE_NOW_MS);
    expect(result).toEqual([]);
  });

  it("P5 高义务 → fulfill_duty desire", () => {
    const G = buildGraph([{ id: "channel:a", pendingDirected: 3, displayName: "小明" }]);
    const tm = new Map([["channel:a", tension()]]);
    const result = deriveDesires(tm, G, BASE_NOW_MS);
    const duty = result.find((d) => d.type === "fulfill_duty");
    expect(duty).toBeDefined();
    expect(duty?.targetId).toBe("channel:a");
    expect(duty?.urgency).toBeGreaterThan(0);
    expect(duty?.label).toContain("小明");
  });

  it("P3 高 → reconnect desire", () => {
    const G = buildGraph([{ id: "channel:a", displayName: "Alice" }]);
    const tm = new Map([["channel:a", tension({ tau3: 0.8 })]]);
    const result = deriveDesires(tm, G, BASE_NOW_MS);
    const reconnect = result.find((d) => d.type === "reconnect");
    expect(reconnect).toBeDefined();
    expect(reconnect?.urgency).toBeCloseTo(0.8, 2);
  });

  it("P4 高 → resolve_thread desire", () => {
    const G = buildGraph([{ id: "channel:a" }]);
    const tm = new Map([["channel:a", tension({ tau4: 0.9 })]]);
    const result = deriveDesires(tm, G, BASE_NOW_MS);
    const thread = result.find((d) => d.type === "resolve_thread");
    expect(thread).toBeDefined();
    expect(thread?.urgency).toBeCloseTo(0.9, 2);
  });

  it("P1 高 → reduce_backlog desire", () => {
    const G = buildGraph([{ id: "channel:a" }]);
    const tm = new Map([["channel:a", tension({ tau1: 0.7 })]]);
    const result = deriveDesires(tm, G, BASE_NOW_MS);
    const backlog = result.find((d) => d.type === "reduce_backlog");
    expect(backlog).toBeDefined();
    expect(backlog?.urgency).toBeCloseTo(0.7, 2);
  });

  it("P6 高 → explore desire", () => {
    const G = buildGraph([{ id: "channel:a" }]);
    const tm = new Map([["channel:a", tension({ tau6: 0.5 })]]);
    const result = deriveDesires(tm, G, BASE_NOW_MS);
    const explore = result.find((d) => d.type === "explore");
    expect(explore).toBeDefined();
    expect(explore?.urgency).toBeCloseTo(0.5, 2);
  });

  it("多 desire → urgency 降序排列", () => {
    const G = buildGraph([{ id: "channel:a" }, { id: "channel:b" }]);
    const tm = new Map([
      ["channel:a", tension({ tau3: 0.5, tau6: 0.9 })],
      ["channel:b", tension({ tau3: 0.7 })],
    ]);
    const result = deriveDesires(tm, G, BASE_NOW_MS);
    expect(result.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < result.length; i++) {
      expect(result[i].urgency).toBeLessThanOrEqual(result[i - 1].urgency);
    }
  });

  it("超过 MAX_DESIRES(10) → 截断", () => {
    // 创建 12 个 channel，每个至少产生 1 个 desire
    const channels = Array.from({ length: 12 }, (_, i) => ({
      id: `channel:${i}`,
    }));
    const G = buildGraph(channels);
    const tm = new Map(
      channels.map((ch, i) => [ch.id, tension({ tau3: 0.5 + i * 0.04 })] as const),
    );
    const result = deriveDesires(tm, G, BASE_NOW_MS);
    expect(result.length).toBeLessThanOrEqual(10);
  });

  it("urgency clamp 到 1.0", () => {
    const G = buildGraph([{ id: "channel:a" }]);
    // tau3 = 5.0 远超阈值 → urgency 应 clamp 到 1.0
    const tm = new Map([["channel:a", tension({ tau3: 5.0 })]]);
    const result = deriveDesires(tm, G, BASE_NOW_MS);
    const reconnect = result.find((d) => d.type === "reconnect");
    expect(reconnect).toBeDefined();
    expect(reconnect?.urgency).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// findTopDesireForTarget
// ═══════════════════════════════════════════════════════════════════════════

describe("findTopDesireForTarget", () => {
  const desires: Desire[] = [
    { type: "fulfill_duty", targetId: "channel:a", urgency: 0.9, label: "reply to A" },
    { type: "reconnect", targetId: "channel:b", urgency: 0.7, label: "reconnect with B" },
    { type: "explore", targetId: "channel:a", urgency: 0.5, label: "explore A" },
    { type: "reconnect", targetId: "channel:c", urgency: 0.3, label: "reconnect with C" },
  ];

  it("匹配 → 返回最高 urgency（排序靠前的第一个匹配）", () => {
    const result = findTopDesireForTarget(desires, "channel:a");
    expect(result).toBeDefined();
    expect(result?.type).toBe("fulfill_duty");
    expect(result?.urgency).toBe(0.9);
  });

  it("单个匹配 → 返回该 desire", () => {
    const result = findTopDesireForTarget(desires, "channel:b");
    expect(result).toBeDefined();
    expect(result?.type).toBe("reconnect");
    expect(result?.urgency).toBe(0.7);
  });

  it("无匹配 → undefined", () => {
    const result = findTopDesireForTarget(desires, "channel:nonexistent");
    expect(result).toBeUndefined();
  });

  it("空 desires → undefined", () => {
    const result = findTopDesireForTarget([], "channel:a");
    expect(result).toBeUndefined();
  });
});
