/**
 * Conversation 实体生命周期测试 (ADR-26 Phase 1c)。
 *
 * 核心验证:
 * - detectConversationStart: 私聊/群聊/非directed/已有活跃
 * - updateConversation: turnState 切换、双握手、pace 更新
 * - tickConversations: 超时状态转移
 * - findActiveConversation
 * - 退化验证: conversation 节点不影响 computeAllPressures
 */
import { describe, expect, it } from "vitest";
import {
  detectConversationStart,
  tickConversations,
  updateConversation,
} from "../src/engine/conversation.js";
import type { ChatType } from "../src/graph/entities.js";
import { findActiveConversation } from "../src/graph/queries.js";
import { WorldModel } from "../src/graph/world-model.js";
import { computeAllPressures } from "../src/pressure/aggregate.js";

import type { GraphPerturbation } from "../src/telegram/mapper.js";

// -- 辅助 -------------------------------------------------------------------

/** ADR-110: 固定基准墙钟时间（避免 Date.now() 漂移导致测试不确定）。 */
const BASE_MS = 1_000_000_000;

function tickMs(tick: number): number {
  return tick * 60_000;
}

function makeGraph(): WorldModel {
  const G = new WorldModel();
  G.tick = 100;
  G.addAgent("self");
  G.addContact("bob", { tier: 50, last_active_ms: tickMs(95) });
  G.addChannel("channel:bob", {
    unread: 3,
    tier_contact: 50,
    chat_type: "private",
    pending_directed: 1,
    last_directed_ms: tickMs(98),
  });
  G.addChannel("channel:group", {
    unread: 10,
    tier_contact: 150,
    chat_type: "group",
    pending_directed: 1,
    last_directed_ms: tickMs(99),
  });
  G.addRelation("self", "monitors", "channel:bob");
  G.addRelation("self", "monitors", "channel:group");
  G.addRelation("self", "acquaintance", "bob");
  G.addRelation("bob", "joined", "channel:bob");
  G.addRelation("bob", "joined", "channel:group");
  return G;
}

/**
 * ADR-110: 在 conversation 节点上设置墙钟时间属性。
 * detectConversationStart 只写 tick 属性，tickConversations 读 ms 属性，
 * 测试需要手动桥接。
 */
function setConvWallClock(G: WorldModel, convId: string, ms: number): void {
  G.setDynamic(convId, "last_activity_ms", ms);
  G.setDynamic(convId, "start_ms", ms);
}

function directedMessage(
  channelId: string,
  contactId: string,
  tick: number,
  chatType: ChatType = "private",
  nowMs?: number,
): GraphPerturbation {
  return { type: "new_message", channelId, contactId, isDirected: true, tick, chatType, nowMs };
}

function nonDirectedMessage(channelId: string, contactId: string, tick: number): GraphPerturbation {
  return { type: "new_message", channelId, contactId, isDirected: false, tick, chatType: "group" };
}

/** 断言 detectConversationStart 返回非 null 的 convId。 */
function mustDetect(G: WorldModel, event: GraphPerturbation): string {
  const convId = detectConversationStart(G, event);
  expect(convId).not.toBeNull();
  return convId as string;
}

// -- detectConversationStart ------------------------------------------------

