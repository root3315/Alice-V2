/**
 * mod-builder.ts 单元测试。
 *
 * 覆盖：
 * 1. extractDescription — 直接 .describe()、wrapped（各种嵌套顺序）
 * 2. zodToParamDefs — 多参数 z.object → ParamDefinition record
 * 3. createMod 完整链式调用 → build() 输出满足 ModDefinition 结构
 * 4. 空 instructions/queries 的 build → 对应字段为 undefined
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createMod, extractDescription, zodToParamDefs } from "../src/core/mod-builder.js";
import { PromptBuilder } from "../src/core/prompt-style.js";
import type { ModDefinition } from "../src/core/types.js";

// ── extractDescription ──────────────────────────────────────────────────────

describe("extractDescription", () => {
  it("直接 .describe()", () => {
    expect(extractDescription(z.string().describe("hello"))).toBe("hello");
  });

  it(".describe().optional() — describe 在内层", () => {
    expect(extractDescription(z.string().describe("inner").optional())).toBe("inner");
  });

  it(".optional().describe() — describe 在外层", () => {
    expect(extractDescription(z.string().optional().describe("outer"))).toBe("outer");
  });

  it(".describe().default() — describe 在 default 内层", () => {
    expect(extractDescription(z.number().describe("with default").default(42))).toBe(
      "with default",
    );
  });

  it(".describe().nullable() — describe 在 nullable 内层", () => {
    expect(extractDescription(z.string().describe("nullable test").nullable())).toBe(
      "nullable test",
    );
  });

  it("无 describe 返回空字符串", () => {
    expect(extractDescription(z.string())).toBe("");
  });

  it("深层嵌套: .describe().optional().default()", () => {
    const schema = z.string().describe("deep").optional().default("x");
    expect(extractDescription(schema)).toBe("deep");
  });
});

// ── zodToParamDefs ──────────────────────────────────────────────────────────

describe("zodToParamDefs", () => {
  it("多参数 z.object → ParamDefinition record", () => {
    const shape = {
      name: z.string().describe("用户名"),
      age: z.number().int().positive().describe("年龄"),
      email: z.string().email().optional().describe("邮箱"),
    };
    const defs = zodToParamDefs(shape);

    expect(Object.keys(defs)).toEqual(["name", "age", "email"]);
    expect(defs.name.description).toBe("用户名");
    expect(defs.age.description).toBe("年龄");
    expect(defs.email.description).toBe("邮箱");
    // schema 保留原始引用
    expect(defs.name.schema).toBe(shape.name);
  });

  it("空 shape → 空 record", () => {
    expect(zodToParamDefs({})).toEqual({});
  });
});

// ── createMod + build ───────────────────────────────────────────────────────

describe("createMod", () => {
  interface TestState {
    count: number;
  }

  it("完整链式调用 → build() 输出满足 ModDefinition", () => {
    const mod: ModDefinition = createMod<TestState>("test-mod", {
      category: "mechanic",
      description: "测试 mod",
      topics: ["test"],
      initialState: { count: 0 },
    })
      .instruction("increment", {
        params: z.object({
          amount: z.number().int().positive().describe("增量"),
        }),
        description: "增加计数",
        impl(ctx, args) {
          ctx.state.count += args.amount;
          return ctx.state.count;
        },
      })
      .query("getCount", {
        params: z.object({}),
        description: "获取计数",
        returns: "number",
        impl(ctx) {
          return ctx.state.count;
        },
      })
      .listen("some_event", (ctx, _args) => {
        ctx.state.count = 0;
      })
      .contribute((ctx) => [
        {
          bucket: "section",
          key: "test",
          lines: [PromptBuilder.of(`count=${ctx.state.count}`)],
        },
      ])
      .onTickStart((ctx) => {
        ctx.state.count = 0;
      })
      .onTickEnd((ctx) => {
        ctx.state.count++;
      })
      .build();

    // meta
    expect(mod.meta.name).toBe("test-mod");
    expect(mod.meta.category).toBe("mechanic");
    expect(mod.meta.description).toBe("测试 mod");
    expect(mod.meta.topics).toEqual(["test"]);

    // initialState
    expect(mod.initialState).toEqual({ count: 0 });

    // instructions
    expect(mod.instructions).toBeDefined();
    expect(mod.instructions?.increment).toBeDefined();
    expect(mod.instructions?.increment.description).toBe("增加计数");
    expect(mod.instructions?.increment.params.amount.description).toBe("增量");

    // queries
    expect(mod.queries).toBeDefined();
    expect(mod.queries?.getCount).toBeDefined();
    expect(mod.queries?.getCount.returns).toBe("number");

    // listen
    expect(mod.listen).toBeDefined();
    expect(typeof mod.listen?.some_event).toBe("function");

    // lifecycle hooks
    expect(typeof mod.onTickStart).toBe("function");
    expect(typeof mod.onTickEnd).toBe("function");

    // contribute
    expect(typeof mod.contribute).toBe("function");
  });

  it("空 instructions/queries → undefined", () => {
    const mod = createMod<TestState>("empty", {
      category: "core",
      initialState: { count: 0 },
    }).build();

    expect(mod.instructions).toBeUndefined();
    expect(mod.queries).toBeUndefined();
    expect(mod.listen).toBeUndefined();
    expect(mod.onTickStart).toBeUndefined();
    expect(mod.onTickEnd).toBeUndefined();
    expect(mod.contribute).toBeUndefined();
  });

  it("只有 instructions → queries 为 undefined", () => {
    const mod = createMod<TestState>("instr-only", {
      category: "mechanic",
      initialState: { count: 0 },
    })
      .instruction("inc", {
        params: z.object({
          n: z.number().describe("数量"),
        }),
        description: "加",
        impl(ctx, args) {
          ctx.state.count += args.n;
        },
      })
      .build();

    expect(mod.instructions).toBeDefined();
    expect(mod.queries).toBeUndefined();
  });

  it("depends 传递到 meta", () => {
    const mod = createMod<TestState>("with-deps", {
      category: "mechanic",
      depends: ["observer", "memory"],
      initialState: { count: 0 },
    }).build();

    expect(mod.meta.depends).toEqual(["observer", "memory"]);
  });

  it("instruction 的 deriveParams / perTurnCap / affordance / examples 保留", () => {
    const mod = createMod<TestState>("rich", {
      category: "mechanic",
      initialState: { count: 0 },
    })
      .instruction("rich_instr", {
        params: z.object({
          target: z.string().optional().describe("目标"),
        }),
        description: "丰富指令",
        examples: ['rich_instr({ target: "test" })'],
        deriveParams: {
          target: (cv) => cv.TARGET,
        },
        perTurnCap: { limit: 2, group: "rich" },
        affordance: {
          whenToUse: "Test",
          whenNotToUse: "Never",
          priority: "capability",
          category: "social",
        },
        impl() {
          return true;
        },
      })
      .build();

    const instr = mod.instructions!["rich_instr"];
    expect(instr.examples).toEqual(['rich_instr({ target: "test" })']);
    expect(instr.deriveParams).toBeDefined();
    expect(instr.perTurnCap).toEqual({ limit: 2, group: "rich" });
    expect(instr.affordance).toBeDefined();
    expect(instr.affordance?.priority).toBe("capability");
  });

  it("query 的 deriveParams / format / affordance / returns 保留", () => {
    const mod = createMod<TestState>("query-rich", {
      category: "mechanic",
      initialState: { count: 0 },
    })
      .query("rich_query", {
        params: z.object({
          id: z.string().describe("ID"),
        }),
        description: "丰富查询",
        returns: "Array<{ id: string }>",
        deriveParams: { id: (cv) => cv.ID },
        affordance: {
          whenToUse: "Test",
          whenNotToUse: "Never",
          priority: "capability",
          category: "threads",
        },
        format: (result) => [String(result)],
        impl() {
          return [];
        },
      })
      .build();

    const query = mod.queries!["rich_query"];
    expect(query.returns).toBe("Array<{ id: string }>");
    expect(query.deriveParams).toBeDefined();
    expect(query.format).toBeDefined();
    expect(query.affordance?.priority).toBe("capability");
  });
});
