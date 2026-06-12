/**
 * ADR-125: 自适应节奏冷却单元测试。
 *
 * 覆盖 computeAdaptiveCooldown 纯函数：
 * 1. 快模型 + 对话 → cooldown 补偿 engagement 时长
 * 2. 慢模型 + 对话 → 命中 floor
 * 3. 群组 vs 私聊 → 1.5× 差异
 * 4. consecutive_outgoing 递增 → cooldown 递增
 * 5. 对话 vs 主动 → 不同基础周期
 * 6. jitter 范围 → 多次调用分布在 [0.8, 1.2]×
 *
 * @see docs/adr/127-adaptive-rhythm-cooldown.md
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type AdaptiveCooldownOpts,
  computeAdaptiveCooldown,
} from "../src/engine/react/feedback-arc.js";

// 固定 jitter 为 1.0（中点）以便精确断言
beforeEach(() => {
  vi.spyOn(Math, "random").mockReturnValue(0.5); // 0.8 + 0.5*0.4 = 1.0
});
afterEach(() => {
  vi.restoreAllMocks();
});

const base = (overrides: Partial<AdaptiveCooldownOpts> = {}): AdaptiveCooldownOpts => ({
  engagementMs: 500,
  consecutiveOutgoing: 0,
  chatType: "private",
  isConversationActive: true,
  ...overrides,
});

describe("ADR-125: computeAdaptiveCooldown", () => {
  // -- 1. 快模型 + 对话 → cooldown 补偿 engagement --------------------------
  it("快模型 + 对话 + 私聊 → cooldown ≈ τ_base − engagement", () => {
    const cd = computeAdaptiveCooldown(base({ engagementMs: 500 }));
    // τ_target = 4000, cooldown = max(800, 4000-500) × 1.0 = 3500
    expect(cd).toBe(3500);
  });

  // -- 2. 慢模型 → 命中 floor ------------------------------------------------
  it("慢模型 + 对话 → 命中 τ_floor", () => {
    const cd = computeAdaptiveCooldown(base({ engagementMs: 5000 }));
    // τ_target = 4000, 4000-5000 = -1000, max(800, -1000) = 800
    expect(cd).toBe(800);
  });

  it("极慢模型 engagement 远超 τ_target → 仍然返回 floor", () => {
    const cd = computeAdaptiveCooldown(base({ engagementMs: 20000 }));
    expect(cd).toBe(800);
  });

  // -- 3. 群组 vs 私聊 → 1.5× 差异 ------------------------------------------
  it("群组 chatType → 1.5× 周期", () => {
    const cdPrivate = computeAdaptiveCooldown(base({ chatType: "private" }));
    const cdGroup = computeAdaptiveCooldown(base({ chatType: "group" }));
    // private: max(800, 4000-500) = 3500
    // group:   max(800, 6000-500) = 5500
    expect(cdPrivate).toBe(3500);
    expect(cdGroup).toBe(5500);
    expect(cdGroup / cdPrivate).toBeCloseTo(5500 / 3500, 2);
  });

  it("supergroup 和 group 同权重", () => {
    const cdGroup = computeAdaptiveCooldown(base({ chatType: "group" }));
    const cdSupergroup = computeAdaptiveCooldown(base({ chatType: "supergroup" }));
    expect(cdSupergroup).toBe(cdGroup);
  });

  it("channel chatType → 1.0× (与私聊相同)", () => {
    const cdPrivate = computeAdaptiveCooldown(base({ chatType: "private" }));
    const cdChannel = computeAdaptiveCooldown(base({ chatType: "channel" }));
    expect(cdChannel).toBe(cdPrivate);
  });

  // -- 4. consecutive_outgoing 递增 → cooldown 递增 --------------------------
  it("每条连发消息增加 α=1500ms", () => {
    const cd0 = computeAdaptiveCooldown(base({ consecutiveOutgoing: 0 }));
    const cd1 = computeAdaptiveCooldown(base({ consecutiveOutgoing: 1 }));
    const cd3 = computeAdaptiveCooldown(base({ consecutiveOutgoing: 3 }));
    // cd0 = max(800, 4000-500) = 3500
    // cd1 = max(800, 5500-500) = 5000
    // cd3 = max(800, 8500-500) = 8000
    expect(cd0).toBe(3500);
    expect(cd1).toBe(5000);
    expect(cd3).toBe(8000);
    expect(cd1 - cd0).toBe(1500); // α
    expect(cd3 - cd1).toBe(3000); // 2α
  });

  // -- 5. 对话 vs 主动 → 不同基础周期 ----------------------------------------
  it("主动出击 → 更长基础周期 (7000ms vs 4000ms)", () => {
    const cdConv = computeAdaptiveCooldown(base({ isConversationActive: true }));
    const cdProactive = computeAdaptiveCooldown(base({ isConversationActive: false }));
    // conv:     max(800, 4000-500) = 3500
    // proactive: max(800, 7000-500) = 6500
    expect(cdConv).toBe(3500);
    expect(cdProactive).toBe(6500);
  });

  // -- 6. jitter 范围 --------------------------------------------------------
  it("jitter 分布在 [0.8, 1.2]× 范围内", () => {
    vi.restoreAllMocks(); // 恢复真实 Math.random

    const results: number[] = [];
    for (let i = 0; i < 200; i++) {
      results.push(computeAdaptiveCooldown(base()));
    }

    // τ_target − engagement = 3500，jitter 范围 → [2800, 4200]
    const nojitterBase = 3500;
    const min = Math.min(...results);
    const max = Math.max(...results);
    expect(min).toBeGreaterThanOrEqual(nojitterBase * 0.8 - 1);
    expect(max).toBeLessThanOrEqual(nojitterBase * 1.2 + 1);

    // 200 次采样应有足够方差（不全是同一个值）
    const unique = new Set(results.map((r) => Math.round(r)));
    expect(unique.size).toBeGreaterThan(10);
  });

  // -- 组合场景 --------------------------------------------------------------
  it("Flash + 主动 + 群组 + 2 条连发 → 高 cooldown", () => {
    const cd = computeAdaptiveCooldown({
      engagementMs: 500,
      consecutiveOutgoing: 2,
      chatType: "group",
      isConversationActive: false,
    });
    // τ_target = (7000 + 1500*2) × 1.5 = 15000
    // cooldown = max(800, 15000 - 500) = 14500
    expect(cd).toBe(14500);
  });

  it("慢模型 + 主动 + 私聊 + 0 条连发 → moderate cooldown", () => {
    const cd = computeAdaptiveCooldown({
      engagementMs: 5000,
      consecutiveOutgoing: 0,
      chatType: "private",
      isConversationActive: false,
    });
    // τ_target = 7000, cooldown = max(800, 7000 - 5000) = 2000
    expect(cd).toBe(2000);
  });
});