describe("detectConversationStart", () => {
  it("私聊 directed → opening, turnState=alice_turn", () => {
    const G = makeGraph();
    const convId = mustDetect(G, directedMessage("channel:bob", "bob", 100, "private"));

    expect(convId).toBe("conversation:channel:bob_100");
    expect(G.has(convId)).toBe(true);

    const attrs = G.getConversation(convId);
    expect(attrs.entity_type).toBe("conversation");
    expect(attrs.state).toBe("opening");
    expect(attrs.turn_state).toBe("alice_turn");
    expect(attrs.channel).toBe("channel:bob");
    expect(attrs.participants).toEqual(["bob"]);
    expect(attrs.message_count).toBe(1);
    expect(attrs.alice_message_count).toBe(0);
  });

  it("群聊 directed → pending (双握手)", () => {
    const G = makeGraph();
    const convId = mustDetect(G, directedMessage("channel:group", "bob", 100, "group"));

    expect(convId).toBe("conversation:channel:group_100");
    const attrs = G.getConversation(convId);
    expect(attrs.state).toBe("pending");
    expect(attrs.turn_state).toBe("open");
  });

  it("非 directed 消息 → 不创建", () => {
    const G = makeGraph();
    const convId = detectConversationStart(G, nonDirectedMessage("channel:bob", "bob", 100));
    expect(convId).toBeNull();
  });

  it("已有活跃 conv → 不创建", () => {
    const G = makeGraph();
    // 先创建一个
    detectConversationStart(G, directedMessage("channel:bob", "bob", 100, "private"));
    // 再尝试创建
    const second = detectConversationStart(
      G,
      directedMessage("channel:bob", "bob", 101, "private"),
    );
    expect(second).toBeNull();
  });

  it("non new_message 事件 → 不创建", () => {
    const G = makeGraph();
    const event: GraphPerturbation = { type: "reaction", channelId: "channel:bob", tick: 100 };
    expect(detectConversationStart(G, event)).toBeNull();
  });

  it("创建边 happens_in 和 participates", () => {
    const G = makeGraph();
    const convId = mustDetect(G, directedMessage("channel:bob", "bob", 100, "private"));

    // conv → happens_in → channel:bob
    const channels = G.getNeighbors(convId, "happens_in");
    expect(channels).toContain("channel:bob");

    // bob → participates → conv
    const convs = G.getNeighbors("bob", "participates");
    expect(convs).toContain(convId);
  });
});

// -- updateConversation -----------------------------------------------------

