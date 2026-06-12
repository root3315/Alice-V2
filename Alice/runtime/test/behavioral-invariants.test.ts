/**
 * ADR-115 T3: 行为不变量集成测试。
 *
 * 验证 evolve 管线在关键场景下的行为不变量：
 * 1. directed 消息必须触发入队
 * 2. rate cap 超限时静默（silence_log 有 rate_cap 记录）
 * 3. consecutive outgoing 上限在私聊中生效（cap=3）
 * 4. 冷启动环境好奇心产生非零 API
 * 5. VoI Deferral: 高 entropy 信念 → L4_DEFERRED 沉默
 * 6. 对话延续 → lambda 0.5× 折扣 → 行动入队
 * 7. permanent unreachable 不绕过门控
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../src/config.js";
import { loadConfig } from "../src/config.js";

// ADR-189 蟑螂审计: directedCandidate fallback 需要 isAnyProviderHealthy=true。
// 无 mock 时 _providers=[] → false → directedCandidate 被熔断器抑制。
// mock 对 IAUS 主路径无影响（IAUS enqueue 不经过此检查）。
vi.mock("../src/llm/client.js", () => ({
  isAnyProviderHealthy: () => true,
}));

import type { Dispatcher } from "../src/core/dispatcher.js";
import { closeDb, getDb, initDb } from "../src/db/connection.js";
import { candidateTrace, decisionTrace, silenceLog, tickLog } from "../src/db/schema.js";
import { ActionQueue } from "../src/engine/action-queue.js";
import { createDeliberationState } from "../src/engine/deliberation.js";
import { type EvolveState, evolveTick } from "../src/engine/evolve.js";
import { classifySilence, computeVoINull } from "../src/engine/silence.js";
import type { ConversationState, TurnState } from "../src/graph/entities.js";
import type { ChannelDefaultsInput } from "../src/graph/entity-defaults.js";
import { WorldModel } from "../src/graph/world-model.js";
import { AdaptiveKappa, computeAllPressures } from "../src/pressure/aggregate.js";
import { createCuriosityHistory } from "../src/pressure/p6-curiosity.js";
import { EventBuffer } from "../src/telegram/events.js";
import { TickClock } from "../src/utils/time.js";
import { PersonalityVector } from "../src/voices/personality.js";

/** 最小 Dispatcher stub — 复制自 cold-start.test.ts。 */
function stubDispatcher(): Dispatcher {
  return {
    dispatch: () => undefined,
    query: (name: string) => {
      if (name === "crisis_channels") return [];
      if (name === "best_time") return { peakHour: undefined };
      return null;
    },
    getInstructionNames: () => [],
    getInstructionDef: () => undefined,
    getQueryNames: () => [],
    getQueryDef: () => undefined,
    startTick: () => {},
    endTick: () => {},
    collectContributions: () => [],
    generateManual: async () => "",

    mods: [],
    snapshotModStates: () => new Map(),
    restoreModStates: () => {},
    saveModStatesToDb: () => {},
    loadModStatesFromDb: () => false,
    readModState: () => undefined,
  };
}

/**
 * 构建灵活的测试场景状态。
 * 基于 cold-start.test.ts 的 buildColdStartState 模式，支持更多场景参数。
 */
