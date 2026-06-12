/**
 * M4 Wave 4 测试 — 记忆压缩 (consolidation.mod)。
 *
 * - consolidate_facts 原子替换衰减事实（图节点操作）
 * - contribute: ADR-81 压力门控——无 urgent directed 时注入 housekeeping 提示
 */
import { describe, expect, it } from "vitest";
import type { ModContext } from "../src/core/types.js";
import { WorldModel } from "../src/graph/world-model.js";
import { consolidationMod } from "../src/mods/consolidation.mod.js";
import { getContactFacts } from "../src/mods/relationships.mod.js";

// -- 测试辅助 -----------------------------------------------------------------

/** 向图中添加 fact 节点并建立 knows 边。 */
function addFactToGraph(
  graph: WorldModel,
  contactId: string,
  factId: string,
  content: string,
  stability: number,
  lastAccess: number,
  created = 0,
  /** ADR-110: 墙钟毫秒。设置后 factRetrievabilityFromNode 优先使用此值。 */
  lastAccessMs?: number,
) {
  graph.addFact(factId, {
    content,
    fact_type: "observation",
    importance: 0.5,
    stability,
    last_access_ms: lastAccess,
    volatility: 0,
    tracked: false,
    created_ms: created,
    novelty: 1.0,
    reinforcement_count: 1,
    source_contact: contactId,
  });
  // ADR-110: 双写墙钟时间戳
  if (lastAccessMs != null) {
    graph.setDynamic(factId, "last_access_ms", lastAccessMs);
  }
  graph.addRelation(contactId, "knows", factId);
}

function makeCtx(
  overrides: {
    activeVoice?: string | null;
    hasDirected?: boolean;
  } = {},
  tick = 100,
  nowMs?: number,
) {
  const graph = new WorldModel();
  graph.tick = tick;

  // ADR-81: 添加 channel 模拟 directed 门控
  if (overrides.hasDirected) {
    graph.addChannel("channel:test", {
      chat_type: "private",
      pending_directed: 1,
    });
  }

  // consolidation.mod 的 state
  const state = { lastCheckTick: 0, consolidationCount: 0 };

  return {
    graph,
    state,
    tick,
    nowMs: nowMs ?? tick * 60_000,
    getModState: (name: string) => {
      if (name === "soul") return { activeVoice: overrides.activeVoice ?? null };
      return undefined;
    },
    dispatch: () => undefined,
  };
}

// biome-ignore lint/style/noNonNullAssertion: test — instructions 已知存在
const instructions = consolidationMod.instructions!;

// -- consolidate_facts -------------------------------------------------------

describe("consolidation.mod — consolidate_facts", () => {
  it("替换衰减事实为摘要", () => {
    const ctx = makeCtx({}, 1000);
    ctx.graph.addContact("contact:1");
    addFactToGraph(ctx.graph, "contact:1", "info_1", "Likes coffee", 0.1, 0);
    addFactToGraph(ctx.graph, "contact:1", "info_2", "Works at Google", 0.1, 0);
    addFactToGraph(ctx.graph, "contact:1", "info_3", "Has a cat", 0.1, 0);
    addFactToGraph(ctx.graph, "contact:1", "info_4", "Fresh fact", 1.0, 90, 90);

    const result = instructions.consolidate_facts.impl(ctx as unknown as ModContext, {
      contactId: "contact:1",
      summary: "Bob: coffee lover, Google employee with a cat.",
      original_facts: ["Likes coffee", "Works at Google", "Has a cat"],
    }) as { success: boolean; removedCount: number; summaryStability: number };

    expect(result.success).toBe(true);
    expect(result.removedCount).toBe(3);
    expect(result.summaryStability).toBe(2.0);

    // 原始 3 条被删除，1 条 fresh 保留，1 条摘要添加 = 2 条
    const remaining = getContactFacts(ctx.graph, "contact:1");
    expect(remaining).toHaveLength(2);
    expect(remaining.find((f) => f.attrs.content === "Fresh fact")).toBeDefined();
    expect(remaining.find((f) => f.attrs.content?.includes("coffee lover"))).toBeDefined();
  });

  it("摘要事实 stability = 2.0", () => {
    const ctx = makeCtx({}, 500);
    ctx.graph.addContact("contact:1");
    addFactToGraph(ctx.graph, "contact:1", "info_a", "fact_a", 0.1, 0);
    addFactToGraph(ctx.graph, "contact:1", "info_b", "fact_b", 0.1, 0);

    instructions.consolidate_facts.impl(ctx as unknown as ModContext, {
      contactId: "contact:1",
      summary: "summary of a and b",
      original_facts: ["fact_a", "fact_b"],
    });

    const remaining = getContactFacts(ctx.graph, "contact:1");
    const summaryFact = remaining.find((f) => f.attrs.content === "summary of a and b");
    expect(summaryFact).toBeDefined();
    // biome-ignore lint/style/noNonNullAssertion: test — summaryFact 已验证存在
    expect(summaryFact!.attrs.stability).toBe(2.0);
    // biome-ignore lint/style/noNonNullAssertion: test
    expect(summaryFact!.attrs.created_ms).toBe(500 * 60_000);
  });

  it("空 summary 拒绝", () => {
    const ctx = makeCtx();
    ctx.graph.addContact("contact:1");
    const result = instructions.consolidate_facts.impl(ctx as unknown as ModContext, {
      contactId: "contact:1",
      summary: "  ",
      original_facts: ["x"],
    }) as { success: boolean };
    expect(result.success).toBe(false);
  });

  it("空 original_facts 拒绝", () => {
    const ctx = makeCtx();
    ctx.graph.addContact("contact:1");
    const result = instructions.consolidate_facts.impl(ctx as unknown as ModContext, {
      contactId: "contact:1",
      summary: "summary",
      original_facts: [],
    }) as { success: boolean };
    expect(result.success).toBe(false);
  });

  it("指定事实不存在时报错", () => {
    const ctx = makeCtx();
    ctx.graph.addContact("contact:1");
    addFactToGraph(ctx.graph, "contact:1", "info_exists", "exists", 1.0, 0);

    const result = instructions.consolidate_facts.impl(ctx as unknown as ModContext, {
      contactId: "contact:1",
      summary: "summary",
      original_facts: ["nonexistent_a", "nonexistent_b"],
    }) as { success: boolean };
    expect(result.success).toBe(false);
  });

  it("consolidationCount 递增", () => {
    const ctx = makeCtx();
    ctx.graph.addContact("contact:1");
    addFactToGraph(ctx.graph, "contact:1", "info_a", "a", 0.1, 0);

    instructions.consolidate_facts.impl(ctx as unknown as ModContext, {
      contactId: "contact:1",
      summary: "summary a",
      original_facts: ["a"],
    });

    expect(ctx.state.consolidationCount).toBe(1);
  });
});

