/**
 * ADR-136: Eval Fixtures — eval 管线所需的 mock/fixture 工厂函数。
 *
 * eval runner 不连接真实 Telegram，通过 fixtures 提供最小上下文驱动
 * buildPrompt → callLLM → executeInSandbox 管线。
 *
 * 设计决策：
 * - Dispatcher 使用真实 Mod 加载 + 内存 SQLite，测试真实管线路径
 * - WorldModel 是真实实例，填充场景所需的最小节点/边
 * - ActContext 只填充 buildPrompt 实际使用的字段，其余 stub
 * - 所有工厂共享统一 nowMs，消除 Date.now() 散布导致的时间漂移
 * - 场景 contactId 使用裸域名（"carol"），图层前缀由此处负责
 *
 * @see docs/adr/136-model-eval-suite.md
 */

import { type Config, loadConfig } from "../config.js";
import { createAliceDispatcher, type Dispatcher } from "../core/dispatcher.js";
import { loadAllMods } from "../core/mod-loader.js";
import { closeDb, initDb } from "../db/connection.js";
import type { MessageRecord } from "../engine/act/messages.js";
import type { ActionQueueItem } from "../engine/action-queue.js";
import type { ActContext } from "../engine/react/orchestrator.js";
import { ALICE_SELF } from "../graph/constants.js";
import { WorldModel } from "../graph/world-model.js";
import { type AllPressures, apiAggregate, observableMapping } from "../pressure/aggregate.js";
import type { PressureDims } from "../utils/math.js";
import { PersonalityVector } from "../voices/personality.js";
import type { EvalScenario, PressureValues } from "./types.js";

// ── 领域→图 ID 转换 ─────────────────────────────────────────────────────

/**
 * 裸域名 → 图层 contact ID。
 *
 * 场景定义使用领域语言（"carol"），图实现使用 "contact:" 前缀。
 * 此函数是两层之间的唯一桥梁。
 */
function toGraphContactId(bareId: string): string {
  return `contact:${bareId}`;
}

/** 裸域名 → 图层 channel ID。 */
function toGraphChannelId(bareId: string): string {
  return `channel:${bareId}`;
}

/** eval 默认压力快照。单一真理源。 */
const DEFAULT_EVAL_PRESSURES: PressureValues = {
  p1: 2.0,
  p2: 1.0,
  p3: 1.5,
  p4: 0.5,
  p5: 1.0,
  p6: 0.3,
};

/** PressureValues → PressureDims 数组。消除 2 处手动展开。 */
function pressuresToDims(p: PressureValues): PressureDims {
  return [p.p1, p.p2, p.p3, p.p4, p.p5, p.p6];
}

/**
 * 从 eval 场景的 PressureValues 构造最小可行 AllPressures。
 *
 * eval 场景使用静态压力值（不经过真实 computeAllPressures 管线），
 * 此函数将 p1-p6 转换为 pressure.mod 可消费的完整 AllPressures 对象。
 * 所有压力贡献归属到目标 channel entity（单实体模型）。
 *
 * @see computeAllPressures — 生产版完整计算管线
 */
function buildEvalPressures(p: PressureValues, targetEntity: string): AllPressures {
  const api = apiAggregate(p.p1, p.p2, p.p3, p.p4, p.p5, p.p6);
  const a = observableMapping(api);

  // 单实体模型：所有压力贡献归属到目标 channel
  const contributions: Record<string, Record<string, number>> = {
    P1: { [targetEntity]: p.p1 },
    P2: { [targetEntity]: p.p2 },
    P3: { [targetEntity]: p.p3 },
    P4: { [targetEntity]: p.p4 },
    P5: { [targetEntity]: p.p5 },
    P6: { [targetEntity]: p.p6 },
  };

  return {
    P1: p.p1,
    P2: p.p2,
    P3: p.p3,
    P4: p.p4,
    P5: p.p5,
    P6: p.p6,
    P_prospect: 0,
    API: api,
    API_peak: api,
    A: a,
    contributions,
    prospectContributions: {},
    pressureHistory: { P1: [], P2: [], P3: [], P4: [], P5: [], P6: [] },
  };
}

/**
 * ADR-139: Eval 固定时间戳 — 避免 Date.now() 导致的时间敏感场景失败。
 *
 * 使用上午 9:30（UTC+8），确保：
 * - "早上好" 类问候与时间一致（不再出现 20:35 说早上好的矛盾）
 * - 日历/时钟 App 返回可预测结果
 * - 跨次运行结果一致（消除时间漂移导致的 flaky test）
 */