describe("updateConversation", () => {
  it("pending + Alice 回复 → opening (双握手完成)", () => {
    const G = makeGraph();
    const convId = mustDetect(G, directedMessage("channel:group", "bob", 100, "group"));
    expect(G.getConversation(convId).state).toBe("pending");

    updateConversation(G, convId, directedMessage("channel:group", "self", 101, "group"));

    const attrs = G.getConversation(convId);
    expect(attrs.state).toBe("opening");
    expect(attrs.turn_state).toBe("other_turn");
    expect(attrs.message_count).toBe(2);
    expect(attrs.alice_message_count).toBe(1);
  });

  it("opening + 对方回复 → active", () => {
    const G = makeGraph();
    const convId = mustDetect(G, directedMessage("channel:bob", "bob", 100, "private"));
    expect(G.getConversation(convId).state).toBe("opening");

    updateConversation(G, convId, directedMessage("channel:bob", "bob", 102, "private"));

    const attrs = G.getConversation(convId);
    expect(attrs.state).toBe("active");
    expect(attrs.turn_state).toBe("alice_turn");
  });

  it("active 中 turnState 正确切换", () => {
    const G = makeGraph();
    const convId = mustDetect(G, directedMessage("channel:bob", "bob", 100, "private"));
    updateConversation(G, convId, directedMessage("channel:bob", "bob", 102, "private")); // → active

    // Alice 说话 → other_turn
    updateConversation(G, convId, directedMessage("channel:bob", "self", 103, "private"));
    expect(G.getConversation(convId).turn_state).toBe("other_turn");

    // Bob 说话 → alice_turn
    updateConversation(G, convId, directedMessage("channel:bob", "bob", 104, "private"));
    expect(G.getConversation(convId).turn_state).toBe("alice_turn");
  });

  it("pace 正确更新", () => {
    const G = makeGraph();
    // ADR-110: pace = msgCount / elapsedS, elapsedS = max(1, (nowMs - startMs) / 1000)
    // 使用固定 nowMs 避免 Date.now() 漂移
    const t0 = BASE_MS;
    const convId = mustDetect(G, directedMessage("channel:bob", "bob", 100, "private", t0));

    // 2nd message at t0+120s, elapsed=120s → pace=2/120≈0.0167
    updateConversation(
      G,
      convId,
      directedMessage("channel:bob", "bob", 102, "private", t0 + 120_000),
    );
    expect(G.getConversation(convId).pace).toBeCloseTo(2 / 120, 4);

    // 3rd message at t0+300s, elapsed=300s → pace=3/300=0.01
    updateConversation(
      G,
      convId,
      directedMessage("channel:bob", "self", 105, "private", t0 + 300_000),
    );
    expect(G.getConversation(convId).pace).toBeCloseTo(3 / 300, 4);
  });

  it("群聊 non-directed → turn_state=open（不触发 alice_turn 义务）", () => {
    const G = makeGraph();
    // 群聊创建：directed → pending，Alice 回复 → opening，对方回复 → active
    const convId = mustDetect(G, directedMessage("channel:group", "bob", 100, "group"));
    updateConversation(G, convId, directedMessage("channel:group", "self", 101, "group"));
    updateConversation(G, convId, directedMessage("channel:group", "bob", 102, "group"));
    expect(G.getConversation(convId).state).toBe("active");
    expect(G.getConversation(convId).turn_state).toBe("alice_turn");

    // Alice 回复 → other_turn
    updateConversation(G, convId, directedMessage("channel:group", "self", 103, "group"));
    expect(G.getConversation(convId).turn_state).toBe("other_turn");

    // 群聊非 directed 消息 → open（中性态，非 alice_turn）
    updateConversation(G, convId, nonDirectedMessage("channel:group", "bob", 104));
    expect(G.getConversation(convId).turn_state).toBe("open");
  });

  it("群聊 directed → 仍然 alice_turn", () => {
    const G = makeGraph();
    const convId = mustDetect(G, directedMessage("channel:group", "bob", 100, "group"));
    updateConversation(G, convId, directedMessage("channel:group", "self", 101, "group"));
    updateConversation(G, convId, directedMessage("channel:group", "bob", 102, "group")); // → active

    // Alice 回复
    updateConversation(G, convId, directedMessage("channel:group", "self", 103, "group"));
    expect(G.getConversation(convId).turn_state).toBe("other_turn");

    // 群聊 directed 消息 → alice_turn（有明确义务）
    updateConversation(G, convId, directedMessage("channel:group", "bob", 104, "group"));
    expect(G.getConversation(convId).turn_state).toBe("alice_turn");
  });

  it("私聊行为不变：non-directed 仍然 alice_turn", () => {
    const G = makeGraph();
    const convId = mustDetect(G, directedMessage("channel:bob", "bob", 100, "private"));
    updateConversation(G, convId, directedMessage("channel:bob", "bob", 102, "private")); // → active

    // 私聊非 directed 消息也应该是 alice_turn（1:1 场景，对方说话就是 Alice 的轮次）
    updateConversation(G, convId, nonDirectedMessage("channel:bob", "bob", 103));
    expect(G.getConversation(convId).turn_state).toBe("alice_turn");
  });

  it("新参与者自动加入 participants", () => {
    const G = makeGraph();
    G.addContact("carol", { tier: 150, last_active_ms: 0 });
    const convId = mustDetect(G, directedMessage("channel:group", "bob", 100, "group"));

    updateConversation(G, convId, {
      type: "new_message",
      chatType: "group",
      channelId: "channel:group",
      contactId: "carol",
      isDirected: true,
      tick: 101,
    });

    const participants = G.getConversation(convId).participants as string[];
    expect(participants).toContain("bob");
    expect(participants).toContain("carol");
  });
});

// -- tickConversations ------------------------------------------------------

