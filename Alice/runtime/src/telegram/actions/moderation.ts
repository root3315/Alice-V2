/**
 * moderation 类别动作：pin_message, delete_message, unpin_message。
 *
 * @see docs/adr/149-define-action-builder.md
 */

import { z } from "zod";
import { defineAction } from "../action-builder.js";
import type { TelegramActionDef } from "../action-types.js";
import { deleteMessages, pinMessage, unpinMessage } from "../actions.js";

export const moderationActions: TelegramActionDef[] = [
  defineAction({
    name: "pin_message",
    category: "moderation",
    description: ["Pin a message in a chat. Use for important agreements or reminders."],
    params: z.object({
      chatId: z.number().describe("Target chat"),
      msgId: z.number().describe("Message ID to pin"),
    }),
    inject: { chatId: "TARGET_CHAT" },
    affordance: {
      whenToUse: "Pin important agreements or reminders in a chat",
      whenNotToUse: "For trivial messages that don't need long-term visibility",
      priority: "on-demand",
    },
    async impl(ctx, args) {
      if (!args.chatId || !args.msgId) return false;

      const rawId = ctx.parseChatId(args.chatId);
      const graphId = ctx.ensureGraphId(args.chatId);

      await pinMessage(ctx.client, rawId, args.msgId);
      ctx.dispatcher.dispatch("DECLARE_ACTION", { target: graphId, isMessage: false });

      ctx.log.info("pin_message executed", { chatId: args.chatId, msgId: args.msgId });
      return true;
    },
  }),

  defineAction({
    name: "delete_message",
    category: "moderation",
    description: ["Delete a message (revoke for both sides)."],
    params: z.object({
      chatId: z.number().describe("Target chat"),
      msgId: z.number().describe("Message ID to delete"),
    }),
    inject: { chatId: "TARGET_CHAT" },
    affordance: {
      whenToUse: "Remove a message for both sides",
      whenNotToUse: "When the message history should be preserved",
      priority: "on-demand",
    },
    async impl(ctx, args) {
      if (!args.chatId || !args.msgId) return false;

      const rawId = ctx.parseChatId(args.chatId);
      const graphId = ctx.ensureGraphId(args.chatId);

      await deleteMessages(ctx.client, rawId, [args.msgId]);
      ctx.dispatcher.dispatch("DECLARE_ACTION", { target: graphId, isMessage: false });

      ctx.log.info("delete_message executed", { chatId: args.chatId, msgId: args.msgId });
      return true;
    },
  }),

  defineAction({
    name: "unpin_message",
    category: "moderation",
    description: ["Unpin a message in a chat."],
    params: z.object({
      chatId: z.number().describe("Target chat"),
      msgId: z.number().describe("Message ID to unpin"),
    }),
    inject: { chatId: "TARGET_CHAT" },
    affordance: {
      whenToUse: "Unpin a message that is no longer relevant",
      whenNotToUse: "When the pinned message is still useful to the group",
      priority: "on-demand",
    },
    async impl(ctx, args) {
      if (!args.chatId || !args.msgId) return false;

      const rawId = ctx.parseChatId(args.chatId);
      const graphId = ctx.ensureGraphId(args.chatId);

      await unpinMessage(ctx.client, rawId, args.msgId);
      ctx.dispatcher.dispatch("DECLARE_ACTION", { target: graphId, isMessage: false });

      ctx.log.info("unpin_message executed", { chatId: args.chatId, msgId: args.msgId });
      return true;
    },
  }),
];