const EVAL_FIXED_TIME_MS = new Date("2026-01-15T09:30:00+08:00").getTime();

// ── 内存 DB 管理 ─────────────────────────────────────────────────────────────

/** 内存 DB 引用计数，支持嵌套初始化/清理。 */
let dbRefCount = 0;

/**
 * 初始化内存 SQLite（幂等）。
 * eval 开始前调用，结束后调用 teardownEvalDb() 释放。
 */
export function setupEvalDb(): void {
  if (dbRefCount === 0) {
    initDb(":memory:");
  }
  dbRefCount++;
}

/** 释放内存 SQLite。与 setupEvalDb 配对使用。 */
export function teardownEvalDb(): void {
  dbRefCount--;
  if (dbRefCount <= 0) {
    dbRefCount = 0;
    closeDb();
  }
}

// ── Graph Fixture ────────────────────────────────────────────────────────────

/**
 * 根据 eval 场景创建预填充的 WorldModel。
 *
 * 最小图结构：
 * - self 节点（agent 类型）
 * - target contact 节点
 * - target channel 节点
 * - self → channel（joined）、contact → channel（joined）关系
 */
export function createEvalGraph(scenario: EvalScenario, nowMs: number): WorldModel {
  const G = new WorldModel();

  // 1. self 节点
  G.addAgent(ALICE_SELF, {
    display_name: "Alice",
    mood_valence: 0,
    mood_set_ms: nowMs,
    created_ms: nowMs - 86_400_000, // 模拟存在 1 天
  });

  // 2. 目标联系人（裸域名 → 图层 ID）
  const contactId = toGraphContactId(scenario.target.contactId);
  const channelId = toGraphChannelId(scenario.target.contactId);

  G.addContact(contactId, {
    display_name: scenario.target.displayName,
    tier: scenario.target.tier as import("../graph/entities.js").DunbarTier,
    relation_type: scenario.target.relationType as import("../graph/entities.js").RelationType,
    last_active_ms: nowMs,
    auth_level: 0,
    interaction_count: 10,
    is_bot: false,
  });

  // 3. 目标频道（私聊或群聊）
  const isGroup = scenario.chatType === "group";

  G.addChannel(channelId, {
    display_name: isGroup ? `${scenario.target.displayName} 的群` : scenario.target.displayName,
    chat_type: scenario.chatType,
    tier_contact: scenario.target.tier as import("../graph/entities.js").DunbarTier,
    unread: scenario.messages.filter((m) => m.role !== "alice").length,
    pending_directed: scenario.messages.filter((m) => m.role === "user" && m.directed !== false)
      .length,
    last_directed_ms: nowMs,
  });

  // 4. 关系边
  G.addRelation(ALICE_SELF, "joined", channelId);
  G.addRelation(contactId, "joined", channelId);
  G.addRelation(ALICE_SELF, "knows", contactId);

  // 5. 群聊场景：添加 other 角色的联系人
  if (isGroup) {
    const otherNames = new Set<string>();
    for (const msg of scenario.messages) {
      if (msg.role === "other" && msg.name) {
        otherNames.add(msg.name);
      }
    }
    let otherIdx = 900_000;
    for (const name of otherNames) {
      const otherId = `contact:${otherIdx}`;
      G.addContact(otherId, {
        display_name: name,
        tier: 150,
        relation_type: "acquaintance",
        last_active_ms: nowMs,
        is_bot: false,
      });
      G.addRelation(otherId, "joined", channelId);
      otherIdx++;
    }
  }

  // 设置 tick
  G.tick = 100;

  return G;
}

// ── Dispatcher Fixture ───────────────────────────────────────────────────────

/**
 * 创建真实的 Dispatcher（真实 Mod + 内存 DB）。
 *
 * 使用真实 Mod 加载路径：eval 测试的是真实管线，不是 mock。
 * 内存 SQLite 隔离了文件系统副作用。
 *
 * 调用前必须先 setupEvalDb()。
 */
export function createEvalDispatcher(graph: WorldModel): Dispatcher {
  const mods = loadAllMods();
  return createAliceDispatcher({ graph, mods });
}

// ── Config Fixture ───────────────────────────────────────────────────────────

