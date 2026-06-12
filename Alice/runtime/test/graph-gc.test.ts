/**
 * ADR-79 M2: 图 GC (mark-sweep) 测试。
 *
 * 覆盖:
 * 1. Mark 阶段 — permanent failure + low score → gc_candidate_ms
 * 2. Sweep 阶段 — grace ms 到期 → removeEntity
 * 3. 豁免 — tier ≤ 15 不被 GC
 * 4. 豁免 — 有活跃 conversation 不被 GC
 * 5. 孤儿 conversation 清理
 * 6. 自愈取消标记
 *
 * @see runtime/src/db/maintenance.ts — gcGraph
 */
import { describe, expect, it } from "vitest";
import { gcGraph } from "../src/db/maintenance.js";
import { WorldModel } from "../src/graph/world-model.js";

/** GC_GRACE_MS = 8h（与 maintenance.ts 保持一致）。 */
const GC_GRACE_MS = 8 * 3600 * 1000; // 28800000

function makeGraph(): WorldModel {
  const G = new WorldModel();
  G.addAgent("self");
  return G;
}

// ═══════════════════════════════════════════════════════════════════════════
// Mark 阶段
// ═══════════════════════════════════════════════════════════════════════════

describe("GC mark phase", () => {
  it("permanent failure + low score → 设置 gc_candidate_ms", () => {
    const G = makeGraph();
    G.addChannel("channel:dead", {
      chat_type: "private",
      tier_contact: 150,
      reachability_score: 0.01,
      failure_type: "permanent",
      consecutive_act_failures: 6,
    });

    const baseMs = 1700000000000;
    const removed = gcGraph(100, G, baseMs);
    expect(removed).toHaveLength(0); // 首次标记不删除
    expect(G.getChannel("channel:dead").gc_candidate_ms).toBe(baseMs);
  });

  it("transient failure → 不标记", () => {
    const G = makeGraph();
    G.addChannel("channel:temp", {
      chat_type: "private",
      tier_contact: 150,
      reachability_score: 0.01,
      failure_type: "transient",
      consecutive_act_failures: 6,
    });

    gcGraph(100, G, 1700000000000);
    expect(G.getChannel("channel:temp").gc_candidate_ms).toBeUndefined();
  });

  it("score >= threshold → 不标记", () => {
    const G = makeGraph();
    G.addChannel("channel:ok", {
      chat_type: "private",
      tier_contact: 150,
      reachability_score: 0.1,
      failure_type: "permanent",
    });

    gcGraph(100, G, 1700000000000);
    expect(G.getChannel("channel:ok").gc_candidate_ms).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Sweep 阶段
// ═══════════════════════════════════════════════════════════════════════════

describe("GC sweep phase", () => {
  it("grace ms 到期 → 删除节点", () => {
    const G = makeGraph();
    const markedMs = 1700000000000;
    G.addChannel("channel:dead", {
      chat_type: "private",
      tier_contact: 150,
      reachability_score: 0.01,
      failure_type: "permanent",
      gc_candidate_ms: markedMs,
    });

    // nowMs = markedMs + GC_GRACE_MS - 1 → 还在观察窗内
    const removed1 = gcGraph(200, G, markedMs + GC_GRACE_MS - 1);
    expect(removed1).toHaveLength(0);
    expect(G.has("channel:dead")).toBe(true);

    // nowMs = markedMs + GC_GRACE_MS → grace 到期
    const removed2 = gcGraph(300, G, markedMs + GC_GRACE_MS);
    expect(removed2).toContain("channel:dead");
    expect(G.has("channel:dead")).toBe(false);
  });

  it("contact 也能被 GC", () => {
    const G = makeGraph();
    const markedMs = 1700000000000;
    G.addContact("contact:ghost", {
      tier: 150,
      reachability_score: 0.01,
      failure_type: "permanent",
      gc_candidate_ms: markedMs,
    });

    const removed = gcGraph(500, G, markedMs + GC_GRACE_MS);
    expect(removed).toContain("contact:ghost");
    expect(G.has("contact:ghost")).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 豁免
// ═══════════════════════════════════════════════════════════════════════════

describe("GC exemptions", () => {
  it("tier ≤ 15 的联系人不被标记", () => {
    const G = makeGraph();
    G.addContact("contact:close", {
      tier: 5,
      reachability_score: 0.01,
      failure_type: "permanent",
    });

    gcGraph(100, G, 1700000000000);
    expect(G.getContact("contact:close").gc_candidate_ms).toBeUndefined();
    expect(G.has("contact:close")).toBe(true);
  });

  it("tier_contact ≤ 15 的频道不被标记", () => {
    const G = makeGraph();
    G.addChannel("channel:close", {
      chat_type: "private",
      tier_contact: 15,
      reachability_score: 0.01,
      failure_type: "permanent",
    });

    gcGraph(100, G, 1700000000000);
    expect(G.getChannel("channel:close").gc_candidate_ms).toBeUndefined();
  });

  it("有活跃 conversation 的频道不被 GC", () => {
    const G = makeGraph();
    const markedMs = 1700000000000;
    G.addChannel("channel:active", {
      chat_type: "private",
      tier_contact: 150,
      reachability_score: 0.01,
      failure_type: "permanent",
      gc_candidate_ms: markedMs,
    });
    G.addConversation("conversation:1", {
      channel: "channel:active",
      state: "active",
      participants: [],
      start_ms: 0,
      last_activity_ms: 50,
      turn_state: "open",
      pace: 0,
      message_count: 5,
      alice_message_count: 2,
    });

    const removed = gcGraph(600, G, markedMs + GC_GRACE_MS);
    expect(removed).not.toContain("channel:active");
    expect(G.has("channel:active")).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 孤儿 conversation 清理
// ═══════════════════════════════════════════════════════════════════════════

describe("orphan conversation cleanup", () => {
  it("channel 被 GC 后遗留的 conversation 也被清理", () => {
    const G = makeGraph();
    const markedMs = 1700000000000;
    // channel:dead 将被 GC
    G.addChannel("channel:dead", {
      chat_type: "private",
      tier_contact: 150,
      reachability_score: 0.01,
      failure_type: "permanent",
      gc_candidate_ms: markedMs,
    });
    // conv 属于 channel:dead
    G.addConversation("conversation:orphan", {
      channel: "channel:dead",
      state: "cooldown",
      participants: [],
      start_ms: 0,
      last_activity_ms: 10,
      turn_state: "open",
      pace: 0,
      message_count: 3,
      alice_message_count: 1,
    });

    const removed = gcGraph(500, G, markedMs + GC_GRACE_MS);
    expect(removed).toContain("channel:dead");
    // conversation:orphan 被 removeEntity 级联清理（审计修复 M5），不出现在 GC removed 列表中
    expect(G.has("channel:dead")).toBe(false);
    expect(G.has("conversation:orphan")).toBe(false);
  });

  it("孤儿 conversation（channel 不存在）被清理", () => {
    const G = makeGraph();
    // conversation 引用了一个不存在的 channel
    G.addConversation("conversation:orphan", {
      channel: "channel:nonexistent",
      state: "active",
      participants: [],
      start_ms: 0,
      last_activity_ms: 10,
      turn_state: "open",
      pace: 0,
      message_count: 1,
      alice_message_count: 0,
    });

    const removed = gcGraph(100, G, 1700000000000);
    expect(removed).toContain("conversation:orphan");
    expect(G.has("conversation:orphan")).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 自愈取消标记
// ═══════════════════════════════════════════════════════════════════════════

describe("GC self-healing cancellation", () => {
  it("score 恢复后清除 gc_candidate_ms", () => {
    const G = makeGraph();
    G.addChannel("channel:recovered", {
      chat_type: "private",
      tier_contact: 150,
      reachability_score: 0.5, // 已恢复
      failure_type: null,
      gc_candidate_ms: 1700000000000, // 之前被标记过
    });

    gcGraph(200, G, 1700000100000);
    expect(G.getChannel("channel:recovered").gc_candidate_ms).toBeNull();
  });
});
