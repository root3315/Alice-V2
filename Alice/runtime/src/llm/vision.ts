/**
 * ADR-88: Модуль восприятия изображений/GIF/стикеров/видео.
 *
 * Архитектура:
 *   getVlmModel()       — создаёт VLM-провайдер Vercel AI SDK по запросу (lazy singleton)
 *   MEDIA_HANDLERS       — реестр prompt-определений для каждого типа медиа
 *   describeMedia()      — публичный API, маршрутизирует по mediaType; sticker идёт через generateObject
 *   getStickerAnalysis() — структурированный анализ стикера (побочный продукт describeMedia("sticker"))
 *
 * Принципы проектирования:
 *   - photo/gif/video: generateText() → strip markdown → description
 *   - sticker: generateObject() + Zod schema → description + StickerAnalysis (чтение и запись одновременно)
 *   - Фильтр безопасности содержимого → fallback WD Tagger → заглушка
 *   - Zod валидирует все внешние данные
 *
 * @see docs/adr/88-multimodal-proactive-behavior.md §2.2
 * @see https://github.com/LlmKira/wd14-tagger-server — WD Tagger сервис
 * @see https://github.com/TelechaBot/anime-identify — классификация аниме-изображений
 */
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateObject, generateText, type LanguageModel } from "ai";
import { z } from "zod";
import type { Config } from "../config.js";
import { createLogger } from "../utils/logger.js";
import { getCachedDescription, setCachedDescription } from "./media-cache.js";

const log = createLogger("vision");

// ═══════════════════════════════════════════════════════════════════════════
// Zod schemas — единственный источник истины для внешних данных
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Phase 2: Структурированный ответ VLM для стикеров.
 * Короткие имена полей (d/emo/act/int) экономят токены вывода VLM.
 * .describe() инжектирует описания JSON Schema → API принудительно применяет structured output.
 * Определение anime/text выполняется специализированной моделью (ONNX anime-identify + OCR), VLM отвечает только за семантику.
 */
const stickerVlmSchema = z.object({
  d: z.string().min(1).describe("What the sticker conveys, one sentence, plain text"),
  emo: z
    .enum(["happy", "sad", "angry", "surprised", "shy", "tired", "neutral", "love", "scared"])
    .describe("Primary emotion conveyed"),
  act: z
    .enum([
      "wave",
      "hug",
      "cry",
      "laugh",
      "sleep",
      "eat",
      "dance",
      "thumbsup",
      "facepalm",
      "peek",
      "none",
    ])
    .describe("Primary physical action shown"),
  int: z.enum(["gentle", "moderate", "intense"]).describe("Expression intensity"),
});

/** Phase 2: Результат семантического анализа стикера (публичный тип, выводится из VLM schema). */
export const stickerAnalysisSchema = z.object({
  description: z.string(),
  emotion: stickerVlmSchema.shape.emo,
  action: stickerVlmSchema.shape.act,
  intensity: stickerVlmSchema.shape.int,
});

export type StickerAnalysis = z.infer<typeof stickerAnalysisSchema>;

/** Ответ WD Tagger API. */
const wdTaggerResponseSchema = z.object({
  sorted_general_strings: z.string(),
  rating: z.object({
    general: z.number(),
    sensitive: z.number(),
    questionable: z.number(),
    explicit: z.number(),
  }),
  character_res: z.record(z.number()).optional(),
});

// ═══════════════════════════════════════════════════════════════════════════
// VLM Provider — Vercel AI SDK (lazy singleton)
// ═══════════════════════════════════════════════════════════════════════════

let _vlmModel: LanguageModel | null = null;
let _vlmConfigKey = "";
let _visionAuthDisabledKey = "";
let _visionAuthDisabledUntil = 0; // H11: time-bounded latch — транзиентный 401/403 не глушит vision навсегда

/**
 * Получает экземпляр языковой модели VLM.
 * Создаётся на основе visionBaseUrl + visionApiKey + visionModel, переиспользуется при неизменной конфигурации.
 */
