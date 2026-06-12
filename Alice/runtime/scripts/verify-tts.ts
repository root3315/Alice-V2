/**
 * TTS（MiniMax）验证脚本。
 *
 * 用法：
 *   cd runtime && npx tsx scripts/verify-tts.ts
 *   cd runtime && npx tsx scripts/verify-tts.ts "自定义文本" calm
 *   cd runtime && npx tsx scripts/verify-tts.ts "开心！" happy
 *
 * 从 .env 读取 TTS_BASE_URL / TTS_API_KEY / TTS_MODEL / TTS_VOICE / TTS_GROUP_ID。
 * 生成音频保存到 /tmp/alice-tts-test.ogg（OGG/Opus），可用 mpv 播放。
 * 含 ffmpeg 静音填充（与 runtime 行为一致）。
 *
 * 支持的 emotion：
 *   happy, sad, angry, fearful, disgusted, surprised, calm, fluent, whisper
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

// 手动加载 .env（脚本直接跑，不经过 pm2/dotenv 注入）
try {
  const envPath = resolve(import.meta.dirname, "../.env");
  for (const line of readFileSync(envPath, "utf-8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq === -1) continue;
    const key = t.slice(0, eq);
    if (!process.env[key]) process.env[key] = t.slice(eq + 1);
  }
} catch {}

import { loadConfig } from "../src/config.js";
import { type TTSEmotion, textToSpeech } from "../src/llm/tts.js";

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

async function main() {
  const text = process.argv[2] || "你好呀～今天心情怎么样？";
  const emotionArg = process.argv[3];
  const emotion =
    emotionArg && VALID_EMOTIONS.has(emotionArg) ? (emotionArg as TTSEmotion) : undefined;

  const config = loadConfig();
  const ttsConfig = {
    ttsBaseUrl: config.ttsBaseUrl,
    ttsApiKey: config.ttsApiKey,
    ttsModel: config.ttsModel,
    ttsVoice: config.ttsVoice,
    ttsGroupId: config.ttsGroupId,
  };

  const mask = (s: string) => (s ? `${s.slice(0, 8)}...` : "(empty)");
  console.log("=== TTS 验证（MiniMax）===");
  console.log(`  BASE_URL:  ${ttsConfig.ttsBaseUrl}`);
  console.log(`  MODEL:     ${ttsConfig.ttsModel}`);
  console.log(`  VOICE:     ${ttsConfig.ttsVoice}`);
  console.log(`  GROUP_ID:  ${ttsConfig.ttsGroupId || "(empty)"}`);
  console.log(`  API_KEY:   ${mask(ttsConfig.ttsApiKey)}`);
  console.log(`  Text:      "${text}"`);
  console.log(`  Emotion:   ${emotion ?? "(auto)"}`);
  console.log();

  if (!ttsConfig.ttsBaseUrl || !ttsConfig.ttsApiKey) {
    console.error("ERROR: TTS_BASE_URL 或 TTS_API_KEY 未配置。请检查 .env");
    process.exit(1);
  }

  console.log("合成中...");
  const start = Date.now();
  const buf = await textToSpeech(text, ttsConfig, emotion);
  const elapsed = Date.now() - start;

  if (!buf) {
    console.error("\n✗ TTS 生成失败（返回 undefined）。查看上方日志排查原因。");
    process.exit(1);
  }

  const outPath = "/tmp/alice-tts-test.ogg";
  writeFileSync(outPath, buf);

  console.log(`\n✓ TTS 验证通过`);
  console.log(`  耗时:       ${elapsed}ms`);
  console.log(`  音频大小:   ${buf.byteLength} bytes`);
  console.log(`  输出:       ${outPath}`);
  console.log(`  播放:       mpv ${outPath}`);
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
