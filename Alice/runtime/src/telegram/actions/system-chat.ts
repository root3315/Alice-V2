/**
 * Shell-native system chat commands.
 *
 * These are the preferred Alice OS surface for Telegram body operations.
 * Prompts and examples should converge on this command-space-first layer.
 */

import { z } from "zod";
import { engineUrlEnv } from "../../core/shell-executor.js";
import { executeRawCommand } from "../../skills/backends/shell.js";
import { buildInstalledSkillEnv, getAliceSystemBinDir } from "../../skills/registry.js";
import { defineAction } from "../action-builder.js";
import { commandOutputContract } from "../action-contracts.js";
import type { ActionImplContext, TelegramActionDef } from "../action-types.js";

const IRC_CMD = "irc";
const EXEC_TIMEOUT = 30;

function buildAliceChatArgs(
  subcommand: string,
  options?: {
    chatId?: number;
    flags?: Record<string, string | number | undefined>;
  },
): string[] {
  const args = [subcommand];
  if (options?.chatId != null) {
    args.push("--in", String(options.chatId));
  }
  if (options?.flags) {
    for (const [key, value] of Object.entries(options.flags)) {
      if (value == null) continue;
      args.push(`--${key}`, String(value));
    }
  }
  return args;
}

async function runAliceChat(
  ctx: ActionImplContext,
  args: string[],
  chatId?: number,
): Promise<string> {
  // 显式传递 --in flag 替代隐式 ALICE_TARGET_CHAT 环境变量。
  // --in 必须在 subcommand 之后（citty 解析要求），
  // 且仅在 buildAliceChatArgs 未包含 --in 时注入。
  const targetChat = chatId ?? Number(ctx.contextVars?.TARGET_CHAT ?? NaN);
  const hasExplicitIn = args.includes("--in");
  const fullArgs =
    Number.isFinite(targetChat) && !hasExplicitIn
      ? [args[0], "--in", String(targetChat), ...args.slice(1)]
      : args;

  return executeRawCommand(IRC_CMD, fullArgs, {
    cwd: getAliceSystemBinDir(),
    timeout: EXEC_TIMEOUT,
    env: {
      ...buildInstalledSkillEnv({ skillName: "alice-system" }),
      ...engineUrlEnv(),
    },
  });
}

