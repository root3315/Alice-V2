/**
 * reaction 类别动作：react。
 *
 * @see docs/adr/149-define-action-builder.md
 */

import { z } from "zod";
import { defineAction } from "../action-builder.js";
import type { TelegramActionDef } from "../action-types.js";
import { sendReaction } from "../actions.js";
import { TelegramReactionSchema } from "./shared.js";

export const reactionActions: TelegramActionDef[] = [
  defineAction({
    name: "react",
    category: "reaction",
    description: ["React to a message with an emoji."],
    usageHint: "Low-cost social signal. Acknowledges a message without requiring a full reply.",
    params: z.object({
      chatId: z.number().describe("Target chat"),
      msgId: z.number().describe("Message ID"),
      emoji: TelegramReactionSchema.describe(
        "Reaction emoji (Telegram standard set: 👍👎❤🔥🥰😁🤔😱😢🎉🤩😭 etc.)",
      ),
    }),
    inject: { chatId: "TARGET_CHAT" },
    affordance: {
      whenToUse: "Acknowledge a message with a low-cost emoji reaction",
      whenNotToUse: "When a full text reply is more appropriate",
      priority: "core",
    },
    async impl(ctx, args) {
      if (!args.chatId || !args.msgId || !args.emoji) return false;

      const rawId = ctx.parseChatId(args.chatId);
      const graphId = ctx.ensureGraphId(args.chatId);

      await sendReaction(ctx.client, rawId, args.msgId, args.emoji);
      // 审计修复: react 不是消息，不应递增 consecutive_outgoing
      ctx.dispatcher.dispatch("DECLARE_ACTION", { target: graphId, isMessage: false });

      ctx.log.info("react executed", {
        chatId: args.chatId,
        msgId: args.msgId,
        emoji: args.emoji,
      });
      return true;
    },
  }),
];
