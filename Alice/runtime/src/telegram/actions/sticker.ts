/**
 * Действия категории sticker: send_sticker, list_stickers, get_sticker_set.
 *
 * send_sticker равнозначен reply — выполняется за один шаг, LLM описывает только эмоцию/действие.
 * list_stickers / get_sticker_set — продвинутые API для обзора, обычно не нужны.
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

      // Трёхуровневая цепочка деградации:
      // Tier 1: resolveLabel(palette) — семантическое сопоставление по измерению (оптимально)
      // Tier 2: keyword → emoji → совпадение по столбцу palette.emoji
      // Tier 3: структурированный сбой + рекомендации

      let fileId: string | null = null;
      let tier = 0;

      // Tier 1: семантическое сопоставление по измерению
      fileId = resolveLabel(db, args.sticker, graphId);
      if (fileId) {
        tier = 1;
      }

      // Tier 2: сопоставление по столбцу emoji (когда palette содержит данные, но столбец измерения отсутствует — например, на этапе bootstrap)
      if (!fileId) {
        fileId = resolveByEmoji(db, args.sticker, graphId);
        if (fileId) tier = 2;
      }

      // запасной вариант с raw fileId — LLM мог скопировать raw fileId из истории чата
      if (!fileId && typeof args.sticker === "string" && args.sticker.startsWith("CAACAgI")) {
        fileId = args.sticker;
        tier = 0;
      }

      // Tier 3: запасной emoji → структурированный сбой
      if (!fileId) {
        const emoji = KEYWORD_TO_EMOJI[args.sticker.toLowerCase()];
        if (emoji) {
          // запасной emoji: отправляем чистый текстовый emoji
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

        // полный сбой: структурированное сообщение об ошибке
        const available = getAvailableKeywords(db);
        const errorMsg = `No sticker matches "${args.sticker}". Valid: ${available}`;
        ctx.log.warn("send_sticker: all tiers failed", { input: args.sticker });
        return { success: false, error: errorMsg };
      }

      const msgId = await sendSticker(ctx.client, rawId, fileId, { replyToMsgId: args.replyTo });

      // явно кешируем исходящий msg_id — нужен для определения направленных ответов (аналогично send_message)
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
