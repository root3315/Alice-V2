/**
 * mtcute 0.30 rich-message + migration boundary tests.
 *
 * The wider suite mocks the mtcute client far above actions.ts, so the 0.27→0.30
 * migration (joinChat result shape) and the new checklist/table wrappers were
 * essentially untested. These drive the REAL actions.ts wrappers against a
 * hand-rolled fake mtcute client and assert the exact params handed to the
 * client method — mirroring the album.test.ts pattern.
 */

import type { TelegramClient } from "@mtcute/node";
import { InputMedia } from "@mtcute/node";
import { describe, expect, it, vi } from "vitest";
import { joinChat, sendChecklist, sendPoll, sendTable } from "../src/telegram/actions.js";

// Typed fake media-send signatures so vi.fn().mock.calls carries the arg types.
type TodoMedia = { type: string; title: string; items: string[] };
type SendMediaArgs = [chatId: number, media: TodoMedia, opts: { replyTo?: number }];
type RichBlock = Record<string, unknown>;
type RichPayload = { content: { type: string; blocks: RichBlock[] }; replyTo?: number };
type SendRichArgs = [chatId: number, payload: RichPayload];

const fakeSendMedia = () => vi.fn(async (..._args: SendMediaArgs) => ({ id: 5 }));
const fakeSendRich = () => vi.fn(async (..._args: SendRichArgs) => ({ id: 9 }));

describe("joinChat — mtcute 0.30 result shape", () => {
  it('returns the chat and pending:false when status is "ok"', async () => {
    const chat = { id: 1 };
    const client = {
      joinChat: async () => ({ status: "ok", chat }),
    };

    const result = await joinChat(client as unknown as TelegramClient, "@somegroup");

    expect(result).toEqual({ chat, pending: false });
  });

  it('returns pending:true (no chat) when admin approval is required ("request_sent")', async () => {
    const client = {
      joinChat: async () => ({ status: "request_sent" }),
    };

    const result = await joinChat(client as unknown as TelegramClient, "https://t.me/+invite");

    expect(result).toEqual({ pending: true });
    expect(result.chat).toBeUndefined();
  });

  it('returns pending:true for the "webview" status variant', async () => {
    const client = {
      joinChat: async () => ({ status: "webview", url: "https://t.me/webview" }),
    };

    const result = await joinChat(client as unknown as TelegramClient, "@webviewgroup");

    expect(result).toEqual({ pending: true });
    expect(result.chat).toBeUndefined();
  });
});

