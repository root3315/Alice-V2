/**
 * bot 类别动作：click_inline_button, inline_query, send_inline_result, get_bot_commands。
 *
 * @see docs/adr/149-define-action-builder.md
 */

import { Long } from "@mtcute/node";
import { z } from "zod";
import { defineAction } from "../action-builder.js";
import {
  clickInlineButtonContract,
  getBotCommandsContract,
  inlineQueryContract,
} from "../action-contracts.js";
import type { TelegramActionDef } from "../action-types.js";
import {
  getBotCommands,
  getCallbackAnswer,
  getInlineBotResults,
  sendInlineBotResult,
} from "../actions.js";

export const botActions: TelegramActionDef[] = [
  defineAction({
    name: "click_inline_button",
    category: "bot",
    description: [
      "Click an inline keyboard button on a bot message. Results available in the next round .",
    ],
    usageHint: "Interact with bot keyboards. Result available in the next round.",
    params: z.object({
      chatId: z.number().describe("Target chat"),
      msgId: z.number().describe("Message ID with the inline keyboard"),
      data: z.string().describe("Callback data string from the button"),
    }),
    inject: { chatId: "TARGET_CHAT" },
    contract: clickInlineButtonContract,
    returnDoc:
      "Results available in the next round as observation (`<chatNode>.last_callback_answer`).",
    affordance: {
      whenToUse: "Interact with a bot's inline keyboard button",
      whenNotToUse: "When you don't understand the button's callback data",
      priority: "capability",
      category: "contact_info",
    },
    async impl(ctx, args) {
      if (!args.chatId || !args.msgId || !args.data) return false;

      const rawId = ctx.parseChatId(args.chatId);
      const graphId = ctx.ensureGraphId(args.chatId);
      const answer = await getCallbackAnswer(ctx.client, rawId, args.msgId, args.data);

      if (answer.message || answer.url) {
        clickInlineButtonContract.store(ctx.G, graphId, {
          msgId: args.msgId,
          message: answer.message,
          url: answer.url,
          alert: answer.alert,
        });
      }

      ctx.log.info("click_inline_button executed", {
        chatId: args.chatId,
        msgId: args.msgId,
        hasAnswer: !!answer.message,
      });
      return true;
    },
  }),

  defineAction({
    name: "inline_query",
    category: "bot",
    description: [
      "Query an inline bot. Results available in the next round .",
      "Use send_inline_result() in the next round to send a chosen result.",
    ],
    usageHint:
      "Search inline bots (e.g., @gif, @pic, music bots). Two-round flow: query → results auto-delivered → send result.",
    params: z.object({
      botUsername: z.string().describe("Bot username (e.g. '@gif')"),
      query: z.string().describe("Search query string"),
      chatId: z.number().describe("Chat context"),
    }),
    inject: { chatId: "TARGET_CHAT" },
    contract: inlineQueryContract,
    returnDoc:
      "Results available in the next round as observation (`<chatNode>.last_inline_query`).",
    affordance: {
      whenToUse: "Search an inline bot for content to share",
      whenNotToUse: "When a direct message or regular search is more appropriate",
      priority: "capability",
      category: "contact_info",
    },
    async impl(ctx, args) {
      if (!args.botUsername || !args.query || !args.chatId) return false;

      const rawChatId = ctx.parseChatId(args.chatId);
      const results = await getInlineBotResults(
        ctx.client,
        args.botUsername,
        rawChatId,
        args.query,
      );

      const graphId = ctx.ensureGraphId(args.chatId);
      inlineQueryContract.store(ctx.G, graphId, {
        botUsername: args.botUsername,
        query: args.query,
        queryId: results.queryId.toString(),
        results: results.results.slice(0, 30).map((r) => ({
          id: r.id,
          title: r.title ?? null,
          description: r.description ?? null,
        })),
      });

      ctx.log.info("inline_query executed", {
        botUsername: args.botUsername,
        query: args.query,
        resultCount: results.results.length,
      });
      return true;
    },
  }),

  defineAction({
    name: "send_inline_result",
    category: "bot",
    description: [
      "Send an inline bot result from a previous inline_query(). Two-round flow:",
      "Round 1: inline_query() → Round 2: read results, send_inline_result().",
    ],
    params: z.object({
      chatId: z.number().describe("Target chat"),
      queryId: z.string().describe("Query ID from the inline_query result"),
      resultId: z.string().describe("Result ID to send"),
    }),
    inject: { chatId: "TARGET_CHAT" },
    affordance: {
      whenToUse: "Send a result from a previous inline_query",
      whenNotToUse: "Without running inline_query first",
      priority: "capability",
      category: "contact_info",
    },
    async impl(ctx, args) {
      if (!args.chatId || !args.queryId || !args.resultId) return false;

      const rawId = ctx.parseChatId(args.chatId);
      await sendInlineBotResult(ctx.client, rawId, Long.fromString(args.queryId), args.resultId);

      const graphId = ctx.ensureGraphId(args.chatId);
      if (ctx.G.has(graphId)) {
        ctx.G.setDynamic(graphId, "last_inline_query", null);
      }

      ctx.dispatcher.dispatch("DECLARE_ACTION", { target: graphId });

      ctx.log.info("send_inline_result executed", {
        chatId: args.chatId,
        resultId: args.resultId,
      });
      return { success: true, obligationsConsumed: 1 };
    },
  }),

  defineAction({
    name: "get_bot_commands",
    category: "bot",
    description: ["Get a bot's registered commands. Results available in the next round ."],
    usageHint: "Discover what a bot can do. Use before interacting with unfamiliar bots.",
    params: z.object({
      botId: z.string().describe("Bot user ID or @username"),
    }),
    contract: getBotCommandsContract,
    returnDoc: "Results available in the next round as observation (`self.last_bot_commands`).",
    affordance: {
      whenToUse: "Discover what commands a bot supports",
      whenNotToUse: "When you already know how to interact with the bot",
      priority: "capability",
      category: "contact_info",
    },
    async impl(ctx, args) {
      if (!args.botId) return false;

      const commands = await getBotCommands(ctx.client, args.botId);
      getBotCommandsContract.store(ctx.G, "self", { botId: args.botId, commands });
      ctx.log.info("get_bot_commands executed", {
        botId: args.botId,
        commandCount: commands.length,
      });
      return true;
    },
  }),
];
