/**
 * ADR-118: 群组存在感计算 + Hint 渲染 单元测试。
 *
 * @see src/engine/act/presence.ts
 * @see docs/adr/118-group-presence-awareness.md
 */
import { describe, expect, it } from "vitest";
import type { MessageRecord } from "../src/engine/act/messages.js";
import { computeChannelPresence, renderPresenceHint } from "../src/engine/act/presence.js";

/** 创建测试用 MessageRecord。 */
function msg(id: number, isOutgoing: boolean, minutesAgo = 0): MessageRecord {
  return {
    id,
    senderName: isOutgoing ? "Alice" : `User${id}`,
    senderId: isOutgoing ? undefined : id,
    isOutgoing,
    isBot: !isOutgoing ? false : undefined,
    text: `msg-${id}`,
    date: new Date(Date.now() - minutesAgo * 60_000),
  };
}

function botMsg(id: number, minutesAgo = 0): MessageRecord {
  return {
    id,
    senderName: `Bot${id}`,
    senderId: id,
    isOutgoing: false,
    isBot: true,
    text: `bot-${id}`,
    date: new Date(Date.now() - minutesAgo * 60_000),
  };
}

describe("computeChannelPresence", () => {
  it("空消息列表", () => {
    const p = computeChannelPresence([]);
    expect(p.total).toBe(0);
    expect(p.yours).toBe(0);
    expect(p.botIncoming).toBe(0);
    expect(p.humanIncoming).toBe(0);
    expect(p.trailingYours).toBe(0);
    expect(p.trailingBotIncoming).toBe(0);
    expect(p.lastOtherAgoMs).toBe(Infinity);
  });

  it("trailingYours=0 — 无 Alice 消息", () => {
    const messages = [msg(1, false, 5), msg(2, false, 3), msg(3, false, 1)];
    const p = computeChannelPresence(messages);
    expect(p.total).toBe(3);
    expect(p.yours).toBe(0);
    expect(p.botIncoming).toBe(0);
    expect(p.humanIncoming).toBe(3);
    expect(p.trailingYours).toBe(0);
    expect(p.lastOtherAgoMs).toBeLessThan(2 * 60_000);
  });

  it("trailingYours=1 — 1 条 Alice 尾部", () => {
    const messages = [msg(1, false, 5), msg(2, false, 3), msg(3, true, 1)];
    const p = computeChannelPresence(messages);
    expect(p.yours).toBe(1);
    expect(p.trailingYours).toBe(1);
    expect(p.botIncoming).toBe(0);
    expect(p.humanIncoming).toBe(2);
  });

  it("trailingYours=2 — 2 条连续 Alice 尾部", () => {
    const messages = [msg(1, false, 5), msg(2, true, 3), msg(3, true, 1)];
    const p = computeChannelPresence(messages);
    expect(p.yours).toBe(2);
    expect(p.trailingYours).toBe(2);
    expect(p.botIncoming).toBe(0);
    expect(p.humanIncoming).toBe(1);
  });

  it("中间有他人 — Alice-Bob-Alice → trailingYours=1", () => {
    const messages = [msg(1, true, 5), msg(2, false, 3), msg(3, true, 1)];
    const p = computeChannelPresence(messages);
    expect(p.yours).toBe(2);
    expect(p.trailingYours).toBe(1);
  });

  it("trailingYours=4 — 4 条连续 Alice 尾部", () => {
    const messages = [
      msg(1, false, 10),
      msg(2, true, 4),
      msg(3, true, 3),
      msg(4, true, 2),
      msg(5, true, 1),
    ];
    const p = computeChannelPresence(messages);
    expect(p.yours).toBe(4);
    expect(p.trailingYours).toBe(4);
  });

  it("全是 Alice — 10 条", () => {
    const messages = Array.from({ length: 10 }, (_, i) => msg(i + 1, true, 10 - i));
    const p = computeChannelPresence(messages);
    expect(p.yours).toBe(10);
    expect(p.trailingYours).toBe(10);
    expect(p.lastOtherAgoMs).toBe(Infinity);
  });

  it("统计 bot 消息并检测尾部 bot streak", () => {
    const messages = [msg(1, true, 5), botMsg(2, 3), botMsg(3, 2), botMsg(4, 1)];
    const p = computeChannelPresence(messages);
    expect(p.yours).toBe(1);
    expect(p.botIncoming).toBe(3);
    expect(p.humanIncoming).toBe(0);
    expect(p.trailingBotIncoming).toBe(3);
  });
});

