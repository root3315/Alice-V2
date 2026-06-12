/**
 * ADR-121: Social Peripheral Vision 单元测试。
 *
 * @see src/engine/act/timeline.ts — PeripheralTimelineSource
 * @see docs/adr/121-social-peripheral-vision/README.md
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MessageRecord } from "../src/engine/act/messages.js";

// Mock DB 查询
vi.mock("../src/db/queries.js", () => ({
  getPeripheralMessages: vi.fn(() => []),
  getRecentActionsByChat: vi.fn(() => []),
}));

import { getPeripheralMessages } from "../src/db/queries.js";
import {
  buildTimeline,
  MessageTimelineSource,
  PeripheralTimelineSource,
  type PeripheralVisionConfig,
  renderTimeline,
} from "../src/engine/act/timeline.js";

const mockGetPeripheral = vi.mocked(getPeripheralMessages);

// ── 测试工具 ──────────────────────────────────────────────────────────────

function makeConfig(overrides?: Partial<PeripheralVisionConfig>): PeripheralVisionConfig {
  return {
    contactId: "contact:42",
    contactName: "Bob",
    currentChat: "channel:42",
    sharedChats: new Map([
      ["channel:100", "Tech群"],
      ["channel:200", "Casual群"],
    ]),
    perChannelCap: 3,
    totalCap: 8,
    windowS: 86400,
    minTextLength: 15,
    ...overrides,
  };
}

function makeRow(
  chatId: string,
  text: string,
  createdAt: Date,
  msgId = 1,
  senderName: string | null = "Bob",
) {
  return { chatId, text, msgId, createdAt, senderName };
}

/** 创建测试用 MessageRecord。 */
function msg(
  id: number,
  isOutgoing: boolean,
  date: Date,
  overrides?: Partial<MessageRecord>,
): MessageRecord {
  return {
    id,
    senderName: isOutgoing ? "Alice" : `User${id}`,
    senderId: isOutgoing ? undefined : id,
    isOutgoing,
    text: `msg-${id}`,
    date,
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// PeripheralTimelineSource
// ═══════════════════════════════════════════════════════════════════════════

describe("PeripheralTimelineSource", () => {
  beforeEach(() => {
    mockGetPeripheral.mockReset();
  });

  it("基本渲染 — context block + messages + delimiters", () => {
    const t1 = new Date("2025-06-01T09:15:00Z");
    const t2 = new Date("2025-06-01T09:23:00Z");
    mockGetPeripheral.mockReturnValue([
      makeRow("channel:100", "Rust 的零成本抽象真的是零成本吗", t2, 2),
      makeRow("channel:100", "我做了个 benchmark 结果很有意思", t1, 1),
    ]);

    const source = new PeripheralTimelineSource(makeConfig());
    const entries = source.entries("channel:42", 0, Date.now());

    // 开头分隔符 + 2 条消息 + 结尾分隔符
    expect(entries).toHaveLength(4);
    expect(entries[0].kind).toBe("context");
    expect(entries[0].rendered).toContain("peripheral: what Bob has been up to");
    expect(entries[1].kind).toBe("message");
    expect(entries[1].rendered).toContain('Bob in Tech群: "我做了个 benchmark 结果很有意思"');
    expect(entries[2].kind).toBe("message");
    expect(entries[2].rendered).toContain('Bob in Tech群: "Rust 的零成本抽象真的是零成本吗"');
    expect(entries[3].kind).toBe("context");
    expect(entries[3].rendered).toBe("--- end peripheral ---");
  });

  it("隐私：空 sharedChats → 无输出", () => {
    const source = new PeripheralTimelineSource(makeConfig({ sharedChats: new Map() }));
    const entries = source.entries("channel:42", 0, Date.now());
    expect(entries).toEqual([]);
    // 不应调用 DB
    expect(mockGetPeripheral).not.toHaveBeenCalled();
  });

  it("隐私：windowS=0 (tier 500) → 禁用", () => {
    const source = new PeripheralTimelineSource(makeConfig({ windowS: 0 }));
    const entries = source.entries("channel:42", 0, Date.now());
    expect(entries).toEqual([]);
    expect(mockGetPeripheral).not.toHaveBeenCalled();
  });

  it("隐私：非共享频道的消息被过滤", () => {
    mockGetPeripheral.mockReturnValue([
      makeRow("channel:999", "这条来自未共享的频道", new Date("2025-06-01T09:00:00Z"), 1),
      makeRow(
        "channel:100",
        "这条来自共享的 Tech群 需要超过15字符",
        new Date("2025-06-01T09:10:00Z"),
        2,
      ),
    ]);

    const source = new PeripheralTimelineSource(makeConfig());
    const entries = source.entries("channel:42", 0, Date.now());

    // 只有 channel:100 的消息通过
    const messages = entries.filter((e) => e.kind === "message");
    expect(messages).toHaveLength(1);
    expect(messages[0].rendered).toContain("Tech群");
  });

  it("每频道 cap K=3", () => {
    const base = new Date("2025-06-01T09:00:00Z");
    mockGetPeripheral.mockReturnValue(
      Array.from({ length: 5 }, (_, i) =>
        makeRow(
          "channel:100",
          `消息内容需要超过十五个字符 ${i}`,
          new Date(base.getTime() - i * 60_000),
          i + 1,
        ),
      ),
    );

    const source = new PeripheralTimelineSource(makeConfig({ perChannelCap: 3 }));
    const entries = source.entries("channel:42", 0, Date.now());

    const messages = entries.filter((e) => e.kind === "message");
    expect(messages).toHaveLength(3);
  });

  it("总 cap M=8", () => {
    const base = new Date("2025-06-01T09:00:00Z");
    // channel:100 有 5 条，channel:200 有 5 条（每频道 cap=5 > 3，但总 cap=8）
    const rows = [
      ...Array.from({ length: 5 }, (_, i) =>
        makeRow(
          "channel:100",
          `Tech 群消息需要超过十五个字符 ${i}`,
          new Date(base.getTime() - i * 60_000),
          i + 1,
        ),
      ),
      ...Array.from({ length: 5 }, (_, i) =>
        makeRow(
          "channel:200",
          `Casual 群消息需要超过十五个字符 ${i}`,
          new Date(base.getTime() - i * 60_000),
          i + 10,
        ),
      ),
    ];
    mockGetPeripheral.mockReturnValue(rows);

    const source = new PeripheralTimelineSource(makeConfig({ perChannelCap: 5, totalCap: 8 }));
    const entries = source.entries("channel:42", 0, Date.now());

    const messages = entries.filter((e) => e.kind === "message");
    expect(messages.length).toBeLessThanOrEqual(8);
  });

  it("最短文本长度过滤", () => {
    const t = new Date("2025-06-01T09:00:00Z");
    mockGetPeripheral.mockReturnValue([
      makeRow("channel:100", "嗯", t, 1), // 太短
      makeRow("channel:100", "好的", new Date(t.getTime() + 1000), 2), // 太短
      makeRow(
        "channel:100",
        "这条消息的长度超过了十五个字符所以应该通过",
        new Date(t.getTime() + 2000),
        3,
      ),
    ]);

    const source = new PeripheralTimelineSource(makeConfig({ minTextLength: 15 }));
    const entries = source.entries("channel:42", 0, Date.now());

    const messages = entries.filter((e) => e.kind === "message");
    expect(messages).toHaveLength(1);
    expect(messages[0].rendered).toContain("这条消息的长度超过了十五个字符");
  });

  it("文本截断到 150 字符", () => {
    const t = new Date("2025-06-01T09:00:00Z");
    const longText = "字".repeat(200);
    mockGetPeripheral.mockReturnValue([makeRow("channel:100", longText, t, 1)]);

    const source = new PeripheralTimelineSource(makeConfig({ minTextLength: 1 }));
    const entries = source.entries("channel:42", 0, Date.now());

    const messages = entries.filter((e) => e.kind === "message");
    expect(messages).toHaveLength(1);
    expect(messages[0].rendered).toContain("字".repeat(147));
    expect(messages[0].rendered).toContain("...");
    expect(messages[0].rendered).not.toContain("字".repeat(148));
  });

  it("时间戳排序 — 余光消息按时间升序", () => {
    const t1 = new Date("2025-06-01T09:00:00Z");
    const t2 = new Date("2025-06-01T09:30:00Z");
    mockGetPeripheral.mockReturnValue([
      // getPeripheralMessages 返回 DESC
      makeRow("channel:100", "后发的消息需要超过十五个字符才行", t2, 2),
      makeRow("channel:100", "先发的消息也需要超过十五个字符才行", t1, 1),
    ]);

    const source = new PeripheralTimelineSource(makeConfig());
    const entries = source.entries("channel:42", 0, Date.now());

    const messages = entries.filter((e) => e.kind === "message");
    expect(messages).toHaveLength(2);
    // 反转后应该是时间升序
    expect(messages[0].ts).toBeLessThan(messages[1].ts);
  });

  it("开头分隔符 ts < 最早消息 ts", () => {
    const t = new Date("2025-06-01T09:15:00Z");
    mockGetPeripheral.mockReturnValue([
      makeRow("channel:100", "这是一条测试消息需要超过十五个字符", t, 1),
    ]);

    const source = new PeripheralTimelineSource(makeConfig());
    const entries = source.entries("channel:42", 0, Date.now());

    expect(entries[0].kind).toBe("context");
    expect(entries[0].ts).toBe(t.getTime() - 1);
    expect(entries[1].kind).toBe("message");
    expect(entries[1].ts).toBe(t.getTime());
  });

  it("DB 失败 → 静默降级（空数组）", () => {
    mockGetPeripheral.mockImplementation(() => {
      throw new Error("DB connection failed");
    });

    const source = new PeripheralTimelineSource(makeConfig());
    const entries = source.entries("channel:42", 0, Date.now());

    expect(entries).toEqual([]);
  });

  it("null text 消息被过滤", () => {
    const t = new Date("2025-06-01T09:00:00Z");
    mockGetPeripheral.mockReturnValue([
      makeRow("channel:100", null as unknown as string, t, 1),
      makeRow("channel:100", "这条有文本内容且超过十五个字符", new Date(t.getTime() + 1000), 2),
    ]);

    const source = new PeripheralTimelineSource(makeConfig({ minTextLength: 1 }));
    const entries = source.entries("channel:42", 0, Date.now());

    const messages = entries.filter((e) => e.kind === "message");
    expect(messages).toHaveLength(1);
  });

  it("senderName 回退到 contactName", () => {
    const t = new Date("2025-06-01T09:00:00Z");
    mockGetPeripheral.mockReturnValue([
      makeRow("channel:100", "消息来自没有名字的人需要超十五字符", t, 1, null),
    ]);

    const source = new PeripheralTimelineSource(makeConfig());
    const entries = source.entries("channel:42", 0, Date.now());

    const messages = entries.filter((e) => e.kind === "message");
    expect(messages).toHaveLength(1);
    expect(messages[0].rendered).toContain("Bob in Tech群");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 集成：buildTimeline 归并 PeripheralTimelineSource + MessageTimelineSource
// ═══════════════════════════════════════════════════════════════════════════

describe("buildTimeline with PeripheralTimelineSource", () => {
  beforeEach(() => {
    mockGetPeripheral.mockReset();
  });

  it("余光条目出现在主时间线消息之前", () => {
    const peripheralTime = new Date("2025-06-01T09:15:00Z");
    const messageTime = new Date("2025-06-01T11:30:00Z");

    mockGetPeripheral.mockReturnValue([
      makeRow("channel:100", "群里讨论了一个很有意思的问题值得关注", peripheralTime, 1),
    ]);

    const peripheralSource = new PeripheralTimelineSource(makeConfig());
    const messageSource = new MessageTimelineSource([
      msg(5001, false, messageTime, { senderName: "Bob", senderId: 42 }),
    ]);

    const nowMs = messageTime.getTime() + 60_000;
    const sinceMs = nowMs - 10 * 60 * 1000;
    const timeline = buildTimeline([peripheralSource, messageSource], "channel:42", sinceMs, nowMs);

    // 余光条目（context + message + context）应排在主消息之前
    const kinds = timeline.map((e) => e.kind);
    const peripheralStart = kinds.indexOf("context");
    const mainMessage = kinds.lastIndexOf("message");
    expect(peripheralStart).toBeLessThan(mainMessage);

    // 检查开头分隔符
    const firstContext = timeline.find((e) => e.rendered.includes("peripheral:"));
    expect(firstContext).toBeDefined();

    // 检查结尾分隔符
    const endContext = timeline.find((e) => e.rendered === "--- end peripheral ---");
    expect(endContext).toBeDefined();
  });

  it("renderTimeline 对余光 context 不加时间戳", () => {
    const t = new Date("2025-06-01T09:15:00Z");
    mockGetPeripheral.mockReturnValue([
      makeRow("channel:100", "这是一条很长的消息它超过了十五个字符哦", t, 1),
    ]);

    const source = new PeripheralTimelineSource(makeConfig());
    const entries = source.entries("channel:42", 0, Date.now());
    const lines = renderTimeline(entries);

    const TIME_RE = /\d{1,2}:\d{2}\s[AP]M/;

    // context 行不含时间戳
    expect(lines[0]).toMatch(/^--- peripheral:/);
    expect(lines[0]).not.toMatch(TIME_RE);

    // message 行含 [h:MM AM/PM] 时间戳
    expect(lines[1]).toMatch(TIME_RE);

    // end peripheral 不含时间戳
    const endLine = lines[lines.length - 1];
    expect(endLine).toMatch(/^--- end peripheral ---/);
    expect(endLine).not.toMatch(TIME_RE);
  });
});
