/**
 * Category C: Proactive 场景 — 测试 Alice 主动联系的决策质量。
 *
 * 当前 eval 只测试"收到消息后如何回应"，不测试"何时主动联系"。
 * 这些场景模拟长时间沉默后的状态，验证 Alice 是否在 Goldilocks 窗口内行动：
 * - tier 5 (intimate): 沉默数小时后应主动联系
 * - tier 50 (friend): 沉默 1 天后可能联系
 * - tier 150 (acquaintance): 不应主动联系
 *
 * 关键设计：messages 为空或只有旧消息 — 测试的是"无刺激下的自发行为"。
 * pressures 设置反映沉默时间导致的 P1/P3 积累。
 *
 * @see docs/adr/154-goldilocks-window/
 * @see docs/adr/136-model-eval-suite.md
 */
import type { EvalScenario } from "../types.js";

export const PROACTIVE_SCENARIOS: readonly EvalScenario[] = [
  // ── 1. 亲密好友沉默 4 小时 — 应主动联系 ──────────────────────────────
  {
    id: "proactive.intimate.initiate",
    title: "亲密好友长时间沉默 — 应主动发消息",
    tags: ["private", "proactive"],
    messages: [
      // 只有一条很旧的 Alice 消息，没有后续
      {
        role: "alice",
        text: "晚安～明天聊",
      },
    ],
    target: {
      contactId: "carol",
      displayName: "Carol",
      tier: 5,
      relationType: "intimate",
    },
    chatType: "private",
    features: { hasTarget: true },
    pressures: { p1: 4.0, p2: 0.5, p3: 3.0, p4: 0.5, p5: 2.0, p6: 1.0 },
    structural: {
      // engage 或 defer 都可接受 — "先确认状态再决定" 是合理行为
      expectedIntent: ["engage", "defer"],
      maxSteps: 3,
    },
    quality: {
      dimensions: ["companionship", "initiative", "naturalness"],
      passThreshold: 3.0,
    },
  },

  // ── 2. 熟人沉默 1 天 — 可接受联系或沉默 ──────────────────────────────
  {
    id: "proactive.friend.optional",
    title: "普通朋友沉默较长时间 — 联系或沉默均可",
    tags: ["private", "proactive"],
    messages: [
      {
        role: "alice",
        text: "好的 下次再聊",
      },
    ],
    target: {
      contactId: "david",
      displayName: "David",
      tier: 50,
      relationType: "close_friend",
    },
    chatType: "private",
    features: { hasTarget: true },
    pressures: { p1: 2.5, p2: 0.5, p3: 1.5, p4: 0.3, p5: 1.0, p6: 0.5 },
    structural: {
      // 联系、沉默、观望都可接受 — tier 50 的 Goldilocks 窗口边界模糊
      expectedIntent: ["engage", "silence", "defer"],
      maxSteps: 3,
    },
  },

  // ── 3. 点头之交沉默 — 不应主动联系 ───────────────────────────────────
  {
    id: "proactive.acquaintance.silence",
    title: "点头之交沉默 — 不应主动联系",
    tags: ["private", "proactive", "restraint"],
    messages: [],
    target: {
      contactId: "stranger",
      displayName: "Lee",
      tier: 150,
      relationType: "acquaintance",
    },
    chatType: "private",
    features: { hasTarget: true },
    pressures: { p1: 1.0, p2: 0.3, p3: 0.5, p4: 0.2, p5: 0.5, p6: 0.2 },
    structural: {
      expectedIntent: "silence",
      actions: { must_not: ["send_message"] },
    },
  },

  // ── 4. 群聊沉默 — 不应无故在群里发言 ─────────────────────────────────
  {
    id: "proactive.group.silence",
    title: "群聊无人说话 — 不应无故发言",
    tags: ["group", "proactive", "restraint"],
    messages: [],
    target: {
      contactId: "techgroup",
      displayName: "技术讨论群",
      tier: 50,
      relationType: "group_member",
    },
    chatType: "group",
    features: { hasTarget: true, isGroup: true },
    pressures: { p1: 0.5, p2: 0.3, p3: 0.5, p4: 0.2, p5: 0.5, p6: 0.3 },
    structural: {
      // 沉默和观望都是"不发消息"的正确行为 — stay() 在空群聊中语义等价于 silence
      expectedIntent: ["silence", "defer"],
      actions: { must_not: ["send_message"] },
    },
  },
] satisfies readonly EvalScenario[];
