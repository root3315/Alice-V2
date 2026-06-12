/**
 * group 类别动作：join_chat, leave_chat, search_public, preview_chat,
 * get_similar_channels, create_invite_link。
 *
 * @see docs/adr/149-define-action-builder.md
 */

import { z } from "zod";
import { defineAction } from "../action-builder.js";
import {
  createInviteLinkContract,
  getSimilarChannelsContract,
  previewChatContract,
  searchPublicContract,
} from "../action-contracts.js";
import type { TelegramActionDef } from "../action-types.js";
import {
  createInviteLink,
  getChatPreview,
  getSimilarChannels,
  joinChat,
  leaveChat,
  searchPublicChats,
} from "../actions.js";
import { getExplorationGuard } from "./shared.js";

export const groupActions: TelegramActionDef[] = [
  defineAction({
    name: "join_chat",
    category: "group",
    description: ["Join a channel/group by invite link, @username, or numeric ID."],
    usageHint:
      "Shell-native path preferred: `irc join ...`. Preview recommended before joining. Newly joined groups have a silent observation window before participation is allowed. ExplorationGuard enforces daily join limits.",
    params: z.object({
      chatIdOrLink: z.string().describe("Chat ID, @username, or invite link"),
    }),
    affordance: {
      whenToUse: "Join a channel or group by link or username",
      whenNotToUse:
        "Without previewing first — use preview_chat before joining, and prefer irc join for the shell-native path",
      priority: "on-demand",
    },
    async impl(ctx, args) {
      if (!args.chatIdOrLink) return false;

      const guard = getExplorationGuard();
      const check = guard.canJoin();
      if (!check.allowed) {
        ctx.log.info("join_chat blocked by ExplorationGuard", { reason: check.reason });
        return false;
      }

      try {
        const result = await joinChat(ctx.client, args.chatIdOrLink);
        guard.recordJoin();
        guard.recordSuccess("join");

        // ADR-115: 注册延迟评估——3 天后 deferred generator 创建评估线程
        const graphId = ctx.ensureGraphId(args.chatIdOrLink);
        if (ctx.G.has(graphId)) {
          ctx.G.setDynamic(graphId, "deferred_eval_ms", Date.now() + 3 * 24 * 3600_000);
        }

        if (result.pending) {
          ctx.log.info("join_chat: request sent, pending approval", {
            chatIdOrLink: args.chatIdOrLink,
          });
        } else {
          ctx.log.info("join_chat executed", { chatIdOrLink: args.chatIdOrLink });
        }
        return true;
      } catch (e) {
        guard.recordFailure("join");
        ctx.log.warn("join_chat failed", {
          chatIdOrLink: args.chatIdOrLink,
          error: e instanceof Error ? e.message : String(e),
        });
        return false;
      }
    },
  }),

  defineAction({
    name: "leave_chat",
    category: "group",
    description: ["Leave a channel or group."],
    usageHint: "Shell-native path preferred: `irc leave`.",
    params: z.object({
      chatId: z.number().describe("Chat ID"),
    }),
    affordance: {
      whenToUse: "Leave a channel or group you no longer want to be in",
      whenNotToUse:
        "Impulsively — consider the social consequences first, and prefer irc leave for the shell-native path",
      priority: "on-demand",
    },
    async impl(ctx, args) {
      if (!args.chatId) return false;

      const rawId = ctx.parseChatId(args.chatId);
      await leaveChat(ctx.client, rawId);
      getExplorationGuard().recordLeave();

      ctx.log.info("leave_chat executed", { chatId: args.chatId });
      return true;
    },
  }),

  defineAction({
    name: "search_public",
    category: "group",
    description: [
      "Search for public groups, channels, and users. Results available in the next round .",
    ],
    usageHint: "Find public groups/channels to explore. Use preview_chat(link) before joining.",
    params: z.object({
      query: z.string().describe("Search query"),
    }),
    contract: searchPublicContract,
    returnDoc: "Results available in the next round as observation (`self.last_search_public`).",
    affordance: {
      whenToUse: "Find public groups, channels, or users",
      whenNotToUse: "When you already know the chat to join",
      priority: "capability",
      category: "group_admin",
    },
    async impl(ctx, args) {
      if (!args.query) return false;

      const guard = getExplorationGuard();
      const check = guard.canSearch("public");
      if (!check.allowed) {
        ctx.log.info("search_public blocked by ExplorationGuard", { reason: check.reason });
        return false;
      }

      try {
        const result = await searchPublicChats(ctx.client, args.query);
        searchPublicContract.store(ctx.G, "self", {
          query: args.query,
          users: result.users,
          chats: result.chats,
        });
        guard.recordSearch();
        guard.recordSuccess("search_public");
        ctx.log.info("search_public executed", {
          query: args.query,
          users: result.users.length,
          chats: result.chats.length,
        });
        return true;
      } catch (e) {
        guard.recordFailure("search_public");
        ctx.log.warn("search_public failed", {
          query: args.query,
          error: e instanceof Error ? e.message : String(e),
        });
        return false;
      }
    },
  }),

  defineAction({
    name: "preview_chat",
    category: "group",
    description: [
      "Preview a chat from an invite link before joining. Results available in the next round .",
    ],
    usageHint:
      "Preview a group before committing to join. Check member count, title, and approval requirements.",
    params: z.object({
      inviteLink: z.string().describe("Invite link to preview"),
    }),
    contract: previewChatContract,
    returnDoc: "Results available in the next round as observation (`self.last_chat_preview`).",
    affordance: {
      whenToUse: "Preview a chat from an invite link before joining",
      whenNotToUse: "When you're already a member of the chat",
      priority: "capability",
      category: "group_admin",
    },
    async impl(ctx, args) {
      if (!args.inviteLink) return false;

      const preview = await getChatPreview(ctx.client, args.inviteLink);
      previewChatContract.store(ctx.G, "self", {
        link: args.inviteLink,
        title: preview.title,
        type: preview.type,
        memberCount: preview.memberCount,
        withApproval: preview.withApproval,
      });
      ctx.log.info("preview_chat executed", {
        inviteLink: args.inviteLink,
        title: preview.title,
      });
      return true;
    },
  }),

  defineAction({
    name: "get_similar_channels",
    category: "group",
    description: ["Get recommended similar channels. Results available in the next round ."],
    usageHint: "Discover related channels for exploration. Good when curiosity pressure is high.",
    params: z.object({
      chatId: z.number().describe("Channel ID to find similar ones for"),
    }),
    contract: getSimilarChannelsContract,
    returnDoc:
      "Results available in the next round as observation (`<chatNode>.similar_channels`).",
    affordance: {
      whenToUse: "Discover channels related to one you already know",
      whenNotToUse: "When not exploring — only use when curiosity is high",
      priority: "capability",
      category: "group_admin",
    },
    async impl(ctx, args) {
      if (!args.chatId) return false;

      const rawId = ctx.parseChatId(args.chatId);
      const graphId = ctx.ensureGraphId(args.chatId);
      const channels = await getSimilarChannels(ctx.client, rawId);

      const results = channels.slice(0, 20).map((c) => ({
        id: c.id,
        title: c.title,
      }));
      getSimilarChannelsContract.store(ctx.G, graphId, results);
      ctx.log.info("get_similar_channels executed", {
        chatId: args.chatId,
        resultCount: results.length,
      });
      return true;
    },
  }),

  defineAction({
    name: "create_invite_link",
    category: "group",
    description: [
      "Create an invite link for a group/channel where Alice is admin.",
      "Results available in the next round .",
    ],
    usageHint: "Share groups with friends. Only works if Alice has admin/invite permissions.",
    params: z.object({
      chatId: z.number().describe("Chat ID to create invite for"),
    }),
    contract: createInviteLinkContract,
    returnDoc:
      "Results available in the next round as observation (`<chatNode>.last_invite_link`).",
    affordance: {
      whenToUse: "Create an invite link to share a group with someone",
      whenNotToUse: "When you don't have admin permissions in the group",
      priority: "on-demand",
    },
    async impl(ctx, args) {
      if (!args.chatId) return false;

      const rawId = ctx.parseChatId(args.chatId);
      const graphId = ctx.ensureGraphId(args.chatId);
      const result = await createInviteLink(ctx.client, rawId);

      createInviteLinkContract.store(ctx.G, graphId, result.link);
      ctx.log.info("create_invite_link executed", { chatId: args.chatId, link: result.link });
      return true;
    },
  }),
];
