/**
 * sendVote — голосование в нативном опросе Telegram (messages.sendVote, raw TL).
 *
 * mtcute 0.30 не имеет высокоуровневого метода голосования, поэтому actions.sendVote
 * сам тянет сообщение опроса (client.getMessages), сопоставляет 0-based индексы вариантов
 * с option-байтами (poll.answers[i].option) и делает raw-вызов messages.sendVote.
 *
 * Эти тесты гоняют РЕАЛЬНУЮ обёртку actions.sendVote против рукодельного фейкового
 * mtcute-клиента и проверяют точные аргументы, переданные в client.call — в стиле
 * telegram-actions-mtcute.test.ts. Сервер не дёргается.
 */

import type { TelegramClient } from "@mtcute/node";
import { describe, expect, it, vi } from "vitest";
import { sendVote } from "../src/telegram/actions.js";

// Байты-«ключи» вариантов: messages.sendVote ждёт option-байты, не индексы.
const OPT = [
  new Uint8Array([0]),
  new Uint8Array([1]),
  new Uint8Array([2]),
] as const;

/** Строит фейковое сообщение-опрос с сырым TL (Message.raw → media.messageMediaPoll.poll). */
function pollMessage(opts: { multipleChoice?: boolean; closed?: boolean; answers?: number } = {}) {
  const answerCount = opts.answers ?? 3;
  return {
    raw: {
      _: "message",
      media: {
        _: "messageMediaPoll",
        poll: {
          _: "poll",
          closed: opts.closed ?? false,
          multipleChoice: opts.multipleChoice ?? false,
          answers: Array.from({ length: answerCount }, (_, i) => ({
            _: "pollAnswer",
            option: OPT[i],
          })),
        },
      },
    },
  };
}

/** Минимальный фейковый клиент: resolvePeer + getMessages + call (raw TL). */
function fakeClient(message: unknown) {
  const call = vi.fn(async (_req: unknown) => ({ _: "updates", updates: [] }));
  const client = {
    resolvePeer: vi.fn(async (_id: unknown) => ({ _: "inputPeerChannel", channelId: 1, accessHash: 2 })),
    getMessages: vi.fn(async (_chatId: unknown, _ids: number[]) => [message]),
    call,
  };
  return { client, call };
}

describe("sendVote — native poll vote (messages.sendVote, raw TL)", () => {
  it("maps a single 0-based index to its option bytes", async () => {
    const { client, call } = fakeClient(pollMessage());

    const result = await sendVote(client as unknown as TelegramClient, -100, 555, [1]);

    expect(result).toEqual({ voted: [1] });
    expect(call).toHaveBeenCalledTimes(1);
    expect(call.mock.calls[0][0]).toMatchObject({
      _: "messages.sendVote",
      msgId: 555,
      options: [OPT[1]],
    });
  });

  it("maps multiple indexes to option bytes for a multi-choice poll", async () => {
    const { client, call } = fakeClient(pollMessage({ multipleChoice: true }));

    const result = await sendVote(client as unknown as TelegramClient, -100, 555, [0, 2]);

    expect(result).toEqual({ voted: [0, 2] });
    expect(call.mock.calls[0][0]).toMatchObject({ options: [OPT[0], OPT[2]] });
  });

  it("uses only the first index when a single-choice poll gets more than one", async () => {
    const { client, call } = fakeClient(pollMessage({ multipleChoice: false }));

    const result = await sendVote(client as unknown as TelegramClient, -100, 555, [2, 0]);

    expect(result).toEqual({ voted: [2] });
    expect(call.mock.calls[0][0]).toMatchObject({ options: [OPT[2]] });
  });

  it("dedups repeated indexes before voting", async () => {
    const { client, call } = fakeClient(pollMessage({ multipleChoice: true }));

    const result = await sendVote(client as unknown as TelegramClient, -100, 555, [1, 1, 2]);

    expect(result).toEqual({ voted: [1, 2] });
    expect(call.mock.calls[0][0]).toMatchObject({ options: [OPT[1], OPT[2]] });
  });

  it("rejects an out-of-range index (and does not call sendVote)", async () => {
    const { client, call } = fakeClient(pollMessage({ answers: 3 }));

    await expect(
      sendVote(client as unknown as TelegramClient, -100, 555, [9]),
    ).rejects.toThrow(/out of range/i);
    expect(call).not.toHaveBeenCalled();
  });

  it("rejects voting in a closed poll (and does not call sendVote)", async () => {
    const { client, call } = fakeClient(pollMessage({ closed: true }));

    await expect(
      sendVote(client as unknown as TelegramClient, -100, 555, [0]),
    ).rejects.toThrow(/closed/i);
    expect(call).not.toHaveBeenCalled();
  });

  it("rejects a non-poll message (and does not call sendVote)", async () => {
    const nonPoll = { raw: { _: "message", media: { _: "messageMediaPhoto" } } };
    const { client, call } = fakeClient(nonPoll);

    await expect(
      sendVote(client as unknown as TelegramClient, -100, 555, [0]),
    ).rejects.toThrow(/not a poll/i);
    expect(call).not.toHaveBeenCalled();
  });

  it("rejects a missing message (and does not call sendVote)", async () => {
    const { client, call } = fakeClient(null);

    await expect(
      sendVote(client as unknown as TelegramClient, -100, 555, [0]),
    ).rejects.toThrow(/not found/i);
    expect(call).not.toHaveBeenCalled();
  });
});
