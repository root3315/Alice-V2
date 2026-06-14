/**
 * ADR-88: TTS-модуль — клиент синтеза речи MiniMax.
 *
 * Бэкенд: MiniMax /v1/t2a_v2
 * - Работают оба: китайский api.minimaxi.com / международный api.minimax.io
 * - Параметр emotion: happy/sad/angry/fearful/disgusted/surprised/calm/fluent/whisper
 * - speech-2.8 поддерживает теги интонации: (laughs), (sighs), (coughs) и т.д. (встраиваются прямо в текст)
 *
 * Обработка естественности:
 * - С помощью ffmpeg случайные фрагменты тишины добавляются в начало и конец аудио, чтобы избежать механического старта/финиша
 * - Начало 0.15–0.6 с, конец 0.3–0.9 с (имитация естественных дыхательных пауз живого голоса)
 *
 * ENV:
 *   TTS_BASE_URL  — адрес MiniMax API (пусто = отключено)
 *   TTS_API_KEY   — API-ключ (формат JWT)
 *   TTS_MODEL     — название модели (например speech-02-hd)
 *   TTS_VOICE     — ID тембра
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

/** Подмножество конфигурации TTS — не зависит от полного интерфейса Config, удобно для передачи из action-defs. */
export interface TTSConfig {
  ttsBaseUrl: string;
  ttsApiKey: string;
  ttsModel: string;
  ttsVoice: string;
  /** MiniMax Group ID. */
  ttsGroupId?: string;
}

/** Поддерживаемые MiniMax значения эмоций. */
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
 * Проверяет, включён ли TTS.
 */
export function isTTSEnabled(config: TTSConfig): boolean {
  return !!config.ttsBaseUrl && !!config.ttsApiKey;
}

/**
 * Преобразует текст в речь.
 *
 * Процесс: синтез через MiniMax API → добавление тишины в начало/конец через ffmpeg (естественность).
 *
 * @param emotion параметр эмоции
 * @returns аудио Buffer (OGG/Opus, формат Telegram voice message) или undefined (отключено/ошибка)
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
// ffmpeg добавление тишины — имитация естественных дыхательных пауз живого голоса
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Добавление тишины + перекодирование в OGG/Opus.
 *
 * Начало 0.15–0.6 с (имитация короткой паузы перед началом речи),
 * конец 0.3–0.9 с (имитация естественного завершения после речи).
 *
 * Вход: MP3 от MiniMax (32 кГц/128 кбит/с/моно).
 * Выход: OGG/Opus (48 кГц/моно) — Telegram voice message требует именно этот формат для отображения волновой полосы.
 *
 * Использует ffmpeg concat filter для склейки трёх фрагментов (тишина + речь + тишина),
 * одновременно выполняя перекодирование MP3 → OGG/Opus.
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
      // вход 0: тишина в начале (48 кГц соответствует выходу Opus)
      "-f",
      "lavfi",
      "-t",
      headSec,
      "-i",
      "anullsrc=r=48000:cl=mono",
      // вход 1: речь (ffmpeg автоматически ресемплирует 32 кГц → 48 кГц)
      "-i",
      inputPath,
      // вход 2: тишина в конце
      "-f",
      "lavfi",
      "-t",
      tailSec,
      "-i",
      "anullsrc=r=48000:cl=mono",
      // склеить три фрагмента
      "-filter_complex",
      "[0:a][1:a][2:a]concat=n=3:v=0:a=1",
      // вывод OGG/Opus (требование формата Telegram voice message)
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
      // процесс ffmpeg может ещё держать файловый дескриптор (после kill по таймауту немедленный отпуск не гарантирован),
      // утечка временных файлов лучше краша — очистка OS tmpdir в конечном счёте их соберёт.
    }
  }
}

/** Оборачивает ffmpeg в Promise. */
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
