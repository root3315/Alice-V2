/**
 * Фото → короткое квадратное mp4 для Telegram video note («кружок») через ffmpeg.
 *
 * Video note обязан быть КВАДРАТНЫМ; делаем статичный «кружок» из картинки (N секунд, без звука,
 * yuv420p для совместимости). Требует ffmpeg на PATH (или FFMPEG_PATH). Работает на стороне движка.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";

/** Сторона квадрата и длительность кружка по умолчанию. */
export const ROUND_VIDEO_SIZE = 384;
export const ROUND_VIDEO_SECONDS = 5;

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(FFMPEG, args, { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    proc.stderr?.on("data", (d) => {
      err += String(d);
    });
    proc.on("error", reject);
    proc.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}: ${err.slice(-200)}`)),
    );
  });
}

/**
 * Статичный квадратный mp4 (video note) из картинки: seconds сек, size×size, без звука.
 * Бросает при отсутствии ffmpeg/ошибке — вызывающий ловит и берёт другого кандидата.
 */
export async function imageToRoundVideo(
  image: Buffer,
  seconds = ROUND_VIDEO_SECONDS,
  size = ROUND_VIDEO_SIZE,
): Promise<Buffer> {
  const dir = mkdtempSync(join(tmpdir(), "alice-circle-"));
  const inPath = join(dir, "in.img");
  const outPath = join(dir, "out.mp4");
  writeFileSync(inPath, image);
  try {
    await runFfmpeg([
      "-y",
      "-loop",
      "1",
      "-i",
      inPath,
      "-t",
      String(seconds),
      // crop смещён к ВЕРХУ (≈15% сверху): у портретов лицо вверху, центр-кроп его срезал бы.
      "-vf",
      `scale=${size}:${size}:force_original_aspect_ratio=increase,crop=${size}:${size}:(iw-${size})/2:(ih-${size})*0.15,format=yuv420p`,
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-movflags",
      "+faststart",
      "-an",
      outPath,
    ]);
    return readFileSync(outPath);
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // очистка best-effort
    }
  }
}
