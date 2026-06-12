/**
 * 远程 Skill Store 客户端。
 *
 * 通过 HTTP API 搜索、下载和发布 Skill 包。
 * Store URL 通过 ALICE_STORE_URL 环境变量配置。
 *
 * 协议：
 *   GET  /api/v1/skills?query=...    搜索/列出
 *   GET  /api/v1/skills/:name        获取 manifest + 元信息
 *   GET  /api/v1/skills/:name/archive  下载 tarball
 *   POST /api/v1/skills              发布（需要 ALICE_STORE_TOKEN）
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

/** 远程 Store 的 Skill 摘要。 */
export interface RemoteSkillSummary {
  name: string;
  version: string;
  description: string;
  whenToUse: string;
  hash: string;
}

/** 远程 Store 的 Skill 详情。 */
export interface RemoteSkillInfo {
  name: string;
  version: string;
  description: string;
  hash: string;
  manifest: Record<string, unknown>;
}

/** 获取远程 Store URL（null = 未配置）。 */
export function getRemoteStoreUrl(): string | null {
  const url = process.env.ALICE_STORE_URL?.trim();
  return url || null;
}

/** 获取远程 Store 认证 token（发布用）。 */
export function getRemoteStoreToken(): string | null {
  const token = process.env.ALICE_STORE_TOKEN?.trim();
  return token || null;
}

/**
 * 搜索远程 Skill Store。
 *
 * @returns 匹配的 Skill 列表，或 null（Store 不可用）
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
 * 获取远程 Skill 详情。
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
 * 从远程 Store 下载 Skill 包到本地目录。
 *
 * 下载后校验 SHA256 hash。校验失败则删除下载文件并抛错。
 *
 * @param name Skill 名称
 * @param targetDir 下载目标目录
 * @param expectedHash 预期 hash（来自搜索结果的 hash 字段）
 * @returns 下载的 tarball 路径
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

  // Web ReadableStream → Node Readable（fetch().body 是 Web API 的 ReadableStream）
  const nodeStream = Readable.fromWeb(resp.body as import("node:stream/web").ReadableStream);

  // pipeline 自动处理背压和错误传播
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

  // 校验 hash
  const actualHash = hasher.digest("hex").slice(0, 16);
  if (expectedHash && actualHash !== expectedHash) {
    rmSync(archivePath, { force: true });
    throw new Error(`Hash mismatch for ${name}: expected ${expectedHash}, got ${actualHash}`);
  }

  log.info("Downloaded skill archive", { name, hash: actualHash, archivePath });
  return archivePath;
}

/**
 * 发布 Skill 到远程 Store。
 *
 * @param archivePath tarball 路径
 * @param manifest Skill manifest 数据
 * @returns 发布的 hash
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
 * 从远程 Store 下载 Skill 并解压到本地 skills/ 目录。
 *
 * 返回解压后的 manifest.yaml 路径，可直接传给 installSkill()。
 * 下载失败或 hash 校验失败时抛错。
 *
 * @param name Skill 名称
 * @param skillsRoot 本地 skills/ 根目录
 * @returns manifest.yaml 的绝对路径
 */
export async function downloadAndExtractRemoteSkill(
  name: string,
  skillsRoot: string,
): Promise<string> {
  // 先查远程信息获取 hash
  const info = await getRemoteSkillInfo(name);
  if (!info) {
    throw new Error(`Skill "${name}" not found in remote Store`);
  }

  const { tmpdir } = await import("node:os");
  const { execFileSync } = await import("node:child_process");

  const tmpDir = resolve(tmpdir(), `alice-pkg-download-${Date.now()}`);
  mkdirSync(tmpDir, { recursive: true });

  try {
    // 下载 tarball（带 hash 校验）
    const archivePath = await downloadSkillArchive(name, tmpDir, info.hash);

    // 解压到 skills/<name>/
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
    // 清理临时下载目录
    rmSync(tmpDir, { recursive: true, force: true });
  }
}
