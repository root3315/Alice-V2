/**
 * Клиент удалённого Skill Store.
 *
 * Поиск, загрузка и публикация пакетов Skill через HTTP API.
 * URL Store задаётся переменной окружения ALICE_STORE_URL.
 *
 * Протокол:
 *   GET  /api/v1/skills?query=...    поиск/список
 *   GET  /api/v1/skills/:name        получить manifest + метаинформацию
 *   GET  /api/v1/skills/:name/archive  скачать tarball
 *   POST /api/v1/skills              публикация (требует ALICE_STORE_TOKEN)
 *
 * @see docs/adr/201-os-for-llm.md
 */

import { createHash } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createLogger } from "../utils/logger.js";

const log = createLogger("remote-store");

/** Краткая информация о Skill в удалённом Store. */
export interface RemoteSkillSummary {
  name: string;
  version: string;
  description: string;
  whenToUse: string;
  hash: string;
}

/** Подробная информация о Skill в удалённом Store. */
export interface RemoteSkillInfo {
  name: string;
  version: string;
  description: string;
  hash: string;
  manifest: Record<string, unknown>;
}

/** Получить URL удалённого Store (null = не настроен). */
export function getRemoteStoreUrl(): string | null {
  const url = process.env.ALICE_STORE_URL?.trim();
  return url || null;
}

/** Получить токен аутентификации удалённого Store (для публикации). */
export function getRemoteStoreToken(): string | null {
  const token = process.env.ALICE_STORE_TOKEN?.trim();
  return token || null;
}

/**
 * Поиск в удалённом Skill Store.
 *
 * @returns Список подходящих Skill или null (Store недоступен)
 */
export async function searchRemoteStore(query?: string): Promise<RemoteSkillSummary[] | null> {
  const storeUrl = getRemoteStoreUrl();
  if (!storeUrl) return null;

  const url = new URL("/api/v1/skills", storeUrl);
  if (query) url.searchParams.set("query", query);

  try {
    const resp = await fetch(url.toString(), {
      signal: AbortSignal.timeout(10_000),
      headers: { Accept: "application/json" },
    });
    if (!resp.ok) {
      log.warn("Remote store search failed", { status: resp.status });
      return null;
    }
    const data = (await resp.json()) as { skills: RemoteSkillSummary[] };
    return data.skills ?? [];
  } catch (e) {
    log.warn("Remote store unreachable", {
      error: e instanceof Error ? e.message : String(e),
    });
    return null;
  }
}

/**
 * Получить подробную информацию об удалённом Skill.
 */
export async function getRemoteSkillInfo(name: string): Promise<RemoteSkillInfo | null> {
  const storeUrl = getRemoteStoreUrl();
  if (!storeUrl) return null;

  const url = new URL(`/api/v1/skills/${encodeURIComponent(name)}`, storeUrl);

  try {
    const resp = await fetch(url.toString(), {
      signal: AbortSignal.timeout(10_000),
      headers: { Accept: "application/json" },
    });
    if (!resp.ok) return null;
    return (await resp.json()) as RemoteSkillInfo;
  } catch {
    return null;
  }
}

/**
 * Загрузить пакет Skill из удалённого Store в локальный каталог.
 *
 * После загрузки проверяет SHA256 hash. При несоответствии — удаляет файл и бросает ошибку.
 *
 * @param name Имя Skill
 * @param targetDir Целевой каталог загрузки
 * @param expectedHash Ожидаемый hash (поле hash из результатов поиска)
 * @returns Путь к загруженному tarball
 */
