/**
 * Получение сообщений — Telegram API реального времени + диффузия цепочек ответов.
 */
import {
  Audio,
  type Photo,
  Poll,
  Sticker,
  type TelegramClient,
  Contact as TgContact,
  User,
  Venue,
  Video,
  WebPageMedia,
} from "@mtcute/node";

import { eq } from "drizzle-orm";
import type { Config } from "../../config.js";
import { updateAlbumPhotoSemantics } from "../../db/album.js";
import { getDb } from "../../db/connection.js";
import { type DbMessageRecord, getMessageCluster } from "../../db/queries.js";
import { stickerPalette } from "../../db/schema.js";
import { telegramChannelId } from "../../graph/constants.js";
import type { ChatType } from "../../graph/entities.js";
import { isASREnabled, transcribeVoice } from "../../llm/asr.js";
import { setCachedChatInfo } from "../../llm/group-cache.js";
import {
  getCachedDescription,
  getCachedOcrText,
  getCachedStickerSetTitle,
  setCachedDescription,
  setCachedOcrText,
  setCachedStickerSetTitle,
} from "../../llm/media-cache.js";
import { extractText, isOcrEnabled } from "../../llm/ocr.js";
import { describeMedia, getStickerAnalysis, isVisionEnabled } from "../../llm/vision.js";
import { getHistory, getUnreadMentionIds, markRead } from "../../telegram/actions.js";
import { isInPalette, upsertFromVLM } from "../../telegram/apps/sticker-palette.js";
import { createLogger } from "../../utils/logger.js";
import { annotateSenderRole, fetchChatInfo, getAdminMap } from "./group-meta.js";

const log = createLogger("act");

/**
 * Белый список растровых типов миниатюр.
 * Типы миниатюр Telegram: s/m/x/y/w/a/b/c/d = растровый JPEG
 * j = SVG outline (photoPathSize — mtcute разворачивает локально в SVG), i = stripped, f/u/v = video
 * @see docs/reference/mtcute/.../types/media/thumbnail.ts
 */
const RASTER_THUMB_TYPES = new Set(["s", "m", "x", "y", "w", "a", "b", "c", "d"]);

/** Сегменты содержимого сообщения — поддерживает умное усечение с учётом приоритетов. */
export interface ContentSegment {
  readonly kind: "body" | "media" | "link" | "image" | "meta";
  readonly text: string;
}

export function formatImageOcrMetaText(ocr: string): string {
  return `(image OCR text, not sender speech: "${ocr}")`;
}