function getVlmModel(config: Config): LanguageModel {
  const key = `${config.visionBaseUrl}|${config.visionApiKey}|${config.visionModel}`;
  if (_vlmModel && _vlmConfigKey === key) return _vlmModel;

  const provider = createOpenAICompatible({
    name: "vision",
    baseURL: config.visionBaseUrl,
    apiKey: config.visionApiKey,
    // Включаем режим json_schema → generateObject отправляет полную schema, API принудительно применяет structured output
    // @see https://github.com/vercel/ai/issues/5197
    supportsStructuredOutputs: true,
  });

  _vlmModel = provider(config.visionModel);
  _vlmConfigKey = key;
  return _vlmModel;
}

// ═══════════════════════════════════════════════════════════════════════════
// Входные ограждения
// ═══════════════════════════════════════════════════════════════════════════

type GuardResult = { ok: true } | { ok: false; reason: string; placeholder?: string };

/** Проверка размера base64 + обнаружение SVG/XML. */
function guardBase64(imageBase64: string): GuardResult {
  if (imageBase64.length < 2000) {
    return { ok: false, reason: "too small", placeholder: "(media too small)" };
  }
  // mtcute photoPathSize (type j) раздувается до <?xml><svg> outline
  const head = Buffer.from(imageBase64.slice(0, 8), "base64");
  if (head.length >= 2 && head[0] === 0x3c && (head[1] === 0x3f || head[1] === 0x73)) {
    return { ok: false, reason: "SVG/XML", placeholder: "(non-raster media)" };
  }
  return { ok: true };
}

// ═══════════════════════════════════════════════════════════════════════════
// Определения типов медиа — реестр prompt'ов
// ═══════════════════════════════════════════════════════════════════════════

const MEDIA_PROMPTS = {
  photo: {
    text: [
      "What is in this image? Be specific: mention any visible text, names, numbers, UI elements.",
      "If there is text or a screenshot, prioritize summarizing the text content.",
      "Be concise but keep important details. DO NOT start with 'This image' or 'The image'.",
    ].join(" "),
    maxTokens: 150,
  },
  gif: {
    text: "What emotion or action does this GIF convey? Be brief but specific.",
    maxTokens: 60,
  },
  video: {
    text: "What is happening in this video? Mention key details (people, scene, action). DO NOT start with 'This' or 'The'.",
    maxTokens: 100,
  },
  sticker: {
    text: "Analyze this chat sticker: describe the emotion, expression, and action it conveys.",
    maxTokens: 120,
  },
} as const;

export type MediaType = keyof typeof MEDIA_PROMPTS;

// ═══════════════════════════════════════════════════════════════════════════
// WD14 Tagger Fallback
// ═══════════════════════════════════════════════════════════════════════════

