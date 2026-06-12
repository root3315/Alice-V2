/**
 * ADR-88: TTS 模块 — MiniMax 语音合成客户端。
 *
 * 后端：MiniMax /v1/t2a_v2
 * - 国内 api.minimaxi.com / 国际 api.minimax.io 均可
 * - emotion 参数：happy/sad/angry/fearful/disgusted/surprised/calm/fluent/whisper
 * - speech-2.8 支持语气标签：(laughs), (sighs), (coughs) 等（直接嵌入文本）
 *
 * 自然感处理：
 * - 通过 ffmpeg 在音频头尾随机拼接静音段，避免突然开始/结束的机械感
 * - 头部 0.15-0.6s，尾部 0.3-0.9s（模拟真人语音的自然呼吸间隔）
 *
 * ENV:
 *   TTS_BASE_URL  — MiniMax API 地址（空 = 禁用）
 *   TTS_API_KEY   — API 密钥（JWT 格式）
 *   TTS_MODEL     — 模型名称（如 speech-02-hd）
 *   TTS_VOICE     — 音色 ID
 *   TTS_GROUP_ID  — MiniMax Group ID
 *
 * @see docs/adr/88-multimodal-proactive-behavior.md §2.4
 * @see https://platform.minimaxi.com/docs/api-reference/speech-t2a-http
 */
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createLogger } from "../utils/logger.js";

const log = createLogger("tts");

/** TTS 配置子集——不依赖完整 Config 接口，便于 action-defs 传入。 */
export interface TTSConfig {
  ttsBaseUrl: string;
  ttsApiKey: string;
  ttsModel: string;
  ttsVoice: string;
  /** MiniMax Group ID。 */
  ttsGroupId?: string;
}

/** MiniMax 支持的情感值。 */
export type TTSEmotion =
  | "happy"
  | "sad"
  | "angry"
  | "fearful"
  | "disgusted"
  | "surprised"
  | "calm"
  | "fluent"
  | "whisper";

/**
 * 检查 TTS 是否已启用。
 */
export function isTTSEnabled(config: TTSConfig): boolean {
  return !!config.ttsBaseUrl && !!config.ttsApiKey;
}

/**
 * 将文本转为语音。
 *
 * 流程：MiniMax API 合成 → ffmpeg 头尾静音填充（自然感）。
 *
 * @param emotion 情感参数
 * @returns 音频 Buffer（OGG/Opus，Telegram voice message 格式），或 undefined（禁用/失败）
 */
export async function textToSpeech(
  text: string,
  config: TTSConfig,
  emotion?: TTSEmotion,
): Promise<Buffer | undefined> {
  if (!isTTSEnabled(config)) return undefined;
  if (!text.trim()) return undefined;

  try {
    const raw = await callMiniMaxAPI(text, config, emotion);
    if (!raw) return undefined;
    return await padSilence(raw);
  } catch (e) {
    log.warn("TTS failed", { error: e instanceof Error ? e.message : String(e) });
    return undefined;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// MiniMax /v1/t2a_v2
// ═══════════════════════════════════════════════════════════════════════════

async function callMiniMaxAPI(
  text: string,
  config: TTSConfig,
  emotion?: TTSEmotion,
): Promise<Buffer | undefined> {
  const baseUrl = config.ttsBaseUrl.replace(/\/$/, "");
  const groupId = config.ttsGroupId ?? "";

  const url = groupId ? `${baseUrl}/v1/t2a_v2?GroupId=${groupId}` : `${baseUrl}/v1/t2a_v2`;

  const body: Record<string, unknown> = {
    model: config.ttsModel || "speech-02-hd",
    text,
    stream: false,
    voice_setting: {
      voice_id: config.ttsVoice || "Calm_Woman",
      speed: 1,
      vol: 1,
      pitch: 0,
      ...(emotion && { emotion }),
    },
    audio_setting: {
      sample_rate: 32000,
      bitrate: 128000,
      format: "mp3",
      channel: 1,
    },
  };

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.ttsApiKey}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    log.warn("MiniMax TTS API error", { status: response.status, statusText: response.statusText });
    return undefined;
  }

  const result = (await response.json()) as {
    data?: { audio?: string; status?: number };
    base_resp?: { status_code?: number; status_msg?: string };
  };

  if (result.base_resp?.status_code !== 0) {
    log.warn("MiniMax TTS business error", { msg: result.base_resp?.status_msg });
    return undefined;
  }

  const audioHex = result.data?.audio;
  if (!audioHex) {
    log.warn("MiniMax TTS returned empty audio");
    return undefined;
  }

  const audioBuffer = Buffer.from(audioHex, "hex");
  log.info("TTS synthesized", {
    textLen: text.length,
    audioBytes: audioBuffer.byteLength,
    emotion: emotion ?? "auto",
  });
  return audioBuffer;
}

