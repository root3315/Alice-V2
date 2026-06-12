/**
 * Category A: 分支覆盖场景 — 测试 ReAct 决策树的各主要分支。
 *
 * ADR-138: 每个场景定义 expectedIntent（社交意图，primary check），
 * 可选定义 expectedBranch（精确过程，secondary check）。
 * Intent 检查容忍过程差异（如 observe_then_reply vs reply 同为 engage），
 * Branch 检查仅用于过程本身是测试重点的场景。
 *
 * @see docs/adr/136-model-eval-suite.md
 * @see docs/adr/138-social-intent-truth-model.md
 * @see runtime/src/engine/act/shell-guide.ts — Shell-native prompt contract
 */
import type { EvalScenario } from "../types.js";

export const BRANCH_SCENARIOS = [
  // ── 1. branch.reply.direct ──────────────────────────────────────────
  {
    id: "branch.reply.direct",
    title: "私聊被直接提问 — 应立即回复",
    tags: ["private"],
    messages: [
      {
        role: "user",
        name: "Carol",
        text: "你最近在忙什么呀？",
        directed: true,
      },
    ],
    target: {
      contactId: "carol",
      displayName: "Carol",
      tier: 50,
      relationType: "close_friend",
    },
    chatType: "private",
    features: { hasTarget: true },
    structural: {
      expectedIntent: "engage",
      expectedBranch: "reply", // 简单问题应回复（模型可能先 observe 查上下文）
      maxSteps: 3,
      actions: { must: ["send_message"] },
    },
  },

  // ── 2. branch.reply.emotional ───────────────────────────────────────
  {
    id: "branch.reply.emotional",
    title: "对方情绪低落 — 共情回复 + feel",
    tags: ["private", "empathy"],
    messages: [
      {
        role: "user",
        name: "Carol",
        text: "今天好累，什么都不想做…",
        directed: true,
      },
    ],
    target: {
      contactId: "carol",
      displayName: "Carol",
      tier: 50,
      relationType: "close_friend",
    },
    chatType: "private",
    features: { hasTarget: true },
    structural: {
      expectedIntent: "engage",
      // 不限定 branch — 直接共情回复 or 先查联系人再回复都可接受
      actions: { must: ["send_message"] },
      instructions: { must: ["feel"] },
    },
    quality: {
      dimensions: ["emotional_fit", "companionship"],
      passThreshold: 3.0,
    },
  },

  // ── 3. branch.silence.group_listen ──────────────────────────────────
  {
    id: "branch.silence.group_listen",
    title: "群聊旁听 — 他人闲聊未@Alice，保持沉默",
    tags: ["group", "restraint"],
    messages: [
      { role: "other", name: "Bob", text: "你们昨天看比赛了吗" },
      { role: "other", name: "Dave", text: "看了看了，太精彩了" },
      { role: "other", name: "Bob", text: "那个绝杀真的绝了" },
    ],
    target: {
      contactId: "bob",
      displayName: "Bob",
      tier: 100,
      relationType: "acquaintance",
    },
    chatType: "group",
    features: { hasTarget: true, isGroup: true },
    structural: {
      // 沉默是理想行为，但简短参与也可接受 — 群聊中偶尔插嘴是自然的
      expectedIntent: ["silence", "engage"],
    },
  },

  // ── 4. branch.reply.burst_patience ──────────────────────────────────
  {
    id: "branch.reply.burst_patience",
    title: "私聊连发消息 — 对方已表达完毕，温柔回应",
    tags: ["private", "patience"],
    messages: [
      { role: "user", name: "Carol", text: "等下", directed: true },
      {
        role: "user",
        name: "Carol",
        text: "我想跟你说个事",
        directed: true,
      },
      {
        role: "user",
        name: "Carol",
        text: "但是又不知道怎么开口",
        directed: true,
      },
    ],
    target: {
      contactId: "carol",
      displayName: "Carol",
      tier: 50,
      relationType: "close_friend",
    },
    chatType: "private",
    features: { hasTarget: true },
    structural: {
      expectedIntent: "engage",
      // 不限定 branch — 直接回复 or 先查联系人状态再回复都可接受
      actions: { must: ["send_message"] },
    },
    quality: {
      dimensions: ["emotional_fit", "naturalness"],
      passThreshold: 3.0,
    },
  },

  // ── 5. branch.observe.query_contact ─────────────────────────────────
  {
    id: "branch.observe.query_contact",
    title: "久未联系的人发消息 — 先查联系人再回复",
    tags: ["private", "memory"],
    messages: [
      {
        role: "user",
        name: "Eve",
        text: "好久没聊了，最近还好吗？",
        directed: true,
      },
    ],
    target: {
      contactId: "eve",
      displayName: "Eve",
      tier: 150,
      relationType: "acquaintance",
    },
    chatType: "private",
    features: { hasTarget: true },
    structural: {
      expectedIntent: "engage",
      expectedBranch: "observe_then_reply", // 久未联系 → 建议先查联系人（诊断）
      maxSteps: 3,
      queries: { must: ["contact_profile"] },
      actions: { must: ["send_message"] },
    },
  },

  // ── 6. branch.observe.query_topic ───────────────────────────────────
  {
    id: "branch.observe.query_topic",
    title: "对方追问之前的话题 — 先查上下文再回复",
    tags: ["private", "context"],
    messages: [
      {
        role: "user",
        name: "Carol",
        text: "上次你说要推荐给我的那本书叫什么来着？",
        directed: true,
      },
    ],
    target: {
      contactId: "carol",
      displayName: "Carol",
      tier: 50,
      relationType: "close_friend",
    },
    chatType: "private",
    features: { hasTarget: true },
    structural: {
      expectedIntent: ["engage", "defer"],
      // 不限定 branch — 直接回复、搜索记忆后回复、或搜索中观望都可接受
    },
  },

  // ── 7. branch.wait.half_sentence ────────────────────────────────────
  {
    id: "branch.wait.half_sentence",
    title: "对方只说了半句 — 等待对方继续",
    tags: ["private", "turn_taking"],
    messages: [
      { role: "alice", text: "真的假的？？" },
      {
        role: "user",
        name: "Carol",
        text: "真的！然后…",
        directed: true,
      },
    ],
    target: {
      contactId: "carol",
      displayName: "Carol",
      tier: 50,
      relationType: "close_friend",
    },
    chatType: "private",
    features: { hasTarget: true },
    structural: {
      expectedIntent: ["defer", "silence"],
      // 半句话 → 等待或沉默都合理，关键是不抢话
      actions: { must_not: ["send_message"] },
    },
  },

  // ── 8. branch.silence.group_debate ──────────────────────────────────
  {
    id: "branch.silence.group_debate",
    title: "群聊激烈辩论 — 未被邀请的旁观者",
    tags: ["group", "restraint"],
    messages: [
      { role: "other", name: "Bob", text: "春天才是最好的季节，万物复苏" },
      {
        role: "other",
        name: "Dave",
        text: "秋天吧，不冷不热还有红叶",
      },
      {
        role: "other",
        name: "Bob",
        text: "秋天太短了，一眨眼就冬天了",
      },
      {
        role: "other",
        name: "Eve",
        text: "我觉得看地方吧，南方春天潮湿得不行",
      },
    ],
    target: {
      contactId: "bob",
      displayName: "Bob",
      tier: 100,
      relationType: "acquaintance",
    },
    chatType: "group",
    features: { hasTarget: true, isGroup: true },
    structural: {
      // 沉默是理想行为，但简短参与也可接受 — 分享观点是人格表达
      expectedIntent: ["silence", "engage"],
    },
  },

  // ── 9. branch.observe.calendar_app ──────────────────────────────────
  {
    id: "branch.observe.calendar_app",
    title: "询问日期信息 — 调用日历 App 后回复",
    tags: ["private", "app", "calendar"],
    messages: [
      {
        role: "user",
        name: "Carol",
        // 真正的日历查询（不是社交邀约 — "明天下午来找你玩呀"不需要查日历）
        text: "后天是不是工作日？帮我看看",
        directed: true,
      },
    ],
    target: {
      contactId: "carol",
      displayName: "Carol",
      tier: 50,
      relationType: "close_friend",
    },
    chatType: "private",
    features: { hasTarget: true },
    structural: {
      expectedIntent: "engage",
      expectedBranch: "observe_then_reply",
      maxSteps: 3,
      actions: { must: ["use_calendar_app", "send_message"] },
    },
  },

  // ── 10. branch.reply.group_help ─────────────────────────────────────
  {
    id: "branch.reply.group_help",
    title: "群聊中问题无人应答 — 主动帮忙回复",
    tags: ["group"],
    messages: [
      {
        role: "other",
        name: "Eve",
        text: "有人知道怎么用 git 撤销上一次 commit 吗？push 之前想改一下",
        msgId: 42,
      },
      {
        role: "other",
        name: "Bob",
        text: "刚看到新闻说明天下雨",
      },
    ],
    target: {
      contactId: "eve",
      displayName: "Eve",
      tier: 100,
      relationType: "acquaintance",
    },
    chatType: "group",
    features: { hasTarget: true, isGroup: true },
    structural: {
      expectedIntent: "engage",
      // 不限定 branch — 直接回复 or 先观察再回复都可接受
      actions: { must: ["send_message"] },
    },
    quality: {
      dimensions: ["initiative", "naturalness"],
      passThreshold: 3.0,
    },
  },

  // ── 11. branch.observe_then_silence.already_answered ───────────────────
  {
    id: "branch.observe_then_silence.already_answered",
    title: "群聊问题已被他人解答 — 查询后判断不插嘴",
    tags: ["group", "restraint", "observation"],
    messages: [
      {
        role: "other",
        name: "Eve",
        text: "有人知道附近哪里有好吃的拉面吗？",
        msgId: 50,
      },
      {
        role: "other",
        name: "Dave",
        text: "一风堂不错，就在商场B1层",
      },
      {
        role: "other",
        name: "Eve",
        text: "谢谢！我去试试",
      },
    ],
    target: {
      contactId: "eve",
      displayName: "Eve",
      tier: 100,
      relationType: "acquaintance",
    },
    chatType: "group",
    features: { hasTarget: true, isGroup: true },
    structural: {
      expectedIntent: "silence",
      // 不限定 branch — 直接沉默 or 观察后沉默都可（直接沉默甚至更聪明）
      actions: { must_not: ["send_message"] },
    },
  },

  // ── 12. branch.action_only.react ──────────────────────────────────────
  {
    id: "branch.action_only.react",
    title: "朋友分享喜讯 — 用表情反应（不发消息）",
    tags: ["private", "sticker"],
    messages: [
      { role: "alice", text: "考得怎么样？" },
      {
        role: "user",
        name: "Carol",
        text: "过了过了！！！",
        directed: true,
        msgId: 60,
      },
    ],
    target: {
      contactId: "carol",
      displayName: "Carol",
      tier: 50,
      relationType: "close_friend",
    },
    chatType: "private",
    features: { hasTarget: true },
    structural: {
      expectedIntent: "engage",
      expectedBranch: "action_only", // 建议只用反应/贴纸（诊断，非 goal）
      // 反应/贴纸/文字回复都是合理的好消息响应 — 不限制表达方式
      instructions: { must: ["feel"] },
    },
  },

  // ── 13. branch.stay.unfinished ────────────────────────────────────────
  {
    id: "branch.stay.unfinished",
    title: "群聊正在展开的讨论 — 选择留下观望",
    tags: ["group", "turn_taking"],
    messages: [
      {
        role: "other",
        name: "Bob",
        text: "Alice 你觉得呢？",
        directed: true,
        msgId: 70,
      },
      {
        role: "other",
        name: "Dave",
        text: "等等，让我先说完...",
      },
    ],
    target: {
      contactId: "bob",
      displayName: "Bob",
      tier: 80,
      relationType: "friend",
    },
    chatType: "group",
    features: { hasTarget: true, isGroup: true },
    structural: {
      // defer (stay) 或 silence 都可接受 — 核心是"不说话，等别人说完"
      expectedIntent: ["defer", "silence"],
      expectedBranch: "watching", // 建议 watching（诊断，非 goal）
      actions: { must_not: ["send_message"] },
    },
  },

  // ── 14. branch.reply.p5_high ──────────────────────────────────────────
  {
    id: "branch.reply.p5_high",
    title: "高 P5 — 压力驱动的主动回复",
    tags: ["private", "p5_high"],
    messages: [
      {
        role: "user",
        name: "Carol",
        text: "在吗？",
        directed: true,
      },
    ],
    target: {
      contactId: "carol",
      displayName: "Carol",
      tier: 30,
      relationType: "close_friend",
    },
    chatType: "private",
    features: { hasTarget: true },
    pressures: { p1: 3.0, p2: 1.5, p3: 2.0, p4: 0.5, p5: 4.0, p6: 0.5 },
    structural: {
      expectedIntent: "engage",
      // 不限定 branch — 直接回复 or 先观察再回复都可
      actions: { must: ["send_message"] },
    },
  },

  // ── 15. branch.observe.research_task ─────────────────────────────────
  {
    id: "branch.observe.research_task",
    title: "请求调研任务 — 多步搜索",
    tags: ["private"],
    messages: [
      {
        role: "user",
        name: "Carol",
        text: "帮我查一下最近有什么好看的科幻电影，列个清单给我",
        directed: true,
      },
    ],
    target: {
      contactId: "carol",
      displayName: "Carol",
      tier: 50,
      relationType: "close_friend",
    },
    chatType: "private",
    features: { hasTarget: true },
    structural: {
      // LLM 可能直接回复或通过 App 异步搜索（multi-round 处理 stay() 流程）
      expectedIntent: "engage",
      actions: { must: ["send_message"] },
    },
  },

  // ── 16. branch.baseline.greeting ──────────────────────────────────────
  {
    id: "branch.baseline.greeting",
    title: "基线：简单问候 — 标准回复",
    tags: ["private", "baseline"],
    messages: [
      {
        role: "user",
        name: "Carol",
        text: "早上好呀！",
        directed: true,
      },
    ],
    target: {
      contactId: "carol",
      displayName: "Carol",
      tier: 50,
      relationType: "close_friend",
    },
    chatType: "private",
    features: { hasTarget: true },
    structural: {
      expectedIntent: "engage",
      expectedBranch: "reply", // 简单问候应回复（模型可能先 observe 查上下文）
      maxSteps: 3,
      actions: { must: ["send_message"] },
    },
    quality: {
      dimensions: ["personality", "naturalness"],
      passThreshold: 3.0,
    },
  },
] as const satisfies readonly EvalScenario[];