function buildScenarioState(overrides?: {
  startTick?: number;
  channelId?: string;
  channelAttrs?: Partial<ChannelDefaultsInput>;
  configOverrides?: Partial<Config>;
  addConversation?: { state: ConversationState; turnState: TurnState };
  personality?: [number, number, number, number];
  utcHour?: number;
  recentActions?: EvolveState["recentActions"];
  mode?: "patrol" | "conversation" | "consolidation";
  extraChannels?: Array<{ id: string; attrs: ChannelDefaultsInput }>;
}): EvolveState {
  const config = loadConfig();
  config.idleThreshold = 999; // 禁用 idle 路径
  config.actionRateFloor = 0.05;
  config.rateCap = { private: 100, group: 100, channel: 100, bot: 0 }; // 默认不被 rate cap 拦截
  config.eta = 0.6;
  config.s10LeakProb = 1; // 禁用 diligence system1（100% 泄漏到 system2）
  config.snapshotIntervalS = 999999; // 禁用快照写入

  if (overrides?.configOverrides) {
    Object.assign(config, overrides.configOverrides);
  }

  const startTick = overrides?.startTick ?? 10;
  const channelId = overrides?.channelId ?? "channel:test";

  const G = new WorldModel();
  G.tick = startTick;
  G.addAgent("self");

  // 主频道
  const channelDefaults: ChannelDefaultsInput = {
    unread: 5,
    tier_contact: 5,
    chat_type: "private",
    pending_directed: 0,
    last_directed_ms: 0,
  };
  G.addChannel(channelId, { ...channelDefaults, ...overrides?.channelAttrs });
  G.addRelation("self", "monitors", channelId);

  // 额外频道
  if (overrides?.extraChannels) {
    for (const ch of overrides.extraChannels) {
      G.addChannel(ch.id, ch.attrs);
      G.addRelation("self", "monitors", ch.id);
    }
  }

  // 可选：添加对话实体
  if (overrides?.addConversation) {
    G.addConversation(`conversation:${channelId}_1`, {
      channel: channelId,
      state: overrides.addConversation.state,
      turn_state: overrides.addConversation.turnState,
      start_ms: Date.now() - 60_000,
      last_activity_ms: Date.now(),
      participants: [],
    });
  }

  const piHome = overrides?.personality ?? [0.25, 0.25, 0.25, 0.25];
  config.piHome = piHome;

  return {
    G,
    personality: new PersonalityVector(piHome),
    clock: new TickClock({ startTick }),
    buffer: new EventBuffer(),
    queue: new ActionQueue(),
    config,
    curiosityHistory: createCuriosityHistory(),
    recentEventCounts: [],
    recentActions: overrides?.recentActions ?? [],
    dispatcher: stubDispatcher(),
    lastActionMs: Date.now(),
    pressureHistory: [],
    deliberation: createDeliberationState(),
    attentionDebtMap: new Map(),
    lastSelectedTarget: null,
    lastSelectedCandidate: null,
    mode: overrides?.mode ?? "patrol",
    modeEnteredMs: Date.now(),
    adaptiveKappa: new AdaptiveKappa(config.kappa, config.kappaAdaptAlpha),
    channelRateEma: new Map(),
    lastChannelCounts: new Map(),
    eventCountEma: 10,
    floodTickCount: 0,
    lastAPI: 0,
    lastAPIPeak: 0,
    lastFlushMs: Date.now(), // 防止快照触发
    currentDt: 60,
    wakeupTicksElapsed: 0,
    wakeupEngagedTargets: new Set(),
    utcHour: overrides?.utcHour,
    llmBackoff: { consecutiveFailures: 0, lastFailureMs: 0 },
    episodeState: {
      currentId: null,
      currentTarget: null,
      currentTickStart: null,
      activeResidues: [],
    },
  };
}