/** Fallback при срабатывании фильтра безопасности VLM — восприятие содержимого изображения через теги. */
async function describeWithTagger(
  imageBase64: string,
  taggerUrl: string,
): Promise<string | undefined> {
  try {
    const imageBuffer = Buffer.from(imageBase64, "base64");
    const boundary = `----WdTagger${Date.now()}`;
    const header = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="image.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`,
    );
    const footer = Buffer.from(`\r\n--${boundary}--\r\n`);

    const url = `${taggerUrl.replace(/\/$/, "")}/upload?general_threshold=0.35&character_threshold=0.85`;
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
      body: Buffer.concat([header, imageBuffer, footer]),
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) return undefined;

    const result = wdTaggerResponseSchema.safeParse(await resp.json());
    if (!result.success) return undefined;

    const { sorted_general_strings: tags, rating, character_res } = result.data;
    const topRating = (Object.entries(rating) as [string, number][]).sort(
      (a, b) => b[1] - a[1],
    )[0][0];
    const characters = Object.entries(character_res ?? {})
      .filter(([, score]) => score > 0.5)
      .map(([name]) => name);

    const parts: string[] = [];
    if (characters.length > 0) parts.push(`Characters: ${characters.join(", ")}.`);
    const cappedTags = tags.length > 200 ? `${tags.slice(0, 200)}...` : tags;
    parts.push(`Tags: ${cappedTags}.`);
    parts.push(`Content rating: ${topRating}.`);
    return parts.join(" ");
  } catch (e) {
    log.warn("WD Tagger failed", { error: e instanceof Error ? e.message : String(e) });
    return undefined;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Постобработка
// ═══════════════════════════════════════════════════════════════════════════

/** Удаление markdown + приведение к одной строке (свободный текстовый вывод VLM инжектируется в IRC-формат). */
function stripMarkdown(raw: string): string {
  return raw
    .replace(/\*{1,2}([^*]+)\*{1,2}/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^[-•]\s*/gm, "")
    .replace(/\n+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** Обнаружение срабатывания фильтра безопасности содержимого — охватывает различные формы отказов провайдеров Gemini / OpenAI и др. */
function isContentFilterError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /safety|blocked|filter|content_policy|prompt_blocked|RECITATION/i.test(msg);
}

function isAuthFailure(e: unknown): boolean {
  if (e == null || typeof e !== "object") {
    return /unauthorized|forbidden/i.test(String(e));
  }
  const obj = e as Record<string, unknown>;
  const status = obj.statusCode ?? obj.status;
  if (status === 401 || status === 403) return true;
  if (obj.cause && isAuthFailure(obj.cause)) return true;
  return /unauthorized|forbidden/i.test(e instanceof Error ? e.message : String(e));
}

// ═══════════════════════════════════════════════════════════════════════════
// Кеш структурированного анализа стикеров — побочный продукт describeMedia("sticker")
// ═══════════════════════════════════════════════════════════════════════════

const _stickerAnalysisCache = new Map<string, StickerAnalysis>();

/**
 * Читает структурированный семантический анализ стикера.
 *
 * Доступно после вызова describeMedia(base64, uid, "sticker", config).
 * Жизненный цикл: память процесса (не персистируется, после перезапуска анализируется заново).
 */
export function getStickerAnalysis(fileUniqueId: string): StickerAnalysis | undefined {
  const analysis = _stickerAnalysisCache.get(fileUniqueId);
  if (analysis) _stickerAnalysisCache.delete(fileUniqueId);
  return analysis;
}

// ═══════════════════════════════════════════════════════════════════════════
// Публичный API
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Единая точка входа для описания медиа — маршрутизирует по mediaType.
 *
 * | Тип     | SDK-функция       | Постобработка           |
 * |---------|-------------------|-------------------------|
 * | photo   | generateText()    | stripMarkdown           |
 * | gif     | generateText()    | stripMarkdown           |
 * | video   | generateText()    | stripMarkdown           |
 * | sticker | generateObject()  | Zod структурирование + кеш |
 *
 * **sticker "чтение и запись одновременно"**:
 * - generateObject() + stickerVlmSchema → API принудительно применяет structured output
 * - description возвращается вызывающей стороне (для восприятия)
 * - StickerAnalysis кешируется в памяти → читается через getStickerAnalysis() (для записи в палитру)
 *
 * Fallback: фильтр безопасности содержимого → WD Tagger → заглушка.
 *
 * @returns Описание на естественном языке или undefined (отключено/ошибка)
 */
export async function describeMedia(
  imageBase64: string,
  fileUniqueId: string,
  mediaType: MediaType,
  config: Config,
): Promise<string | undefined> {
  if (!config.visionModel) return undefined;

  const visionConfigKey = `${config.visionBaseUrl}|${config.visionApiKey}|${config.visionModel}`;
  if (_visionAuthDisabledKey === visionConfigKey && Date.now() < _visionAuthDisabledUntil) {
    log.debug("Vision skipped: provider auth disabled (cooling down)", { mediaType });
    return undefined;
  }

  // Попадание в кеш
  const cached = getCachedDescription(fileUniqueId);
  if (cached) {
    log.debug("Vision cache hit", { fileUniqueId, mediaType });
    return cached;
  }

  // Входное ограждение
  const guard = guardBase64(imageBase64);
  if (!guard.ok) {
    log.warn(`Vision skipped: ${guard.reason}`, { fileUniqueId, mediaType });
    if (guard.placeholder) setCachedDescription(fileUniqueId, mediaType, guard.placeholder);
    return undefined;
  }

  const prompt = MEDIA_PROMPTS[mediaType];
  const model = getVlmModel(config);
  const imageBuffer = Buffer.from(imageBase64, "base64");

  try {
    let description: string;

    if (mediaType === "sticker") {
      // ── Структурированный путь: generateObject → Zod проверка → description + analysis ──
      const { object } = await generateObject({
        model,
        schema: stickerVlmSchema,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: prompt.text },
              { type: "image", image: imageBuffer },
            ],
          },
        ],
        maxOutputTokens: prompt.maxTokens,
        // 25s: нативное зрение Claude через прокси ~5-9с, под нагрузкой бывает дольше.
        abortSignal: AbortSignal.timeout(25_000),
      });

      description = stripMarkdown(object.d);
      const analysis: StickerAnalysis = {
        description,
        emotion: object.emo,
        action: object.act,
        intensity: object.int,
      };
      _stickerAnalysisCache.set(fileUniqueId, analysis);
      log.info("Sticker analyzed", {
        fileUniqueId,
        emotion: analysis.emotion,
        action: analysis.action,
        description: description.slice(0, 60),
      });
    } else {
      // ── Путь свободного текста: generateText → stripMarkdown ──
      const { text } = await generateText({
        model,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: prompt.text },
              { type: "image", image: imageBuffer },
            ],
          },
        ],
        maxOutputTokens: prompt.maxTokens,
        // 22s: нативное зрение Claude через прокси ~5-9с, под нагрузкой бывает дольше.
        abortSignal: AbortSignal.timeout(22_000),
      });

      description = stripMarkdown(text);
      log.info("Media described", { fileUniqueId, mediaType, caption: description.slice(0, 60) });
    }

    if (!description) return undefined;
    _visionAuthDisabledUntil = 0; // успех → снять кулдаун немедленно (H11)
    setCachedDescription(fileUniqueId, mediaType, description);
    return description;
  } catch (e) {
    if (isAuthFailure(e)) {
      _visionAuthDisabledKey = visionConfigKey;
      _visionAuthDisabledUntil = Date.now() + 5 * 60_000; // повтор через 5 мин, не навсегда (H11)
      log.warn("Vision disabled (5 min) after provider auth failure", {
        mediaType,
        error: e instanceof Error ? e.message : String(e),
      });
      return undefined;
    }

    // Фильтр безопасности содержимого → fallback WD Tagger
    if (isContentFilterError(e)) {
      log.info("Vision content filtered, trying WD Tagger fallback", { fileUniqueId, mediaType });
      const taggerResult = config.wdTaggerUrl
        ? await describeWithTagger(imageBase64, config.wdTaggerUrl)
        : undefined;
      if (taggerResult) {
        setCachedDescription(fileUniqueId, mediaType, taggerResult);
        return taggerResult;
      }
      const placeholder = "(image present but content not visible)";
      setCachedDescription(fileUniqueId, mediaType, placeholder);
      return placeholder;
    }

    log.warn("Vision API call failed", {
      mediaType,
      error: e instanceof Error ? e.message : String(e),
    });
    return undefined;
  }
}

