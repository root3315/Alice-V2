/**
 * ADR-119: модуль ASR — распознавание речи, совместимое с OpenAI Whisper.
 *
 * Бэкенд: любой API, совместимый с OpenAI /audio/transcriptions (OpenAI, Groq, Azure, local Whisper).
 * Вход: аудио OGG/Opus (исходный формат голосовых сообщений Telegram).
 * Выход: транскрибированный текст.
 *
 * @see docs/adr/119-multimodal-perception-completion.md
 */
import { createLogger } from "../utils/logger.js";

const log = createLogger("asr");

export interface ASRConfig {
  asrBaseUrl: string; // пусто = отключено
  asrApiKey: string;
  asrModel: string; // default: "whisper-1"
}

export function isASREnabled(config: ASRConfig): boolean {
  return !!config.asrBaseUrl && !!config.asrApiKey;
}

/** Максимальный размер файла: 10 МБ (лимит Whisper — 25 МБ; запас для безопасности). */
const MAX_AUDIO_SIZE = 10_485_760;

/**
 * Преобразование речи в текст.
 *
 * @param audioBuffer аудио OGG/Opus (исходный формат голосовых сообщений Telegram)
 * @param config конфигурация ASR
 * @returns транскрибированный текст или undefined (отключено/ошибка)
 */
export async function transcribeVoice(
  audioBuffer: Buffer,
  config: ASRConfig,
): Promise<string | undefined> {
  if (!isASREnabled(config)) return undefined;
  if (audioBuffer.byteLength === 0) return undefined;
  if (audioBuffer.byteLength > MAX_AUDIO_SIZE) return undefined;

  const baseUrl = config.asrBaseUrl.replace(/\/$/, "");
  // Конвертируем Buffer в копию ArrayBuffer, чтобы избежать проблем совместимости типов SharedArrayBuffer
  const ab = audioBuffer.buffer.slice(
    audioBuffer.byteOffset,
    audioBuffer.byteOffset + audioBuffer.byteLength,
  ) as ArrayBuffer;
  const formData = new FormData();
  formData.append("file", new Blob([ab], { type: "audio/ogg" }), "voice.ogg");
  formData.append("model", config.asrModel || "whisper-1");

  try {
    const response = await fetch(`${baseUrl}/audio/transcriptions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.asrApiKey}` },
      body: formData,
      signal: AbortSignal.timeout(60_000), // 60s: локальный whisper large-v3 на CPU медленнее, но идёт фоном
    });

    if (!response.ok) {
      log.warn("ASR API error", { status: response.status, statusText: response.statusText });
      return undefined;
    }

    const data = (await response.json()) as { text?: string };
    const text = data.text?.trim();
    if (text) {
      log.info("Voice transcribed", { length: text.length, preview: text.slice(0, 60) });
    }
    return text || undefined;
  } catch (e) {
    log.warn("ASR API call failed", { error: e instanceof Error ? e.message : String(e) });
    return undefined;
  }
}