describe("tickConversations", () => {
  it("pending 超时 → cooldown", () => {
    const G = makeGraph();
    detectConversationStart(G, directedMessage("channel:group", "bob", 100, "group"));
    const convId = "conversation:channel:group_100";

    // ADR-110: 设置墙钟时间，N_PENDING_S=300 秒
    setConvWallClock(G, convId, BASE_MS);
    // nowMs = BASE_MS + 300_000 → idleS = 300 → 等于 N_PENDING_S → cooldown
    tickConversations(G, 105, BASE_MS + 300_000);
    expect(G.getConversation(convId).state).toBe("cooldown");
  });

  it("active 超时 → closing", () => {
    const G = makeGraph();
    const convId = mustDetect(G, directedMessage("channel:bob", "bob", 100, "private"));
    updateConversation(G, convId, directedMessage("channel:bob", "bob", 102, "private")); // → active

    // ADR-113: 设置墙钟时间。
    // start_ms = BASE_MS, last_activity_ms = BASE_MS + 120_000 (模拟 updateConv 的 2 分钟偏移)
    // msgCount = 2, elapsedS = 120 → pacePerS = 2/120 = 0.0167
    // nClosingS = max(2700, ceil(3/0.0167)) = max(2700, 180) = 2700
    // idleS ≥ 2700 → closing
    G.setDynamic(convId, "start_ms", BASE_MS);
    G.setDynamic(convId, "last_activity_ms", BASE_MS + 120_000);
    tickConversations(G, 132, BASE_MS + 120_000 + 2700_000);
    expect(G.getConversation(convId).state).toBe("closing");
  });

  it("closing 超时 → cooldown", () => {
    const G = makeGraph();
    const convId = mustDetect(G, directedMessage("channel:bob", "bob", 100, "private"));
    updateConversation(G, convId, directedMessage("channel:bob", "bob", 102, "private"));

    // ADR-113: 先推进到 closing（与上一个测试相同的时间设置）
    G.setDynamic(convId, "start_ms", BASE_MS);
    G.setDynamic(convId, "last_activity_ms", BASE_MS + 120_000);
    tickConversations(G, 132, BASE_MS + 120_000 + 2700_000);
    expect(G.getConversation(convId).state).toBe("closing");

    // ADR-110: M_COOLDOWN_S=600 → closing 后再等 600 秒 → cooldown
    // last_activity_ms 没变（closing 状态不更新 last_activity_ms）
    tickConversations(G, 142, BASE_MS + 120_000 + 2700_000 + 600_000);
    expect(G.getConversation(convId).state).toBe("cooldown");
  });

  it("cooldown 不再变化（GC 前）", () => {
    const G = makeGraph();
    G.addConversation("conversation:test", {
      channel: "channel:bob",
      state: "cooldown",
      last_activity_ms: BASE_MS,
    });

    // idle = 1800s < COOLDOWN_GC_S (3600) → 保持 cooldown，不被 GC
    tickConversations(G, 999, BASE_MS + 1800_000);
    expect(G.getConversation("conversation:test").state).toBe("cooldown");
  });

  it("cooldown GC → 实体删除", () => {
    const G = makeGraph();
    G.addConversation("conversation:gc", {
      channel: "channel:bob",
      state: "cooldown",
      last_activity_ms: BASE_MS,
    });

    // idle = 3600s = COOLDOWN_GC_S → GC 删除实体
    tickConversations(G, 999, BASE_MS + 3600_000);
    expect(G.has("conversation:gc")).toBe(false);
  });

  it("opening 超时 → closing（低 pace 时 nClosing 更大）", () => {
    const G = makeGraph();
    const convId = mustDetect(G, directedMessage("channel:bob", "bob", 100, "private"));
    // ADR-110: opening, msgCount=1, start_ms=BASE_MS
    // 让 start_ms 和 last_activity_ms 相同（只有 1 条消息）
    // elapsedS = (nowMs - start_ms) / 1000 足够大时 → pacePerS 极小
    // pacePerS = 1 / elapsedS → 如果 elapsedS=3600 → pacePerS = 0.000278
    // nClosingS = max(1800, ceil(3/0.000278)) = max(1800, 10800) = 10800
    // 但我们只需要测试 pace=0 时的兜底: start_ms=0 → elapsedS 走兜底=1
    // pacePerS = 1/1 → nClosingS = max(1800, 3) = 1800
    // 更直接: 不设 start_ms → start_ms=0 → elapsedS=1(兜底) → pacePerS=1 → nClosingS=1800
    // 但 pace=0 的兜底: pacePerS > 0 ? ceil(3/pacePerS) : 3600 → 如果 pacePerS=0 → 3600
    // 要让 pacePerS=0: msgCount=0, 但 detectConversationStart 设置 message_count=1
    // 实际上: start_ms 未设置 → 0 → elapsedS 走兜底=1 → pacePerS = 1/1 = 1
    // nClosingS = max(1800, ceil(3/1)) = 1800
    // ADR-113: 设置 last_activity_ms 然后让 idle >= 2700
    setConvWallClock(G, convId, BASE_MS);
    tickConversations(G, 160, BASE_MS + 2700_000);
    expect(G.getConversation(convId).state).toBe("closing");
  });
});

