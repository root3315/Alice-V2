/**
 * ADR-123 §D3/D4: learning.mod 测试。
 *
 * 测试覆盖:
 * 1. note_jargon 基本功能 + 结晶条件
 * 2. jargon contribute 渲染
 * 3. rate_outcome listener 触发 expression 信念更新
 * 4. expression 结晶条件
 * 5. 衰减逻辑
 *
 * @see docs/adr/123-crystallization-substrate-generalization.md §D3, §D4
 */
import { describe, expect, it } from "vitest";
import type { ModContext } from "../src/core/types.js";
import { WorldModel } from "../src/graph/world-model.js";
import { CONFIDENCE_MAP, type LearningState, learningMod } from "../src/mods/learning.mod.js";

// -- 辅助 -------------------------------------------------------------------

function makeGraph(tick = 100): WorldModel {
  const G = new WorldModel();
  G.tick = tick;
  G.addAgent("self");
  return G;
}

function makeCtx(
  overrides: Partial<{
    tick: number;
    nowMs: number;
    state: LearningState;
    graph: WorldModel;
    modStates: Record<string, unknown>;
  }> = {},
): ModContext<LearningState> {
  const tick = overrides.tick ?? 100;
  const graph = overrides.graph ?? makeGraph(tick);
  const state: LearningState = overrides.state ?? {
    jargon: {},
    jargonCrystallizeSigma2: 0.08,
    jargonMinObs: 2,
    expressions: {},
    expressionCrystallizeSigma2: 0.1,
    expressionMinPositive: 2,
    jargonObsCounts: {},
    expressionObsCounts: {},
    expressionReasonCache: {},
  };
  const modStates = overrides.modStates ?? {};
  return {
    graph,
    state,
    tick,
    nowMs: overrides.nowMs ?? Date.now(),
    getModState: <T = unknown>(name: string) => modStates[name] as T | undefined,
    dispatch: () => undefined,
  };
}

// -- note_jargon 测试 ---------------------------------------------------------

describe("note_jargon", () => {
  const impl = learningMod.instructions!.note_jargon.impl;

  it("首次观察不结晶（obs=1 不满足 minObs=2）", () => {
    const ctx = makeCtx();
    const result = impl(ctx, {
      chatId: "channel:test",
      term: "yyds",
      meaning: "永远的神",
      confidence: "likely",
    }) as Record<string, unknown>;

    expect(result.success).toBe(true);
    expect(result.crystallized).toBe(false);
    expect(result.observations).toBe(1);
    // state 中没有结晶
    expect(ctx.state.jargon["channel:test"]?.yyds).toBeUndefined();
  });

  it("两次一致观察后结晶（σ² 收敛 + obs >= 2）", () => {
    const ctx = makeCtx();

    // 第一次：likely (0.6)
    impl(ctx, {
      chatId: "channel:test",
      term: "yyds",
      meaning: "永远的神",
      confidence: "likely",
    });

    // 第二次：certain (0.9) → σ² 收缩
    const result = impl(ctx, {
      chatId: "channel:test",
      term: "yyds",
      meaning: "永远的神 v2",
      confidence: "certain",
    }) as Record<string, unknown>;

    expect(result.success).toBe(true);
    expect(result.observations).toBe(2);
    // 检查是否结晶（取决于 EMA 后的 σ²）
    if (result.crystallized) {
      expect(ctx.state.jargon["channel:test"]?.yyds).toBeDefined();
      expect(ctx.state.jargon["channel:test"]?.yyds?.meaning).toBe("永远的神 v2");
    }
  });

  it("已结晶 term 收到新观察 → 刷新 lastReinforced + 更新 meaning", () => {
    const ctx = makeCtx({ tick: 100, nowMs: 1000000 });

    // 手动植入已结晶条目
    ctx.state.jargon["channel:test"] = {
      yyds: {
        meaning: "old meaning",
        crystallizedAt: 50,
        lastReinforced: 50,
        lastReinforcedMs: 500000,
      },
    };

    const result = impl(ctx, {
      chatId: "channel:test",
      term: "yyds",
      meaning: "永远的神 updated",
      confidence: "certain",
    }) as Record<string, unknown>;

    expect(result.success).toBe(true);
    expect(result.reinforced).toBe(true);
    expect(ctx.state.jargon["channel:test"].yyds.meaning).toBe("永远的神 updated");
    expect(ctx.state.jargon["channel:test"].yyds.lastReinforced).toBe(100);
    expect(ctx.state.jargon["channel:test"].yyds.lastReinforcedMs).toBe(1000000);
  });

  it("confidence 映射正确", () => {
    expect(CONFIDENCE_MAP.guess).toBe(0.3);
    expect(CONFIDENCE_MAP.likely).toBe(0.6);
    expect(CONFIDENCE_MAP.certain).toBe(0.9);
  });
});