/**
 * 创建 eval 专用的最小 Config（纯函数）。
 *
 * 基于 loadConfig() 默认值，通过 spread 覆盖——不 mutate 原对象。
 * 禁用所有外部服务（TTS/Vision/ASR/Exa），场景可通过 features 恢复。
 */
function createEvalConfig(scenario: EvalScenario): Config {
  return {
    ...loadConfig(),
    // 禁用所有外部依赖
    ttsBaseUrl: "",
    ttsApiKey: "",
    visionModel: "",
    asrBaseUrl: "",
    exaApiKey: "",
    musicApiBaseUrl: "",
    // 场景功能开关覆盖
    ...(scenario.features.hasTTS && { ttsBaseUrl: "https://eval.local/tts" }),
  };
}

// ── ActionQueueItem Fixture ──────────────────────────────────────────────────

/**
 * 从 eval 场景构建 ActionQueueItem。
 *
 * 压力快照使用场景指定值或合理默认值。
 *
 * ADR-139: voice action 从 expectedIntent 推断（不再从 expectedBranch）。
 * expectedIntent 是必填字段，消除了 expectedBranch 可选化后的 undefined 回退问题。
 * 映射语义：engage → diligence（有消息待读），silence/defer → caution（安静观望）。
 */
export function createEvalQueueItem(scenario: EvalScenario): ActionQueueItem {
  const pressureSnapshot = pressuresToDims(scenario.pressures ?? DEFAULT_EVAL_PRESSURES);

  // ADR-139: 从社交意图推断声部 — 消除与 expectedBranch 的循环依赖
  // 支持可接受集：取第一个意图作为声部推断基准
  // ADR-152 F3: 群聊沉默场景用 diligence（"有消息但不需要你回复"）而非 caution
  // （"有什么不对劲"），避免 caution whisper 误导 LLM 参与讨论
  const rawIntent = scenario.structural.expectedIntent;
  const primaryIntent = Array.isArray(rawIntent) ? rawIntent[0] : rawIntent;
  const isGroup = scenario.chatType === "group";
  let action: "diligence" | "curiosity" | "sociability" | "caution";
  switch (primaryIntent) {
    case "engage":
      action = "diligence";
      break;
    case "silence":
    case "defer":
      // 群聊沉默 → diligence（"有消息，不是每条都需要你"）更自然
      // 私聊沉默 → caution（"需要停一下"）保持克制
      action = isGroup ? "diligence" : "caution";
      break;
    default:
      action = "diligence";
      break;
  }

  return {
    enqueueTick: 100,
    action,
    target: toGraphChannelId(scenario.target.contactId),
    pressureSnapshot,
    contributions: {},
  };
}

// ── Messages Fixture ─────────────────────────────────────────────────────────

/**
 * 将 EvalMessage[] 转换为 buildPrompt 使用的 MessageRecord[]。
 */
export function createEvalMessages(scenario: EvalScenario, nowMs: number): MessageRecord[] {
  const msgs: MessageRecord[] = [];
  let msgIdCounter = 1;

  for (let i = 0; i < scenario.messages.length; i++) {
    const em = scenario.messages[i];
    const id = em.msgId ?? msgIdCounter++;

    // 时间递增，最新消息距现在最近
    const offsetMs = (scenario.messages.length - i) * 30_000; // 每条间隔 30 秒

    msgs.push({
      id,
      senderName: em.role === "alice" ? "Alice" : (em.name ?? scenario.target.displayName),
      senderId: em.role === "alice" ? undefined : em.role === "user" ? 100_001 : 900_000 + i,
      isOutgoing: em.role === "alice",
      text: em.text,
      date: new Date(nowMs - offsetMs),
      mediaType: em.mediaLabel ? parseMediaLabel(em.mediaLabel) : undefined,
    });
  }

  return msgs;
}