export const systemChatActions: TelegramActionDef[] = [
  defineAction({
    name: "read",
    category: "messaging",
    description: ["Mark the current chat as read through the system chat client."],
    usageHint: "Preferred shell-native path for read receipts. Equivalent to irc read.",
    params: z.object({
      chatId: z.number().optional().describe("Optional chat override; omit for current chat"),
    }),
    affordance: {
      priority: "core",
      whenToUse: "Acknowledge the current chat without replying",
      whenNotToUse: "When you are about to send a reply anyway and read receipts are unnecessary",
    },
    async impl(ctx, args) {
      try {
        await runAliceChat(ctx, buildAliceChatArgs("read", { chatId: args.chatId }), args.chatId);
        return true;
      } catch (e) {
        return { success: false, error: e instanceof Error ? e.message : String(e) };
      }
    },
  }),
  defineAction({
    name: "tail",
    category: "search",
    description: ["Read recent messages from the current chat through the system command layer."],
    usageHint: "Preferred shell-native read path. Equivalent to irc tail --count <number>.",
    params: z.object({
      count: z.number().int().positive().max(50).optional().describe("Message count (default 20)"),
      chatId: z.number().optional().describe("Optional chat override; omit for current chat"),
    }),
    contract: commandOutputContract,
    returnDoc:
      "Recent chat output appears in the next round as observation (`self.last_command_output`).",
    affordance: {
      priority: "capability",
      category: "chat_history",
      whenToUse: "Inspect recent chat lines before replying or deciding whether to stay silent",
      whenNotToUse: "When the live timeline already contains enough recent messages",
    },
    async impl(ctx, args) {
      try {
        const stdout = await runAliceChat(
          ctx,
          buildAliceChatArgs("tail", {
            chatId: args.chatId,
            flags: { count: args.count },
          }),
          args.chatId,
        );
        commandOutputContract.store(ctx.G, "self", {
          command: `irc tail${args.count != null ? ` --count ${args.count}` : ""}`,
          stdout: stdout || "(no output)",
        });
        return true;
      } catch (e) {
        return { success: false, error: e instanceof Error ? e.message : String(e) };
      }
    },
  }),
  defineAction({
    name: "whois",
    category: "search",
    description: ["Look up the current chat room or a specific contact."],
    usageHint: "Preferred shell-native read path. Equivalent to irc whois.",
    params: z.object({
      chatId: z.number().optional().describe("Optional chat override; omit for current chat"),
    }),
    contract: commandOutputContract,
    returnDoc:
      "Chat summary output appears in the next round as observation (`self.last_command_output`).",
    affordance: {
      priority: "capability",
      category: "chat_history",
      whenToUse: "Refresh your sense of what this chat is, its topic, unread state, and your role",
      whenNotToUse: "When the current chat context is already obvious",
    },
    async impl(ctx, args) {
      try {
        const stdout = await runAliceChat(
          ctx,
          buildAliceChatArgs("whois", { chatId: args.chatId }),
          args.chatId,
        );
        commandOutputContract.store(ctx.G, "self", {
          command: "irc whois",
          stdout: stdout || "(no output)",
        });
        return true;
      } catch (e) {
        return { success: false, error: e instanceof Error ? e.message : String(e) };
      }
    },
  }),
  defineAction({
    name: "topic",
    category: "search",
    description: ["Inspect the current chat topic through the system chat client."],
    usageHint: "Preferred shell-native read path. Equivalent to irc topic.",
    params: z.object({
      chatId: z.number().optional().describe("Optional chat override; omit for current chat"),
    }),
    contract: commandOutputContract,
    returnDoc:
      "Topic output appears in the next round as observation (`self.last_command_output`).",
    affordance: {
      priority: "capability",
      category: "chat_history",
      whenToUse: "Quickly check what the room is about before jumping in",
      whenNotToUse: "When you already know the active topic from the live timeline",
    },
    async impl(ctx, args) {
      try {
        const stdout = await runAliceChat(
          ctx,
          buildAliceChatArgs("topic", { chatId: args.chatId }),
          args.chatId,
        );
        commandOutputContract.store(ctx.G, "self", {
          command: "irc topic",
          stdout: stdout || "(no output)",
        });
        return true;
      } catch (e) {
        return { success: false, error: e instanceof Error ? e.message : String(e) };
      }
    },
  }),
  defineAction({
    name: "join",
    category: "group",
    description: ["Join a group, channel, or invite link through the system chat client."],
    usageHint: "Preferred shell-native join path. Equivalent to irc join --target <target>.",
    params: z.object({
      target: z.string().describe("Chat id, @username, or invite link"),
    }),
    affordance: {
      priority: "on-demand",
      category: "group_admin",
      whenToUse: "Join a chat after previewing or deciding to explore it",
      whenNotToUse: "When you still need to inspect the room or verify the target before entering",
    },
    async impl(ctx, args) {
      try {
        await runAliceChat(ctx, buildAliceChatArgs("join", { flags: { target: args.target } }));
        return true;
      } catch (e) {
        return { success: false, error: e instanceof Error ? e.message : String(e) };
      }
    },
  }),
  defineAction({
    name: "part",
    category: "group",
    description: ["Leave the current chat through the system chat client."],
    usageHint: "Preferred shell-native leave path. Equivalent to irc leave.",
    params: z.object({
      chatId: z.number().optional().describe("Optional chat override; omit for current chat"),
    }),
    affordance: {
      priority: "on-demand",
      category: "group_admin",
      whenToUse: "Leave the current room when you have decided it is not worth staying in",
      whenNotToUse: "When you mean conversation leave() instead of room departure",
    },
    async impl(ctx, args) {
      try {
        await runAliceChat(ctx, buildAliceChatArgs("leave", { chatId: args.chatId }), args.chatId);
        return true;
      } catch (e) {
        return { success: false, error: e instanceof Error ? e.message : String(e) };
      }
    },
  }),
];
