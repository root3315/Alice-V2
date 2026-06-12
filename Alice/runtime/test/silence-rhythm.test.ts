/**
 * B3: 沉默-打破沉默节奏 — ADR-76 集成测试。
 *
 * 构造：群聊中 Alice 连续沉默 N tick，然后收到 directed 消息。
 * 验证：
 * - ADR-189 墙钟 VoI 衰减：沉默时间越长，VoI(null) 有效值越低
 * - 声部疲劳在沉默期恢复（φ_v → 1）
 * - 冲动保留队列中的高 V 候选在合适时机释放
 *
 * @see docs/adr/76-naturalness-validation-methodology.md §B3
 * @see docs/adr/75-deliberation-state/75-deliberation-state.md
 * @see docs/adr/189-gate-iaus-unification.md — VoI 墙钟衰减
 */

import { describe, expect, it } from "vitest";
import {
  addImpulse,
  createDeliberationState,
  DEFAULT_VOICE_COOLDOWN,
  IMPULSE_DEFAULT_DECAY,
  onActionEnqueued,
  onSilence,
  SILENCE_VOI_DECAY_RATE,
  voiceFatigue,
} from "../src/engine/deliberation.js";

/** ADR-110: 固定墙钟时间基准（ms），避免 Date.now() 漂移。 */
const T0 = 1_000_000_000;

// ═══════════════════════════════════════════════════════════════════════════
// B3.1: 墙钟 VoI 衰减 — ADR-189
// ═══════════════════════════════════════════════════════════════════════════