describe("sendChecklist — native To-Do list (InputMedia.todo)", () => {
  it("sends an InputMedia.todo media object with title + items", async () => {
    const sendMedia = fakeSendMedia();
    const client = { sendMedia };

    const msgId = await sendChecklist(client as unknown as TelegramClient, -100, {
      title: "Groceries",
      items: ["bread", "milk"],
    });

    expect(msgId).toBe(5);
    expect(sendMedia).toHaveBeenCalledTimes(1);
    const [chatId, media] = sendMedia.mock.calls[0];
    expect(chatId).toBe(-100);
    // Built via InputMedia.todo → { type: "todo", title, items }
    expect(media).toMatchObject({ type: "todo", title: "Groceries", items: ["bread", "milk"] });
    // Sanity: matches the real mtcute builder output for the same inputs.
    expect(media).toEqual(InputMedia.todo({ title: "Groceries", items: ["bread", "milk"] }));
  });

  it("clamps item count to 30", async () => {
    const sendMedia = fakeSendMedia();
    const client = { sendMedia };

    const items = Array.from({ length: 50 }, (_, i) => `item-${i}`);
    await sendChecklist(client as unknown as TelegramClient, -100, { title: "T", items });

    const media = sendMedia.mock.calls[0][1] as { items: string[] };
    expect(media.items).toHaveLength(30);
    expect(media.items[0]).toBe("item-0");
    expect(media.items[29]).toBe("item-29");
  });

  it("truncates an item longer than 64 code points", async () => {
    const sendMedia = fakeSendMedia();
    const client = { sendMedia };

    const longItem = "x".repeat(100);
    await sendChecklist(client as unknown as TelegramClient, -100, {
      title: "T",
      items: [longItem],
    });

    const media = sendMedia.mock.calls[0][1] as { items: string[] };
    expect([...media.items[0]]).toHaveLength(64);
    expect(media.items[0]).toBe("x".repeat(64));
  });

  it("truncates a title longer than 32 code points", async () => {
    const sendMedia = fakeSendMedia();
    const client = { sendMedia };

    const longTitle = "T".repeat(60);
    await sendChecklist(client as unknown as TelegramClient, -100, {
      title: longTitle,
      items: ["a"],
    });

    const media = sendMedia.mock.calls[0][1] as { title: string };
    expect([...media.title]).toHaveLength(32);
    expect(media.title).toBe("T".repeat(32));
  });

  it("drops blank/empty/whitespace items", async () => {
    const sendMedia = fakeSendMedia();
    const client = { sendMedia };

    await sendChecklist(client as unknown as TelegramClient, -100, {
      title: "T",
      items: ["keep", "", "   ", "alsokeep"],
    });

    const media = sendMedia.mock.calls[0][1] as { items: string[] };
    expect(media.items).toEqual(["keep", "alsokeep"]);
  });

  it('falls back to "Чеклист" when title is missing', async () => {
    const sendMedia = fakeSendMedia();
    const client = { sendMedia };

    await sendChecklist(client as unknown as TelegramClient, -100, { items: ["a"] });

    const media = sendMedia.mock.calls[0][1] as { title: string };
    expect(media.title).toBe("Чеклист");
  });

  it('falls back to "Чеклист" when title is blank/whitespace', async () => {
    const sendMedia = fakeSendMedia();
    const client = { sendMedia };

    await sendChecklist(client as unknown as TelegramClient, -100, {
      title: "   ",
      items: ["a"],
    });

    const media = sendMedia.mock.calls[0][1] as { title: string };
    expect(media.title).toBe("Чеклист");
  });

  it("does not split an emoji at the 64-code-point boundary", async () => {
    const sendMedia = fakeSendMedia();
    const client = { sendMedia };

    // 63 ASCII chars + one emoji (😀 = 2 UTF-16 units, 1 code point) = 64 code points exactly,
    // so the whole emoji must survive intact (not chopped to a lone surrogate).
    const item = `${"a".repeat(63)}😀`;
    await sendChecklist(client as unknown as TelegramClient, -100, {
      title: "T",
      items: [item],
    });

    const media = sendMedia.mock.calls[0][1] as { items: string[] };
    expect([...media.items[0]]).toHaveLength(64);
    expect(media.items[0]).toBe(item);
    expect(media.items[0].endsWith("😀")).toBe(true);
  });

  it("truncates past an emoji boundary without producing a lone surrogate", async () => {
    const sendMedia = fakeSendMedia();
    const client = { sendMedia };

    // 64 ASCII chars then a trailing emoji → the emoji is fully dropped (code point 65).
    const item = `${"a".repeat(64)}😀`;
    await sendChecklist(client as unknown as TelegramClient, -100, {
      title: "T",
      items: [item],
    });

    const media = sendMedia.mock.calls[0][1] as { items: string[] };
    expect([...media.items[0]]).toHaveLength(64);
    expect(media.items[0]).toBe("a".repeat(64));
    // No lone surrogate left behind.
    expect(media.items[0]).not.toMatch(/[\uD800-\uDBFF]$/);
  });

  it("routes replyTo to replyToMsgId when provided", async () => {
    const sendMedia = fakeSendMedia();
    const client = { sendMedia };

    await sendChecklist(client as unknown as TelegramClient, -100, {
      title: "T",
      items: ["a"],
      replyToMsgId: 42,
      topicId: 7,
    });

    const opts = sendMedia.mock.calls[0][2] as { replyTo?: number };
    expect(opts.replyTo).toBe(42);
  });

  it("routes replyTo to topicId when replyToMsgId is absent", async () => {
    const sendMedia = fakeSendMedia();
    const client = { sendMedia };

    await sendChecklist(client as unknown as TelegramClient, -100, {
      title: "T",
      items: ["a"],
      topicId: 7,
    });

    const opts = sendMedia.mock.calls[0][2] as { replyTo?: number };
    expect(opts.replyTo).toBe(7);
  });
});

