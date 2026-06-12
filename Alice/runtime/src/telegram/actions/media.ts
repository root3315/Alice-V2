/**
 * media 类别动作：send_media, send_voice。
 *
 * @see docs/adr/149-define-action-builder.md
 */

import { z } from "zod";
import { isTTSEnabled, type TTSEmotion, textToSpeech } from "../../llm/tts.js";
import { defineAction } from "../action-builder.js";
import type { TelegramActionDef } from "../action-types.js";
import { sendMedia, sendText, sendVoice } from "../actions.js";

export const mediaActions: TelegramActionDef[] = [
  defineAction({
    name: "send_media",
    category: "media",
    description: [
      "Send a media file (photo/video/document) by Telegram file ID.",
      "Only supports existing Telegram file IDs — for local files use `irc send-file`.",
    ],
    usageHint:
      "Forward existing media by file ID. For local files: irc download → process → irc send-file.",
    params: z.object({
      chatId: z.number().describe("Target chat"),
      fileId: z.string().describe("Telegram file ID"),
      caption: z.string().optional().describe("Optional caption text"),
      replyTo: z.number().optional().describe("Message ID to reply to"),
    }),
    inject: { chatId: "TARGET_CHAT" },
    affordance: {
      whenToUse: "Share a photo, video, or document by file ID",
      whenNotToUse: "When you don't have a valid Telegram file ID",
      priority: "capability",
      category: "media",
    },
    async impl(ctx, args) {
      if (!args.chatId || !args.fileId) return false;

      const rawId = ctx.parseChatId(args.chatId);
      const graphId = ctx.ensureGraphId(args.chatId);

      await sendMedia(ctx.client, rawId, args.fileId, {
        caption: args.caption,
        replyTo: args.replyTo,
      });

      ctx.dispatcher.dispatch("DECLARE_ACTION", { target: graphId });

      ctx.log.info("send_media executed", { chatId: args.chatId, fileId: args.fileId });
      return { success: true, obligationsConsumed: 1 };
    },
  }),

  defineAction({
    name: "send_voice",
    category: "media",
    description: [
      "Convert text to speech and send as a voice message.",
      "Voice carries warmth that text can't. Natural for storytelling, comfort, greetings, excitement, or replying to a voice message.",
    ],
    usageHint: "Voice instead of text. Adds presence and intimacy — like being in the same room.",
    params: z.object({
      chatId: z.number().describe("Target chat"),
      text: z.string().describe("Text to speak (max 1000 chars)"),
      emotion: z
        .string()
        .optional()
        .describe(
          "Emotion tone: happy, sad, angry, fearful, disgusted, surprised, calm, fluent, whisper",
        ),
      replyTo: z.number().optional().describe("Message ID to reply to"),
    }),
    inject: { chatId: "TARGET_CHAT" },
    affordance: {
      whenToUse:
        "When voice adds warmth or presence — stories, comfort, greetings, excitement, or replying to a voice message",
      whenNotToUse: "For factual or informational replies where tone doesn't matter",
      priority: "core",
      requires: "hasTTS",
    },
    async impl(ctx, args) {
      const text = (args.text ?? "").slice(0, 1000);
      if (!args.chatId || !text) return false;

      if (!isTTSEnabled(ctx.ttsConfig)) {
        ctx.log.warn("send_voice called but TTS is not configured");
        return false;
      }

      const VALID_EMOTIONS = new Set([
        "happy",
        "sad",
        "angry",
        "fearful",
        "disgusted",
        "surprised",
        "calm",
        "fluent",
        "whisper",
      ]);
      const emotion =
        args.emotion && VALID_EMOTIONS.has(args.emotion) ? (args.emotion as TTSEmotion) : undefined;

      const audioBuffer = await textToSpeech(text, ctx.ttsConfig, emotion);
      if (!audioBuffer) {
        ctx.log.warn("TTS failed, falling back to text message", { chatId: args.chatId });
        const rawId = ctx.parseChatId(args.chatId);
        const graphId = ctx.ensureGraphId(args.chatId);
        await sendText(ctx.client, rawId, text);
        ctx.dispatcher.dispatch("DECLARE_ACTION", { target: graphId });
        return true;
      }

      const rawId = ctx.parseChatId(args.chatId);
      const graphId = ctx.ensureGraphId(args.chatId);
      await sendVoice(ctx.client, rawId, audioBuffer, { replyToMsgId: args.replyTo });

      ctx.dispatcher.dispatch("SEND_MESSAGE", {
        chatId: graphId,
        text,
        mediaType: "voice",
      });
      ctx.dispatcher.dispatch("DECLARE_ACTION", { target: graphId });

      ctx.log.info("send_voice executed", {
        chatId: args.chatId,
        textLen: text.length,
        audioBytes: audioBuffer.byteLength,
      });
      return { success: true, obligationsConsumed: 1 };
    },
  }),
];