// -- contribute housekeeping -------------------------------------------------

describe("consolidation.mod — contribute", () => {
  // biome-ignore lint/style/noNonNullAssertion: test — contribute 已知存在
  const contribute = consolidationMod.contribute!;

  it("无 directed + 3 条衰减事实 → 注入提示", () => {
    // ADR-110: FACT_TIME_SCALE=86400（秒），stability=0.05
    // nowMs=6_000_000_000, last_access_ms=0 → gapS=6000000, scaled=69.4
    // R = (1+69.4/0.45)^(-0.5) = (155.3)^(-0.5) ≈ 0.080 < 0.2
    // ADR-81: 不再依赖 reflection 声部，只检查无 urgent directed
    const nowMs = 6_000_000_000;
    const ctx = makeCtx({}, 100, nowMs);
    ctx.graph.addContact("contact:1");
    addFactToGraph(ctx.graph, "contact:1", "info_a", "old_a", 0.05, 0, 0, 0);
    addFactToGraph(ctx.graph, "contact:1", "info_b", "old_b", 0.05, 0, 0, 0);
    addFactToGraph(ctx.graph, "contact:1", "info_c", "old_c", 0.05, 0, 0, 0);

    const items = contribute(ctx as unknown as ModContext);
    const content = JSON.stringify(items);
    expect(content).toContain("memory-housekeeping");
    expect(content).toContain("fading");
    // ADR-66: 不再暴露函数名，改为自然语言
    expect(content).toContain("Merging these into a summary");
  });

  it("有 urgent directed 消息 → 不注入", () => {
    // ADR-81: 压力门控——有紧急 directed 消息时不注入簿记提示
    const nowMs = 6_000_000_000;
    const ctx = makeCtx({ hasDirected: true }, 100, nowMs);
    ctx.graph.addContact("contact:1");
    addFactToGraph(ctx.graph, "contact:1", "info_a", "old_a", 0.05, 0, 0, 0);
    addFactToGraph(ctx.graph, "contact:1", "info_b", "old_b", 0.05, 0, 0, 0);
    addFactToGraph(ctx.graph, "contact:1", "info_c", "old_c", 0.05, 0, 0, 0);

    const items = contribute(ctx as unknown as ModContext);
    expect(items).toHaveLength(0);
  });

  it("衰减事实不足 3 条 → 不注入", () => {
    const nowMs = 6_000_000_000;
    const ctx = makeCtx({}, 100, nowMs);
    ctx.graph.addContact("contact:1");
    addFactToGraph(ctx.graph, "contact:1", "info_a", "old_a", 0.05, 0, 0, 0);
    addFactToGraph(ctx.graph, "contact:1", "info_b", "old_b", 0.05, 0, 0, 0);

    const items = contribute(ctx as unknown as ModContext);
    expect(items).toHaveLength(0);
  });

  it("所有事实 R 高 → 不注入", () => {
    // nowMs=100_000, last_access_ms=nowMs-1000 → gapS=1 → R≈1.0
    const nowMs = 100_000;
    const ctx = makeCtx({}, 100, nowMs);
    ctx.graph.addContact("contact:1");
    addFactToGraph(ctx.graph, "contact:1", "info_a", "fresh_a", 1.0, 95, 95, nowMs - 1_000);
    addFactToGraph(ctx.graph, "contact:1", "info_b", "fresh_b", 1.0, 96, 96, nowMs - 1_000);
    addFactToGraph(ctx.graph, "contact:1", "info_c", "fresh_c", 1.0, 97, 97, nowMs - 1_000);

    const items = contribute(ctx as unknown as ModContext);
    expect(items).toHaveLength(0);
  });
});