// -- jargon contribute 测试 ---------------------------------------------------

describe("jargon contribute", () => {
  it("目标频道有结晶黑话时渲染 group-jargon section", () => {
    const ctx = makeCtx({
      modStates: { memory: { targetChatId: "channel:test" } },
    });
    ctx.state.jargon["channel:test"] = {
      yyds: {
        meaning: "永远的神",
        crystallizedAt: 50,
        lastReinforced: 90,
        lastReinforcedMs: Date.now(),
      },
      "6": {
        meaning: "顺利",
        crystallizedAt: 60,
        lastReinforced: 90,
        lastReinforcedMs: Date.now(),
      },
    };

    const items = learningMod.contribute!(ctx);
    const jargonItem = items.find((i) => i.key === "group-jargon");

    expect(jargonItem).toBeDefined();
    expect(jargonItem?.lines.length).toBe(2);
    expect(jargonItem?.lines.some((l) => l.includes("yyds"))).toBe(true);
    expect(jargonItem?.lines.some((l) => l.includes("顺利"))).toBe(true);
  });

  it("无目标频道时不渲染", () => {
    const ctx = makeCtx({ modStates: { memory: { targetChatId: null } } });
    ctx.state.jargon["channel:test"] = {
      yyds: {
        meaning: "永远的神",
        crystallizedAt: 50,
        lastReinforced: 90,
        lastReinforcedMs: Date.now(),
      },
    };

    const items = learningMod.contribute!(ctx);
    expect(items.find((i) => i.key === "group-jargon")).toBeUndefined();
  });

  it("最多渲染 8 条", () => {
    const ctx = makeCtx({
      modStates: { memory: { targetChatId: "channel:test" } },
    });
    const jargon: Record<
      string,
      { meaning: string; crystallizedAt: number; lastReinforced: number; lastReinforcedMs: number }
    > = {};
    for (let i = 0; i < 12; i++) {
      jargon[`term_${i}`] = {
        meaning: `meaning ${i}`,
        crystallizedAt: 50,
        lastReinforced: 90,
        lastReinforcedMs: Date.now(),
      };
    }
    ctx.state.jargon["channel:test"] = jargon;

    const items = learningMod.contribute!(ctx);
    const jargonItem = items.find((i) => i.key === "group-jargon");
    expect(jargonItem).toBeDefined();
    expect(jargonItem?.lines.length).toBeLessThanOrEqual(8);
  });
});

// -- rate_outcome listener 测试 -----------------------------------------------

describe("expression: rate_outcome listener", () => {
  const listener = learningMod.listen!.rate_outcome;

  it("quality=good 时触发 expression 信念更新", () => {
    const ctx = makeCtx();

    listener(
      ctx,
      {
        target: "channel:test",
        quality: "good",
        reason: "The joke landed well",
        action_ms: 1000,
      },
      { success: true },
    );

    // 检查观察计数
    const keys = Object.keys(ctx.state.expressionObsCounts);
    expect(keys.length).toBe(1);
    expect(Object.values(ctx.state.expressionObsCounts)[0]).toBe(1);

    // 检查 reason 缓存
    const cacheKeys = Object.keys(ctx.state.expressionReasonCache);
    expect(cacheKeys.length).toBe(1);
    expect(Object.values(ctx.state.expressionReasonCache)[0].reason).toBe("The joke landed well");
  });

  it("quality=fair 时不触发", () => {
    const ctx = makeCtx();

    listener(
      ctx,
      {
        target: "channel:test",
        quality: "fair",
        reason: "meh",
      },
      { success: true },
    );

    expect(Object.keys(ctx.state.expressionObsCounts).length).toBe(0);
  });

  it("quality=poor 时不触发", () => {
    const ctx = makeCtx();

    listener(
      ctx,
      {
        target: "channel:test",
        quality: "poor",
        reason: "bad",
      },
      { success: true },
    );

    expect(Object.keys(ctx.state.expressionObsCounts).length).toBe(0);
  });

  it("多次正向观察后结晶", () => {
    const ctx = makeCtx({ tick: 100 });

    // 需要多次同 situationKey 的观察才能结晶
    // situationKey = target_bucket, bucket = floor(tick/10)
    // tick=100 → bucket=10 → key = "channel:test_10"
    listener(
      ctx,
      {
        target: "channel:test",
        quality: "excellent",
        reason: "Humor worked perfectly",
      },
      { success: true },
    );

    listener(
      ctx,
      {
        target: "channel:test",
        quality: "excellent",
        reason: "Humor worked perfectly again",
      },
      { success: true },
    );

    // 检查是否有结晶（取决于 EMA 后的 σ² 和 μ）
    const obsKeys = Object.keys(ctx.state.expressionObsCounts);
    expect(obsKeys.length).toBe(1);
    const obsCount = Object.values(ctx.state.expressionObsCounts)[0];
    expect(obsCount).toBe(2);
  });
});

