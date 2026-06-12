/**
 * ADR-147: 洪水积压与重连恢复 — 测试矩阵。
 *
 * TDD 流程：先证明问题存在（RED），再修复（GREEN）。
 *
 * @see docs/adr/147-flood-backlog-recovery.md §D3
 */
import { describe, expect, it } from "vitest";
import { WorldModel } from "../src/graph/world-model.js";
import {
  effectiveUnread,
  KAPPA_TONIC,
  UNREAD_FRESHNESS_HALFLIFE_S,
} from "../src/pressure/signal-decay.js";
import { EventBuffer } from "../src/telegram/events.js";
import type { GraphPerturbation } from "../src/telegram/mapper.js";
import { applyPerturbations } from "../src/telegram/mapper.js";

// ═══════════════════════════════════════════════════════════════════════════
// T1: EventBuffer 大量灌入 — directed 保留率（回归基线）
// ═══════════════════════════════════════════════════════════════════════════

describe("T1: EventBuffer directed 保留率", () => {
  it("500 regular + 5 directed → 5 directed 全部保留", () => {
    const buffer = new EventBuffer(1000);
    // 500 条 regular
    for (let i = 0; i < 500; i++) {
      buffer.push({
        type: "new_message",
        chatType: "group",
        channelId: `channel:${i % 10}`,
        tick: i,
      });
    }
    // 5 条 directed
    for (let i = 0; i < 5; i++) {
      buffer.push({
        type: "new_message",
        chatType: "group",
        channelId: "channel:main",
        isDirected: true,
        tick: 500 + i,
      });
    }
    const { events, droppedDirectedCount } = buffer.drain();
    const directedEvents = events.filter((e) => e.isDirected);
    expect(directedEvents).toHaveLength(5);
    expect(droppedDirectedCount).toBe(0);
  });

  it("200 directed → 最新 100 条保留（MAX_PROTECTED=100）", () => {
    const buffer = new EventBuffer(1000);
    for (let i = 0; i < 200; i++) {
      buffer.push({
        type: "new_message",
        chatType: "group",
        channelId: "channel:main",
        isDirected: true,
        tick: i,
      });
    }
    const { events, droppedDirectedCount } = buffer.drain();
    const directedEvents = events.filter((e) => e.isDirected);
    expect(directedEvents).toHaveLength(100);
    expect(droppedDirectedCount).toBe(100);
    // 最新 100 条保留（tick 100-199）
    expect(directedEvents[0].tick).toBe(100);
    expect(directedEvents[99].tick).toBe(199);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// T2: nowMs 时间戳矫正效果
// ═══════════════════════════════════════════════════════════════════════════

describe("T2: nowMs 时间戳矫正", () => {
  it("applyPerturbations 使用 nowMs 原始时间设置 last_incoming_ms", () => {
    const G = new WorldModel();
    const channelId = "channel:test";
    G.addChannel(channelId, { chat_type: "supergroup" });

    const twoHoursAgo = Date.now() - 2 * 3600 * 1000;
    const events: GraphPerturbation[] = [];
    for (let i = 0; i < 100; i++) {
      events.push({
        type: "new_message",
        chatType: "group",
        channelId,
        tick: i,
        nowMs: twoHoursAgo + i * 1000, // 2 小时前的消息，间隔 1s
      });
    }

    applyPerturbations(G, events);

    // last_incoming_ms 应该是最后一条消息的 nowMs（≈ 2 小时前 + 99s）
    const lastIncomingMs = Number(G.getChannel(channelId).last_incoming_ms ?? 0);
    const expectedMs = twoHoursAgo + 99 * 1000;
    expect(lastIncomingMs).toBeCloseTo(expectedMs, -3); // 容差 1000ms

    // effectiveUnread 应该有显著衰减（100 unread × 0.25 ≈ 25）
    const eu = effectiveUnread(G, channelId, Date.now());
    expect(eu).toBeLessThan(50); // 远低于 100
    expect(eu).toBeGreaterThan(10); // 但不是 0
  });

  it("不设置 nowMs 时 effectiveUnread 无衰减（问题证明）", () => {
    const G = new WorldModel();
    const channelId = "channel:test2";
    G.addChannel(channelId, { chat_type: "supergroup" });

    // 不设置 nowMs → applyPerturbation 回退到 Date.now()
    const events: GraphPerturbation[] = [];
    for (let i = 0; i < 100; i++) {
      events.push({
        type: "new_message",
        chatType: "group",
        channelId,
        tick: i,
        // 无 nowMs
      });
    }

    applyPerturbations(G, events);

    // last_incoming_ms 会是 Date.now() 附近
    const lastIncomingMs = Number(G.getChannel(channelId).last_incoming_ms ?? 0);
    expect(lastIncomingMs).toBeGreaterThan(Date.now() - 5000); // 当前时间附近

    // effectiveUnread ≈ 100（几乎无衰减）— 这就是问题所在
    const eu = effectiveUnread(G, channelId, Date.now());
    expect(eu).toBeGreaterThan(90); // 几乎无衰减
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// T3: EMA 积压检测
// ═══════════════════════════════════════════════════════════════════════════

describe("T3: EMA 积压检测", () => {
  // 依赖 detectBacklog 函数——Phase B 实现后导入
  // import { detectBacklog } from "../src/engine/evolve.js";

  it("正常 10 条/tick × 20 ticks → 突增 200 条 → 检测为积压", async () => {
    // 动态导入：如果 detectBacklog 不存在则 skip
    const { detectBacklog, EMA_ALPHA } = await import("../src/engine/evolve.js");
    if (!detectBacklog) return; // Phase B 前 skip

    // 模拟 EvolveState 的最小必要字段
    const state = { eventCountEma: 10 } as { eventCountEma: number };
    // 先稳定 20 tick（D9: detectBacklog 是纯查询，需手动更新 EMA）
    for (let i = 0; i < 20; i++) {
      const isBacklog = detectBacklog(state, 10);
      if (!isBacklog) {
        state.eventCountEma = EMA_ALPHA * 10 + (1 - EMA_ALPHA) * state.eventCountEma;
      }
    }
    // 突增 200 条
    const result = detectBacklog(state, 200);
    expect(result).toBe(true);
  });

  it("正常 50 条/tick × 20 ticks → 60 条 → 非积压", async () => {
    const { detectBacklog, EMA_ALPHA } = await import("../src/engine/evolve.js");
    if (!detectBacklog) return;

    const state = { eventCountEma: 10 } as { eventCountEma: number };
    // 先稳定在 50 条（D9: detectBacklog 是纯查询，需手动更新 EMA）
    for (let i = 0; i < 20; i++) {
      const isBacklog = detectBacklog(state, 50);
      if (!isBacklog) {
        state.eventCountEma = EMA_ALPHA * 50 + (1 - EMA_ALPHA) * state.eventCountEma;
      }
    }
    // 小幅增长 60 条
    const result = detectBacklog(state, 60);
    expect(result).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// T4: isFloodCondition 统一谓词
// ═══════════════════════════════════════════════════════════════════════════

describe("T4: isFloodCondition 统一谓词", () => {
  it("buffer.isRecovering=true → isFloodCondition=true", async () => {
    const { isFloodCondition } = await import("../src/engine/evolve.js");
    if (!isFloodCondition) return;

    const buffer = new EventBuffer();
    buffer.isRecovering = true;
    const state = { buffer, eventCountEma: 100 } as Parameters<typeof isFloodCondition>[0];
    expect(isFloodCondition(state, 10)).toBe(true);
  });

  it("detectBacklog=true → isFloodCondition=true", async () => {
    const { isFloodCondition } = await import("../src/engine/evolve.js");
    if (!isFloodCondition) return;

    const buffer = new EventBuffer();
    buffer.isRecovering = false;
    const state = { buffer, eventCountEma: 10 } as Parameters<typeof isFloodCondition>[0];
    // eventCount=200 >> 3*10=30 → detectBacklog=true
    expect(isFloodCondition(state, 200)).toBe(true);
  });

  it("两者都 false → isFloodCondition=false", async () => {
    const { isFloodCondition } = await import("../src/engine/evolve.js");
    if (!isFloodCondition) return;

    const buffer = new EventBuffer();
    buffer.isRecovering = false;
    const state = { buffer, eventCountEma: 100 } as Parameters<typeof isFloodCondition>[0];
    expect(isFloodCondition(state, 10)).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// T5: EventBuffer isRecovering 标志
// ═══════════════════════════════════════════════════════════════════════════

describe("T5: EventBuffer isRecovering", () => {
  it("isRecovering 默认 false，可设置和读取", () => {
    const buffer = new EventBuffer();
    expect(buffer.isRecovering).toBe(false);
    buffer.isRecovering = true;
    expect(buffer.isRecovering).toBe(true);
    buffer.isRecovering = false;
    expect(buffer.isRecovering).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// T6: 时钟偏差守卫
// ═══════════════════════════════════════════════════════════════════════════

describe("T6: 时钟偏差守卫", () => {
  it("nowMs 正常值（1 小时前）→ 使用原值", () => {
    const G = new WorldModel();
    const channelId = "channel:clock_normal";
    G.addChannel(channelId, { chat_type: "private" });

    const oneHourAgo = Date.now() - 3600 * 1000;
    applyPerturbations(G, [
      { type: "new_message", chatType: "private", channelId, tick: 1, nowMs: oneHourAgo },
    ]);

    const lastMs = Number(G.getChannel(channelId).last_incoming_ms ?? 0);
    // 应该使用 1 小时前的原始时间
    expect(Math.abs(lastMs - oneHourAgo)).toBeLessThan(1000);
  });

  it("nowMs = -1（非法值）→ 回退到 Date.now()", () => {
    const G = new WorldModel();
    const channelId = "channel:clock_neg";
    G.addChannel(channelId, { chat_type: "private" });

    applyPerturbations(G, [
      { type: "new_message", chatType: "private", channelId, tick: 1, nowMs: -1 },
    ]);

    const lastMs = Number(G.getChannel(channelId).last_incoming_ms ?? 0);
    // 应该回退到 Date.now() 附近
    expect(lastMs).toBeGreaterThan(Date.now() - 5000);
  });

  it("nowMs = 未来 2 分钟（时钟偏差过大）→ 回退到 Date.now()", () => {
    const G = new WorldModel();
    const channelId = "channel:clock_future";
    G.addChannel(channelId, { chat_type: "private" });

    const futureMs = Date.now() + 2 * 60 * 1000;
    applyPerturbations(G, [
      { type: "new_message", chatType: "private", channelId, tick: 1, nowMs: futureMs },
    ]);

    const lastMs = Number(G.getChannel(channelId).last_incoming_ms ?? 0);
    // 应该回退到 Date.now() 附近（不是 2 分钟后）
    expect(lastMs).toBeLessThan(Date.now() + 5000);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// T7: detectBacklog EMA 单次更新保证（Wave 3 — O7/D9）
// ═══════════════════════════════════════════════════════════════════════════

describe("T7: detectBacklog 纯查询——EMA 不被多次调用污染", () => {
  it("同 tick 内多次调用 isFloodCondition，EMA 不变", async () => {
    const { isFloodCondition, detectBacklog } = await import("../src/engine/evolve.js");
    if (!isFloodCondition || !detectBacklog) return;

    const buffer = new EventBuffer();
    buffer.isRecovering = false;
    const state = { buffer, eventCountEma: 10 } as Parameters<typeof isFloodCondition>[0];

    const emaBefore = state.eventCountEma;
    // 模拟一个 tick 内的三次调用（evolveTick + computeTickPlan + transitionMode）
    isFloodCondition(state, 8);
    isFloodCondition(state, 8);
    detectBacklog(state, 8);
    const emaAfter = state.eventCountEma;

    // EMA 不应该被这些调用改变（纯查询）
    expect(emaAfter).toBe(emaBefore);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// T8: EWMS 精确衰减（ADR-150）
// ═══════════════════════════════════════════════════════════════════════════

describe("T8: EWMS 精确逐消息衰减", () => {
  it("200 条积压横跨 2h — EWMS 给出精确的逐消息衰减和", () => {
    const G = new WorldModel();
    const channelId = "channel:active_group";
    G.addChannel(channelId, { chat_type: "supergroup" });

    const now = Date.now();
    const twoHoursAgo = now - 2 * 3600 * 1000;
    const spacingMs = (2 * 3600 * 1000) / 200; // ~36s 间隔
    const events: GraphPerturbation[] = [];
    for (let i = 0; i < 200; i++) {
      events.push({
        type: "new_message",
        chatType: "group",
        channelId,
        tick: i,
        nowMs: twoHoursAgo + i * spacingMs,
      });
    }

    applyPerturbations(G, events);

    // 计算理想值：Σᵢ 2^(-(now - tᵢ) / 3600)
    const TAU = 3600; // 秒
    let ideal = 0;
    for (let i = 0; i < 200; i++) {
      const tI = twoHoursAgo + i * spacingMs;
      const ageS = (now - tI) / 1000;
      ideal += 2 ** (-ageS / TAU);
    }

    const eu = effectiveUnread(G, channelId, now);

    // EWMS 应该非常接近理想值（仅浮点误差）
    expect(eu).toBeCloseTo(ideal, 1); // 1 位小数精度
    // 理想值 ≈ 108，远低于 raw 200
    expect(eu).toBeLessThan(150);
    expect(eu).toBeGreaterThan(50);
  });

  it("read_history 后 EWMS 归零", () => {
    const G = new WorldModel();
    const channelId = "channel:read";
    G.addChannel(channelId, { chat_type: "private" });

    // 灌入 10 条消息
    for (let i = 0; i < 10; i++) {
      applyPerturbations(G, [
        { type: "new_message", chatType: "private", channelId, tick: i, nowMs: Date.now() },
      ]);
    }
    expect(effectiveUnread(G, channelId, Date.now())).toBeGreaterThan(5);

    // read_history → 清零
    applyPerturbations(G, [{ type: "read_history", channelId, tick: 10 }]);
    expect(effectiveUnread(G, channelId, Date.now())).toBe(0);
    expect(G.getChannel(channelId).unread).toBe(0);
    expect(G.getChannel(channelId).unread_ewms).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// T9: Tonic/Phasic 注意力分解（ADR-176）
// ═══════════════════════════════════════════════════════════════════════════

describe("T9: Tonic/Phasic 注意力分解", () => {
  it("T9.1: 旧积压（10h）— tonic 地板阻止信号归零", () => {
    const G = new WorldModel();
    const channelId = "channel:old_backlog";
    G.addChannel(channelId, { chat_type: "supergroup" });

    const now = Date.now();
    const tenHoursAgo = now - 10 * 3600 * 1000;
    // 50 条消息，10 小时前到达
    for (let i = 0; i < 50; i++) {
      applyPerturbations(G, [
        {
          type: "new_message",
          chatType: "supergroup",
          channelId,
          tick: i,
          nowMs: tenHoursAgo + i * 1000,
        },
      ]);
    }

    const eu = effectiveUnread(G, channelId, now);
    // tonic = ln(1 + 50) ≈ 3.93，phasic ≈ 0（10 个半衰期）
    // 旧行为会返回 ~0，新行为应 ≥ tonic
    const expectedTonic = KAPPA_TONIC * Math.log(1 + 50);
    expect(eu).toBeGreaterThanOrEqual(expectedTonic * 0.99);
    expect(eu).toBeGreaterThan(1); // 绝对不是零
  });

  it("T9.2: 新鲜消息 — phasic 主导（行为不变）", () => {
    const G = new WorldModel();
    const channelId = "channel:fresh";
    G.addChannel(channelId, { chat_type: "private" });

    const now = Date.now();
    // 3 条消息，刚刚到达
    for (let i = 0; i < 3; i++) {
      applyPerturbations(G, [
        {
          type: "new_message",
          chatType: "private",
          channelId,
          tick: i,
          nowMs: now - (2 - i) * 1000,
        },
      ]);
    }

    const eu = effectiveUnread(G, channelId, now);
    const tonic = KAPPA_TONIC * Math.log(1 + 3);
    // phasic ≈ 3（几乎无衰减），tonic = ln(4) ≈ 1.39
    // phasic 应主导
    expect(eu).toBeGreaterThan(tonic);
    expect(eu).toBeGreaterThan(2); // 接近 EWMS 原始值
  });

  it("T9.3: read_history — tonic 和 phasic 均归零", () => {
    const G = new WorldModel();
    const channelId = "channel:read_reset";
    G.addChannel(channelId, { chat_type: "supergroup" });

    const now = Date.now();
    const fiveHoursAgo = now - 5 * 3600 * 1000;
    for (let i = 0; i < 30; i++) {
      applyPerturbations(G, [
        {
          type: "new_message",
          chatType: "supergroup",
          channelId,
          tick: i,
          nowMs: fiveHoursAgo + i * 1000,
        },
      ]);
    }

    // 确认有 tonic 信号
    expect(effectiveUnread(G, channelId, now)).toBeGreaterThan(0);

    // read_history 清零
    applyPerturbations(G, [{ type: "read_history", channelId, tick: 30 }]);
    expect(effectiveUnread(G, channelId, now)).toBe(0);
  });

  it("T9.4: 沉默减半 — tonic 跟踪减半后的 rawUnread", () => {
    const G = new WorldModel();
    const channelId = "channel:silence_halve";
    G.addChannel(channelId, { chat_type: "supergroup" });

    const now = Date.now();
    const sixHoursAgo = now - 6 * 3600 * 1000;
    for (let i = 0; i < 100; i++) {
      applyPerturbations(G, [
        {
          type: "new_message",
          chatType: "supergroup",
          channelId,
          tick: i,
          nowMs: sixHoursAgo + i * 1000,
        },
      ]);
    }

    effectiveUnread(G, channelId, now); // 确保调用不抛异常
    const tonicBefore = KAPPA_TONIC * Math.log(1 + 100);

    // 模拟 W2 沉默减半：rawUnread 100 → 50
    const attrs = G.getChannel(channelId);
    G.updateChannel(channelId, { unread: 50, unread_ewms: Number(attrs.unread_ewms) / 2 });

    const euAfter = effectiveUnread(G, channelId, now);
    const tonicAfter = KAPPA_TONIC * Math.log(1 + 50);

    // tonic 应该反映减半：ln(101)→ln(51)
    expect(tonicAfter).toBeLessThan(tonicBefore);
    // 6h 后 phasic 很小，tonic 主导
    expect(euAfter).toBeCloseTo(tonicAfter, 0);
  });

  it("T9.5: 交叉点 — phasic 在 ~4h 后让位于 tonic", () => {
    // 对 50 条消息：phasic = 50 × 2^(-t/3600)，tonic = ln(51) ≈ 3.93
    // 交叉点 ≈ 3.7h
    const rawUnread = 50;
    const tonic = KAPPA_TONIC * Math.log(1 + rawUnread);

    // 2h 时 phasic 应 > tonic
    const phasic2h = rawUnread * 2 ** (-(2 * 3600) / UNREAD_FRESHNESS_HALFLIFE_S);
    expect(phasic2h).toBeGreaterThan(tonic);

    // 6h 时 phasic 应 < tonic
    const phasic6h = rawUnread * 2 ** (-(6 * 3600) / UNREAD_FRESHNESS_HALFLIFE_S);
    expect(phasic6h).toBeLessThan(tonic);
  });
});
