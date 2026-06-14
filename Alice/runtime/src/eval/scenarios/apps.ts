/**
 * Category B: Сценарии App Toolkit — тестирование корректного вызова 9 App.
 *
 * Для каждого App минимум один положительный пример (должен вызываться) + несколько сдержанных сценариев (не должен вызываться).
 * Проверяет, что LLM в естественном диалоге правильно выбирает и вызывает нужный App,
 * сохраняя сдержанность, когда App не нужен.
 *
 * ADR-138: все положительные примеры expectedIntent="engage" + maxSteps: 3 (ограничение бюджета).
 * eval runner поддерживает многораундовый tick: LLM вызывает App → stay() → инжект мок-результата → round 2 send_message.
 * GOAL верифицируется через actions.must — проверяет полную цепочку вызова App + send_message.
 *
 * Список App (ADR-132):
 * calendar, weather, browser, trending, music, video, countdown
 *
 * @see docs/adr/132-app-toolkit.md
 * @see docs/adr/138-social-intent-truth-model.md
 * @see runtime/src/telegram/apps/ — реализации App
 * @see runtime/src/engine/act/shell-guide.ts — инжекция Shell-native примеров
 */
import type { EvalScenario } from "../types.js";

export const APP_SCENARIOS = [
  // ═══════════════════════════════════════════════════════════════════════════
  // Положительные примеры: каждый App должен вызываться корректно
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
  // Сдержанные сценарии: App вызываться не должен
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
  // Абляционный контроль: деградированное поведение при отсутствии возможностей App
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
    // Возможность browse недоступна
    features: { hasTarget: true },
    structural: {
      expectedIntent: "engage",
      maxSteps: 3,
      actions: {
        // trending — разумная деградация при недоступном browse (горячие темы ≈ новостные тренды)
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
