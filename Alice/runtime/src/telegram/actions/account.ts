/**
 * account 类别动作 + 杂项：update_profile, save_note, send_poll。
 *
 * save_note 和 send_poll 的 category 字段是 "messaging"，
 * 但按语义归属放在此文件（个人账户管理 + 收藏夹）。
 *
 * @see docs/adr/149-define-action-builder.md
 */

import { z } from "zod";
import { defineAction } from "../action-builder.js";
import type { TelegramActionDef } from "../action-types.js";
import { sendPoll, sendText, updateProfile } from "../actions.js";

export const accountActions: TelegramActionDef[] = [
  defineAction({
    name: "update_profile",
    category: "account",
    description: [
      "Update Alice's Telegram profile. Pass only the fields you want to change.",
      "firstName: display name. about: bio/signature (max 70 chars).",
    ],
    usageHint:
      "Express identity changes. Update bio to reflect current mood/status. Use sparingly.",
    params: z.object({
      firstName: z.string().optional().describe("New first name"),
      lastName: z.string().optional().describe("New last name (empty to clear)"),
      about: z.string().optional().describe("New bio/signature (max 70 chars)"),
    }),
    affordance: {
      whenToUse: "Update your display name or bio to reflect identity changes",
      whenNotToUse: "Frequently — profile changes should be meaningful",
      priority: "on-demand",
    },
    async impl(ctx, args) {
      if (args.firstName === undefined && args.lastName === undefined && args.about === undefined)
        return false;

      await updateProfile(ctx.client, {
        firstName: args.firstName,
        lastName: args.lastName,
        about: args.about,
      });

      if (ctx.G.has("self")) {
        if (args.firstName !== undefined) ctx.G.setDynamic("self", "display_name", args.firstName);
        if (args.about !== undefined) ctx.G.setDynamic("self", "bio", args.about);
      }

      ctx.log.info("update_profile executed", {
        firstName: args.firstName,
        lastName: args.lastName,
        about: args.about?.slice(0, 50),
      });
      return true;
    },
  }),

  defineAction({
    name: "save_note",
    category: "messaging",
    description: [
      "Save a note to Saved Messages (Alice's personal notebook).",
      "Use for: bookmarks, reminders, ideas, things to remember.",
    ],
    usageHint:
      "Personal notebook. Save important info, bookmarks, or thoughts. Read back with read_notes().",
    params: z.object({
      text: z.string().describe("Note text to save"),
    }),
    affordance: {
      whenToUse: "Save important info, bookmarks, or reminders to personal notebook",
      whenNotToUse: "For trivial or temporary information",
      priority: "capability",
      category: "memory",
    },
    async impl(ctx, args) {
      if (!args.text) return false;

      await sendText(ctx.client, "me", args.text);

      ctx.log.info("save_note executed", { textLen: args.text.length });
      return true;
    },
  }),

  defineAction({
    name: "send_poll",
    category: "messaging",
    description: [
      "Create a poll in a group/channel. Cannot be used in private chats.",
      "Provide 2-10 answer options.",
    ],
    usageHint: "Engage the group with a question. Good for casual decisions or fun interactions.",
    params: z.object({
      chatId: z.number().describe("Target chat"),
      question: z.string().describe("Poll question (1-255 chars)"),
      answers: z.array(z.string()).describe("Answer options (2-10 strings, each 1-100 chars)"),
    }),
    inject: { chatId: "TARGET_CHAT" },
    affordance: {
      whenToUse: "Create a poll to engage the group with a question",
      whenNotToUse: "In private chats or when a simple question suffices",
      priority: "core",
    },
    async impl(ctx, args) {
      const answers = Array.isArray(args.answers) ? args.answers.map(String) : [];
      if (!args.chatId || !args.question || answers.length < 2) return false;

      const rawId = ctx.parseChatId(args.chatId);
      const graphId = ctx.ensureGraphId(args.chatId);

      await sendPoll(ctx.client, rawId, args.question, answers);

      ctx.dispatcher.dispatch("DECLARE_ACTION", { target: graphId });

      ctx.log.info("send_poll executed", {
        chatId: args.chatId,
        question: args.question,
        answerCount: answers.length,
      });
      return { success: true, obligationsConsumed: 1 };
    },
  }),
];
