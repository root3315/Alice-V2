/**
 * Category B: App Toolkit 场景 — 测试 9 个 App 的正确调用。
 *
 * 每个 App 至少一个正例（应调用）+ 若干克制场景（不应调用）。
 * 验证 LLM 在自然对话中能正确选择并调用对应 App，
 * 同时在不需要 App 时保持克制。
 *
 * ADR-138: 所有正例 expectedIntent="engage" + maxSteps: 3（budget 约束）。
 * eval runner 支持多轮 tick：LLM 调用 App 后 stay() → 注入模拟结果 → round 2 send_message。
 * GOAL 通过 actions.must 验证 App 调用 + send_message 完整链路。
 *
 * App 列表（ADR-132）：
 * calendar, weather, browser, trending, music, video, countdown
 *
 * @see docs/adr/132-app-toolkit.md
 * @see docs/adr/138-social-intent-truth-model.md
 * @see runtime/src/telegram/apps/ — App 实现
 * @see runtime/src/engine/act/shell-guide.ts — Shell-native 示例注入
 */
import type { EvalScenario } from "../types.js";

export const APP_SCENARIOS = [
  // ═══════════════════════════════════════════════════════════════════════════
  // 正例：每个 App 应被正确调用
  // ═══════════════════════════════════════════════════════════════════════════

  // ── calendar ──────────────────────────────────────────────────────────────
  {
    id: "app.calendar.weekday",
    title: "询问日期对应星期 — 调用日历 App",
    tags: ["private", "app", "calendar"],
    messages: [
      {
        role: "user",
        name: "Carol",
        text: "下个月15号是星期几呀？",
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
      maxSteps: 3,
      actions: { must: ["use_calendar_app", "send_message"] },
    },
  },

  // ── weather ───────────────────────────────────────────────────────────────
  {
    id: "app.weather.tomorrow",
    title: "询问天气 — 调用天气 App",
    tags: ["private", "app", "weather"],
    messages: [
      {
        role: "user",
        name: "Carol",
        text: "明天上海会下雨吗？",
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
      maxSteps: 3,
      actions: { must: ["use_weather_app", "send_message"] },
    },
  },

  // ── countdown ─────────────────────────────────────────────────────────────
  {
    id: "app.countdown.holiday",
    title: "询问距离节日倒计时 — 调用倒计时 App",
    tags: ["private", "app", "countdown"],
    messages: [
      {
        role: "user",
        name: "Carol",
        text: "距离国庆节还有多少天？",
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
      maxSteps: 3,
      actions: { must: ["use_countdown_app", "send_message"] },
    },
  },

  // ── video ─────────────────────────────────────────────────────────────────
  {
    id: "app.video.search",
    title: "请求视频推荐 — 调用视频 App",
    tags: ["private", "app", "video"],
    messages: [
      {
        role: "user",
        name: "Carol",
        text: "有没有教做提拉米苏的视频推荐？",
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
      maxSteps: 3,
      actions: { must: ["use_video_app", "send_message"] },
    },
  },

  // ── browser ─────────────────────────────────────────────────────────────────
  {
    id: "app.browser.search",
    title: "请求搜索信息 — 调用浏览器 App",
    tags: ["private", "app", "browser"],
    messages: [
      {
        role: "user",
        name: "Carol",
        text: "帮我查一下最新的 iPhone 发布日期",
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
      maxSteps: 3,
      actions: { must: ["google", "send_message"] },
    },
  },

  // ── trending ────────────────────────────────────────────────────────────────
  {
    id: "app.trending.hot",
    title: "询问热搜 — 调用热搜 App",
    tags: ["private", "app", "trending"],
    messages: [
      {
        role: "user",
        name: "Carol",
        text: "今天微博有什么热搜？",
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
      maxSteps: 3,
      actions: { must: ["use_trending_app", "send_message"] },
    },
  },

  // ── music ──────────────────────────────────────────────────────────────────
  {
    id: "app.music.recommend",
    title: "请求歌曲推荐 — 调用音乐 App",
    tags: ["private", "app", "music"],
    messages: [
      {
        role: "user",
        name: "Carol",
        text: "推荐一首适合下雨天听的歌",
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
      maxSteps: 3,
      actions: { must: ["use_music_app", "send_message"] },
    },
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // 克制场景：不应调用 App
  // ═══════════════════════════════════════════════════════════════════════════

  {
    id: "app.restraint.no_clock_needed",
    title: "提到时间但不需要查时间 — 不调用 clock App",
    tags: ["private", "app", "restraint"],
    messages: [
      {
        role: "user",
        name: "Carol",
        text: "昨天下午三点发生了一件好玩的事",
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
      maxSteps: 3,
      actions: {
        must: ["send_message"],
        must_not: ["use_calendar_app", "use_countdown_app"],
      },
    },
  },

  {
    id: "app.restraint.no_weather_needed",
    title: "用天气比喻心情 — 不调用天气 App",
    tags: ["private", "app", "restraint"],
    messages: [
      {
        role: "user",
        name: "Carol",
        text: "我心里像暴风雨一样",
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
      maxSteps: 3,
      actions: {
        must: ["send_message"],
        must_not: ["use_weather_app"],
      },
      instructions: { must: ["feel"] },
    },
    quality: {
      dimensions: ["emotional_fit", "companionship"],
      passThreshold: 3.0,
    },
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // 消融对照：App 能力缺失时的降级行为
  // ═══════════════════════════════════════════════════════════════════════════

  {
    id: "app.ablation.no_browse",
    title: "请求搜索但无 browse 能力 — 不幻觉，坦诚告知",
    tags: ["private", "app", "ablation"],
    messages: [
      {
        role: "user",
        name: "Carol",
        text: "帮我查一下最近的新闻热点",
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
    // browse 能力不可用
    features: { hasTarget: true },
    structural: {
      expectedIntent: "engage",
      maxSteps: 3,
      actions: {
        // trending 是 browse 不可用时的合理降级（热搜 ≈ 新闻热点）
        must: ["send_message"],
        must_not: ["google", "visit"],
      },
    },
    quality: {
      dimensions: ["boundary", "naturalness"],
      passThreshold: 3.0,
    },
  },
] as const satisfies readonly EvalScenario[];