describe("sendPoll — native poll (InputMedia.poll, free feature)", () => {
  type PollMedia = { type: string; question: unknown; answers: string[]; multiple?: boolean; correct?: number };
  type PollSendArgs = [chatId: number, media: PollMedia, opts: { replyTo?: number }];
  const fakePollSend = () => vi.fn(async (..._args: PollSendArgs) => ({ id: 11 }));

  it("sends an InputMedia.poll-shaped media with question + options", async () => {
    const sendMedia = fakePollSend();
    const client = { sendMedia };

    const msgId = await sendPoll(client as unknown as TelegramClient, -100, {
      question: "Куда пойдём?",
      options: ["Кафе", "Кино"],
    });

    expect(msgId).toBe(11);
    expect(sendMedia).toHaveBeenCalledTimes(1);
    const [chatId, media] = sendMedia.mock.calls[0];
    expect(chatId).toBe(-100);
    // Built via InputMedia.poll → { type: "poll", question, answers }
    expect(media).toMatchObject({ type: "poll", answers: ["Кафе", "Кино"] });
    // Sanity: matches the real mtcute builder output for the same inputs.
    expect(media).toEqual(
      InputMedia.poll({ question: "Куда пойдём?", answers: ["Кафе", "Кино"], multiple: false }),
    );
  });

  it("passes multiple:true through to the poll media", async () => {
    const sendMedia = fakePollSend();
    const client = { sendMedia };

    await sendPoll(client as unknown as TelegramClient, -100, {
      question: "Q",
      options: ["a", "b"],
      multiple: true,
    });

    expect(sendMedia.mock.calls[0][1]).toMatchObject({ type: "poll", multiple: true });
  });

  it("builds a quiz with the correct option index when quiz + correctOption are valid", async () => {
    const sendMedia = fakePollSend();
    const client = { sendMedia };

    await sendPoll(client as unknown as TelegramClient, -100, {
      question: "2+2?",
      options: ["3", "4", "5"],
      quiz: true,
      correctOption: 1,
    });

    expect(sendMedia.mock.calls[0][1]).toMatchObject({ type: "quiz", correct: 1 });
  });

  it("falls back to a plain poll when quiz correctOption is out of range", async () => {
    const sendMedia = fakePollSend();
    const client = { sendMedia };

    await sendPoll(client as unknown as TelegramClient, -100, {
      question: "Q",
      options: ["a", "b"],
      quiz: true,
      correctOption: 9,
    });

    expect(sendMedia.mock.calls[0][1]).toMatchObject({ type: "poll" });
  });

  it("clamps options to 10", async () => {
    const sendMedia = fakePollSend();
    const client = { sendMedia };

    const options = Array.from({ length: 15 }, (_, i) => `opt-${i}`);
    await sendPoll(client as unknown as TelegramClient, -100, { question: "Q", options });

    const media = sendMedia.mock.calls[0][1] as { answers: string[] };
    expect(media.answers).toHaveLength(10);
    expect(media.answers[0]).toBe("opt-0");
    expect(media.answers[9]).toBe("opt-9");
  });

  it("drops blank options and rejects fewer than 2 remaining", async () => {
    const sendMedia = fakePollSend();
    const client = { sendMedia };

    await expect(
      sendPoll(client as unknown as TelegramClient, -100, {
        question: "Q",
        options: ["only", "", "   "],
      }),
    ).rejects.toBeDefined();
    expect(sendMedia).not.toHaveBeenCalled();
  });

  it("truncates a question longer than 255 code points", async () => {
    const sendMedia = fakePollSend();
    const client = { sendMedia };

    const longQ = "q".repeat(300);
    await sendPoll(client as unknown as TelegramClient, -100, {
      question: longQ,
      options: ["a", "b"],
    });

    const media = sendMedia.mock.calls[0][1] as { question: string };
    expect([...media.question]).toHaveLength(255);
  });

  it("truncates an option longer than 100 code points", async () => {
    const sendMedia = fakePollSend();
    const client = { sendMedia };

    await sendPoll(client as unknown as TelegramClient, -100, {
      question: "Q",
      options: ["x".repeat(150), "b"],
    });

    const media = sendMedia.mock.calls[0][1] as { answers: string[] };
    expect([...media.answers[0]]).toHaveLength(100);
  });

  it("routes replyTo to replyToMsgId when provided", async () => {
    const sendMedia = fakePollSend();
    const client = { sendMedia };

    await sendPoll(client as unknown as TelegramClient, -100, {
      question: "Q",
      options: ["a", "b"],
      replyToMsgId: 42,
      topicId: 7,
    });

    const opts = sendMedia.mock.calls[0][2] as { replyTo?: number };
    expect(opts.replyTo).toBe(42);
  });

  it("routes replyTo to topicId when replyToMsgId is absent", async () => {
    const sendMedia = fakePollSend();
    const client = { sendMedia };

    await sendPoll(client as unknown as TelegramClient, -100, {
      question: "Q",
      options: ["a", "b"],
      topicId: 7,
    });

    const opts = sendMedia.mock.calls[0][2] as { replyTo?: number };
    expect(opts.replyTo).toBe(7);
  });
});