export async function downloadSkillArchive(
  name: string,
  targetDir: string,
  expectedHash?: string,
): Promise<string> {
  const storeUrl = getRemoteStoreUrl();
  if (!storeUrl) throw new Error("ALICE_STORE_URL not configured");

  const url = new URL(`/api/v1/skills/${encodeURIComponent(name)}/archive`, storeUrl);

  const resp = await fetch(url.toString(), {
    signal: AbortSignal.timeout(60_000),
  });

  if (!resp.ok) {
    throw new Error(`Failed to download ${name}: HTTP ${resp.status} ${resp.statusText}`);
  }

  if (!resp.body) {
    throw new Error(`Failed to download ${name}: empty body`);
  }

  mkdirSync(targetDir, { recursive: true });
  const archivePath = join(targetDir, `${name}.tar.gz`);
  const fileStream = createWriteStream(archivePath);
  const hasher = createHash("sha256");

  // Web ReadableStream → Node Readable (fetch().body является Web API ReadableStream)
  const nodeStream = Readable.fromWeb(resp.body as import("node:stream/web").ReadableStream);

  // pipeline автоматически обрабатывает обратное давление и распространение ошибок
  await pipeline(
    nodeStream,
    async function* (source) {
      for await (const chunk of source) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
        hasher.update(buf);
        yield buf;
      }
    },
    fileStream,
  );

  // Проверить hash
  const actualHash = hasher.digest("hex").slice(0, 16);
  if (expectedHash && actualHash !== expectedHash) {
    rmSync(archivePath, { force: true });
    throw new Error(`Hash mismatch for ${name}: expected ${expectedHash}, got ${actualHash}`);
  }

  log.info("Downloaded skill archive", { name, hash: actualHash, archivePath });
  return archivePath;
}

/**
 * Опубликовать Skill в удалённом Store.
 *
 * @param archivePath Путь к tarball
 * @param manifest Данные manifest Skill
 * @returns Hash опубликованного пакета
 */
export async function publishToRemoteStore(
  archivePath: string,
  manifest: Record<string, unknown>,
): Promise<string> {
  const storeUrl = getRemoteStoreUrl();
  if (!storeUrl) throw new Error("ALICE_STORE_URL not configured");

  const token = getRemoteStoreToken();
  if (!token) throw new Error("ALICE_STORE_TOKEN not configured");

  const archiveData = readFileSync(archivePath);
  const hash = createHash("sha256").update(archiveData).digest("hex").slice(0, 16);

  const url = new URL("/api/v1/skills", storeUrl);
  const resp = await fetch(url.toString(), {
    method: "POST",
    signal: AbortSignal.timeout(60_000),
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      manifest,
      hash,
      archiveBase64: archiveData.toString("base64"),
    }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Publish failed: HTTP ${resp.status} — ${body}`);
  }

  return hash;
}

/**
 * Загрузить Skill из удалённого Store и распаковать в локальный каталог skills/.
 *
 * Возвращает путь к распакованному manifest.yaml, который можно сразу передать в installSkill().
 * При ошибке загрузки или несоответствии hash — бросает ошибку.
 *
 * @param name Имя Skill
 * @param skillsRoot Локальный корневой каталог skills/
 * @returns Абсолютный путь к manifest.yaml
 */
export async function downloadAndExtractRemoteSkill(
  name: string,
  skillsRoot: string,
): Promise<string> {
  // Сначала запросить удалённую информацию для получения hash
  const info = await getRemoteSkillInfo(name);
  if (!info) {
    throw new Error(`Skill "${name}" not found in remote Store`);
  }

  const { tmpdir } = await import("node:os");
  const { execFileSync } = await import("node:child_process");

  const tmpDir = resolve(tmpdir(), `alice-pkg-download-${Date.now()}`);
  mkdirSync(tmpDir, { recursive: true });

  try {
    // Скачать tarball (с проверкой hash)
    const archivePath = await downloadSkillArchive(name, tmpDir, info.hash);

    // Распаковать в skills/<name>/
    const extractDir = resolve(skillsRoot, name);
    mkdirSync(extractDir, { recursive: true });
    execFileSync("tar", ["-xzf", archivePath, "-C", extractDir], { timeout: 30_000 });

    const manifestPath = resolve(extractDir, "manifest.yaml");
    if (!existsSync(manifestPath)) {
      throw new Error(`Downloaded package for "${name}" has no manifest.yaml`);
    }

    log.info("Downloaded and extracted remote skill", { name, hash: info.hash });
    return manifestPath;
  } finally {
    // Очистить временный каталог загрузки
    rmSync(tmpDir, { recursive: true, force: true });
  }
}