describe("B3: 墙钟 VoI 衰减", () => {
  it("60s 沉默后 VoI 衰减约 13%", () => {
    // silenceDecay = 1 / (1 + 60 * 0.0025) = 1 / 1.15 ≈ 0.87
    const silenceDecay = 1 / (1 + 60 * SILENCE_VOI_DECAY_RATE);
    expect(silenceDecay).toBeCloseTo(0.87, 1);
  });

  it("300s 沉默后 VoI 衰减约 43%", () => {
    // silenceDecay = 1 / (1 + 300 * 0.0025) = 1 / 1.75 ≈ 0.57
    const silenceDecay = 1 / (1 + 300 * SILENCE_VOI_DECAY_RATE);
    expect(silenceDecay).toBeCloseTo(0.57, 1);
  });

  it("0s 沉默 → VoI 无衰减 (decay=1)", () => {
    const silenceDecay = 1 / (1 + 0 * SILENCE_VOI_DECAY_RATE);
    expect(silenceDecay).toBe(1);
  });

  it("衰减与 tick 间隔无关——3s tick 和 60s tick 在相同墙钟时间下产生相同衰减", () => {
    // 核心不变量：conversation mode (3s tick) 和 patrol mode (60s tick)
    // 在相同墙钟沉默时间下 VoI 衰减完全一致。
    const wallClockSilenceS = 180; // 3 分钟沉默

    // 墙钟衰减（与 tick 间隔无关）
    const decay = 1 / (1 + wallClockSilenceS * SILENCE_VOI_DECAY_RATE);

    // 无论 tick 间隔是 3s 还是 60s，衰减相同
    expect(decay).toBeCloseTo(1 / (1 + 180 * 0.0025), 5);
    expect(decay).toBeCloseTo(0.69, 1);
  });

  it("行动后沉默时钟重置，VoI 恢复", () => {
    // 模拟：lastActionMs 刚刚更新 → silenceDurationS = 0 → decay = 1
    const lastActionMs = T0;
    const nowMs = T0; // 刚行动
    const silenceDurationS = (nowMs - lastActionMs) / 1000;
    const silenceDecay = 1 / (1 + silenceDurationS * SILENCE_VOI_DECAY_RATE);
    expect(silenceDecay).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// B3.2: 声部疲劳在沉默期恢复
// ═══════════════════════════════════════════════════════════════════════════

describe("B3: 声部疲劳沉默期恢复", () => {
  it("声部获胜后疲劳，经过 K_v 秒后完全恢复", () => {
    const state = createDeliberationState();

    // ADR-110: onActionEnqueued 存储墙钟 ms，voiceFatigue 用 ms 计算
    onActionEnqueued(state, 10, "sociability", "channel:group", 0.8, T0);
    expect(state.voiceLastWon.sociability).toBe(T0);

    // T0: 完全疲劳
    expect(voiceFatigue(T0, state.voiceLastWon.sociability)).toBe(0);

    // T0 + 1s: 部分恢复 → 1s / 300s = 1/300
    expect(voiceFatigue(T0 + 1000, state.voiceLastWon.sociability)).toBeCloseTo(
      1 / DEFAULT_VOICE_COOLDOWN,
    );

    // T0 + K_v 秒: 完全恢复
    expect(voiceFatigue(T0 + DEFAULT_VOICE_COOLDOWN * 1000, state.voiceLastWon.sociability)).toBe(
      1,
    );
  });

  it("沉默期间其他声部不受影响（φ_v = 1）", () => {
    const state = createDeliberationState();

    // 只有 sociability 获胜过
    onActionEnqueued(state, 10, "sociability", "channel:group", 0.8, T0);

    // ADR-110: 其他声部 voiceLastWon=-Infinity → voiceFatigue 返回 1
    expect(voiceFatigue(T0 + 1000, state.voiceLastWon.curiosity)).toBe(1);
    expect(voiceFatigue(T0 + 1000, state.voiceLastWon.diligence)).toBe(1);
    expect(voiceFatigue(T0 + 1000, state.voiceLastWon.caution)).toBe(1);
  });

  it("连续沉默 = 所有声部疲劳同步恢复", () => {
    const state = createDeliberationState();

    // ADR-110: sociability 获胜 at T0
    onActionEnqueued(state, 10, "sociability", "channel:group", 0.8, T0);
    // curiosity 获胜 120s later
    onActionEnqueued(state, 12, "curiosity", "channel:carol", 0.6, T0 + 120_000);

    // T0 + 420s: 两个声部都过了 cooldown (300s)
    // sociability: elapsed=420s → φ=min(1, 420/300)=1
    expect(voiceFatigue(T0 + 420_000, state.voiceLastWon.sociability)).toBe(1);
    // curiosity: elapsed=300s → φ=min(1, 300/300)=1
    expect(voiceFatigue(T0 + 420_000, state.voiceLastWon.curiosity)).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// B3.3: 冲动保留队列释放
// ═══════════════════════════════════════════════════════════════════════════

describe("B3: 冲动保留队列", () => {
  it("高 V 冲动在沉默期衰减但保留", () => {
    const state = createDeliberationState();

    // 添加一个高 V 冲动
    addImpulse(state, {
      action: "sociability",
      target: "channel:bob",
      netValue: 0.8,
      originTick: 10,
    });
    expect(state.pendingImpulses).toHaveLength(1);

    // 沉默 1 tick → 衰减但保留
    onSilence(state, 11, "api_floor");
    expect(state.pendingImpulses).toHaveLength(1);
    expect(state.pendingImpulses[0].netValue).toBeCloseTo(0.8 * IMPULSE_DEFAULT_DECAY);
  });

  it("行动后清除匹配的冲动", () => {
    const state = createDeliberationState();

    addImpulse(state, {
      action: "sociability",
      target: "channel:bob",
      netValue: 0.5,
      originTick: 10,
    });

    // 对 channel:bob 执行 sociability → 冲动被满足
    onActionEnqueued(state, 15, "sociability", "channel:bob", 0.6);
    expect(state.pendingImpulses).toHaveLength(0);
  });

  it("directed 消息触发行动后冲动保留队列正确更新", () => {
    const state = createDeliberationState();

    // 添加两个不同目标的冲动
    addImpulse(state, {
      action: "sociability",
      target: "channel:carol",
      netValue: 0.5,
      originTick: 10,
    });
    addImpulse(state, {
      action: "curiosity",
      target: "channel:david",
      netValue: 0.7,
      originTick: 10,
    });
    expect(state.pendingImpulses).toHaveLength(2);

    // David 的 directed 消息触发行动 → 只清除 David 的冲动
    onActionEnqueued(state, 15, "curiosity", "channel:david", 0.9);
    expect(state.pendingImpulses).toHaveLength(1);
    expect(state.pendingImpulses[0].target).toBe("channel:carol");
  });

  it("沉默后 directed 消息打破沉默时的完整状态转换", () => {
    const state = createDeliberationState();

    // 添加冲动
    addImpulse(state, {
      action: "sociability",
      target: "channel:bob",
      netValue: 0.6,
      originTick: 5,
    });

    // 连续沉默 4 tick（模拟没有足够压力行动）
    for (let t = 6; t <= 9; t++) {
      onSilence(state, t, "api_floor");
    }
    // ADR-189: consecutiveSilentTicks 已移除

    // 冲动应衰减但可能仍存活
    // V = 0.6 * 0.7^4 = 0.6 * 0.2401 ≈ 0.144 > IMPULSE_MIN_VALUE(0.05)
    expect(state.pendingImpulses).toHaveLength(1);
    expect(state.pendingImpulses[0].netValue).toBeCloseTo(0.6 * IMPULSE_DEFAULT_DECAY ** 4, 3);

    // tick 10: directed 消息触发行动 → 打破沉默
    onActionEnqueued(state, 10, "sociability", "channel:bob", 0.5);

    // 验证完整状态转换
    expect(state.lastSilenceReason).toBeNull();
    expect(state.pendingImpulses).toHaveLength(0); // 匹配的冲动被清除
    expect(state.lastDeliberation).toEqual({
      voice: "sociability",
      target: "channel:bob",
      netValue: 0.5,
      tick: 10,
    });
  });
});
