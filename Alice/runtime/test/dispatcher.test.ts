/**
 * Dispatcher 单元测试 — createAliceDispatcher 核心行为验证。
 *
 * 测试覆盖:
 * 1. dispatch 已注册指令 → 执行成功
 * 2. dispatch 未注册指令 → 返回 undefined
 * 3. query 已注册查询 → 返回结果
 * 4. query 未注册查询 → 返回 undefined
 * 5. dispatch 触发 listener 广播
 * 6. MAX_DISPATCH_DEPTH 递归保护
 * 7. startTick / endTick 生命周期
 * 8. collectContributions 收集贡献
 * 9. snapshotModStates / restoreModStates 快照回滚（ADR-31）
 * 10. getInstructionNames / getQueryNames 正确列表
 */
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

vi.mock("../src/skills/backends/docker.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/skills/backends/docker.js")>();
  return {
    ...original,
    executeDockerCommand: vi
      .fn()
      .mockResolvedValue(
        "CMD\tirc\nCMD\tctl\nCMD\tself\nCMD\tengine\nCMD\task\nCMD\talice-pkg\nMAN\tirc\nMAN\tctl\n",
      ),
  };
});

import { createAliceDispatcher } from "../src/core/dispatcher.js";
import { createMod } from "../src/core/mod-builder.js";
import { PromptBuilder } from "../src/core/prompt-style.js";
import { WorldModel } from "../src/graph/world-model.js";

// -- 测试用 Mod 定义 ----------------------------------------------------------

interface CounterState {
  count: number;
  lastListenedInstruction: string | null;
  tickStartCalled: boolean;
  tickEndCalled: boolean;
}

const counterMod = createMod<CounterState>("counter", {
  category: "core",
  description: "测试用计数器 Mod",
  topics: ["memory"],
  initialState: {
    count: 0,
    lastListenedInstruction: null,
    tickStartCalled: false,
    tickEndCalled: false,
  },
})
  .instruction("INCREMENT", {
    params: z.object({
      amount: z.number().optional().describe("增量"),
    }),
    description: "增加计数器",
    affordance: { priority: "core", whenToUse: "test", whenNotToUse: "test" },
    impl: (ctx, args) => {
      const amount = (args.amount as number) ?? 1;
      ctx.state.count += amount;
      return { success: true, newCount: ctx.state.count };
    },
  })
  .instruction("DECREMENT", {
    params: z.object({}),
    description: "减少计数器",
    affordance: { priority: "core", whenToUse: "test", whenNotToUse: "test" },
    impl: (ctx) => {
      ctx.state.count -= 1;
      return { success: true, newCount: ctx.state.count };
    },
  })
  .instruction("FAILING_INSTRUCTION", {
    params: z.object({}),
    description: "必定失败的指令",
    // 无 affordance — 内部指令，不渲染到 manual
    impl: () => {
      throw new Error("Intentional failure");
    },
  })
  .query("getCount", {
    params: z.object({}),
    description: "获取当前计数",
    affordance: { priority: "core", whenToUse: "test", whenNotToUse: "test" },
    impl: (ctx) => ctx.state.count,
  })
  .query("getState", {
    params: z.object({}),
    description: "获取完整状态",
    impl: (ctx) => ({ ...ctx.state }),
  })
  .onTickStart((ctx) => {
    ctx.state.tickStartCalled = true;
  })
  .onTickEnd((ctx) => {
    ctx.state.tickEndCalled = true;
  })
  .contribute((ctx) => {
    if (ctx.state.count === 0) return [];
    return [
      {
        bucket: "section",
        key: "counter-status",
        title: "Counter",
        lines: [PromptBuilder.of(`Current count: ${ctx.state.count}`)],
      },
    ];
  })
  .build();

interface ListenerState {
  listenedEvents: Array<{ instruction: string; args: Record<string, unknown>; result: unknown }>;
}