/** Получает кешированное описание изображения (экспорт для обратной совместимости). */
export function getCachedCaption(fileUniqueId: string): string | undefined {
  return getCachedDescription(fileUniqueId);
}

/** Проверяет, включён ли Vision. */
export function isVisionEnabled(config: Config): boolean {
  return !!config.visionModel;
}

/**
 * Вызывает микросервис AnimeIDF для определения, является ли изображение аниме/иллюстрацией.
 * При недоступности сервиса деградирует до true (все проходят, запись в БД не блокируется).
 * @see docs/adr/153-sticker-palette-phase3-group-learning.md §D2
 */
export async function isAnimeSticker(buffer: Buffer, config: Config): Promise<boolean> {
  if (!config.animeClassifyUrl) return true; // Не настроено → деградация: все проходят
  try {
    const boundary = `----AnimeIDF${Date.now()}`;
    const header = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="sticker.webp"\r\nContent-Type: image/webp\r\n\r\n`,
    );
    const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
    const resp = await fetch(`${config.animeClassifyUrl.replace(/\/$/, "")}/classify`, {
      method: "POST",
      headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
      body: Buffer.concat([header, buffer, footer]),
      signal: AbortSignal.timeout(5_000),
    });
    if (!resp.ok) return true; // Ошибка сервиса → деградация
    const result = z.object({ anime: z.boolean() }).safeParse(await resp.json());
    return result.success ? result.data.anime : true;
  } catch {
    return true; // Таймаут/сетевая ошибка → деградация
  }
}