// ═══════════════════════════════════════════════════════════════════════════
// ffmpeg 静音填充 — 模拟真人语音的自然呼吸间隔
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 静音填充 + 转码为 OGG/Opus。
 *
 * 头部 0.15-0.6s（模拟开口前的短暂停顿），
 * 尾部 0.3-0.9s（模拟说完后的自然收尾）。
 *
 * 输入：MiniMax 返回的 MP3（32kHz/128kbps/mono）。
 * 输出：OGG/Opus（48kHz/mono）—— Telegram voice message 必须是此格式才显示波形条。
 *
 * 使用 ffmpeg concat filter 拼接三段（静音 + 语音 + 静音），
 * 同时完成 MP3 → OGG/Opus 转码。
 */
async function padSilence(audio: Buffer): Promise<Buffer> {
  const dir = mkdtempSync(join(tmpdir(), "alice-tts-"));
  const inputPath = join(dir, "in.mp3");
  const outputPath = join(dir, "out.ogg");

  try {
    writeFileSync(inputPath, audio);

    const headSec = (0.15 + Math.random() * 0.45).toFixed(2);
    const tailSec = (0.3 + Math.random() * 0.6).toFixed(2);

    await runFfmpeg([
      "-y",
      // 输入 0: 头部静音（48kHz 匹配 Opus 输出）
      "-f",
      "lavfi",
      "-t",
      headSec,
      "-i",
      "anullsrc=r=48000:cl=mono",
      // 输入 1: 语音（ffmpeg 自动重采样 32kHz → 48kHz）
      "-i",
      inputPath,
      // 输入 2: 尾部静音
      "-f",
      "lavfi",
      "-t",
      tailSec,
      "-i",
      "anullsrc=r=48000:cl=mono",
      // 拼接三段
      "-filter_complex",
      "[0:a][1:a][2:a]concat=n=3:v=0:a=1",
      // OGG/Opus 输出（Telegram voice message 格式要求）
      "-codec:a",
      "libopus",
      "-b:a",
      "48k",
      "-ar",
      "48000",
      "-ac",
      "1",
      "-application",
      "voip",
      outputPath,
    ]);

    const result = readFileSync(outputPath);
    log.debug("Silence padded + transcoded to OGG/Opus", {
      headSec,
      tailSec,
      beforeBytes: audio.byteLength,
      afterBytes: result.byteLength,
    });
    return result;
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ffmpeg 进程可能仍持有文件句柄（超时 kill 后不保证立即释放），
      // 临时文件泄漏比崩溃好——OS tmpdir 清理会最终回收。
    }
  }
}

/** 封装 ffmpeg 为 Promise。 */
function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile("ffmpeg", args, { timeout: 15_000 }, (err, _stdout, stderr) => {
      if (err) {
        log.warn("ffmpeg failed", { stderr: stderr.slice(0, 300) });
        reject(err);
      } else {
        resolve();
      }
    });
  });
}