/** 从 mediaLabel 提取媒体类型。 "(photo)" → "photo", "(sticker: 😂)" → "sticker" */
function parseMediaLabel(label: string): string {
  const match = label.match(/^\((\w+)/);
  return match?.[1] ?? "unknown";
}

// ── ActContext Fixture ────────────────────────────────────────────────────────

/**
 * 组装 buildPrompt 所需的最小 ActContext。
 *
 * buildPrompt 实际依赖的字段：
 * - ctx.G（WorldModel）
 * - ctx.config（Config — budgetZones, ttsBaseUrl, exaApiKey, peripheral 等）
 * - ctx.dispatcher（generateManual, collectContributions）
 *
 * 不依赖的字段（stub）：
 * - ctx.client, ctx.queue, ctx.buffer, ctx.personality
 * - ctx.getCurrentTick, ctx.getCurrentPressures, ctx.onPersonalityUpdate
 */
export function createEvalContext(
  scenario: EvalScenario,
  graph: WorldModel,
  dispatcher: Dispatcher,
): ActContext {
  const config = createEvalConfig(scenario);
  const pressures = pressuresToDims(scenario.pressures ?? DEFAULT_EVAL_PRESSURES);

  return {
    G: graph,
    config,
    dispatcher,
    // buildPrompt 不使用以下字段，提供类型安全的 stub
    client: null as never,
    queue: null as never,
    buffer: null as never,
    personality: new PersonalityVector([0.25, 0.25, 0.25, 0.25]),
    getCurrentTick: () => graph.tick,
    getCurrentPressures: () => pressures,
    onPersonalityUpdate: () => {},
    recordAction: () => {},
    reportLLMOutcome: () => {},
  };
}

// ── 一站式 Fixture ───────────────────────────────────────────────────────────

/**
 * 一站式创建完整 eval fixture 集。
 *
 * 返回 buildPrompt 所需的全部参数 + dispatcher（脚本执行用）。
 * 调用前必须先 setupEvalDb()。
 *
 * 设计：单一 nowMs 贯穿所有子工厂，保证 fixture 内部时间一致性。
 *
 * @example
 * ```typescript
 * setupEvalDb();
 * try {
 *   const fx = createEvalFixture(scenario);
 *   const { system, user } = buildPrompt(
 *     fx.ctx, fx.item, fx.tick, fx.messages, fx.contextVars,
 *   );
 *   const result = await callLLM(fx.item, fx.tick, system, user);
 * } finally {
 *   teardownEvalDb();
 * }
 * ```
 */
export interface EvalFixture {
  readonly ctx: ActContext;
  readonly graph: WorldModel;
  readonly dispatcher: Dispatcher;
  readonly item: ActionQueueItem;
  readonly tick: number;
  readonly messages: MessageRecord[];
  readonly contextVars: Record<string, unknown>;
  /** 固定墙钟时间（ms）——与消息时间戳对齐，消除 Date.now() 时间漂移。 */
  readonly nowMs: number;
}

export function createEvalFixture(scenario: EvalScenario): EvalFixture {
  // ADR-139: 使用固定时间戳，消除时间敏感场景的不确定性
  const nowMs = EVAL_FIXED_TIME_MS;

  const graph = createEvalGraph(scenario, nowMs);
  const dispatcher = createEvalDispatcher(graph);
  const ctx = createEvalContext(scenario, graph, dispatcher);
  const item = createEvalQueueItem(scenario);
  const messages = createEvalMessages(scenario, nowMs);
  const tick = graph.tick;

  const contactId = toGraphContactId(scenario.target.contactId);

  const contextVars: Record<string, unknown> = {
    TARGET_CHAT: item.target,
    CHAT_NAME: scenario.target.displayName,
    TARGET_CONTACT: contactId,
    ...scenario.contextOverrides,
  };

  // 初始化 dispatcher tick（触发 mod onTickStart）
  dispatcher.startTick(tick, nowMs);

  // Part 3a: 初始化压力和目标——驱动 contribute() 生成情境描述。
  // 无此初始化时 pressure.mod 的 state.latest = null，
  // contribute() 返回 "No recent pressure data" 而非真实情境线。
  const pressureValues = scenario.pressures ?? DEFAULT_EVAL_PRESSURES;
  // item.target 在 eval 中始终非 null（createEvalQueueItem 硬编码了 channel ID）
  // biome-ignore lint/style/noNonNullAssertion: eval 上下文中 target 保证存在
  const allPressures = buildEvalPressures(pressureValues, item.target!);
  dispatcher.dispatch("UPDATE_PRESSURES", {
    pressures: allPressures,
    focalEntities: [item.target],
  });
  dispatcher.dispatch("SET_CONTACT_TARGET", { nodeId: contactId });

  return {
    ctx,
    graph,
    dispatcher,
    item,
    tick,
    messages,
    contextVars,
    nowMs,
  };
}