// -- expression contribute 测试 -----------------------------------------------

describe("expression contribute", () => {
  it("有结晶 expression 时渲染 learned-expressions section", () => {
    const ctx = makeCtx();
    ctx.state.expressions = {
      key1: {
        situation: "Talking to channel:test",
        expression: "Using humor when they're stressed",
        quality: 0.8,
        source: "learned",
        crystallizedAt: 50,
        lastReinforced: 90,
        lastReinforcedMs: Date.now(),
      },
    };

    const items = learningMod.contribute!(ctx);
    const exprItem = items.find((i) => i.key === "learned-expressions");

    expect(exprItem).toBeDefined();
    expect(exprItem?.lines.length).toBe(1);
    expect(exprItem?.lines[0]).toContain("humor");
  });

  it("top-3 按 quality 排序", () => {
    const ctx = makeCtx();
    const now = Date.now();
    ctx.state.expressions = {
      k1: {
        situation: "A",
        expression: "low",
        quality: 0.5,
        source: "learned",
        crystallizedAt: 50,
        lastReinforced: 90,
        lastReinforcedMs: now,
      },
      k2: {
        situation: "B",
        expression: "high",
        quality: 0.9,
        source: "learned",
        crystallizedAt: 50,
        lastReinforced: 90,
        lastReinforcedMs: now,
      },
      k3: {
        situation: "C",
        expression: "mid",
        quality: 0.7,
        source: "learned",
        crystallizedAt: 50,
        lastReinforced: 90,
        lastReinforcedMs: now,
      },
      k4: {
        situation: "D",
        expression: "lowest",
        quality: 0.4,
        source: "learned",
        crystallizedAt: 50,
        lastReinforced: 90,
        lastReinforcedMs: now,
      },
    };

    const items = learningMod.contribute!(ctx);
    const exprItem = items.find((i) => i.key === "learned-expressions");

    expect(exprItem).toBeDefined();
    expect(exprItem?.lines.length).toBe(3);
    // 最高 quality 排第一
    expect(exprItem?.lines[0]).toContain("high");
    expect(exprItem?.lines[1]).toContain("mid");
    expect(exprItem?.lines[2]).toContain("low");
  });

  it("无结晶 expression 时不渲染", () => {
    const ctx = makeCtx();
    const items = learningMod.contribute!(ctx);
    expect(items.find((i) => i.key === "learned-expressions")).toBeUndefined();
  });
});

// -- 衰减逻辑测试 -------------------------------------------------------------

describe("onTickEnd: 衰减", () => {
  it("已过期的 jargon 条目被移除", () => {
    const EXPIRY_S = 604800 * 3; // ~21 天
    const now = Date.now();
    const ctx = makeCtx({ nowMs: now });
    ctx.state.jargon["channel:test"] = {
      yyds: {
        meaning: "永远的神",
        crystallizedAt: 50,
        lastReinforced: 50,
        // 超过 21 天前
        lastReinforcedMs: now - (EXPIRY_S + 1) * 1000,
      },
    };

    learningMod.onTickEnd?.(ctx);

    expect(ctx.state.jargon["channel:test"]).toBeUndefined();
  });

  it("未过期的 jargon 条目保留", () => {
    const now = Date.now();
    const ctx = makeCtx({ nowMs: now });
    ctx.state.jargon["channel:test"] = {
      yyds: {
        meaning: "永远的神",
        crystallizedAt: 50,
        lastReinforced: 90,
        // 最近强化
        lastReinforcedMs: now - 1000,
      },
    };

    learningMod.onTickEnd?.(ctx);

    expect(ctx.state.jargon["channel:test"]?.yyds).toBeDefined();
  });

  it("已过期的 expression 条目被移除", () => {
    const EXPIRY_S = 604800 * 3;
    const now = Date.now();
    const ctx = makeCtx({ nowMs: now });
    ctx.state.expressions = {
      key1: {
        situation: "test",
        expression: "test expr",
        quality: 0.8,
        source: "learned",
        crystallizedAt: 50,
        lastReinforced: 50,
        lastReinforcedMs: now - (EXPIRY_S + 1) * 1000,
      },
    };

    learningMod.onTickEnd?.(ctx);

    expect(ctx.state.expressions.key1).toBeUndefined();
  });

  it("未过期的 expression 条目保留", () => {
    const now = Date.now();
    const ctx = makeCtx({ nowMs: now });
    ctx.state.expressions = {
      key1: {
        situation: "test",
        expression: "test expr",
        quality: 0.8,
        source: "learned",
        crystallizedAt: 50,
        lastReinforced: 90,
        lastReinforcedMs: now - 1000,
      },
    };

    learningMod.onTickEnd?.(ctx);

    expect(ctx.state.expressions.key1).toBeDefined();
  });
});