describe("sendTable — native rich table (sendRichMessage)", () => {
  type SentBlocks = {
    content: { type: string; blocks: Array<Record<string, unknown>> };
    replyTo?: number;
  };

  function tableBlock(call: SentBlocks): {
    _: string;
    title?: { _: string; text: string };
    rows: Array<{ _: string; cells: Array<{ _: string; text: { text: string }; header?: boolean }> }>;
    bordered?: boolean;
  } {
    expect(call.content.type).toBe("blocks");
    expect(call.content.blocks).toHaveLength(1);
    // biome-ignore lint/suspicious/noExplicitAny: structural assert on TL page block
    return call.content.blocks[0] as any;
  }

  it("uses content type 'blocks' with a single pageBlockTable", async () => {
    const sendRichMessage = fakeSendRich();
    const client = { sendRichMessage };

    const msgId = await sendTable(client as unknown as TelegramClient, -100, {
      headers: ["A", "B"],
      rows: [["1", "2"]],
    });

    expect(msgId).toBe(9);
    const [chatId, payload] = sendRichMessage.mock.calls[0] as [number, SentBlocks];
    expect(chatId).toBe(-100);
    expect(payload.content.type).toBe("blocks");
    expect(tableBlock(payload)._).toBe("pageBlockTable");
  });

  it("pads jagged rows to a uniform width (max of headers/rows lengths)", async () => {
    const sendRichMessage = fakeSendRich();
    const client = { sendRichMessage };

    await sendTable(client as unknown as TelegramClient, -100, {
      headers: ["A", "B"],
      rows: [
        ["1", "2", "3"], // wider than headers → width = 3
        ["x"], // shorter → padded
      ],
    });

    const payload = sendRichMessage.mock.calls[0][1] as SentBlocks;
    const block = tableBlock(payload);
    // 1 header row + 2 body rows
    expect(block.rows).toHaveLength(3);
    for (const row of block.rows) {
      expect(row.cells).toHaveLength(3);
    }
    // Header row was padded with a trailing empty cell.
    expect(block.rows[0].cells.map((c) => c.text.text)).toEqual(["A", "B", ""]);
    // Short body row padded with two empty cells.
    expect(block.rows[2].cells.map((c) => c.text.text)).toEqual(["x", "", ""]);
  });

  it("marks header-row cells with header:true and leaves body cells without it", async () => {
    const sendRichMessage = fakeSendRich();
    const client = { sendRichMessage };

    await sendTable(client as unknown as TelegramClient, -100, {
      headers: ["A", "B"],
      rows: [["1", "2"]],
    });

    const block = tableBlock(sendRichMessage.mock.calls[0][1] as SentBlocks);
    // Header row: every cell carries header:true.
    for (const cell of block.rows[0].cells) {
      expect(cell.header).toBe(true);
    }
    // Body row: no header flag.
    for (const cell of block.rows[1].cells) {
      expect(cell.header).toBeUndefined();
    }
  });

  it("includes a title block when a non-blank title is given", async () => {
    const sendRichMessage = fakeSendRich();
    const client = { sendRichMessage };

    await sendTable(client as unknown as TelegramClient, -100, {
      title: "  Prices  ",
      headers: ["A"],
      rows: [["1"]],
    });

    const block = tableBlock(sendRichMessage.mock.calls[0][1] as SentBlocks);
    expect(block.title?.text).toBe("Prices");
    expect(block.bordered).toBe(true);
  });

  it("omits the title when blank", async () => {
    const sendRichMessage = fakeSendRich();
    const client = { sendRichMessage };

    await sendTable(client as unknown as TelegramClient, -100, {
      title: "   ",
      headers: ["A"],
      rows: [["1"]],
    });

    const block = tableBlock(sendRichMessage.mock.calls[0][1] as SentBlocks);
    // The wrapper passes no `title` option to Rich.table, which renders no title text.
    // mtcute normalizes the absent title to the empty TL text node `{ _: "textEmpty" }`,
    // never a textPlain with the blank string — so nothing is shown.
    expect(block.title).not.toMatchObject({ _: "textPlain" });
    const titleText = (block.title as { text?: string } | undefined)?.text;
    expect(titleText ?? "").toBe("");
  });

  it("emits only body rows when headers are empty", async () => {
    const sendRichMessage = fakeSendRich();
    const client = { sendRichMessage };

    await sendTable(client as unknown as TelegramClient, -100, {
      headers: [],
      rows: [["1", "2"]],
    });

    const block = tableBlock(sendRichMessage.mock.calls[0][1] as SentBlocks);
    expect(block.rows).toHaveLength(1);
    // No header cells when headers are empty.
    expect(block.rows[0].cells.every((c) => c.header === undefined)).toBe(true);
  });

  it("routes replyTo to replyToMsgId when provided", async () => {
    const sendRichMessage = fakeSendRich();
    const client = { sendRichMessage };

    await sendTable(client as unknown as TelegramClient, -100, {
      headers: ["A"],
      rows: [["1"]],
      replyToMsgId: 42,
      topicId: 7,
    });

    const payload = sendRichMessage.mock.calls[0][1] as SentBlocks;
    expect(payload.replyTo).toBe(42);
  });

  it("routes replyTo to topicId when replyToMsgId is absent", async () => {
    const sendRichMessage = fakeSendRich();
    const client = { sendRichMessage };

    await sendTable(client as unknown as TelegramClient, -100, {
      headers: ["A"],
      rows: [["1"]],
      topicId: 7,
    });

    const payload = sendRichMessage.mock.calls[0][1] as SentBlocks;
    expect(payload.replyTo).toBe(7);
  });
});

