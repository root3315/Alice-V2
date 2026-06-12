import { describe, expect, it } from "vitest";
import {
  type CompletedAction,
  countTelegramSideEffects,
  decodeCompletedAction,
  encodeCompletedAction,
  extractFirstExternalMessageId,
  hasCompletedSend,
} from "../src/core/script-execution.js";

describe("CompletedAction codec", () => {
  const cases: Array<{ raw: string; decoded: CompletedAction; roundTrip?: string }> = [
    {
      raw: "sent:chatId=123:msgId=789:message=message:telegram:123:789",
      decoded: {
        kind: "sent",
        chatId: "123",
        msgId: "789",
        messageRef: "message:telegram:123:789",
      },
    },
    {
      raw: "voice:chatId=1:msgId=2",
      decoded: { kind: "voice", chatId: "1", msgId: "2" },
    },
    {
      raw: "sticker:chatId=1:msgId=3",
      decoded: { kind: "sticker", chatId: "1", msgId: "3" },
    },
    {
      raw: "react:chatId=1:msgId=3:emoji=👍",
      decoded: { kind: "react", chatId: "1", msgId: "3", emoji: "👍" },
    },
    {
      raw: "sent-file:chatId=1:msgId=4",
      decoded: { kind: "sent-file", chatId: "1", msgId: "4" },
    },
    {
      raw: "sent-file:chatId=1:path=/tmp/a:b.png",
      decoded: { kind: "sent-file", chatId: "1", path: "/tmp/a:b.png" },
    },
    {
      raw: "forwarded:from=-1001:to=-1002:msgId=42",
      decoded: { kind: "forwarded", fromChatId: "-1001", toChatId: "-1002", msgId: "42" },
    },
    {
      raw: "internal:command=feel",
      decoded: { kind: "internal", command: "feel" },
    },
    {
      raw: "downloaded:chatId=1:msgId=2:path=/tmp/a:b.png",
      decoded: { kind: "downloaded", chatId: "1", msgId: "2", path: "/tmp/a:b.png" },
    },
  ];

  it.each(cases)("decodes and encodes $raw", ({ raw, decoded, roundTrip }) => {
    expect(decodeCompletedAction(raw)).toEqual(decoded);
    expect(encodeCompletedAction(decoded)).toBe(roundTrip ?? raw);
  });

  it("preserves unknown and malformed actions explicitly", () => {
    expect(decodeCompletedAction("cached:chatId=1:msgId=2")).toEqual({
      kind: "unknown",
      raw: "cached:chatId=1:msgId=2",
    });
    expect(decodeCompletedAction("sent:chatId=1")).toEqual({
      kind: "malformed",
      raw: "sent:chatId=1",
      reason: "missing msgId",
    });
  });

  it("uses typed facts as semantic authority when present", () => {
    const result = {
      completedActions: ["sent:chatId=wrong:msgId=wrong"],
      completedActionFacts: [{ kind: "voice", chatId: "1", msgId: "2" } satisfies CompletedAction],
    };

    expect(hasCompletedSend(result)).toBe(true);
    expect(countTelegramSideEffects(result)).toBe(1);
    expect(extractFirstExternalMessageId(result)).toBeNull();
  });
});

describe("hasCompletedSend", () => {
  it("counts outbound media actions as sent messages", () => {
    expect(hasCompletedSend({ completedActions: ["voice:chatId=1:msgId=2"] })).toBe(true);
    expect(hasCompletedSend({ completedActions: ["sticker:chatId=1:msgId=3"] })).toBe(true);
    expect(hasCompletedSend({ completedActions: ["react:chatId=1:msgId=3"] })).toBe(true);
    expect(hasCompletedSend({ completedActions: ["sent-file:chatId=1:msgId=4"] })).toBe(true);
  });

  it("does not count read-only actions as sent messages", () => {
    expect(hasCompletedSend({ completedActions: ["read:chatId=1"] })).toBe(false);
    expect(hasCompletedSend({ completedActions: ["internal:command=feel"] })).toBe(false);
  });

  it("does not infer delivery from human-readable CLI confirmations", () => {
    expect(hasCompletedSend({ completedActions: [] })).toBe(false);
  });
});
