/**
 * ADR-75: DeliberationState 单元测试。
 *
 * 验证三个核心机制：
 * 1. 声部疲劳（voiceFatigue + computeLoudness 集成）
 * 2. 冲动保留（addImpulse + onSilence 衰减 + TTL 淘汰）
 * 3. 沉默积累（onSilence 递增 + onActionEnqueued 清零）
 *
 * ADR-110: 所有时间参数使用墙钟 ms / 秒。
 *
 * @see docs/adr/75-deliberation-state/75-deliberation-state.md
 */

import { describe, expect, it } from "vitest";
import {
  addImpulse,
  createDeliberationState,
  DEFAULT_VOICE_COOLDOWN,
  IMPULSE_DEFAULT_DECAY,
  IMPULSE_MAX_COUNT,
  IMPULSE_MAX_TTL_MS,
  IMPULSE_MIN_VALUE,
  IMPULSE_SALIENCE_DECAY_BOOST,
  onActionEnqueued,
  onSilence,
  voiceFatigue,
} from "../src/engine/deliberation.js";

// 固定时间基准（ms），用于确定性测试
const T0 = 1_000_000_000;

// -- voiceFatigue 单元测试 ---------------------------------------------------
// ADR-110: voiceFatigue(nowMs, voiceLastWonMs, cooldownS)
// phi = min(1, elapsedS / cooldownS)  where elapsedS = (nowMs - voiceLastWonMs) / 1000

describe("voiceFatigue", () => {
  it("无历史时返回 1（无疲劳）", () => {
    expect(voiceFatigue(T0, -Infinity)).toBe(1);
  });

  it("同时刻返回 0（完全疲劳）", () => {
    expect(voiceFatigue(T0, T0)).toBe(0);
  });

  it("经过 cooldown 秒后恢复到 1", () => {
    const cooldownS = DEFAULT_VOICE_COOLDOWN; // 300 秒
    // nowMs = T0 + 300s × 1000
    expect(voiceFatigue(T0 + cooldownS * 1000, T0, cooldownS)).toBe(1);
  });

  it("cooldown 中间值线性插值", () => {
    const cooldownS = 4;
    // elapsed = 2s → phi = 2/4 = 0.5
    expect(voiceFatigue(T0 + 2000, T0, cooldownS)).toBe(0.5);
  });

  it("超过 cooldown 后 clamp 到 1", () => {
    // cooldown = 3s, elapsed = 90s → phi = min(1, 90/3) = 1
    expect(voiceFatigue(T0 + 90_000, T0, 3)).toBe(1);
  });
});

// -- createDeliberationState -------------------------------------------------

describe("createDeliberationState", () => {
  it("初始状态：所有声部 lastWon=-Infinity，无冲动，无沉默", () => {
    const s = createDeliberationState();
    expect(s.voiceLastWon.diligence).toBe(-Infinity);
    expect(s.voiceLastWon.curiosity).toBe(-Infinity);
    expect(s.voiceLastWon.sociability).toBe(-Infinity);
    expect(s.voiceLastWon.caution).toBe(-Infinity);
    expect(s.pendingImpulses).toEqual([]);
    // ADR-189: consecutiveSilentTicks 已移除（VoI 改为墙钟衰减）
    expect(s.lastSilenceReason).toBeNull();
    expect(s.lastDeliberation).toBeNull();
  });
});

// -- onActionEnqueued --------------------------------------------------------