describe("ADR-115: Behavioral Invariants", () => {
  beforeEach(() => initDb(":memory:"));
  afterEach(() => closeDb());

  it("Directed message must trigger action enqueue", () => {
    // 场景：channel:test 有 pending_directed=1 — 最强社交义务信号。
    // shouldBypassGates=true → 所有门控绕过 → V-max forced action。
    // 添加 alice_turn 对话确保 caution 不会 system1-skip。
    const state = buildScenarioState({
      channelAttrs: {
        pending_directed: 1,
        unread: 5,
        chat_type: "private",
        last_directed_ms: Date.now() - 5000,
      },
      addConversation: { state: "active", turnState: "alice_turn" },
      personality: [0.1, 0.35, 0.45, 0.1],
      utcHour: 14,
    });

    evolveTick(state);

    // directed 消息不应被任何门控拦截。
    // shouldBypassGates=true 使所有门控 pass，V-max null 时触发 directed_override。
    expect(state.queue.length).toBeGreaterThanOrEqual(1);
  });

  it("Class rate pressure stays soft and traceable when action rate exceeds budget", () => {
    // 场景：大量最近行动 → classActionCount >= classCap。
    // ADR-274: class cadence 不再清空 IAUS 候选池，而是留下 U_class_pacing 诊断。
    const nowMs = Date.now();
    const channelId = "channel:100";
    const privateChannelId = "channel:pm";
    const recentActions = [
      // group 行动
      ...Array.from({ length: 10 }, (_, i) => ({
        tick: i + 1,
        action: "sociability" as string,
        ms: nowMs - (20 - i) * 1000,
        target: channelId as string | null,
      })),
      // private 行动
      ...Array.from({ length: 10 }, (_, i) => ({
        tick: 11 + i,
        action: "sociability" as string,
        ms: nowMs - (10 - i) * 1000,
        target: privateChannelId as string | null,
      })),
    ];

    const state = buildScenarioState({
      channelId,
      channelAttrs: {
        pending_directed: 0,
        unread: 5,
        chat_type: "group",
      },
      configOverrides: {
        rateCap: { private: 3, group: 3, channel: 3, bot: 0 }, // 极低上限
      },
      personality: [0.05, 0.45, 0.45, 0.05],
      recentActions,
      utcHour: 14,
      // 添加 private 频道，确保 countActionsByClass 能分类
      extraChannels: [{ id: privateChannelId, attrs: { chat_type: "private", unread: 0 } }],
    });

    // 跑 3 tick 确保旧 class cap 场景仍能留下可诊断候选
    for (let i = 0; i < 3; i++) {
      evolveTick(state);
    }

    const db = getDb();
    const silences = db.select({ reason: silenceLog.reason }).from(silenceLog).all();
    expect(silences.some((row) => row.reason === "candidate_pool_empty:class_rate_cap")).toBe(
      false,
    );

    const traces = db
      .select({
        reason: candidateTrace.silenceReason,
        sampleStatus: candidateTrace.sampleStatus,
        bottleneck: candidateTrace.bottleneck,
        considerationsJson: candidateTrace.normalizedConsiderationsJson,
      })
      .from(candidateTrace)
      .all();
    expect(traces.length).toBeGreaterThan(0);
    expect(traces.some((row) => row.considerationsJson.includes("U_class_pacing"))).toBe(true);
  });

  it("Consecutive outgoing cap silences in private chat", () => {
    // 场景：连续发出 4 条消息（私聊上限 4），pending_directed=0。
    // shouldBypassGates=false → consecutive_outgoing_cap 门控拦截（outgoing >= cap=4）。
    // ADR-189 蟑螂审计 Recal 1: outgoingCapPrivate 3→4。
    const state = buildScenarioState({
      channelAttrs: {
        consecutive_outgoing: 4,
        pending_directed: 0,
        unread: 5,
        chat_type: "private",
      },
      personality: [0.05, 0.45, 0.45, 0.05],
      utcHour: 14,
    });

    for (let i = 0; i < 3; i++) {
      evolveTick(state);
    }

    // 连发上限阻止入队（3 >= cap=3）
    expect(state.queue.length).toBe(0);
  });

  it("Cold start ambient curiosity produces nonzero API", () => {
    // 场景：空图（仅 self + 1 channel），eta=0.6，tick=50（冷启动期）。
    // P6 ambient curiosity = η × (1 - familiarity)。
    // 无联系人 → contactFamiliarity=0 → familiarity=0 → P6 = η = 0.6。
    // 直接调用 computeAllPressures 检查，不经过 evolveTick 门控。
    const G = new WorldModel();
    G.tick = 50;
    G.addAgent("self");
    G.addChannel("channel:test", {
      unread: 0,
      tier_contact: 150,
      chat_type: "private",
      pending_directed: 0,
      last_directed_ms: 0,
    });
    G.addRelation("self", "monitors", "channel:test");

    const pressures = computeAllPressures(G, 50, {
      eta: 0.6,
      nowMs: Date.now(),
    });

    // P6 ambient curiosity 在无联系人时应接近 η=0.6
    expect(pressures.P6).toBeGreaterThan(0);
    expect(pressures.P6).toBeCloseTo(0.6, 1);
    // API 包含 P6 贡献（tanh(0.6/0.5) ≈ 0.83），应大于 0
    expect(pressures.API).toBeGreaterThan(0);
  });

  it("VoI Deferral: high entropy beliefs trigger L4_DEFERRED", () => {
    // 核心机制：VoI(null) = Kalman gain proxy × nsvScale。
    // 默认信念 sigma2=1.0（高不确定性）→ K ≈ 0.909 → VoI ≈ 0.09。
    // 当 VoI > bestV > 0 时，观望优于行动 → L4_DEFERRED 沉默。
    //
    // @see paper-pomdp/ Def 5.3: Value of Information
    // @see src/engine/silence.ts: computeVoINull
    const G = new WorldModel();
    G.tick = 50;
    G.addAgent("self");
    G.addChannel("channel:test", {
      unread: 3,
      tier_contact: 50,
      chat_type: "private",
      pending_directed: 0,
      last_directed_ms: 0,
    });
    G.addRelation("self", "monitors", "channel:test");

    // 默认 BeliefStore：无任何观测 → getOrDefault 返回 sigma2=1.0
    // K_tier = 1.0 / (1.0 + 0.1) ≈ 0.909
    // K_mood = 1.0 / (1.0 + 0.1) ≈ 0.909
    // VoI = (K_tier + K_mood) / 1 entity × 0.05 ≈ 0.0909
    const voiNull = computeVoINull(["channel:test"], G.beliefs, 50);

    expect(voiNull).toBeGreaterThan(0.05);
    expect(voiNull).toBeCloseTo(0.0909, 2);

    // L4_DEFERRED 条件：voiNull > bestV > 0
    // bestV=0.03（V-max 找到的最优行动净值很小但为正）
    const bestV = 0.03;
    const level = classifySilence(0.5, 0.05, bestV, voiNull, false);
    expect(level).toBe("L4_DEFERRED");

    // 对比：bestV=0（非正）→ 不满足 bestV > 0 → 降级到 L3_STRATEGIC
    const levelZero = classifySilence(0.5, 0.05, 0, voiNull, false);
    expect(levelZero).toBe("L3_STRATEGIC");

    // 对比：bestV > VoI → 行动优于观望 → 不是 L4_DEFERRED
    const levelHigh = classifySilence(0.5, 0.05, 0.15, voiNull, false);
    expect(levelHigh).not.toBe("L4_DEFERRED");
  });

  it("Conversation continuation stays on the IAUS path instead of directed_override", () => {
    // 核心机制：alice_turn 对话 → isConversationContinuation=true
    // → shouldBypassGates=true + effectiveLambda = λ × 0.5
    //
    // pending_directed=0 → targetHasDirected=false
    // 但 turn_state=alice_turn → isConversationContinuation=true
    // → shouldBypassGates = (false || true) && !permanent = true
    // → 所有 post-gates 绕过 + lambda 折半
    //
    // @see evolve.ts line 530-534: effectiveLambda 调制
    const state = buildScenarioState({
      channelAttrs: {
        pending_directed: 0,
        unread: 5,
        chat_type: "private",
        tier_contact: 5,
        last_directed_ms: 0,
        last_incoming_ms: Date.now(),
      },
      addConversation: { state: "active", turnState: "alice_turn" },
      personality: [0.1, 0.35, 0.45, 0.1],
      utcHour: 14,
    });

    for (let i = 0; i < 3; i++) {
      evolveTick(state);
    }

    const db = getDb();
    const traces = db.select({ payloadJson: decisionTrace.payloadJson }).from(decisionTrace).all();
    expect(traces.some((r) => r.payloadJson.includes("directed_override"))).toBe(false);

    // continuation 仍可经 IAUS 正常入队；它只是不能被伪装成 directed 义务。
    const logs = db.select({ gateVerdict: tickLog.gateVerdict }).from(tickLog).all();
    const hasEnqueue = logs.some((r) => r.gateVerdict?.startsWith("enqueue"));
    expect(hasEnqueue).toBe(true);
  });

  it("Permanent unreachable target does not bypass gates", () => {
    // 核心不变量：shouldBypassGates = (directed || continuation) && !permanent = false。
    // permanent 覆盖 directed，anyBypass=false（permanent 节点被 V-max 跳过）。
    // unread=0 确保 P1=0；低人格外向性 + consecutive_outgoing=3 的 C_sat σ_out 惩罚
    // 在低压力下使 V ≤ 0 → 自然不入队。
    // ADR-136: consecutive_outgoing 二值门控已折叠进 C_sat σ_out 连续惩罚。
    const state = buildScenarioState({
      channelAttrs: {
        pending_directed: 1,
        failure_type: "permanent",
        reachability_score: 0,
        consecutive_outgoing: 3,
        unread: 0,
        chat_type: "private",
        last_directed_ms: Date.now() - 5000,
      },
      personality: [0.05, 0.45, 0.45, 0.05],
      utcHour: 14,
    });

    for (let i = 0; i < 3; i++) {
      evolveTick(state);
    }

    // permanent → shouldBypassGates=false, anyBypass=false → 门控正常 + V ≤ 0 → 无入队
    expect(state.queue.length).toBe(0);
  });

  it("V-max winner target respects Engagement Exclusivity even if different from focal", () => {
    // 场景：两个频道 A 和 B。A 在队列中正在处理。
    // B 是获胜声部的焦点目标（通过 isTargetActive 检查），但 V-max 可能选择 A。
    // 修复前：A 被重复入队（line 527 只检查 B，V-max 赢家 A 逃逸）。
    // 修复后：V-max 赢家 A 被 Engagement Exclusivity 拦截。
    const state = buildScenarioState({
      channelId: "channel:B",
      channelAttrs: {
        unread: 5,
        tier_contact: 5,
        chat_type: "private",
        pending_directed: 0,
      },
      extraChannels: [
        {
          id: "channel:A",
          attrs: {
            unread: 10,
            tier_contact: 5,
            chat_type: "private",
            pending_directed: 3,
            last_directed_ms: Date.now() - 2000,
          },
        },
      ],
      personality: [0.25, 0.25, 0.25, 0.25],
      utcHour: 14,
    });

    // tick 1: 第一次行动（可能入队 A 或 B）
    evolveTick(state);
    const firstQueueLen = state.queue.length;

    if (firstQueueLen > 0) {
      // 不消费队列，模拟 ACT 线程正在处理。
      // 连续跑几个 tick，同一 target 不应再入队。
      const peekTarget = state.queue.peek()?.target;

      for (let i = 0; i < 5; i++) {
        evolveTick(state);
      }

      // 同一 target 在队列中最多出现一次（Engagement Exclusivity 保证）
      // items + processing 中只应有一个 peekTarget
      if (peekTarget) {
        let countInQueue = 0;
        // 通过 dequeue 计数（会消耗队列，仅在测试中使用）
        const allItems: Array<{ target: string | null }> = [];
        while (state.queue.length > 0) {
          const item = state.queue.tryDequeue();
          if (item) allItems.push(item);
          else break;
        }
        countInQueue = allItems.filter((i) => i.target === peekTarget).length;
        // 同一 target 在队列中不应重复
        expect(countInQueue).toBeLessThanOrEqual(1);
      }
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ADR-189 蟑螂审计: 补盲测试
// ═══════════════════════════════════════════════════════════════════════════

describe("ADR-274: normal IAUS winners are not killed by post-winner active_cooling", () => {
  beforeEach(() => initDb(":memory:"));
  afterEach(() => closeDb());

  it("(a) IAUS winner bypass=false + 高 classCounts → 仍然入队", () => {
    // 场景：无义务、无对话延续 → bypass=false。窗口内大量行动（分散到其他 target）。
    // ADR-274: normal cadence 不能在 IAUS 选中赢家后再用 active_cooling 随机杀掉。
    // 注意：recentActions 不能全指向 channel:test，否则 per-target rate limit 先过滤。
    const nowMs = Date.now();
    const otherTargets = ["channel:o1", "channel:o2", "channel:o3", "channel:o4"];
    const recentActions = Array.from({ length: 20 }, (_, i) => ({
      tick: i + 1,
      action: "sociability" as string,
      ms: nowMs - (30 - i) * 1000,
      target: otherTargets[i % otherTargets.length] as string | null,
    }));

    const state = buildScenarioState({
      channelAttrs: {
        pending_directed: 0,
        unread: 10,
        chat_type: "private",
        tier_contact: 5,
      },
      configOverrides: {
        rateCap: { private: 100, group: 100, channel: 100, bot: 100 },
        socialCost: {
          ...loadConfig().socialCost,
          lambdaC: 1.0, // 极小 λ → exp(-20/1) ≈ 0 → 几乎 100% 拦截
        },
      },
      recentActions,
      utcHour: 14,
      // 需要 other target 在图中以便 countActionsByClass 正确分类
      extraChannels: otherTargets.map((id) => ({
        id,
        attrs: { chat_type: "private", unread: 0 },
      })),
    });

    // 跑 5 tick。旧行为会产生 active_cooling silence；新行为应该允许入队。
    for (let i = 0; i < 5; i++) {
      evolveTick(state);
    }

    const db = getDb();
    const silences = db
      .select({
        reason: silenceLog.reason,
        deltaP: silenceLog.deltaP,
        socialCost: silenceLog.socialCost,
        netValue: silenceLog.netValue,
      })
      .from(silenceLog)
      .all();
    const hasCooling = silences.some((r) => r.reason === "active_cooling");
    expect(hasCooling).toBe(false);
    expect(state.queue.length).toBeGreaterThan(0);
  });

  it("(b) IAUS winner bypass=true(pending_directed) + 高 classCounts → enqueue", () => {
    // 场景：强义务(pending_directed) → bypass=true。高 classCounts 不再有 post-winner 冷却可绕。
    const nowMs = Date.now();
    const recentActions = Array.from({ length: 20 }, (_, i) => ({
      tick: i + 1,
      action: "sociability" as string,
      ms: nowMs - (30 - i) * 1000,
      target: "channel:other" as string | null,
    }));

    const state = buildScenarioState({
      channelAttrs: {
        pending_directed: 3,
        unread: 10,
        chat_type: "private",
        tier_contact: 5,
        last_directed_ms: nowMs - 5000,
      },
      configOverrides: {
        socialCost: {
          ...loadConfig().socialCost,
          lambdaC: 1.0, // 极小 λ → 非 bypass 时几乎 100% 拦截
        },
      },
      addConversation: { state: "active", turnState: "alice_turn" },
      recentActions,
      utcHour: 14,
      extraChannels: [{ id: "channel:other", attrs: { chat_type: "private", unread: 0 } }],
    });

    for (let i = 0; i < 3; i++) {
      evolveTick(state);
    }

    expect(state.queue.length).toBeGreaterThanOrEqual(1);
  });
});

describe("ADR-274: directed obligation stays on normal IAUS path under per-target density", () => {
  beforeEach(() => initDb(":memory:"));
  afterEach(() => closeDb());

  it("高 per-target density + directed → IAUS 仍 enqueue，不依赖 directedCandidate fallback", () => {
    // ADR-274: generic per-target rate limit 不再清空候选池。
    // 这里的 6 条同 target recentActions 只降低 U_freshness；pending_directed 仍走 IAUS 主路径。
    const nowMs = Date.now();
    const recentActions = Array.from({ length: 6 }, (_, i) => ({
      tick: i + 1,
      action: "diligence" as string,
      ms: nowMs - (20 - i) * 1000,
      target: "channel:test" as string | null,
    }));

    const state = buildScenarioState({
      channelAttrs: {
        pending_directed: 2,
        unread: 5,
        chat_type: "private",
        tier_contact: 5,
        last_directed_ms: nowMs - 3000,
      },
      recentActions,
      utcHour: 14,
    });

    evolveTick(state);

    const db = getDb();
    const silences = db.select({ reason: silenceLog.reason }).from(silenceLog).all();
    expect(
      silences.some((row) => row.reason === "candidate_pool_empty:per_target_rate_limit"),
    ).toBe(false);
    const traces = db
      .select({
        reason: candidateTrace.silenceReason,
        considerationsJson: candidateTrace.normalizedConsiderationsJson,
      })
      .from(candidateTrace)
      .all();
    expect(traces.some((row) => row.reason === "candidate_pool_empty:per_target_rate_limit")).toBe(
      false,
    );
    expect(traces.some((row) => row.considerationsJson.includes("U_freshness"))).toBe(true);
  });
});

describe("ADR-189 蟑螂审计: directedCandidate + outgoing cap (GAP-4, P1)", () => {
  beforeEach(() => initDb(":memory:"));
  afterEach(() => closeDb());

  it("(a) 强义务 + 高 outgoing → 跳过 anti-bombing 保险丝", () => {
    // 强义务（pending_directed=3，effectiveObligation > bypassGates 阈值 0.2）
    // + consecutive_outgoing >= cap(4) → bypass 穿透同 target anti-bombing cap。
    const nowMs = Date.now();
    const recentActions = Array.from({ length: 6 }, (_, i) => ({
      tick: i + 1,
      action: "diligence" as string,
      ms: nowMs - (20 - i) * 1000,
      target: "channel:test" as string | null,
    }));

    const state = buildScenarioState({
      channelAttrs: {
        pending_directed: 3,
        unread: 5,
        chat_type: "private",
        tier_contact: 5,
        last_directed_ms: nowMs - 3000, // 新鲜义务
        consecutive_outgoing: 5, // > outgoingCapPrivate=4
      },
      configOverrides: {
        iausDeterministic: true,
      },
      recentActions,
      utcHour: 14,
    });

    evolveTick(state);

    // 强义务跳过 outgoing cap；是否最终入队还可能受 VoI / API floor 等非保险丝机制影响。
    const db = getDb();
    const silences = db.select({ reason: silenceLog.reason }).from(silenceLog).all();
    expect(
      silences.some((row) => row.reason === "candidate_pool_empty:consecutive_outgoing_cap"),
    ).toBe(false);
  });

  it("(b) weak continuation + 高 outgoing → anti-bombing 仍可硬拦截", () => {
    // 弱 continuation 还不是 W4 typed continuity；高 outgoing 下同 target anti-bombing
    // 仍是硬不变量，不能把它伪装成已受保护的深聊连续性。
    const nowMs = Date.now();
    const recentActions = Array.from({ length: 6 }, (_, i) => ({
      tick: i + 1,
      action: "diligence" as string,
      ms: nowMs - (20 - i) * 1000,
      target: "channel:test" as string | null,
    }));

    const state = buildScenarioState({
      channelAttrs: {
        pending_directed: 0,
        unread: 5,
        chat_type: "private",
        tier_contact: 5,
        last_directed_ms: 0,
        consecutive_outgoing: 5, // > outgoingCapPrivate=4
      },
      addConversation: { state: "active", turnState: "alice_turn" },
      configOverrides: {
        iausDeterministic: true,
      },
      recentActions,
      utcHour: 14,
    });

    for (let i = 0; i < 3; i++) {
      evolveTick(state);
    }

    expect(state.queue.length).toBe(0);
    const db = getDb();
    const silences = db.select({ reason: silenceLog.reason }).from(silenceLog).all();
    expect(
      silences.some((row) => row.reason === "candidate_pool_empty:consecutive_outgoing_cap"),
    ).toBe(true);
  });
});

describe("ADR-189 蟑螂审计: 多频道真实密度集成 (GAP-10, P0)", () => {
  beforeEach(() => initDb(":memory:"));
  afterEach(() => closeDb());

  it("10+ channels、~8 actions、lambdaC=6.0 → 入队率 > 0", () => {
    // 场景：模拟真实运行条件 — 混合 private/group channels，50 分钟窗口 ~8 actions。
    // ADR-274: lambdaC 不再通过 post-winner active_cooling 决定普通赢家生死。
    const nowMs = Date.now();

    // 8 个历史行动，分散到不同 target（不超过 per-target rate limit）
    const targets = ["channel:p1", "channel:p2", "channel:g1", "channel:g2"];
    const recentActions = Array.from({ length: 8 }, (_, i) => ({
      tick: i + 1,
      action: (i % 3 === 0 ? "diligence" : i % 3 === 1 ? "sociability" : "curiosity") as string,
      ms: nowMs - (i + 1) * 5 * 60_000, // 每 5 分钟 1 个，窗口内分布
      target: targets[i % targets.length] as string | null,
    }));

    // 10+ channels（6 private + 4 group），部分有足够 unread 产生正压力
    const extraChannels: Array<{ id: string; attrs: ChannelDefaultsInput }> = [
      {
        id: "channel:p1",
        attrs: {
          chat_type: "private",
          unread: 8,
          tier_contact: 5,
          last_incoming_ms: nowMs - 60_000,
        },
      },
      {
        id: "channel:p2",
        attrs: {
          chat_type: "private",
          unread: 5,
          tier_contact: 5,
          last_incoming_ms: nowMs - 120_000,
        },
      },
      { id: "channel:p3", attrs: { chat_type: "private", unread: 3, tier_contact: 15 } },
      { id: "channel:p4", attrs: { chat_type: "private", unread: 2, tier_contact: 50 } },
      { id: "channel:p5", attrs: { chat_type: "private", unread: 0, tier_contact: 150 } },
      {
        id: "channel:g1",
        attrs: {
          chat_type: "group",
          unread: 15,
          tier_contact: 50,
          last_incoming_ms: nowMs - 30_000,
        },
      },
      { id: "channel:g2", attrs: { chat_type: "group", unread: 8, tier_contact: 50 } },
      { id: "channel:g3", attrs: { chat_type: "supergroup", unread: 20, tier_contact: 150 } },
      { id: "channel:g4", attrs: { chat_type: "group", unread: 2, tier_contact: 50 } },
    ];

    const state = buildScenarioState({
      channelId: "channel:main",
      channelAttrs: {
        pending_directed: 0,
        unread: 10,
        chat_type: "private",
        tier_contact: 5,
        last_incoming_ms: nowMs - 90_000,
      },
      extraChannels,
      recentActions,
      utcHour: 14,
      // 使用默认 lambdaC=6.0 — 验证修正后的参数不过度拦截
    });

    // 跑 10 tick，统计入队率
    let enqueueCount = 0;
    for (let i = 0; i < 10; i++) {
      const prevLen = state.queue.length;
      evolveTick(state);
      if (state.queue.length > prevLen) enqueueCount++;
      // 消费队列，模拟 act 线程处理
      while (state.queue.length > 0) {
        const item = state.queue.tryDequeue();
        if (item) {
          // 记录到 recentActions（模拟 act 确认回调）
          state.recentActions.push({
            tick: state.G.tick,
            action: item.action,
            ms: Date.now(),
            target: item.target,
          });
        }
      }
    }

    // 核心不变量：10 tick 中至少应有 1 次入队（lambdaC=6.0 不应过度拦截）
    expect(enqueueCount).toBeGreaterThan(0);
  });
});
