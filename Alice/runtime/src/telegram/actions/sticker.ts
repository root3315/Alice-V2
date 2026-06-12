/**
 * sticker 类别动作：send_sticker, list_stickers, get_sticker_set。
 *
 * send_sticker 与 reply 平级——一步完成，LLM 只需描述情绪/动作。
 * list_stickers / get_sticker_set 是高级 API，浏览用，通常不需要。
 *
 * @see docs/adr/149-define-action-builder.md
 */

import { z } from "zod";
import { getDb } from "../../db/connection.js";
import { defineAction } from "../action-builder.js";
import { getStickerSetContract, listStickersContract } from "../action-contracts.js";
import type { TelegramActionDef } from "../action-types.js";
import { getInstalledStickers, getStickerSet, sendSticker, sendText } from "../actions.js";
import {
  getAvailableKeywords,
  KEYWORD_TO_EMOJI,
  resolveByEmoji,
  resolveLabel,
} from "../apps/sticker-palette.js";
import { cacheOutgoingMsg } from "../events.js";

export const stickerActions: TelegramActionDef[] = [
  defineAction({
    name: "send_sticker",
    category: "sticker",
    description: [
      "Send a sticker. Use a dimension keyword — the system picks the best match from the palette.",
    ],
    usageHint:
      "Emotions: happy, sad, angry, surprised, shy, love, tired, scared. Actions: hug, cry, laugh, wave, thumbsup, facepalm, peek.",
    params: z.object({
      chatId: z.number().describe("Target chat"),
      sticker: z
        .string()
        .describe(
          "Dimension keyword: happy|sad|angry|surprised|shy|love|tired|scared|hug|cry|laugh|wave|thumbsup|facepalm|peek",
        ),
      replyTo: z.number().optional().describe("Message ID to reply to"),
    }),
    inject: { chatId: "TARGET_CHAT" },
    affordance: {
      whenToUse: "Express emotion or react with a sticker",
      whenNotToUse: "When text or a reaction emoji is sufficient",
      priority: "core",
    },
    async impl(ctx, args) {
      if (!args.chatId || !args.sticker) {
        return { success: false, error: "Missing chatId or sticker parameter" };
      }

      const rawId = ctx.parseChatId(args.chatId);
      const graphId = ctx.ensureGraphId(args.chatId);

      const db = getDb();

      // 三级降级链：
      // Tier 1: resolveLabel(palette) — 语义维度匹配（最优）
      // Tier 2: keyword → emoji → palette.emoji 列匹配
      // Tier 3: 结构化失败 + 可操作指引

      let fileId: string | null = null;
      let tier = 0;

      // Tier 1: 语义维度匹配
      fileId = resolveLabel(db, args.sticker, graphId);
      if (fileId) {
        tier = 1;
      }

      // Tier 2: emoji 列匹配（palette 有数据但维度列缺失时，如 bootstrap 阶段）
      if (!fileId) {
        fileId = resolveByEmoji(db, args.sticker, graphId);
        if (fileId) tier = 2;
      }

      // raw fileId 兜底 — LLM 可能从聊天记录复制了 raw fileId
      if (!fileId && typeof args.sticker === "string" && args.sticker.startsWith("CAACAgI")) {
        fileId = args.sticker;
        tier = 0;
      }

      // Tier 3: emoji 兜底 → 结构化失败
      if (!fileId) {
        const emoji = KEYWORD_TO_EMOJI[args.sticker.toLowerCase()];
        if (emoji) {
          // emoji 兜底：发送纯文本 emoji
          const msgId = await sendText(ctx.client, rawId, emoji, { replyToMsgId: args.replyTo });
          if (msgId != null) {
            cacheOutgoingMsg(graphId, msgId);
          }
          ctx.dispatcher.dispatch("DECLARE_ACTION", { target: graphId });
          ctx.log.info("send_sticker: emoji fallback", {
            chatId: args.chatId,
            input: args.sticker,
            fallback: emoji,
          });
          return { success: true, obligationsConsumed: 1 };
        }

        // 完全失败：结构化错误信息
        const available = getAvailableKeywords(db);
        const errorMsg = `No sticker matches "${args.sticker}". Valid: ${available}`;
        ctx.log.warn("send_sticker: all tiers failed", { input: args.sticker });
        return { success: false, error: errorMsg };
      }

      const msgId = await sendSticker(ctx.client, rawId, fileId, { replyToMsgId: args.replyTo });

      // 主动缓存 outgoing msg_id — reply directed 检测需要（与 send_message 对齐）
      if (msgId != null) {
        cacheOutgoingMsg(graphId, msgId);
      }

      ctx.dispatcher.dispatch("DECLARE_ACTION", { target: graphId });

      ctx.log.info("send_sticker executed", {
        chatId: args.chatId,
        input: args.sticker,
        tier,
        resolved: fileId !== args.sticker ? fileId.slice(0, 20) : "(raw)",
      });
      return { success: true, obligationsConsumed: 1 };
    },
  }),

  defineAction({
    name: "list_stickers",
    category: "sticker",
    description: ["List installed sticker sets. Results available in the next round ."],
    usageHint:
      "Browse installed sticker sets. Usually not needed — just use `irc sticker --keyword <keyword>` directly.",
    params: z.object({}),
    contract: listStickersContract,
    returnDoc: "Results available in the next round as observation (`self.installed_stickers`).",
    affordance: {
      whenToUse: "Curious about what sticker sets are installed",
      whenNotToUse: "When sending stickers — just use `irc sticker --keyword <keyword>`",
      priority: "capability",
      category: "sticker",
      requires: "hasStickers",
    },
    async impl(ctx, _args) {
      const sets = await getInstalledStickers(ctx.client);
      const summary = sets.slice(0, 30).map((s) => ({
        shortName: s.shortName,
        title: s.title,
        count: s.count,
      }));
      listStickersContract.store(ctx.G, "self", summary);
      ctx.log.info("list_stickers executed", { setCount: summary.length });
      return true;
    },
  }),

  defineAction({
    name: "get_sticker_set",
    category: "sticker",
    description: [
      "Browse a sticker set to see what's available. Results appear in the next round .",
    ],
    usageHint:
      "Browse sticker sets to discover what's available. Usually not needed — just use `irc sticker --keyword <keyword>` directly.",
    params: z.object({
      setName: z.string().describe("Sticker set short name"),
    }),
    contract: getStickerSetContract,
    returnDoc: "Results available in the next round as observation (`self.last_sticker_set`).",
    affordance: {
      whenToUse: "Browse a specific sticker set to see what's inside",
      whenNotToUse: "When sending stickers — just use `irc sticker --keyword <keyword>`",
      priority: "capability",
      category: "sticker",
      requires: "hasStickers",
    },
    async impl(ctx, args) {
      if (!args.setName) return false;

      const set = await getStickerSet(ctx.client, args.setName);
      const detail = {
        shortName: set.shortName,
        title: set.title,
        stickers: set.isFull
          ? set.stickers.slice(0, 50).map((s) => ({
              fileId: s.sticker.fileId,
              emoji: s.alt,
            }))
          : [],
      };
      getStickerSetContract.store(ctx.G, "self", detail);
      ctx.log.info("get_sticker_set executed", {
        setName: args.setName,
        stickerCount: detail.stickers.length,
      });
      return true;
    },
  }),
];
