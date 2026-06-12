/**
 * Query Format Layer — Mod query format 纯函数测试。
 *
 * 验证每个 query 的 format 输出人类可读文本（非 JSON）。
 * 通过 dispatcher.getQueryDef(name).format 获取 format 函数，
 * 传入模拟数据断言输出格式。
 *
 * @see docs/adr/129-query-format-layer.md
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAliceDispatcher } from "../src/core/dispatcher.js";
import { loadAllMods } from "../src/core/mod-loader.js";
import { closeDb, initDb } from "../src/db/connection.js";
import { WorldModel } from "../src/graph/world-model.js";

let dispatcher: ReturnType<typeof createAliceDispatcher>;

beforeEach(() => {
  initDb(":memory:");
  const G = new WorldModel();
  G.addAgent("self");
  dispatcher = createAliceDispatcher({ graph: G, mods: loadAllMods() });
  dispatcher.startTick(1);
});

afterEach(() => {
  closeDb();
});

/** 获取 format 函数并将 string[] 输出 join 回 string（兼容已有断言）。 */
function getFormat(queryName: string): (result: unknown) => string {
  const def = dispatcher.getQueryDef(queryName);
  expect(def).toBeDefined();
  expect(def?.format).toBeDefined();
  const rawFmt = def!.format!;
  return (result: unknown) => rawFmt(result).join("\n");
}

// -- recentChat ----------------------------------------------------------

describe("recentChat.format", () => {
  it("格式化为每行一条消息（humanDuration 时间标签）", () => {
    const fmt = getFormat("recent_chat");
    const now = Date.now();
    const result = [
      {
        tick: 34,
        senderName: "Alice",
        text: "你好",
        isOutgoing: true,
        isDirected: false,
        mediaType: null,
        createdAt: new Date(now - 600_000), // 10 minutes ago
      },
      {
        tick: 39,
        senderName: "池塘",
        text: "真的假的",
        isOutgoing: false,
        isDirected: true,
        mediaType: null,
        createdAt: new Date(now - 300_000), // 5 minutes ago
      },
    ];
    const output = fmt(result);
    // 使用 humanDuration 格式化时间，不再暴露 raw tick
    expect(output).toContain("ago] Alice: 你好 (outgoing)");
    expect(output).toContain("ago] 池塘: 真的假的 (directed)");
    expect(output).not.toContain("tick:");
    // 不包含 JSON 括号
    expect(output).not.toContain("{");
    expect(output).not.toContain("}");
  });

  it("media 消息标注类型", () => {
    const fmt = getFormat("recent_chat");
    const result = [
      {
        tick: 10,
        senderName: "Bob",
        text: null,
        isOutgoing: false,
        isDirected: false,
        mediaType: "photo",
      },
    ];
    const output = fmt(result);
    expect(output).toContain("(photo)");
    expect(output).toContain("photo");
  });

  it("空数组输出 (no messages)", () => {
    const fmt = getFormat("recent_chat");
    expect(fmt([])).toBe("(no messages)");
  });
});

// -- contactProfile -----------------------------------------------------------------

describe("contactProfile.format", () => {
  it("格式化联系人卡片", () => {
    const fmt = getFormat("contact_profile");
    const result = {
      contactId: "contact:123",
      displayName: "池塘",
      language: "zh-CN",
      interactionCount: 42,
      tier: 5,
      memorizedFacts: [
        { content: "likes cats", fact_type: "preference", retrievability: 0.82 },
        { content: "住在上海", fact_type: "general", retrievability: 0.65 },
      ],
      profile: {
        portrait: "热心但有时催得急",
        interests: ["编程", "猫"],
      },
      trustLabel: "deeply trusted",
    };
    const output = fmt(result);
    // 无障碍：display_name 不再附带 raw contactId
    expect(output).toContain("池塘");
    expect(output).not.toContain("contact:123");
    // 语义标签替代 raw 数值
    expect(output).toContain("intimate"); // tierLabel(5)
    expect(output).toContain("speaks zh-CN");
    expect(output).toContain("several conversations"); // 42 interactions
    // retrievability 用清晰度标签替代 raw 数值
    // ADR-156: "vivid" 仅用于高情感反应度事实；纯信息事实用 clear/fading/dim/distant
    expect(output).toContain("[preference] likes cats (clear)"); // R=0.82, E=0
    expect(output).toContain("[general] 住在上海 (fading)"); // R=0.65, E=0
    expect(output).toContain("Portrait: 热心但有时催得急");
    expect(output).toContain("Interests: 编程, 猫");
    // trust 用叙事标签替代 raw 数值
    expect(output).toContain("Trust: deeply trusted"); // 0.85
    expect(output).not.toContain("{");
  });

  it("无 profile 时不崩溃", () => {
    const fmt = getFormat("contact_profile");
    const result = {
      contactId: "contact:456",
      displayName: "Bob",
      language: null,
      interactionCount: 0,
      tier: 50,
      memorizedFacts: [],
      profile: null,
    };
    const output = fmt(result);
    expect(output).toContain("Bob");
    expect(output).not.toContain("contact:456"); // raw ID 不暴露
    expect(output).not.toContain("Facts:");
  });
});

// -- openTopics ----------------------------------------------------------

