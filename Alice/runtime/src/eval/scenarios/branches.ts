/**
 * Category A: Сценарии покрытия ветвей — тестирование основных ветвей дерева решений ReAct.
 *
 * ADR-138: Каждый сценарий задаёт expectedIntent (социальное намерение, primary check),
 * опционально — expectedBranch (точный процесс, secondary check).
 * Проверка Intent допускает расхождения в процессе (например, observe_then_reply vs reply оба относятся к engage),
 * проверка Branch применяется только там, где процесс сам является предметом теста.
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
    title: "Прямой вопрос в личке — должна ответить немедленно",
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
      expectedBranch: "reply", // Простой вопрос — ответить (модель может сначала observe для контекста)
      maxSteps: 3,
      actions: { must: ["send_message"] },
    },
  },

  // ── 2. branch.reply.emotional ───────────────────────────────────────
  {
    id: "branch.reply.emotional",
    title: "Собеседник подавлен — эмпатичный ответ + feel",
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
      // branch не ограничен — допустим как прямой эмпатичный ответ, так и предварительный запрос контакта
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
    title: "Наблюдение в групповом чате — чужой разговор без @Alice, молчать",
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
      // Молчание предпочтительно, но краткое участие допустимо — иногда вставить слово в группе естественно
      expectedIntent: ["silence", "engage"],
    },
  },

  // ── 4. branch.reply.burst_patience ──────────────────────────────────
  {
    id: "branch.reply.burst_patience",
    title: "Серия сообщений в личке — собеседник высказался полностью, мягкий ответ",
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
      // branch не ограничен — допустим как прямой ответ, так и предварительная проверка статуса контакта
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
    title: "Сообщение от давно замолчавшего контакта — сначала запросить профиль, затем ответить",
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
      expectedBranch: "observe_then_reply", // Давно не общались → рекомендуется сначала запросить контакт (диагностика)
      maxSteps: 3,
      queries: { must: ["contact_profile"] },
      actions: { must: ["send_message"] },
    },
  },

  // ── 6. branch.observe.query_topic ───────────────────────────────────
  {
    id: "branch.observe.query_topic",
    title: "Собеседник спрашивает о прошлом разговоре — сначала запросить контекст, затем ответить",
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
      // branch не ограничен — допустимы прямой ответ, ответ после поиска в памяти или ожидание при поиске
    },
  },

  // ── 7. branch.wait.half_sentence ────────────────────────────────────
  {
    id: "branch.wait.half_sentence",
    title: "Собеседник сказал полуфразу — ждать продолжения",
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
      // Полуфраза → ожидание или молчание — оба разумны; главное — не перебивать
      actions: { must_not: ["send_message"] },
    },
  },

  // ── 8. branch.silence.group_debate ──────────────────────────────────
  {
    id: "branch.silence.group_debate",
    title: "Жаркий спор в групповом чате — наблюдатель без приглашения",
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
      // Молчание предпочтительно, но краткое участие допустимо — выражение своего мнения является проявлением личности
      expectedIntent: ["silence", "engage"],
    },
  },

  // ── 9. branch.observe.calendar_app ──────────────────────────────────
  {
    id: "branch.observe.calendar_app",
    title: "Запрос информации о дате — вызвать приложение Календарь, затем ответить",
    tags: ["private", "app", "calendar"],
    messages: [
      {
        role: "user",
        name: "Carol",
        // Реальный запрос к календарю (не социальное приглашение — "давай встретимся завтра днём" не требует календаря)
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
    title: "Вопрос в группе остался без ответа — проявить инициативу и помочь",
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
      // branch не ограничен — допустимы как прямой ответ, так и ответ после наблюдения
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
    title: "Вопрос в группе уже получил ответ от другого — проверить и не вмешиваться",
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
      // branch не ограничен — допустимо прямое молчание или молчание после наблюдения (прямое молчание даже умнее)
      actions: { must_not: ["send_message"] },
    },
  },

  // ── 12. branch.action_only.react ──────────────────────────────────────
  {
    id: "branch.action_only.react",
    title: "Подруга делится радостной новостью — реакция эмодзи (без сообщения)",
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
      expectedBranch: "action_only", // Рекомендуется использовать только реакцию/стикер (диагностика, не goal)
      // Реакция/стикер/текстовый ответ — всё допустимо на хорошую новость; способ выражения не ограничивается
      instructions: { must: ["feel"] },
    },
  },

  // ── 13. branch.stay.unfinished ────────────────────────────────────────
  {
    id: "branch.stay.unfinished",
    title: "В группе разворачивается обсуждение — выбрать ожидание",
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
      // defer (stay) или silence оба допустимы — суть: "молчать, пока другой не договорит"
      expectedIntent: ["defer", "silence"],
      expectedBranch: "watching", // Рекомендуется watching (диагностика, не goal)
      actions: { must_not: ["send_message"] },
    },
  },

  // ── 14. branch.reply.p5_high ──────────────────────────────────────────
  {
    id: "branch.reply.p5_high",
    title: "Высокий P5 — ответ, движимый давлением",
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
      // branch не ограничен — допустимы как прямой ответ, так и ответ после наблюдения
      actions: { must: ["send_message"] },
    },
  },

  // ── 15. branch.observe.research_task ─────────────────────────────────
  {
    id: "branch.observe.research_task",
    title: "Запрос на исследование — многошаговый поиск",
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
      // LLM может ответить напрямую или искать через App асинхронно (multi-round обрабатывает поток stay())
      expectedIntent: "engage",
      actions: { must: ["send_message"] },
    },
  },

  // ── 16. branch.baseline.greeting ──────────────────────────────────────
  {
    id: "branch.baseline.greeting",
    title: "Базовый: простое приветствие — стандартный ответ",
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
      expectedBranch: "reply", // Простое приветствие — ответить (модель может сначала observe для контекста)
      maxSteps: 3,
      actions: { must: ["send_message"] },
    },
    quality: {
      dimensions: ["personality", "naturalness"],
      passThreshold: 3.0,
    },
  },
] as const satisfies readonly EvalScenario[];