describe("onActionEnqueued", () => {
  it("记录获胜声部 ms + 清零沉默原因 + 记录谱系", () => {
    const s = createDeliberationState();
    s.lastSilenceReason = "voi_deferred";

    const nowMs = T0 + 42_000;
    onActionEnqueued(s, 42, "curiosity", "channel:123", 0.8, nowMs);

    // ADR-110: voiceLastWon 存储 ms
    expect(s.voiceLastWon.curiosity).toBe(nowMs);
    // ADR-189: consecutiveSilentTicks 已移除
    expect(s.lastSilenceReason).toBeNull();
    expect(s.lastDeliberation).toEqual({
      voice: "curiosity",
      target: "channel:123",
      netValue: 0.8,
      tick: 42,
    });
  });

  it("清除同 voice+target 的 pendingImpulse", () => {
    const s = createDeliberationState();
    addImpulse(s, {
      action: "sociability",
      target: "channel:bob",
      netValue: 0.5,
      originTick: 10,
      originMs: T0,
    });
    expect(s.pendingImpulses).toHaveLength(1);

    onActionEnqueued(s, 15, "sociability", "channel:bob", 0.6, T0 + 5000);
    expect(s.pendingImpulses).toHaveLength(0);
  });

  it("不清除不匹配的冲动", () => {
    const s = createDeliberationState();
    addImpulse(s, {
      action: "curiosity",
      target: "channel:alice",
      netValue: 0.5,
      originTick: 10,
      originMs: T0,
    });

    onActionEnqueued(s, 15, "sociability", "channel:bob", 0.6, T0 + 5000);
    expect(s.pendingImpulses).toHaveLength(1);
  });
});

// -- onSilence ---------------------------------------------------------------

describe("onSilence", () => {
  it("记录沉默原因", () => {
    const s = createDeliberationState();
    onSilence(s, 1, "api_floor", T0);
    // ADR-189: consecutiveSilentTicks 已移除（VoI 改为墙钟衰减）
    expect(s.lastSilenceReason).toBe("api_floor");

    onSilence(s, 2, "voi_deferred", T0 + 60_000);
    expect(s.lastSilenceReason).toBe("voi_deferred");
  });

  it("衰减 pendingImpulses 的 netValue", () => {
    const s = createDeliberationState();
    addImpulse(s, {
      action: "sociability",
      target: "channel:bob",
      netValue: 1.0,
      originTick: 10,
      originMs: T0,
    });

    // nowMs 仍在 TTL 窗口内
    onSilence(s, 11, "api_floor", T0 + 60_000);
    // netValue *= IMPULSE_DEFAULT_DECAY (0.7)
    expect(s.pendingImpulses[0].netValue).toBeCloseTo(IMPULSE_DEFAULT_DECAY);
  });

  it("淘汰 netValue < IMPULSE_MIN_VALUE 的冲动", () => {
    const s = createDeliberationState();
    addImpulse(s, {
      action: "sociability",
      target: "channel:bob",
      netValue: IMPULSE_MIN_VALUE + 0.01,
      originTick: 10,
      originMs: T0,
    });

    // 多次衰减直到低于阈值（每次 nowMs 递增但仍在 TTL 内）
    for (let t = 11; t < 20; t++) {
      onSilence(s, t, "api_floor", T0 + (t - 10) * 10_000);
    }
    expect(s.pendingImpulses).toHaveLength(0);
  });

  it("淘汰超过 TTL 的冲动", () => {
    const s = createDeliberationState();
    addImpulse(s, {
      action: "sociability",
      target: "channel:bob",
      netValue: 10, // 高 V，不会因衰减淘汰
      originTick: 10,
      originMs: T0,
    });

    // nowMs 超过 TTL（IMPULSE_MAX_TTL_MS = 300_000）
    onSilence(s, 100, "api_floor", T0 + IMPULSE_MAX_TTL_MS);
    expect(s.pendingImpulses).toHaveLength(0);
  });
});

// -- addImpulse --------------------------------------------------------------