describe("native widget fallback to text (no Premium / unsupported account)", () => {
  const textOf = (arg: unknown): string =>
    typeof arg === "string" ? arg : ((arg as { text?: string })?.text ?? "");

  it("sendChecklist falls back to a text ☐-checklist on PREMIUM_ACCOUNT_REQUIRED", async () => {
    const sendMedia = vi.fn(async () => {
      throw { text: "PREMIUM_ACCOUNT_REQUIRED", code: 403 };
    });
    const sendText = vi.fn(async (..._a: unknown[]) => ({ id: 7 }));
    const client = { sendMedia, sendText };

    const msgId = await sendChecklist(client as unknown as TelegramClient, -100, {
      title: "Groceries",
      items: ["bread", "milk"],
    });

    expect(msgId).toBe(7);
    expect(sendMedia).toHaveBeenCalledTimes(1);
    expect(sendText).toHaveBeenCalledTimes(1);
    const text = textOf(sendText.mock.calls[0][1]);
    expect(text).toContain("☐ bread");
    expect(text).toContain("☐ milk");
  });

  it("sendChecklist rethrows non-Premium errors (no silent text fallback)", async () => {
    const sendMedia = vi.fn(async () => {
      throw { text: "CHAT_WRITE_FORBIDDEN", code: 403 };
    });
    const sendText = vi.fn(async (..._a: unknown[]) => ({ id: 7 }));
    const client = { sendMedia, sendText };

    await expect(
      sendChecklist(client as unknown as TelegramClient, -100, { title: "T", items: ["a"] }),
    ).rejects.toBeDefined();
    expect(sendText).not.toHaveBeenCalled();
  });

  it("sendTable falls back to a monospace text table on RICH_MESSAGE_UNSUPPORTED", async () => {
    const sendRichMessage = vi.fn(async () => {
      throw { text: "RICH_MESSAGE_UNSUPPORTED", code: 400 };
    });
    const sendText = vi.fn(async (..._a: unknown[]) => ({ id: 8 }));
    const client = { sendRichMessage, sendText };

    const msgId = await sendTable(client as unknown as TelegramClient, -100, {
      headers: ["Name", "Qty"],
      rows: [["Apple", "3"]],
    });

    expect(msgId).toBe(8);
    expect(sendRichMessage).toHaveBeenCalledTimes(1);
    expect(sendText).toHaveBeenCalledTimes(1);
    const text = textOf(sendText.mock.calls[0][1]);
    expect(text).toContain("Name");
    expect(text).toContain("Apple");
  });
});
