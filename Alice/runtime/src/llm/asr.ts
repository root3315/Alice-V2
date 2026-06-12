/**
 * ADR-119: ASR 模块 — OpenAI Whisper-compatible 语音识别。
 *
 * 后端：任何 OpenAI /audio/transcriptions 兼容的 API（OpenAI, Groq, Azure, local Whisper）。
 * 输入：OGG/Opus 音频（Telegram voice message 原始格式）。
 * 输出：转写文本。
 *
 * @see docs/adr/119-multimodal-perception-completion.md
 */
import { createLogger } from "../utils/logger.js";

const log = createLogger("asr");

export interface ASRConfig {
  asrBaseUrl: string; // 空 = 禁用
  asrApiKey: string;
  asrModel: string; // default: "whisper-1"
}

export function isASREnabled(config: ASRConfig): boolean {
  return !!config.asrBaseUrl && !!config.asrApiKey;
}

/** 文件大小上限：10MB（Whisper 限制 25MB，预留安全余量）。 */
const MAX_AUDIO_SIZE = 10_485_760;

/**
 * 语音转文字。
 *
 * @param audioBuffer OGG/Opus 音频（Telegram voice message 原始格式）
 * @param config ASR 配置
 * @returns 转写文本，或 undefined（禁用/失败）
 */
export async function transcribeVoice(
  audioBuffer: Buffer,
  config: ASRConfig,
): Promise<string | undefined> {
  if (!isASREnabled(config)) return undefined;
  if (audioBuffer.byteLength === 0) return undefined;
  if (audioBuffer.byteLength > MAX_AUDIO_SIZE) return undefined;

  const baseUrl = config.asrBaseUrl.replace(/\/$/, "");
  // 将 Buffer 转为 ArrayBuffer 副本，避免 SharedArrayBuffer 类型兼容问题
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
