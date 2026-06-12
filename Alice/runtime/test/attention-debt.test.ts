/**
 * ADR-100: 注意力负债单元测试。
 *
 * 覆盖:
 * 1. debt 累积：未被选中的有压力 channel debt 增长
 * 2. debt 衰减：长期不增加时 debt 自然衰减趋零
 * 3. 死群不累积：API=0 的 channel debt 不增长
 * 4. 选中 channel：debt 仅衰减，不累积
 * 5. debt bonus 计算：tanh 归一化正确，边界行为
 *
 * @see docs/adr/100-attention-debt.md §9
 */
import { describe, expect, it } from "vitest";
import {
  type AttentionDebtConfig,
  DEFAULT_ATTENTION_DEBT_CONFIG,
  updateAttentionDebt,
} from "../src/pressure/attention-debt.js";

const cfg: AttentionDebtConfig = { ...DEFAULT_ATTENTION_DEBT_CONFIG };

describe("updateAttentionDebt", () => {
  it("未被选中且有压力的 channel → debt 增长", () => {
    const prev = new Map<string, number>();
    const pressures = new Map([
      ["channel:a", 1.0],
      ["channel:b", 0.5],
    ]);

    const next = updateAttentionDebt(prev, pressures, null, cfg);

    // 首次：D = 0 * (1-δ) + 1 * API_h = API_h
    expect(next.get("channel:a")).toBeCloseTo(1.0, 5);
    expect(next.get("channel:b")).toBeCloseTo(0.5, 5);
  });

  it("连续多 tick 不选中 → debt 持续增长", () => {
    let debt = new Map<string, number>();
    const pressures = new Map([["channel:a", 1.0]]);

    for (let i = 0; i < 5; i++) {
      debt = updateAttentionDebt(debt, pressures, null, cfg);
    }

    // 每 tick: D(n) = D(n-1) * 0.95 + 1.0
    // D(1)=1.0, D(2)=1.95, D(3)=2.8525, D(4)=3.7099, D(5)=4.5244
    // biome-ignore lint/style/noNonNullAssertion: key guaranteed by test setup
    const d = debt.get("channel:a")!;
    expect(d).toBeGreaterThan(4.0);
    expect(d).toBeLessThan(5.0);
  });

  it("选中的 channel → debt 仅衰减", () => {
    const prev = new Map([["channel:a", 10.0]]);
    const pressures = new Map([["channel:a", 2.0]]);

    // channel:a 被选中
    const next = updateAttentionDebt(prev, pressures, "channel:a", cfg);

    // D = 10 * (1 - 0.05) + 0 = 9.5（不累积，仅衰减）
    expect(next.get("channel:a")).toBeCloseTo(9.5, 5);
  });

  it("死群不累积（API=0）", () => {
    const prev = new Map([["channel:dead", 5.0]]);
    const pressures = new Map<string, number>(); // channel:dead 不出现 = 压力为 0

    const next = updateAttentionDebt(prev, pressures, null, cfg);

    // D = 5.0 * 0.95 + 0 = 4.75（仅衰减）
    expect(next.get("channel:dead")).toBeCloseTo(4.75, 5);
  });

  it("长期无压力 → debt 自然衰减趋零", () => {
    let debt = new Map([["channel:a", 10.0]]);
    const pressures = new Map<string, number>(); // 持续无压力

    for (let i = 0; i < 500; i++) {
      debt = updateAttentionDebt(debt, pressures, null, cfg);
    }

    // 500 ticks 后: 10 * 0.95^500 ≈ 7.7e-12 → 被清除（< 1e-6 阈值）
    expect(debt.has("channel:a")).toBe(false);
  });

  it("混合场景：选中一个，其余累积", () => {
    const prev = new Map([
      ["channel:a", 3.0],
      ["channel:b", 2.0],
    ]);
    const pressures = new Map([
      ["channel:a", 1.0],
      ["channel:b", 0.8],
    ]);

    // 选中 channel:a
    const next = updateAttentionDebt(prev, pressures, "channel:a", cfg);

    // "channel:a": 3.0 * 0.95 + 0 = 2.85（仅衰减）
    expect(next.get("channel:a")).toBeCloseTo(2.85, 5);
    // "channel:b": 2.0 * 0.95 + 0.8 = 2.7（衰减 + 累积）
    expect(next.get("channel:b")).toBeCloseTo(2.7, 5);
  });

  it("新 channel 首次出现时正确初始化 debt", () => {
    const prev = new Map<string, number>(); // 空
    const pressures = new Map([["channel:new", 0.3]]);

    const next = updateAttentionDebt(prev, pressures, "channel:other", cfg);

    expect(next.get("channel:new")).toBeCloseTo(0.3, 5);
  });

  it("冷频道（>7 天无新消息）仅衰减不累积", () => {
    const now = Date.now();
    const eightDaysAgo = now - 8 * 24 * 3600 * 1000;
    const prev = new Map([["channel:stale", 5.0]]);
    const pressures = new Map([["channel:stale", 2.0]]);
    const lastIncomingMs = new Map([["channel:stale", eightDaysAgo]]);

    const next = updateAttentionDebt(prev, pressures, null, cfg, 60, lastIncomingMs, now);

    // 冷频道：D = 5.0 * 0.95 + 0 = 4.75（仅衰减，不累积 2.0 的压力）
    expect(next.get("channel:stale")).toBeCloseTo(4.75, 5);
  });

  it("新消息到达后冷频道恢复正常累积", () => {
    const now = Date.now();
    const justNow = now - 60_000; // 1 分钟前收到新消息
    const prev = new Map([["channel:revived", 2.0]]);
    const pressures = new Map([["channel:revived", 1.5]]);
    const lastIncomingMs = new Map([["channel:revived", justNow]]);

    const next = updateAttentionDebt(prev, pressures, null, cfg, 60, lastIncomingMs, now);

    // 非冷频道：D = 2.0 * 0.95 + 1.5 = 3.4
    expect(next.get("channel:revived")).toBeCloseTo(3.4, 5);
  });

  it("无 lastIncomingMs 参数时向后兼容（不视为冷频道）", () => {
    const prev = new Map([["channel:a", 3.0]]);
    const pressures = new Map([["channel:a", 1.0]]);

    // 不传 lastIncomingMs → 旧行为
    const next = updateAttentionDebt(prev, pressures, null, cfg);

    // D = 3.0 * 0.95 + 1.0 = 3.85
    expect(next.get("channel:a")).toBeCloseTo(3.85, 5);
  });
});

// ADR-218 Phase 2: computeDebtBonus 已删除——U_coverage 被 U_fairness 取代。
// updateAttentionDebt 测试保留（debt 累积仍用于压力监控）。