describe("renderPresenceHint", () => {
  it("trailingYours=0 → null", () => {
    expect(
      renderPresenceHint({
        total: 5,
        yours: 0,
        botIncoming: 0,
        humanIncoming: 5,
        trailingYours: 0,
        trailingBotIncoming: 0,
        lastOtherAgoMs: 1000,
      }),
    ).toBeNull();
  });

  it("trailingYours=1 → null", () => {
    expect(
      renderPresenceHint({
        total: 5,
        yours: 1,
        botIncoming: 0,
        humanIncoming: 4,
        trailingYours: 1,
        trailingBotIncoming: 0,
        lastOtherAgoMs: 1000,
      }),
    ).toBeNull();
  });

  it("trailingYours=2 → consecutive hint", () => {
    expect(
      renderPresenceHint({
        total: 5,
        yours: 2,
        botIncoming: 0,
        humanIncoming: 3,
        trailingYours: 2,
        trailingBotIncoming: 0,
        lastOtherAgoMs: 1000,
      }),
    ).toBe("--- 2 consecutive from you ---");
  });

  it("trailingYours=3 → consecutive hint", () => {
    expect(
      renderPresenceHint({
        total: 5,
        yours: 3,
        botIncoming: 0,
        humanIncoming: 2,
        trailingYours: 3,
        trailingBotIncoming: 0,
        lastOtherAgoMs: 1000,
      }),
    ).toBe("--- 3 consecutive from you ---");
  });

  it("trailingYours=4 → STOP directive", () => {
    expect(
      renderPresenceHint({
        total: 10,
        yours: 4,
        botIncoming: 0,
        humanIncoming: 6,
        trailingYours: 4,
        trailingBotIncoming: 0,
        lastOtherAgoMs: 60_000,
      }),
    ).toBe("--- 4 consecutive from you — STOP, wait for their reply ---");
  });

  it("trailingYours=10 → STOP directive", () => {
    expect(
      renderPresenceHint({
        total: 10,
        yours: 10,
        botIncoming: 0,
        humanIncoming: 0,
        trailingYours: 10,
        trailingBotIncoming: 0,
        lastOtherAgoMs: Infinity,
      }),
    ).toBe("--- 10 consecutive from you — STOP, wait for their reply ---");
  });

  it("空消息列表 → null", () => {
    expect(
      renderPresenceHint({
        total: 0,
        yours: 0,
        botIncoming: 0,
        humanIncoming: 0,
        trailingYours: 0,
        trailingBotIncoming: 0,
        lastOtherAgoMs: Infinity,
      }),
    ).toBeNull();
  });

  it("只剩 Alice 和 bot 来回说话 → 注入 bot loop 提示", () => {
    expect(
      renderPresenceHint({
        total: 6,
        yours: 3,
        botIncoming: 3,
        humanIncoming: 0,
        trailingYours: 1,
        trailingBotIncoming: 1,
        lastOtherAgoMs: 1000,
      }),
    ).toContain("bot loop");
  });

  it("连续 bot 刷屏 → 注入 spammy 提示", () => {
    expect(
      renderPresenceHint({
        total: 5,
        yours: 1,
        botIncoming: 4,
        humanIncoming: 0,
        trailingYours: 0,
        trailingBotIncoming: 4,
        lastOtherAgoMs: 1000,
      }),
    ).toContain("bot loop");
  });
});
