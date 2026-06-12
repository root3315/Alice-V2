/**
 * ADR-79 M3: Mod State 深度合并测试。
 *
 * 覆盖:
 * 1. 保留旧值 — persisted 覆盖 initial
 * 2. 迁移新字段 — initial 中有但 persisted 中没有的字段保留默认值
 * 3. 嵌套合并 — 递归合并 plain object
 * 4. 数组以 persisted 为准
 * 5. 向前兼容 — persisted 中有但 initial 中没有的字段保留
 * 6. 非对象 state — 直接以 persisted 为准
 *
 * @see runtime/src/core/dispatcher.ts — deepMergeModState
 */
import { describe, expect, it } from "vitest";
import { deepMergeModState } from "../src/core/dispatcher.js";

describe("deepMergeModState", () => {
  it("persisted 覆盖 initial 的已有字段", () => {
    const initial = { count: 0, name: "default" };
    const persisted = { count: 42, name: "alice" };
    const merged = deepMergeModState(initial, persisted);

    expect(merged).toEqual({ count: 42, name: "alice" });
  });

  it("新字段从 initial 迁移", () => {
    const initial = { count: 0, name: "default", newField: "hello" };
    const persisted = { count: 42, name: "alice" };
    const merged = deepMergeModState(initial, persisted);

    expect(merged).toEqual({ count: 42, name: "alice", newField: "hello" });
  });

  it("嵌套对象递归合并", () => {
    const initial = {
      config: {
        threshold: 0.5,
        newOption: true,
        nested: { a: 1, b: 2 },
      },
    };
    const persisted = {
      config: {
        threshold: 0.8,
        // newOption 不存在 → 应从 initial 迁移
        nested: { a: 10 },
        // b 不存在 → 应从 initial.config.nested 迁移
      },
    };
    const merged = deepMergeModState(initial, persisted) as Record<string, unknown>;

    expect((merged.config as Record<string, unknown>).threshold).toBe(0.8);
    expect((merged.config as Record<string, unknown>).newOption).toBe(true);
    const nested = (merged.config as Record<string, unknown>).nested as Record<string, unknown>;
    expect(nested.a).toBe(10);
    expect(nested.b).toBe(2);
  });

  it("数组以 persisted 为准（不合并数组元素）", () => {
    const initial = { items: [1, 2, 3] };
    const persisted = { items: [10, 20] };
    const merged = deepMergeModState(initial, persisted);

    expect(merged).toEqual({ items: [10, 20] });
  });

  it("向前兼容 — persisted 中有但 initial 没有的字段保留", () => {
    const initial = { count: 0 };
    const persisted = { count: 42, legacyField: "old" };
    const merged = deepMergeModState(initial, persisted);

    expect(merged).toEqual({ count: 42, legacyField: "old" });
  });

  it("非对象 state — 直接以 persisted 为准", () => {
    // 数值 state
    expect(deepMergeModState(0, 42)).toBe(42);
    // 字符串 state
    expect(deepMergeModState("default", "custom")).toBe("custom");
    // null state
    expect(deepMergeModState(null, { count: 1 })).toEqual({ count: 1 });
  });

  it("initial 是对象但 persisted 不是 → 以 persisted 为准", () => {
    const initial = { count: 0 };
    const persisted = null;
    expect(deepMergeModState(initial, persisted)).toBeNull();
  });

  it("新字段是深拷贝（不共享引用）", () => {
    const initial = { config: { items: [1, 2] } };
    const persisted = {};
    const merged = deepMergeModState(initial, persisted) as Record<string, unknown>;

    // 修改原始 initial 不应影响 merged
    initial.config.items.push(3);
    const mergedConfig = merged.config as Record<string, unknown>;
    expect((mergedConfig.items as number[]).length).toBe(2);
  });

  it("复杂场景: 多层嵌套 + 新字段 + 数组混合", () => {
    interface SoulState {
      memories: Array<{ id: number; text: string }>;
      config: {
        decay: number;
        newFeature?: {
          enabled: boolean;
          threshold: number;
        };
      };
      version: number;
    }

    const initial: SoulState = {
      memories: [],
      config: {
        decay: 0.95,
        newFeature: {
          enabled: false,
          threshold: 0.5,
        },
      },
      version: 2,
    };

    // DB 中保存的旧版 state（没有 newFeature）
    const persisted = {
      memories: [{ id: 1, text: "hello" }],
      config: {
        decay: 0.9,
        // newFeature 不存在
      },
      version: 1,
    };

    const merged = deepMergeModState(initial, persisted) as SoulState;

    // memories 以 persisted 为准
    expect(merged.memories).toEqual([{ id: 1, text: "hello" }]);
    // config.decay 以 persisted 为准
    expect(merged.config.decay).toBe(0.9);
    // config.newFeature 从 initial 迁移
    expect(merged.config.newFeature).toEqual({ enabled: false, threshold: 0.5 });
    // version 以 persisted 为准
    expect(merged.version).toBe(1);
  });
});
