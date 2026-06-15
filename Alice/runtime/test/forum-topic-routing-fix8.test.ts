/**
 * Fix #8 — forum topic mis-routing in send_message impl.
 *
 * Bug: when args.topicId is absent, send_message fell back unconditionally to the
 * channel's stored current_topic_id, which is whatever the LAST INBOUND message set.
 * In an active forum where the user just switched topics, an outgoing *reply* could
 * land in the WRONG topic.
 *
 * Fixed priority order (see messaging.ts):
 *   1. args.topicId               — explicit caller topic
 *   2. args.replyTo present       — let the reply anchor the topic; do NOT inject the
 *                                   stale current_topic_id (pass topicId=undefined)
 *   3. current_topic_id           — last resort, only for a bare send with no replyTo
 *
 * @see src/telegram/actions/messaging.ts
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionImplContext } from "../src/telegram/action-types.js";
import { setExplorationGuard, TELEGRAM_ACTION_MAP } from "../src/telegram/actions/index.js";
import * as actions from "../src/telegram/actions.js";
import { ExplorationGuard } from "../src/telegram/exploration-guard.js";

vi.mock("../src/telegram/actions.js", () => ({
  sendText: vi.fn().mockResolvedValue(undefined),
  markRead: vi.fn().mockResolvedValue(undefined),
  editMessage: vi.fn().mockResolvedValue(undefined),
  forwardMessage: vi.fn().mockResolvedValue(undefined),
  setTyping: vi.fn().mockResolvedValue(undefined),
}));

function createMockContext(currentTopicId?: number): ActionImplContext {
  const mockG = {
    has: vi.fn().mockReturnValue(true),
    setDynamic: vi.fn(),
    getDynamic: vi.fn().mockReturnValue(undefined),
    getChannel: vi.fn().mockReturnValue({
      entity_type: "channel",
      unread: 0,
      chat_type: "supergroup",
      // Forum: топик последнего входящего (имитирует переключение пользователя на другой топик).
      current_topic_id: currentTopicId,
    }),
    getContact: vi.fn().mockReturnValue({}),
    getAgent: vi.fn().mockReturnValue({}),
    getConversation: vi.fn().mockReturnValue({}),
    getPredecessors: vi.fn().mockReturnValue([]),
  };
  return {
    client: {},
    G: mockG,
    dispatcher: { dispatch: vi.fn() },
    tick: 1,
    log: { info: vi.fn(), warn: vi.fn() },
    parseChatId: (id: string | number) => (typeof id === "number" ? id : Number(id)),
    ensureGraphId: (id: string | number) =>
      typeof id === "number" ? `channel:${id}` : id,
    ttsConfig: { ttsBaseUrl: "", ttsApiKey: "", ttsModel: "", ttsVoice: "" },
    exaApiKey: "",
    musicApiBaseUrl: "",
    youtubeApiKey: "",
    timezoneOffset: 8,
  } as unknown as ActionImplContext;
}

function getImpl(name: string) {
  const def = TELEGRAM_ACTION_MAP.get(name);
  if (!def) throw new Error(`Action "${name}" not found`);
  return def.impl;
}

beforeEach(() => {
  vi.clearAllMocks();
  setExplorationGuard(
    new ExplorationGuard({
      maxJoinsPerDay: 9999,
      maxSearchPerHour: 9999,
      joinCooldownMs: 0,
      searchCooldownMs: 0,
      postJoinSearchCooldownMs: 0,
      silentDurationS: 0,
      apprenticeDurationS: 0,
      apprenticeMaxMessages: 9999,
      circuitBreakerThreshold: 9999,
      circuitBreakerOpenMs: 0,
    }),
  );
});

describe("Fix #8 — forum topic routing priority", () => {
  const impl = getImpl("send_message");

  it("explicit args.topicId wins over stored current_topic_id", async () => {
    // current_topic_id = 50 (last inbound), but caller explicitly targets topic 77.
    const ctx = createMockContext(50);
    await impl(ctx, { chatId: 1, text: "hi", topicId: 77 });
    expect(actions.sendText).toHaveBeenCalledWith(
      ctx.client,
      1,
      "hi",
      expect.objectContaining({ topicId: 77 }),
    );
  });

  it("reply does NOT inject the stale current_topic_id (reply anchors its own topic)", async () => {
    // BUG REGRESSION: user just switched topics → current_topic_id = 50 (topic B),
    // but Alice is replying to msg 42 which lives in topic A. Passing topicId=50 here
    // would mis-route the reply into topic B. Fix: topicId must be undefined so the
    // reply itself determines the topic.
    const ctx = createMockContext(50);
    await impl(ctx, { chatId: 1, text: "answer", replyTo: 42 });
    expect(actions.sendText).toHaveBeenCalledWith(
      ctx.client,
      1,
      "answer",
      expect.objectContaining({ replyToMsgId: 42, topicId: undefined }),
    );
  });

  it("bare send (no replyTo, no explicit topic) falls back to current_topic_id", async () => {
    const ctx = createMockContext(50);
    await impl(ctx, { chatId: 1, text: "bare" });
    expect(actions.sendText).toHaveBeenCalledWith(
      ctx.client,
      1,
      "bare",
      expect.objectContaining({ replyToMsgId: undefined, topicId: 50 }),
    );
  });

  it("non-forum bare send: current_topic_id undefined → topicId undefined (normal send unaffected)", async () => {
    const ctx = createMockContext(undefined);
    await impl(ctx, { chatId: 1, text: "plain" });
    expect(actions.sendText).toHaveBeenCalledWith(
      ctx.client,
      1,
      "plain",
      expect.objectContaining({ replyToMsgId: undefined, topicId: undefined }),
    );
  });
});