describe("addImpulse", () => {
  it("拒绝低于最低阈值的冲动", () => {
    const s = createDeliberationState();
    addImpulse(s, {
      action: "curiosity",
      target: "channel:test",
      netValue: IMPULSE_MIN_VALUE - 0.01,
      originTick: 1,
      originMs: T0,
    });
    expect(s.pendingImpulses).toHaveLength(0);
  });

  it("去重：同 action+target 只保留最新", () => {
    const s = createDeliberationState();
    addImpulse(s, {
      action: "sociability",
      target: "channel:bob",
      netValue: 0.5,
      originTick: 10,
      originMs: T0,
    });
    addImpulse(s, {
      action: "sociability",
      target: "channel:bob",
      netValue: 0.8,
      originTick: 12,
      originMs: T0 + 120_000,
    });
    expect(s.pendingImpulses).toHaveLength(1);
    expect(s.pendingImpulses[0].netValue).toBe(0.8);
    expect(s.pendingImpulses[0].originTick).toBe(12);
  });

  it("容量限制：超出 MAX_COUNT 时保留 V 最高的", () => {
    const s = createDeliberationState();
    for (let i = 0; i < IMPULSE_MAX_COUNT + 2; i++) {
      addImpulse(s, {
        action: "sociability",
        target: `channel:${i}`,
        netValue: 0.1 * (i + 1),
        originTick: i,
        originMs: T0 + i * 60_000,
      });
    }
    expect(s.pendingImpulses).toHaveLength(IMPULSE_MAX_COUNT);
    // 保留 V 最高的
    const values = s.pendingImpulses.map((imp) => imp.netValue);
    for (let i = 1; i < values.length; i++) {
      expect(values[i - 1]).toBeGreaterThanOrEqual(values[i]);
    }
  });

  // -- salience 调制 ----------------------------------------------------------
  // @see docs/adr/151-algorithm-audit/priority-ranking.md #3

  it("不传 salience 时 decay 等于 IMPULSE_DEFAULT_DECAY（行为不变）", () => {
    const s = createDeliberationState();
    addImpulse(s, {
      action: "curiosity",
      target: "channel:test",
      netValue: 0.5,
      originTick: 1,
      originMs: T0,
    });
    expect(s.pendingImpulses[0].decay).toBe(IMPULSE_DEFAULT_DECAY);
    expect(s.pendingImpulses[0].salience).toBe(0);
  });

  it("salience=1 时 decay=0.85", () => {
    const s = createDeliberationState();
    addImpulse(s, {
      action: "curiosity",
      target: "channel:test",
      netValue: 0.5,
      originTick: 1,
      originMs: T0,
      salience: 1,
    });
    expect(s.pendingImpulses[0].decay).toBeCloseTo(
      IMPULSE_DEFAULT_DECAY + IMPULSE_SALIENCE_DECAY_BOOST,
    );
    expect(s.pendingImpulses[0].salience).toBe(1);
  });

  it("salience=0.5 时 decay=0.775", () => {
    const s = createDeliberationState();
    addImpulse(s, {
      action: "curiosity",
      target: "channel:test",
      netValue: 0.5,
      originTick: 1,
      originMs: T0,
      salience: 0.5,
    });
    expect(s.pendingImpulses[0].decay).toBeCloseTo(
      IMPULSE_DEFAULT_DECAY + IMPULSE_SALIENCE_DECAY_BOOST * 0.5,
    );
    expect(s.pendingImpulses[0].salience).toBe(0.5);
  });

  it("salience 超出 [0,1] 范围时 clamp", () => {
    const s = createDeliberationState();
    addImpulse(s, {
      action: "curiosity",
      target: "channel:a",
      netValue: 0.5,
      originTick: 1,
      originMs: T0,
      salience: 2.0,
    });
    expect(s.pendingImpulses[0].salience).toBe(1);
    expect(s.pendingImpulses[0].decay).toBeCloseTo(
      IMPULSE_DEFAULT_DECAY + IMPULSE_SALIENCE_DECAY_BOOST,
    );

    addImpulse(s, {
      action: "curiosity",
      target: "channel:b",
      netValue: 0.5,
      originTick: 2,
      originMs: T0,
      salience: -0.5,
    });
    // biome-ignore lint/style/noNonNullAssertion: guarded by test assertion
    const impB = s.pendingImpulses.find((i) => i.target === "channel:b")!;
    expect(impB.salience).toBe(0);
    expect(impB.decay).toBe(IMPULSE_DEFAULT_DECAY);
  });
});