const listenerMod = createMod<ListenerState>("listener", {
  category: "mechanic",
  description: "测试用监听器 Mod",
  initialState: { listenedEvents: [] },
})
  .listen("INCREMENT", (ctx, args, result) => {
    ctx.state.listenedEvents.push({ instruction: "INCREMENT", args, result });
  })
  .listen("DECREMENT", (ctx, args, result) => {
    ctx.state.listenedEvents.push({ instruction: "DECREMENT", args, result });
  })
  .contribute((ctx) => {
    if (ctx.state.listenedEvents.length === 0) return [];
    return [
      {
        bucket: "footer",
        lines: [PromptBuilder.of(`Events heard: ${ctx.state.listenedEvents.length}`)],
      },
    ];
  })
  .build();

// -- 测试 ---------------------------------------------------------------------

describe("createAliceDispatcher", () => {
  function setup() {
    const graph = new WorldModel();
    const dispatcher = createAliceDispatcher({
      graph,
      mods: [counterMod, listenerMod],
    });
    return { graph, dispatcher };
  }

  // 1. dispatch 已注册指令 → 执行成功
  it("dispatch 已注册指令 → 执行成功并返回结果", () => {
    const { dispatcher } = setup();
    const result = dispatcher.dispatch("INCREMENT", { amount: 5 });
    expect(result).toEqual({ success: true, newCount: 5 });
  });

  // 2. dispatch 未注册指令 → 返回 undefined
  it("dispatch 未注册指令 → 返回 undefined", () => {
    const { dispatcher } = setup();
    const result = dispatcher.dispatch("NONEXISTENT", {});
    expect(result).toBeUndefined();
  });

  // 3. query 已注册查询 → 返回结果
  it("query 已注册查询 → 返回结果", () => {
    const { dispatcher } = setup();
    dispatcher.dispatch("INCREMENT", { amount: 3 });
    const count = dispatcher.query("getCount", {});
    expect(count).toBe(3);
  });

  // 4. query 未注册查询 → 返回 undefined
  it("query 未注册查询 → 返回 undefined", () => {
    const { dispatcher } = setup();
    const result = dispatcher.query("nonexistentQuery", {});
    expect(result).toBeUndefined();
  });

  // 5. dispatch 触发 listener 广播
  it("dispatch 触发 listener 广播", () => {
    const { dispatcher } = setup();
    dispatcher.dispatch("INCREMENT", { amount: 10 });

    // listener mod 应该收到广播
    const _listenerState = dispatcher.query("getState", {}) as CounterState;
    // 上面查的是 counter mod 的 getState，我们需要通过 snapshotModStates 验证 listener 状态
    const snapshot = dispatcher.snapshotModStates();
    const lState = snapshot.get("listener") as ListenerState;
    expect(lState.listenedEvents).toHaveLength(1);
    expect(lState.listenedEvents[0].instruction).toBe("INCREMENT");
    expect(lState.listenedEvents[0].result).toEqual({ success: true, newCount: 10 });
  });

  // 5b. 多次 dispatch → listener 收到多次广播
  it("多次 dispatch → listener 累积收到所有广播", () => {
    const { dispatcher } = setup();
    dispatcher.dispatch("INCREMENT", { amount: 1 });
    dispatcher.dispatch("DECREMENT", {});
    dispatcher.dispatch("INCREMENT", { amount: 5 });

    const snapshot = dispatcher.snapshotModStates();
    const lState = snapshot.get("listener") as ListenerState;
    expect(lState.listenedEvents).toHaveLength(3);
    expect(lState.listenedEvents[0].instruction).toBe("INCREMENT");
    expect(lState.listenedEvents[1].instruction).toBe("DECREMENT");
    expect(lState.listenedEvents[2].instruction).toBe("INCREMENT");
  });

  // 6. MAX_DISPATCH_DEPTH 递归保护
  it("MAX_DISPATCH_DEPTH 递归保护 → 深度超限时返回 undefined", () => {
    const graph = new WorldModel();

    // 创建一个递归 dispatch 的 Mod
    const recursiveMod = createMod<{ depth: number }>("recursive", {
      category: "core",
      initialState: { depth: 0 },
    })
      .instruction("RECURSE", {
        params: z.object({}),
        description: "递归调用自身",
        impl: (ctx) => {
          ctx.state.depth += 1;
          // 通过 ctx.dispatch 调用自身 → 会递归
          const innerResult = ctx.dispatch("RECURSE", {});
          return { depth: ctx.state.depth, innerResult };
        },
      })
      .query("getDepth", {
        params: z.object({}),
        description: "获取深度",
        impl: (ctx) => ctx.state.depth,
      })
      .build();

    const dispatcher = createAliceDispatcher({ graph, mods: [recursiveMod] });
    const result = dispatcher.dispatch("RECURSE", {});

    // 应该在某层返回 undefined（MAX_DISPATCH_DEPTH = 10）
    // 最外层仍会执行，但内层到 10 层时返回 undefined
    const depth = dispatcher.query("getDepth", {}) as number;
    expect(depth).toBe(10); // 执行了 10 层
    expect(result).toBeDefined(); // 外层有返回
  });

  // 7. startTick / endTick 生命周期
  it("startTick 调用各 mod 的 onTickStart", () => {
    const { dispatcher } = setup();
    dispatcher.startTick(42);

    const snapshot = dispatcher.snapshotModStates();
    const cState = snapshot.get("counter") as CounterState;
    expect(cState.tickStartCalled).toBe(true);
    expect(cState.tickEndCalled).toBe(false);
  });

  it("endTick 调用各 mod 的 onTickEnd", () => {
    const { dispatcher } = setup();
    dispatcher.endTick(42);

    const snapshot = dispatcher.snapshotModStates();
    const cState = snapshot.get("counter") as CounterState;
    expect(cState.tickEndCalled).toBe(true);
  });

  // 8. collectContributions 收集贡献
  it("collectContributions 收集所有 mod 的贡献", () => {
    const { dispatcher } = setup();

    // 初始状态 count=0 → counter mod 不贡献
    let contributions = dispatcher.collectContributions();
    expect(contributions).toHaveLength(0);

    // INCREMENT → count > 0 → counter mod 贡献
    dispatcher.dispatch("INCREMENT", { amount: 7 });
    contributions = dispatcher.collectContributions();
    expect(contributions.length).toBeGreaterThanOrEqual(1);

    const counterContrib = contributions.find((c) => c.key === "counter-status");
    expect(counterContrib).toBeDefined();
    expect(counterContrib?.lines[0]).toContain("7");
  });

  it("collectContributions 收集 listener mod 的贡献", () => {
    const { dispatcher } = setup();
    dispatcher.dispatch("INCREMENT", {});

    const contributions = dispatcher.collectContributions();
    const listenerContrib = contributions.find((c) => c.bucket === "footer");
    expect(listenerContrib).toBeDefined();
    expect(listenerContrib?.lines[0]).toContain("Events heard: 1");
  });

  // 9. snapshotModStates / restoreModStates
  it("snapshotModStates 返回深拷贝", () => {
    const { dispatcher } = setup();
    dispatcher.dispatch("INCREMENT", { amount: 10 });

    const snap = dispatcher.snapshotModStates();
    const cState = snap.get("counter") as CounterState;
    expect(cState.count).toBe(10);

    // 修改快照不影响 dispatcher 内部状态
    cState.count = 999;
    const count = dispatcher.query("getCount", {});
    expect(count).toBe(10);
  });

  it("restoreModStates 从快照恢复状态", () => {
    const { dispatcher } = setup();

    // 快照初始状态
    const snap = dispatcher.snapshotModStates();

    // 修改状态
    dispatcher.dispatch("INCREMENT", { amount: 100 });
    expect(dispatcher.query("getCount", {})).toBe(100);

    // 恢复
    dispatcher.restoreModStates(snap);
    expect(dispatcher.query("getCount", {})).toBe(0);
  });

  it("restoreModStates 恢复后 listener 状态也回滚", () => {
    const { dispatcher } = setup();

    const snap = dispatcher.snapshotModStates();
    dispatcher.dispatch("INCREMENT", {});
    dispatcher.dispatch("INCREMENT", {});

    // listener 已记录 2 个事件
    let lSnap = dispatcher.snapshotModStates().get("listener") as ListenerState;
    expect(lSnap.listenedEvents).toHaveLength(2);

    // 恢复
    dispatcher.restoreModStates(snap);
    lSnap = dispatcher.snapshotModStates().get("listener") as ListenerState;
    expect(lSnap.listenedEvents).toHaveLength(0);
  });

  // 10. getInstructionNames / getQueryNames
  it("getInstructionNames 返回所有已注册指令", () => {
    const { dispatcher } = setup();
    const names = dispatcher.getInstructionNames();
    expect(names).toContain("INCREMENT");
    expect(names).toContain("DECREMENT");
    expect(names).toContain("FAILING_INSTRUCTION");
    expect(names).not.toContain("getCount");
  });

  it("getQueryNames 返回所有已注册查询", () => {
    const { dispatcher } = setup();
    const names = dispatcher.getQueryNames();
    expect(names).toContain("getCount");
    expect(names).toContain("getState");
    expect(names).not.toContain("INCREMENT");
  });

  // -- 边缘情况 ----------------------------------------------------------------

  it("dispatch 失败的指令 → 返回 undefined（不崩溃）", () => {
    const { dispatcher } = setup();
    const result = dispatcher.dispatch("FAILING_INSTRUCTION", {});
    expect(result).toBeUndefined();
  });

  it("dispatch 失败不影响 listener", () => {
    const { dispatcher } = setup();
    // FAILING_INSTRUCTION 没有 listener，不会触发广播
    dispatcher.dispatch("FAILING_INSTRUCTION", {});

    const snap = dispatcher.snapshotModStates();
    const lState = snap.get("listener") as ListenerState;
    expect(lState.listenedEvents).toHaveLength(0);
  });

  it("generateManual 返回非空字符串", async () => {
    const { dispatcher } = setup();
    const manual = await dispatcher.generateManual();
    expect(manual).toBeTruthy();
    // ADR-217: All instructions render as `self <name>` (unified namespace)
    expect(manual).toContain("self INCREMENT");
    expect(manual).toContain("self DECREMENT");
    expect(manual).toContain("getCount");
  });

  it("mods 属性返回注册的 mod 列表", () => {
    const { dispatcher } = setup();
    expect(dispatcher.mods).toHaveLength(2);
    expect(dispatcher.mods[0].meta.name).toBe("counter");
    expect(dispatcher.mods[1].meta.name).toBe("listener");
  });

  it("initialState 正确深拷贝（修改不影响原始定义）", () => {
    const { dispatcher } = setup();
    dispatcher.dispatch("INCREMENT", { amount: 50 });
    expect(dispatcher.query("getCount", {})).toBe(50);

    // 创建新 dispatcher → 初始状态应为 0
    const graph2 = new WorldModel();
    const dispatcher2 = createAliceDispatcher({
      graph: graph2,
      mods: [counterMod, listenerMod],
    });
    expect(dispatcher2.query("getCount", {})).toBe(0);
  });

  it("空 Mod 列表 → dispatcher 正常创建", () => {
    const graph = new WorldModel();
    const dispatcher = createAliceDispatcher({ graph, mods: [] });
    expect(dispatcher.getInstructionNames()).toHaveLength(0);
    expect(dispatcher.getQueryNames()).toHaveLength(0);
    expect(dispatcher.collectContributions()).toHaveLength(0);
  });

  it("getModState 跨 Mod 读取状态", () => {
    const graph = new WorldModel();

    // 创建一个可以通过 getModState 读取 counter 状态的 Mod
    const readerMod = createMod<{ readCount: number | null }>("reader", {
      category: "mechanic",
      initialState: { readCount: null },
    })
      .query("readCounterCount", {
        params: z.object({}),
        description: "通过 getModState 读取 counter 状态",
        impl: (ctx) => {
          const counterState = ctx.getModState<CounterState>("counter");
          return counterState?.count ?? -1;
        },
      })
      .build();

    const dispatcher = createAliceDispatcher({
      graph,
      mods: [counterMod, readerMod],
    });

    // 初始 count=0
    expect(dispatcher.query("readCounterCount", {})).toBe(0);

    dispatcher.dispatch("INCREMENT", { amount: 42 });
    expect(dispatcher.query("readCounterCount", {})).toBe(42);
  });
});