// -- findActiveConversation -------------------------------------------------

describe("findActiveConversation", () => {
  it("找到活跃 conv", () => {
    const G = makeGraph();
    detectConversationStart(G, directedMessage("channel:bob", "bob", 100, "private"));
    expect(findActiveConversation(G, "channel:bob")).toBe("conversation:channel:bob_100");
  });

  it("无 conv → null", () => {
    const G = makeGraph();
    expect(findActiveConversation(G, "channel:bob")).toBeNull();
  });

  it("cooldown conv 不被找到", () => {
    const G = makeGraph();
    G.addConversation("conversation:old", {
      channel: "channel:bob",
      state: "cooldown",
      last_activity_ms: 0,
    });
    expect(findActiveConversation(G, "channel:bob")).toBeNull();
  });
});

// -- 退化验证 ---------------------------------------------------------------

describe("退化验证: conversation 节点不影响 computeAllPressures", () => {
  it("添加 conversation 后压力值不变", () => {
    const G = makeGraph();
    // 添加 thread（让 P4 有值）
    G.addThread("t_test", {
      weight: "minor",
      status: "open",
      created_ms: tickMs(90),
      deadline: 110,
      deadline_ms: tickMs(110), // ADR-166: P_prospect 需要 deadline_ms
    });
    G.addRelation("t_test", "involves", "channel:bob");

    // 使用固定 nowMs 消除 Date.now() 漂移（两次 computeAllPressures 之间的 EWMS 衰减差异）
    const nowMs = BASE_MS;

    // 基准压力
    const baseline = computeAllPressures(G, 100, { nowMs });

    // 添加 conversation 节点 + 关系边
    detectConversationStart(G, directedMessage("channel:bob", "bob", 100, "private", nowMs));

    // 重新计算（同一 nowMs → EWMS 无漂移）
    const withConv = computeAllPressures(G, 100, { nowMs });

    // P1-P4, P6, P_prospect 不受 conversation 影响
    expect(withConv.P1).toBeCloseTo(baseline.P1, 6);
    expect(withConv.P2).toBeCloseTo(baseline.P2, 10);
    expect(withConv.P3).toBeCloseTo(baseline.P3, 10);
    expect(withConv.P4).toBeCloseTo(baseline.P4, 10);
    // P5 受两个对冲力量影响：turnBoost (alice_turn → 1.3×) 和 spectral propagation
    // (新增 conversation 节点改变图拓扑 → 压力重分配)。方向不可预测，只验证非负且有限。
    expect(withConv.P5).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(withConv.P5)).toBe(true);
    expect(withConv.P6).toBeCloseTo(baseline.P6, 10);
    expect(withConv.P_prospect).toBeCloseTo(baseline.P_prospect, 10);
  });
});