function formatAudioDuration(seconds: number): string | undefined {
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function formatAudioMediaText(
  audio: Pick<Audio, "title" | "performer" | "duration" | "fileName">,
): string {
  const title = audio.title?.trim();
  const performer = audio.performer?.trim();
  const fileName = audio.fileName?.trim();
  const duration = formatAudioDuration(audio.duration);
  const track = title && performer ? `${title} — ${performer}` : (title ?? performer ?? fileName);
  const detail = [track, duration].filter(Boolean).join(", ");
  return detail ? `(audio 🎵: ${detail})` : "(audio 🎵)";
}

export function formatStickerMediaText(params: {
  emoji?: string;
  title?: string;
  description?: string;
  fileId: string;
}): string {
  const title = params.title?.trim();
  const description = params.description?.trim();
  const emoji = params.emoji?.trim();
  const header = description ? "sticker" : ["sticker", emoji].filter(Boolean).join(" ");
  const titlePart = title ? ` — ${title}` : "";
  const descriptionPart = description ? `: ${description}` : "";
  return `(${header}${titlePart}${descriptionPart} | id:${params.fileId})`;
}

function extractStickerTitle(text: string): string | undefined {
  const match = text.match(/^\(sticker(?:\s+\S+)? — ([^:|]+?)(?:\s*:|\s*\|)/);
  return match?.[1]?.trim() || undefined;
}

/** Упрощённая запись сообщения, используется в fetchRecentMessages. */
export interface MessageRecord {
  id: number;
  senderName: string;
  /** Telegram user ID (для IRC-аннотации ~id). Присутствует только у входящих сообщений. */
  senderId?: number;
  isOutgoing: boolean;
  text: string;
  date: Date;
  /** ADR-83 D4: маркер типа медиа (photo/sticker/voice и др.), undefined при отсутствии медиа. */
  mediaType?: string;
  // --- ADR-85 ---
  /** ID сообщения-цитаты (визуализация ↩#id). */
  replyToId?: number;
  /** Было ли сообщение отредактировано. */
  isEdited?: boolean;
  /** Агрегация реакций: emoji → count (только string-emoji, custom пропускаются). */
  reactions?: Record<string, number>;
  /** Отображаемое имя источника пересылки (название канала/имя пользователя/скрытое). */
  forwardFrom?: string;
  /** ADR-97: сообщение втянуто через диффузию цепочки ответов, не исходный член скользящего окна. */
  isDiffused?: boolean;
  /** ADR-114 D5: нативная метка Telegram mention (сообщение упомянуло текущего пользователя). */
  isMention?: boolean;
  /** ADR-114 D2: сообщение втянуто через диффузию непрочитанного mention (не исходный член скользящего окна). */
  isMentionContext?: boolean;
  /** Является ли отправитель Telegram-ботом. */
  isBot?: boolean;
  /** Структурированные сегменты содержимого (только для реального времени из fetchRecentMessages). */
  segments?: ContentSegment[];
}

/** Заменяет text первого media-сегмента в record, синхронизирует поле text. */
function replaceMediaSegment(record: MessageRecord, newText: string): void {
  if (!record.segments) return;
  const idx = record.segments.findIndex((s) => s.kind === "media");
  if (idx >= 0) {
    (record.segments as ContentSegment[])[idx] = { kind: "media", text: newText };
    record.text = record.segments.map((s) => s.text).join(" ");
  }
}

/** Добавляет сегмент в record, синхронизирует поле text. */
function appendSegment(record: MessageRecord, seg: ContentSegment): void {
  if (!record.segments) return;
  (record.segments as ContentSegment[]).push(seg);
  record.text = record.segments.map((s) => s.text).join(" ");
}

const CONTEXT_HORIZON_MS_PRIVATE = 7 * 24 * 3600_000;
const CONTEXT_HORIZON_MS_GROUP = 48 * 3600_000;

/**
 * ADR-134 D4: вычисляет горизонт окна сообщений реального времени.
 *
 * Канал — это лента, а не разговор. Пока идёт просмотр, последние посты ценны для решений
 * даже спустя 48 ч; иначе промпт деградирует до «списка пересылаемых объектов» без тела канала.
 */
export function resolveContextHorizonMs(chatId: number, chatType?: ChatType): number | null {
  if (chatType === "channel") return null;
  if (chatType === "private") return CONTEXT_HORIZON_MS_PRIVATE;
  if (chatType === "group" || chatType === "supergroup") return CONTEXT_HORIZON_MS_GROUP;
  return chatId > 0 ? CONTEXT_HORIZON_MS_PRIVATE : CONTEXT_HORIZON_MS_GROUP;
}

/**
 * Получает последние сообщения целевого канала (реальное время через Telegram API).
 */
export async function fetchRecentMessages(
  client: TelegramClient,
  chatId: number,
  config: Config,
  opts: {
    limit?: number;
    chatType?: ChatType;
  } = {},
): Promise<MessageRecord[]> {
  try {
    const limit = opts.limit ?? 30;
    const rawMessages = await getHistory(client, chatId, limit);

    // ADR-134 D4: горизонт восприятия — для групп и каналов нельзя применять одно грубое правило.
    // group/supergroup: окно разговора 48 ч; private: 7 д; channel: только последние посты (без ограничения).
    // @see docs/adr/134-temporal-coherence.md §D4
    const horizonMs = resolveContextHorizonMs(chatId, opts.chatType);
    const floorMs = horizonMs == null ? null : Date.now() - horizonMs;
    const messages =
      floorMs == null ? rawMessages : rawMessages.filter((m) => m.date.getTime() >= floorMs);

    let records: MessageRecord[] = [];

    // Метаданные группы + аннотация ролей администраторов (параллельное получение, постоянный кэш SQLite)
    const [adminMap, chatInfo] = await Promise.all([
      getAdminMap(client, chatId),
      fetchChatInfo(client, chatId),
    ]);
    // Дополняем isAliceAdmin: извлекаем user ID Алисы из исходящих сообщений, пишем в постоянный кэш
    if (chatId < 0 && chatInfo) {
      const aliceId = messages.find((m) => m.isOutgoing && m.sender && "id" in m.sender)?.sender
        ?.id as number | undefined;
      if (aliceId) {
        const isAdmin = adminMap.has(aliceId);
        if (chatInfo.isAliceAdmin !== isAdmin) {
          chatInfo.isAliceAdmin = isAdmin;
          setCachedChatInfo(chatId, chatInfo);
        }
      }
    }

    // ADR-88: собираем медиасообщения, требующие асинхронного разбора
    const visionEnabled = isVisionEnabled(config);
    const ocrEnabled = isOcrEnabled(config);
    type MediaRef = NonNullable<(typeof messages)[number]["media"]>;
    const photosToDescribe: Array<{ index: number; fileUniqueId: string; media: MediaRef }> = [];
    // Кандидаты OCR: независимы от VLM, работают даже при отключённом VLM
    const photosToOcr: Array<{ index: number; fileUniqueId: string; media: MediaRef }> = [];
    // ADR-119: собираем стикеры, требующие семантического описания VLM
    const stickersToDescribe: Array<{
      index: number;
      fileUniqueId: string;
      media: MediaRef;
      /** sourceType: "static" | "animated" | "video" */
      sourceType: string;
      /** Phase 2: используется для индексации в палитре */
      emoji?: string;
      fileId: string;
    }> = [];
    // ADR-119: собираем голосовые сообщения, требующие ASR-транскрипции
    const asrEnabled = isASREnabled(config);
    const voicesToTranscribe: Array<{ index: number; fileUniqueId: string; media: MediaRef }> = [];
    const stickersToResolve: Array<{
      index: number;
      emoji: string;
      setId: string;
      fileId: string;
      inputStickerSet: NonNullable<Sticker["inputStickerSet"]>;
    }> = [];
    const gifsToDescribe: Array<{ index: number; fileUniqueId: string; video: Video }> = [];
    const videosToDescribe: Array<{ index: number; fileUniqueId: string; video: Video }> = [];
    const linkPhotosToDescribe: Array<{ index: number; fileUniqueId: string; photo: Photo }> = [];

    for (const msg of messages) {
      const segments: ContentSegment[] = [];
      let mediaType: string | undefined;
      // ADR-78 P0 + ADR-83 D4: нетекстовые сообщения генерируют визуальный маркер, чтобы LLM воспринял наличие медиа
      if (msg.media) {
        mediaType = msg.media.type;
        if (!msg.text) {
          if (msg.media instanceof Sticker) {
            const emoji = msg.media.emoji || "";
            const stickerFileId = msg.media.fileId;
            segments.push({
              kind: "media",
              text: formatStickerMediaText({ emoji, fileId: stickerFileId }),
            });
            // ADR-119: собираем VLM-описание + Phase 2 индексацию в палитре
            if (visionEnabled) {
              const uid = msg.media.uniqueFileId;
              if (uid) {
                stickersToDescribe.push({
                  index: records.length,
                  fileUniqueId: uid,
                  media: msg.media,
                  sourceType: msg.media.sourceType,
                  emoji: emoji || undefined,
                  fileId: stickerFileId,
                });
              }
            }
            // Собираем для асинхронного разбора: название набора стикеров
            const inputSet = msg.media.inputStickerSet;
            if (msg.media.hasStickerSet && inputSet && "id" in inputSet) {
              stickersToResolve.push({
                index: records.length,
                emoji,
                setId: String(inputSet.id),
                fileId: stickerFileId,
                inputStickerSet: inputSet,
              });
            }
          } else if (mediaType === "photo") segments.push({ kind: "media", text: "(photo 📷)" });
          else if (msg.media instanceof Audio) {
            segments.push({ kind: "media", text: formatAudioMediaText(msg.media) });
          } else if (mediaType === "voice") {
            segments.push({ kind: "media", text: "(voice 🎤)" });
            // ADR-119: собираем для ASR-транскрипции
            if (asrEnabled) {
              const uid = "uniqueFileId" in msg.media ? String(msg.media.uniqueFileId) : "";
              if (uid) {
                voicesToTranscribe.push({
                  index: records.length,
                  fileUniqueId: uid,
                  media: msg.media,
                });
              }
            }
          } else if (msg.media instanceof Video) {
            if (msg.media.isAnimation) {
              segments.push({ kind: "media", text: "(gif 🎞)" });
              if (visionEnabled) {
                gifsToDescribe.push({
                  index: records.length,
                  fileUniqueId: msg.media.uniqueFileId,
                  video: msg.media,
                });
              }
            } else {
              segments.push({ kind: "media", text: "(video 🎬)" });
              if (visionEnabled) {
                videosToDescribe.push({
                  index: records.length,
                  fileUniqueId: msg.media.uniqueFileId,
                  video: msg.media,
                });
              }
            }
          } else if (mediaType === "document")
            segments.push({ kind: "media", text: "(document 📎)" });
          else if (msg.media instanceof Poll) {
            const q = msg.media.question;
            const opts = msg.media.answers.map((a) => a.text).join(" / ");
            segments.push({
              kind: "media",
              text: opts ? `(poll: ${q} — ${opts})` : `(poll: ${q})`,
            });
          } else if (msg.media instanceof TgContact) {
            const name = [msg.media.firstName, msg.media.lastName].filter(Boolean).join(" ");
            segments.push({ kind: "media", text: `(contact: ${name || "unknown"})` });
          } else if (msg.media instanceof Venue) {
            segments.push({
              kind: "media",
              text: `(venue: ${msg.media.title}, ${msg.media.address})`,
            });
          } else segments.push({ kind: "media", text: `(${mediaType})` });
        } else {
          // Медиасообщение с подписью (caption): текст несёт сегмент body
          segments.push({ kind: "body", text: msg.text });
        }
        // ADR-88: помечаем фото, требующие VLM-описания (только чистые фото без текста)
        if (
          mediaType === "photo" &&
          segments.some((s) => s.kind === "media" && s.text === "(photo 📷)")
        ) {
          const uid = "uniqueFileId" in msg.media ? String(msg.media.uniqueFileId) : "";
          if (uid) {
            if (visionEnabled) {
              photosToDescribe.push({ index: records.length, fileUniqueId: uid, media: msg.media });
            }
            // OCR не зависит от visionEnabled — работает независимо при отключённом VLM
            if (ocrEnabled) {
              photosToOcr.push({ index: records.length, fileUniqueId: uid, media: msg.media });
            }
          }
        }
        // WebPageMedia: в сообщении есть текст (URL), превью ссылки добавляется как сегмент link
        if (msg.media instanceof WebPageMedia) {
          const wp = msg.media.preview;
          const parts: string[] = [];
          if (wp.title) parts.push(wp.title);
          if (wp.description) parts.push(wp.description);
          if (parts.length > 0) {
            segments.push({ kind: "link", text: `(link: ${parts.join(" — ")})` });
          }
          // Предрендеренное изображение ссылки (previewType="photo") несёт информацию → VLM-описание
          if (visionEnabled && wp.previewType === "photo" && wp.photo) {
            const uid = wp.photo.uniqueFileId;
            if (uid) {
              linkPhotosToDescribe.push({
                index: records.length,
                fileUniqueId: uid,
                photo: wp.photo,
              });
            }
          }
        }
      } else if (msg.text) {
        // Чисто текстовое сообщение
        segments.push({ kind: "body", text: msg.text });
      }
      const text = segments.map((s) => s.text).join(" ");
      if (!text) continue; // Пропускаем только сообщения без текста и без медиа
      let senderName = "Unknown";
      let senderId: number | undefined;
      if (msg.sender) {
        // B4 fix: убрано небезопасное приведение типов, обращаемся к атрибутам интерфейса Peer mtcute напрямую
        senderName = msg.sender.displayName || `User ${msg.sender.id}`;
        if (!msg.isOutgoing) {
          senderId = msg.sender.id;
        }
        // Аннотация ролей в группе: owner/admin + кастомный титул
        senderName = annotateSenderRole(senderName, senderId, adminMap);
      }

      // ADR-85 D4: цепочка ответов
      const replyToId = msg.replyToMessage?.id ?? undefined;

      // ADR-85 D5: отслеживание редактирования
      const isEdited = msg.editDate != null ? true : undefined;

      // ADR-85 D6: агрегация реакций
      let reactions: Record<string, number> | undefined;
      if (msg.reactions) {
        const counts = msg.reactions.reactions;
        if (counts.length > 0) {
          reactions = {};
          for (const r of counts) {
            const emoji = r.emoji;
            // ReactionEmoji = string | tl.Long — оставляем только string emoji
            if (typeof emoji === "string") {
              reactions[emoji] = r.count;
            }
          }
          if (Object.keys(reactions).length === 0) reactions = undefined;
        }
      }

      // Извлечение источника пересылки (IRC-стиль: name ~senderId)
      let forwardFrom: string | undefined;
      if (msg.forward) {
        const fwdSender = msg.forward.sender;
        if (fwdSender) {
          const fwdName = fwdSender.displayName || "Unknown";
          const fwdId = "id" in fwdSender ? ` @${fwdSender.id}` : "";
          forwardFrom = `${fwdName}${fwdId}`;
        }
      }

      records.push({
        id: msg.id,
        senderName,
        senderId,
        isOutgoing: msg.isOutgoing,
        isBot:
          !msg.isOutgoing && msg.sender instanceof User ? msg.sender.isBot || undefined : undefined,
        text,
        date: msg.date,
        mediaType,
        replyToId,
        isEdited,
        reactions,
        forwardFrom,
        // ADR-114 D5: распространяем нативную метку Telegram mention
        isMention: msg.isMention || undefined,
        segments,
      });
    }
    records.reverse();

    // ── Асинхронный разбор названий наборов стикеров ────────────────────────────────────────────
    if (stickersToResolve.length > 0) {
      // Собираем некэшированные set ID, дедублируем (Sticker.inputStickerSet можно передавать напрямую в getStickerSet)
      const uncachedSets = new Map<string, NonNullable<Sticker["inputStickerSet"]>>();
      for (const s of stickersToResolve) {
        if (!getCachedStickerSetTitle(s.setId)) uncachedSets.set(s.setId, s.inputStickerSet);
      }
      // Параллельное получение (обычно ≤5 наборов)
      if (uncachedSets.size > 0) {
        await Promise.allSettled(
          [...uncachedSets].map(async ([setId, inputStickerSet]) => {
            try {
              const set = await client.getStickerSet(inputStickerSet);
              setCachedStickerSetTitle(setId, set.title, set.shortName);
            } catch {
              /* тихо — fallback до чистого emoji */
            }
          }),
        );
      }
      // Обратная запись
      for (const s of stickersToResolve) {
        const cached = getCachedStickerSetTitle(s.setId);
        const title = cached?.title;
        const reversedIdx = records.length - 1 - s.index;
        if (reversedIdx >= 0 && reversedIdx < records.length && title) {
          const newText = formatStickerMediaText({
            emoji: s.emoji,
            title,
            fileId: s.fileId,
          });
          records[reversedIdx].text = newText;
          replaceMediaSegment(records[reversedIdx], newText);
        }
      }
    }

    // ── ADR-119 + Phase 2: VLM-описание стикеров (разделяет бюджет visionMaxPerTick, высший приоритет) ──
    // describeMedia("sticker") одновременно выдаёт description + StickerAnalysis (чтение и запись за один проход).
    // Конвейер: palette check → OCR-предфильтр → структурированный анализ VLM → запись в палитру.
    const db = getDb();
    let stickerVisionUsed = 0;
    if (stickersToDescribe.length > 0) {
      const stickerCap = Math.min(
        stickersToDescribe.length,
        Math.ceil(config.visionMaxPerTick * 0.4),
      );
      const stickerBatch = stickersToDescribe.slice(-stickerCap);
      const stickerResults = await Promise.allSettled(
        stickerBatch.map(async ({ index, fileUniqueId, media, sourceType, emoji, fileId }) => {
          // Уже в палитре → используем кэшированное description (без повторного анализа)
          if (isInPalette(db, fileUniqueId)) {
            const cached = getCachedDescription(fileUniqueId);
            // При истечении TTL media-cache берём fallback из palette label
            if (cached) return { index, fileId, caption: cached };
            const paletteLabel = db
              .select({ label: stickerPalette.label })
              .from(stickerPalette)
              .where(eq(stickerPalette.fileUniqueId, fileUniqueId))
              .limit(1)
              .get();
            return { index, fileId, caption: paletteLabel?.label };
          }
          // Попадание в кэш (ранее проанализирован, но не прошёл критерии для записи в палитру)
          const cached = getCachedDescription(fileUniqueId);
          if (cached) return { index, fileId, caption: cached };
          try {
            // Скачиваем buffer
            let buffer: Buffer;
            // Растровая миниатюра анимированного стикера (.tgs/.webm) — её fileId
            // сохраняем в палитру, чтобы дашборд показывал статичный превью-кадр.
            // Для статичных стикеров остаётся undefined (основной файл уже растр).
            let thumbFileId: string | undefined;
            if (sourceType !== "static") {
              const sticker = media as Sticker;
              const thumb = sticker.thumbnails?.find(
                (t) => t.width > 0 && !Number.isNaN(t.width) && RASTER_THUMB_TYPES.has(t.type),
              );
              if (!thumb) return { index, fileId, caption: undefined };
              thumbFileId = thumb.fileId;
              buffer = Buffer.from(await client.downloadAsBuffer(thumb));
            } else {
              buffer = Buffer.from(
                await client.downloadAsBuffer(
                  media as Parameters<typeof client.downloadAsBuffer>[0],
                ),
              );
            }
            if (buffer.byteLength > 512_000 || buffer.byteLength < 1024) {
              return { index, fileId, caption: undefined };
            }
            const head4 = buffer.subarray(0, 4);
            if (head4[0] === 0x3c && (head4[1] === 0x3f || head4[1] === 0x73)) {
              setCachedDescription(fileUniqueId, "sticker", "(animated sticker)");
              return { index, fileId, caption: "(animated sticker)" };
            }

            // ADR-153 AnimeIDF gate ОСЛАБЛЕН (по просьбе пользователя): описываем ВСЕ
            // стикеры, не только аниме. Раньше тут non-anime → "(non-anime sticker)" skip.

            // OCR + VLM параллельно (независимы друг от друга)
            const base64 = buffer.toString("base64");
            const [ocrResult, caption] = await Promise.all([
              // OCR (обязательно): извлекаем текст на стикере, также служит условием записи в палитру
              extractText(buffer, config).catch(() => undefined),
              // Структурированный VLM-анализ (generateObject → description + побочный продукт StickerAnalysis)
              describeMedia(base64, fileUniqueId, "sticker", config),
            ]);
            const hasText = !!(ocrResult && ocrResult.trim().length > 0);

            // VLM записывает в резервный пул (setName=NULL) — приоритет у установленных самостоятельно стикеров, этот используется как запасной
            const analysis = getStickerAnalysis(fileUniqueId);
            if (analysis && caption && !hasText) {
              upsertFromVLM(db, {
                fileUniqueId,
                fileId,
                label: analysis.description,
                emoji,
                emotion: analysis.emotion,
                action: analysis.action,
                intensity: analysis.intensity,
                // Растровый превью-кадр для анимированных стикеров (статичные → undefined).
                thumbFileId,
              });
              log.info("Sticker indexed to palette (fallback pool)", {
                fileUniqueId,
                emotion: analysis.emotion,
              });
            }

            return { index, fileId, caption };
          } catch {
            return { index, fileId, caption: undefined };
          }
        }),
      );
      // Обратная запись: дописываем VLM-описание к существующему тексту (sticker ...)
      for (const r of stickerResults) {
        if (r.status !== "fulfilled" || !r.value.caption) continue;
        const ri = records.length - 1 - r.value.index;
        if (ri < 0 || ri >= records.length) continue;
        const newText = formatStickerMediaText({
          title: extractStickerTitle(records[ri].text),
          description: r.value.caption,
          fileId: r.value.fileId,
        });
        records[ri].text = newText;
        replaceMediaSegment(records[ri], newText);
      }
      stickerVisionUsed = Math.min(stickerBatch.length, config.visionMaxPerTick);
    }

    // ── Дедупликация загрузки фото: VLM и OCR разделяют один Buffer изображения ──────────
    // Один fileUniqueId скачивается только раз, последующие вызовы повторно используют Promise
    const photoDownloadCache = new Map<string, Promise<Buffer>>();
    function downloadPhotoOnce(uid: string, media: MediaRef): Promise<Buffer> {
      let p = photoDownloadCache.get(uid);
      if (!p) {
        p = client
          .downloadAsBuffer(media as Parameters<typeof client.downloadAsBuffer>[0])
          .then((buf) => Buffer.from(buf));
        photoDownloadCache.set(uid, p);
      }
      return p;
    }

    // ── ADR-88: параллельное получение описаний фото (не более visionMaxPerTick штук) ────────
    // VLM-описания собираются в Map (index → caption), обратная запись единым проходом после OCR
    const visionCaptions = new Map<number, string>();
    if (photosToDescribe.length > 0) {
      const photoBudget = Math.max(0, config.visionMaxPerTick - stickerVisionUsed);
      const batch = photosToDescribe.slice(-photoBudget); // Приоритет — самые новые
      const results = await Promise.allSettled(
        batch.map(async ({ index, fileUniqueId, media }) => {
          try {
            const buffer = await downloadPhotoOnce(fileUniqueId, media);
            if (buffer.byteLength > 1_048_576) return { index, fileUniqueId, caption: undefined }; // > 1 МБ — пропускаем
            const base64 = buffer.toString("base64");
            const caption = await describeMedia(base64, fileUniqueId, "photo", config);
            return { index, fileUniqueId, caption };
          } catch {
            return { index, fileUniqueId, caption: undefined };
          }
        }),
      );

      // Собираем результаты VLM-описания в Map (index → caption)
      for (const r of results) {
        if (r.status === "fulfilled" && r.value.caption) {
          visionCaptions.set(r.value.index, r.value.caption);
          updateAlbumPhotoSemantics(r.value.fileUniqueId, { description: r.value.caption });
        }
      }
    }

    // ── Извлечение текста OCR (отдельный бюджет, не занимает visionMaxPerTick) ────────────────
    // Результаты OCR собираются в Map, затем объединяются с VLM при обратной записи
    const ocrTexts = new Map<number, string>();
    if (photosToOcr.length > 0) {
      const ocrBatch = photosToOcr.slice(-config.ocrMaxPerTick); // Приоритет — самые новые
      const ocrResults = await Promise.allSettled(
        ocrBatch.map(async ({ index, fileUniqueId, media }) => {
          // Попадание в кэш
          const cached = getCachedOcrText(fileUniqueId);
          if (cached) return { index, fileUniqueId, ocrText: cached };
          try {
            const buffer = await downloadPhotoOnce(fileUniqueId, media);
            const ocrText = await extractText(buffer, config);
            if (ocrText) setCachedOcrText(fileUniqueId, ocrText);
            return { index, fileUniqueId, ocrText };
          } catch {
            return { index, fileUniqueId, ocrText: undefined };
          }
        }),
      );
      for (const r of ocrResults) {
        if (r.status === "fulfilled" && r.value.ocrText) {
          ocrTexts.set(r.value.index, r.value.ocrText);
          updateAlbumPhotoSemantics(r.value.fileUniqueId, { ocrText: r.value.ocrText });
        }
      }
    }

    // ── Обратная запись фото: объединяем VLM-описание + OCR-текст ─────────────────────────
    // | Сценарий        | Формат                                        |
    // |-----------------|-----------------------------------------------|
    // | VLM + OCR       | (photo: {VLM-описание}) + meta: (image OCR text...)|
    // | Только VLM      | (photo: {VLM-описание})                       |
    // | Только OCR      | (photo 📷) + meta: (image OCR text...)        |
    // | Ни того ни другого | (photo 📷) (без изменений)                |
    {
      const allPhotoIndices = new Set([...visionCaptions.keys(), ...ocrTexts.keys()]);
      for (const idx of allPhotoIndices) {
        const reversedIndex = records.length - 1 - idx;
        if (reversedIndex < 0 || reversedIndex >= records.length) continue;

        const record = records[reversedIndex];
        const vlm = visionCaptions.get(idx);
        const ocr = ocrTexts.get(idx);
        if (vlm) {
          replaceMediaSegment(record, `(photo: ${vlm})`);
        }
        if (ocr) {
          appendSegment(record, { kind: "meta", text: formatImageOcrMetaText(ocr) });
        }
        // Ни то ни другое → оставляем (photo 📷) без изменений
      }
    }

    // ── Единый VLM-пул: gif/video/linkPhoto сортируются по времени сообщения (новейшие первыми) ──
    // Заменяет старое каскадное распределение бюджета — video и linkPhoto больше не голодают системно.
    {
      const photoUsed = Math.min(
        photosToDescribe.length,
        Math.max(0, config.visionMaxPerTick - stickerVisionUsed),
      );
      const pool = [
        ...gifsToDescribe.map((g) => ({ ...g, mediaKind: "gif" as const })),
        ...videosToDescribe.map((v) => ({ ...v, mediaKind: "video" as const })),
        ...linkPhotosToDescribe.map((l) => ({ ...l, mediaKind: "linkPhoto" as const })),
      ];
      // Сортируем по index сообщения по убыванию (самые новые сообщения получают VLM-описание первыми)
      pool.sort((a, b) => b.index - a.index);
      const poolBudget = Math.max(0, config.visionMaxPerTick - stickerVisionUsed - photoUsed);
      const poolBatch = pool.slice(0, poolBudget);

      if (poolBatch.length > 0) {
        const poolResults = await Promise.allSettled(
          poolBatch.map(async (item) => {
            const { index, fileUniqueId, mediaKind } = item;
            const cached = getCachedDescription(fileUniqueId);
            if (cached) return { index, caption: cached, mediaKind };

            try {
              let buffer: Buffer;
              if (mediaKind === "linkPhoto") {
                const { photo } = item as (typeof linkPhotosToDescribe)[number] & {
                  mediaKind: "linkPhoto";
                };
                buffer = Buffer.from(await client.downloadAsBuffer(photo));
                if (buffer.byteLength > 1_048_576) return { index, caption: undefined, mediaKind };
              } else {
                const { video } = item as (typeof gifsToDescribe)[number] & {
                  mediaKind: "gif" | "video";
                };
                const thumb = video.thumbnails.find(
                  (t) => t.width > 0 && !Number.isNaN(t.width) && RASTER_THUMB_TYPES.has(t.type),
                );
                if (!thumb) return { index, caption: undefined, mediaKind };
                buffer = Buffer.from(await client.downloadAsBuffer(thumb));
                if (buffer.byteLength > 512_000) return { index, caption: undefined, mediaKind };
              }

              const base64 = buffer.toString("base64");
              const vlmType = mediaKind === "linkPhoto" ? "photo" : mediaKind;
              const caption = await describeMedia(base64, fileUniqueId, vlmType, config);
              return { index, caption, mediaKind };
            } catch {
              return { index, caption: undefined, mediaKind };
            }
          }),
        );

        for (const r of poolResults) {
          if (r.status !== "fulfilled" || !r.value.caption) continue;
          const { index, caption, mediaKind } = r.value;
          const ri = records.length - 1 - index;
          if (ri < 0 || ri >= records.length) continue;

          if (mediaKind === "gif") {
            replaceMediaSegment(records[ri], `(gif: ${caption})`);
          } else if (mediaKind === "video") {
            replaceMediaSegment(records[ri], `(video: ${caption})`);
          } else {
            // linkPhoto → сегмент image дописывается после существующего содержимого
            appendSegment(records[ri], { kind: "image", text: `(image: ${caption})` });
          }
        }
      }
    }

    // ── ADR-119: ASR-транскрипция голоса (отдельный бюджет, не занимает visionMaxPerTick) ─────
    const ASR_MAX_PER_TICK = 2;
    if (voicesToTranscribe.length > 0) {
      const asrBatch = voicesToTranscribe.slice(-ASR_MAX_PER_TICK);
      const asrResults = await Promise.allSettled(
        asrBatch.map(async ({ index, fileUniqueId, media }) => {
          const cached = getCachedDescription(fileUniqueId);
          if (cached) return { index, transcription: cached };
          try {
            const buffer = Buffer.from(
              await client.downloadAsBuffer(media as Parameters<typeof client.downloadAsBuffer>[0]),
            );
            if (buffer.byteLength > 10_485_760) return { index, transcription: undefined };
            const text = await transcribeVoice(buffer, config);
            if (text) setCachedDescription(fileUniqueId, "voice", text);
            return { index, transcription: text };
          } catch {
            return { index, transcription: undefined };
          }
        }),
      );
      for (const r of asrResults) {
        if (r.status === "fulfilled" && r.value.transcription) {
          const ri = records.length - 1 - r.value.index;
          if (ri >= 0 && ri < records.length) {
            const newText = `(voice 🎤: "${r.value.transcription}")`;
            records[ri].text = newText;
            replaceMediaSegment(records[ri], newText);
          }
        }
      }
    }

    // ADR-97: диффузия цепочки ответов — идём по replyToId к цитируемым сообщениям за пределами окна
    const channelId = telegramChannelId(chatId);
    const diffused = diffuseReplyChain(records, channelId);
    if (diffused.length > 0) {
      const seedIds = new Set(records.map((r) => r.id));
      const unique = diffused.filter((d) => !seedIds.has(d.id));
      records = [...unique, ...records].sort((a, b) => a.date.getTime() - b.date.getTime());
    }

    // ADR-114 D2: диффузия mention — получаем непрочитанные mention и берём контекст вокруг них
    // Должно вызываться до markRead (markRead очищает статус непрочитанных mention)
    // @see docs/adr/114-context-assembly-rehabilitation.md — D2
    try {
      const mentionIds = await getUnreadMentionIds(client, chatId, 20);
      if (mentionIds.length > 0) {
        const existingIds = new Set(records.map((r) => r.id));
        const mentionContext: MessageRecord[] = [];

        for (const mentionMsgId of mentionIds) {
          if (mentionContext.length >= MENTION_DIFFUSION_BUDGET) break;
          if (existingIds.has(mentionMsgId)) {
            // Mention уже в окне — метка isMention из D5 покрывает его, дополнительная диффузия не нужна
            continue;
          }

          // Получаем из DB кластер сообщений ±radius
          const cluster = getMessageCluster(channelId, mentionMsgId, MENTION_CONTEXT_RADIUS);
          for (const row of cluster) {
            if (row.msgId != null && existingIds.has(row.msgId)) continue;
            if (row.msgId != null) existingIds.add(row.msgId);
            mentionContext.push({
              ...dbRecordToMessageRecord(row),
              isDiffused: undefined, // отличаем от диффузии reply chain
              isMentionContext: true,
            });
            if (mentionContext.length >= MENTION_DIFFUSION_BUDGET) break;
          }
        }

        if (mentionContext.length > 0) {
          records = [...mentionContext, ...records].sort(
            (a, b) => a.date.getTime() - b.date.getTime(),
          );
          log.debug("Mention diffusion", {
            mentionIds: mentionIds.length,
            diffusedMessages: mentionContext.length,
          });
        }
      }
    } catch (e) {
      // Сбой диффузии mention не должен блокировать получение сообщений — деградируем до метки isMention (резервный путь D5)
      log.warn("Mention diffusion failed, falling back to isMention flags", e);
    }

    // Авто-прочитано: fetchRecentMessages равнозначно «Алиса открыла чат»,
    // живой человек отмечал бы прочитанным сразу. Без отметки собеседник не увидит двойной галочки (read receipt).
    // ADR-114 D3: clearMentions одновременно сбрасывает счётчик непрочитанных mention
    markRead(client, chatId).catch(() => {});

    return records;
  } catch (e) {
    log.warn("Failed to fetch message history", e);
    return [];
  }
}

// ── ADR-97: контекст диффузии цепочки ответов ────────────────────────────────────────────
// @see docs/adr/97-reply-chain-diffusion-context.md

/** Максимальная глубина BFS-обхода. Цепочки в групповых чатах обычно 3-5 уровней; глубина 2 покрывает >90%. */
const DIFFUSION_MAX_DEPTH = 2;
/** Число соседних сообщений до и после каждого цитируемого. */
const DIFFUSION_CONTEXT_RADIUS = 1;
/** Общий лимит извлекаемых сообщений, защита от раздувания токенов. */
const DIFFUSION_BUDGET = 15;

// ADR-114 D2: Константы диффузии mention
/** Число соседних сообщений до и после mention-сообщения. На один уровень контекста больше, чем у reply chain. */
const MENTION_CONTEXT_RADIUS = 2;
/** Общий лимит сообщений при диффузии mention. */
const MENTION_DIFFUSION_BUDGET = 20;

/** Конвертация DB-записи → MessageRecord. В диффузированных сообщениях отсутствуют realtime-поля типа reactions. */
function dbRecordToMessageRecord(r: DbMessageRecord): MessageRecord {
  // ADR-119: text медиасообщений может быть null, помечаем плейсхолдером
  let text = r.text ?? "(no text)";
  if (!r.text && r.mediaType) {
    const labels: Record<string, string> = {
      sticker: "(sticker)",
      photo: "(photo 📷)",
      voice: "(voice 🎤)",
      audio: "(audio 🎵)",
      video: "(video 🎬)",
      document: "(document 📎)",
    };
    text = labels[r.mediaType] ?? `(${r.mediaType})`;
  }
  return {
    id: r.msgId ?? 0, // Telegram msgId начинается с 1; null → 0 обозначает запись без ID (инициативное сообщение Алисы)
    senderName: r.senderName ?? "Unknown",
    senderId: r.senderId ? Number(r.senderId.replace("contact:", "")) || undefined : undefined,
    isOutgoing: r.isOutgoing,
    text,
    date: r.createdAt,
    mediaType: r.mediaType ?? undefined,
    replyToId: r.replyToMsgId ?? undefined,
    isDiffused: true,
  };
}

/**
 * Диффузия цепочки ответов: BFS-расширение скользящего окна по рёбрам replyToId.
 *
 * За начальную точку берёт replyToId из seeds, выходящие за пределы окна, и извлекает из messageLog
 * цитируемые сообщения и их соседей ±radius, формируя «диффузионный кластер».
 *
 * @param seeds Исходные сообщения скользящего окна
 * @param chatId ID канала (в формате chatId из messageLog, например "channel:telegram:123")
 * @returns Диффузированные сообщения для вставки (отсортированы по времени, с isDiffused=true)
 */
export function diffuseReplyChain(seeds: MessageRecord[], chatId: string): MessageRecord[] {
  const seedIds = new Set(seeds.map((s) => s.id));
  const visited = new Set(seedIds);
  const diffused: MessageRecord[] = [];

  // Собираем из seeds сообщения, чей replyToId не входит в seeds → начальный frontier
  let frontier = new Set<number>();
  for (const seed of seeds) {
    if (seed.replyToId && !seedIds.has(seed.replyToId)) {
      frontier.add(seed.replyToId);
    }
  }

  for (let depth = 0; depth < DIFFUSION_MAX_DEPTH && frontier.size > 0; depth++) {
    const nextFrontier = new Set<number>();
    for (const targetMsgId of frontier) {
      if (diffused.length >= DIFFUSION_BUDGET) break;
      if (visited.has(targetMsgId)) continue;

      const cluster = getMessageCluster(chatId, targetMsgId, DIFFUSION_CONTEXT_RADIUS);
      for (const row of cluster) {
        if (row.msgId != null && visited.has(row.msgId)) continue;
        if (row.msgId != null) visited.add(row.msgId);
        diffused.push(dbRecordToMessageRecord(row));
        if (diffused.length >= DIFFUSION_BUDGET) break;

        // Рекурсия: связи ответов внутри кластера добавляются в следующий frontier
        if (row.replyToMsgId && !visited.has(row.replyToMsgId)) {
          nextFrontier.add(row.replyToMsgId);
        }
      }
    }
    frontier = nextFrontier;
  }

  // Сортируем по времени
  diffused.sort((a, b) => a.date.getTime() - b.date.getTime());
  return diffused;
}
