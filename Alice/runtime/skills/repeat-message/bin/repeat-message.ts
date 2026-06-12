#!/usr/bin/env npx tsx
/**
 * repeat_message CLI — 复读（转发消息到同一聊天）。
 *
 * 所有 Telegram 操作和副作用在引擎侧完成（Engine API /telegram/forward）。
 * CLI 只做 IPC。
 *
 * @see docs/adr/202-engine-api.md
 */

import { defineCommand, runMain } from "citty";
import { enginePost } from "../../_lib/engine-client.js";

const main = defineCommand({
  meta: {
    name: "repeat-message",
    description: "Forward (repeat) a message in the same chat",
  },
  args: {
    msgId: { type: "positional", description: "Message ID to repeat", required: true },
    chatId: { type: "positional", description: "Chat ID", required: true },
  },
  async run({ args }) {
    const msgId = Number(args.msgId);
    const chatId = Number(args.chatId);

    if (!Number.isFinite(msgId) || !Number.isFinite(chatId)) {
      console.error("Usage: repeat-message <msgId> <chatId>");
      process.exit(1);
    }

    try {
      const result = await enginePost("/telegram/forward", { chatId, msgId });
      if (!result) {
        console.log(JSON.stringify({ error: "Engine API unavailable (no socket)" }));
        process.exit(1);
      }
      console.log(JSON.stringify(result));
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    }
  },
});

runMain(main);