describe("openTopics.format", () => {
  it("格式化话题列表（语义标签替代 raw 数值）", () => {
    const fmt = getFormat("open_topics");
    const result = [
      {
        id: 1,
        title: "morning_digest",
        status: "system",
        weight: "major",
        pressure: 0.8,
        involves: [{ nodeId: "contact:1", displayName: "Alice" }],
        horizon: null,
      },
      {
        id: 3,
        title: "周末爬山",
        status: "open",
        weight: "minor",
        pressure: 0.3,
        involves: [],
        horizon: 10,
      },
    ];
    const output = fmt(result);
    expect(output).toContain('#1 "morning_digest" [system] major');
    // pressure → 定性标签
    expect(output).toContain("moderate"); // 0.5 < 0.8 ≤ 1.0
    expect(output).not.toContain("pressure:");
    // involves → display_name
    expect(output).toContain("involves: Alice");
    expect(output).not.toContain("contact:1");
    expect(output).toContain('#3 "周末爬山" [open] minor');
    // horizon → humanDuration
    expect(output).toContain("ahead");
    expect(output).not.toContain("horizon:");
  });

  it("空列表输出提示", () => {
    const fmt = getFormat("open_topics");
    expect(fmt([])).toBe("(no open topics)");
  });
});

// -- topicUpdates --------------------------------------------------------

describe("topicUpdates.format", () => {
  it("格式化 beat 时间线（humanDuration 时间标签）", () => {
    const fmt = getFormat("topic_updates");
    const result = [
      {
        tick: 95,
        agoLabel: "about 5 minutes ago",
        beatType: "observation",
        content: "Lee mentioned parking",
        causedBy: ["#2"],
        spawns: null,
      },
      {
        tick: 100,
        agoLabel: "just now",
        beatType: "engagement",
        content: "discussed new route",
        causedBy: null,
        spawns: ["#5"],
      },
    ];
    const output = fmt(result);
    // 使用 humanDuration 格式化时间，不再暴露 raw tick
    expect(output).toContain("[about 5 minutes ago] [observation] Lee mentioned parking ← #2");
    expect(output).toContain("[just now] [engagement] discussed new route → #5");
    expect(output).not.toContain("tick:");
  });
});

// -- reminders -----------------------------------------------------------

describe("reminders.format", () => {
  it("格式化定时任务（humanDuration 替代 raw tick）", () => {
    const fmt = getFormat("reminders");
    const nowMs = Date.now();
    const result = [
      {
        id: 5,
        type: "at",
        targetMs: nowMs + 50 * 60_000, // 50 分钟后
        intervalMs: null,
        action: "提醒池塘带零食",
        target: "channel:main",
        _targetName: "主频道",
        _currentMs: nowMs,
      },
      {
        id: 8,
        type: "every",
        targetMs: null,
        intervalMs: 30 * 60_000, // 每 30 分钟
        action: "检查群消息",
        target: "channel:dev",
        _targetName: "开发群",
        _currentMs: nowMs,
      },
    ];
    const output = fmt(result);
    // at 类型：显示剩余时间（50 分钟）
    expect(output).toContain('#5 [once] "提醒池塘带零食"');
    expect(output).toContain("→ 主频道");
    expect(output).toContain("in ~");
    expect(output).not.toContain("target tick:");
    // every 类型：显示间隔时长
    expect(output).toContain("repeats every ~");
    expect(output).toContain('"检查群消息"');
    expect(output).toContain("→ 开发群");
  });

  it("空列表输出提示", () => {
    const fmt = getFormat("reminders");
    expect(fmt([])).toBe("(no reminders)");
  });
});

// -- chatMood ------------------------------------------------------------

describe("chatMood.format", () => {
  it("格式化情绪状态（语义标签，无 raw 数值）", () => {
    const fmt = getFormat("chat_mood");
    const result = {
      displayName: "技术讨论群",
      display_name: "技术讨论群",
      mood_valence: 0.6,
      mood_arousal: 0.3,
      risk_level: "low",
      activity_type: "discussion",
      activity_intensity: 0.5,
      activity_relevance: null,
      social_debt_direction: null,
      risk_reason: null,
    };
    const output = fmt(result);
    expect(output).toContain("技术讨论群:");
    expect(output).toContain("mood: positive");
    expect(output).toContain("energy: calm");
    expect(output).toContain("risk: low");
    expect(output).toContain("activity: discussion (moderate)");
    // 确保不暴露 raw 数值
    expect(output).not.toContain("0.6");
    expect(output).not.toContain("0.3");
  });
});

// -- pastResults ---------------------------------------------------------

describe("pastResults.format", () => {
  it("格式化行动历史（语义标签 + 相对时间）", () => {
    const fmt = getFormat("past_results");
    // impl() 预解析后的结构：{ name, quality, reason, when }
    const result = [
      { name: "Alice 的群", quality: "good", reason: "回复及时", when: "5m ago" },
      { name: "Bob", quality: "fair", reason: "跑题了", when: "1h ago" },
    ];
    const output = fmt(result);
    expect(output).toContain('Alice 的群: good — "回复及时" (5m ago)');
    expect(output).toContain('Bob: fair — "跑题了" (1h ago)');
  });

  it("空列表输出提示", () => {
    const fmt = getFormat("past_results");
    expect(fmt([])).toBe("(no past results)");
  });
});
