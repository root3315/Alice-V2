/**
 * Engine API 路由 — Skill 包管理。
 *
 * alice-pkg CLI 通过这些端点管理 Skill 安装/卸载/搜索。
 * 所有变更操作（install/remove/upgrade/rollback）在引擎进程内执行，
 * 确保热加载和注册表更新的原子性。
 *
 * @see docs/adr/201-ai-native-os.md
 * @see docs/adr/202-engine-api.md
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { getEnginePort } from "../../core/shell-executor.js";
import { ManifestSchema, type SkillManifest } from "../../skills/manifest.js";
import {
  installSkill,
  listSkills,
  removeSkill,
  rollbackSkill,
  upgradeSkill,
} from "../../skills/pkg.js";
import { loadRegistry } from "../../skills/registry.js";
import {
  downloadAndExtractRemoteSkill,
  getRemoteSkillInfo,
  publishToRemoteStore,
  type RemoteSkillSummary,
  searchRemoteStore,
} from "../../skills/remote-store.js";
import { checkForUpgrades } from "../../skills/upgrade-checker.js";

/** 默认 skills 源目录（本地 manifest 发现）。 */
const SKILLS_ROOT = resolve(import.meta.dirname ?? ".", "../../../skills");

/**
 * 扫描 skills/ 目录下所有 manifest.yaml。
 * 跳过内部目录（_lib, store, system-bin, man）。
 */
function discoverManifests(): Array<{ manifest: SkillManifest; path: string }> {
  if (!existsSync(SKILLS_ROOT)) return [];

  const results: Array<{ manifest: SkillManifest; path: string }> = [];
  const skipDirs = new Set(["_lib", "store", "system-bin", "man"]);

  for (const entry of readdirSync(SKILLS_ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith("_") || skipDirs.has(entry.name)) continue;

    const manifestPath = resolve(SKILLS_ROOT, entry.name, "manifest.yaml");
    if (!existsSync(manifestPath)) continue;

    try {
      const raw = readFileSync(manifestPath, "utf-8");
      const manifest = ManifestSchema.parse(parseYaml(raw));
      results.push({ manifest, path: manifestPath });
    } catch {
      // 跳过无效 manifest
    }
  }

  return results;
}

/** 模糊匹配：query 在 name/description/whenToUse 中出现。 */
function matchesQuery(manifest: SkillManifest, query: string): boolean {
  const q = query.toLowerCase();
  const searchable = [
    manifest.name,
    manifest.description,
    ...manifest.actions.map((a) => a.whenToUse),
    ...manifest.actions.flatMap((a) => a.description),
  ];
  return searchable.some((s) => s.toLowerCase().includes(q));
}

/** 读取 JSON body。 */
function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk: Buffer) => {
      data += chunk.toString();
    });
    req.on("end", () => {
      try {
        resolve(data ? (JSON.parse(data) as Record<string, unknown>) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

/**
 * GET /skills/search?query=...
 *
 * 搜索 Skill Store。先查本地，再查远程（如有配置），合并去重。
 */
export async function handleSkillSearch(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const query = url.searchParams.get("query")?.trim() || undefined;

  const allManifests = discoverManifests();
  const registry = loadRegistry();

  const filtered = query
    ? allManifests.filter(({ manifest }) => matchesQuery(manifest, query))
    : allManifests;

  const localNames = new Set<string>();
  const skills: Array<{
    name: string;
    version: string;
    description: string;
    whenToUse: string;
    installed: boolean;
    source: "local" | "remote";
  }> = filtered.map(({ manifest }) => {
    localNames.add(manifest.name);
    return {
      name: manifest.name,
      version: manifest.version,
      description: manifest.description,
      whenToUse: manifest.actions[0]?.whenToUse ?? manifest.description,
      installed: manifest.name in registry,
      source: "local" as const,
    };
  });

  // 合并远程结果（如果配置了 ALICE_STORE_URL）
  const remoteResults = await searchRemoteStore(query);
  if (remoteResults) {
    for (const remote of remoteResults) {
      if (localNames.has(remote.name)) continue; // 本地优先
      skills.push({
        name: remote.name,
        version: remote.version,
        description: remote.description,
        whenToUse: remote.whenToUse,
        installed: remote.name in registry,
        source: "remote" as const,
      });
    }
  }

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ query: query ?? null, skills }));
}

/**
 * GET /skills/list
 *
 * 列出已安装 Skill。
 */
export function handleSkillList(_req: IncomingMessage, res: ServerResponse): void {
  const skills = listSkills();
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ skills }));
}

/**
 * GET /skills/info/:name
 *
 * 查看指定 Skill 详情（manifest + 安装状态）。
 */
export async function handleSkillInfo(
  name: string,
  _req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const registry = loadRegistry();
  const installed = registry[name] ?? null;

  // 查找本地 manifest
  const manifestPath = resolve(SKILLS_ROOT, name, "manifest.yaml");
  let manifest: SkillManifest | null = null;
  if (existsSync(manifestPath)) {
    try {
      manifest = ManifestSchema.parse(parseYaml(readFileSync(manifestPath, "utf-8")));
    } catch {
      // ignore
    }
  }

  // 本地找不到时查远程
  let remoteInfo: RemoteSkillSummary | null = null;
  if (!manifest && !installed) {
    const remote = await getRemoteSkillInfo(name);
    if (remote) {
      remoteInfo = remote as unknown as RemoteSkillSummary;
    }
  }

  if (!manifest && !installed && !remoteInfo) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: `Skill "${name}" not found` }));
    return;
  }

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ name, manifest, installed, remote: remoteInfo }));
}

/**
 * POST /skills/install   { "name": "weather" }
 *
 * 先找本地 skills/<name>/manifest.yaml，找不到则尝试从远程 Store 下载。
 */
export async function handleSkillInstall(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readBody(req);
  const name = String(body.name ?? "").trim();

  if (!name) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "name is required" }));
    return;
  }

  let manifestPath = resolve(SKILLS_ROOT, name, "manifest.yaml");

  // 本地找不到 → 尝试从远程 Store 下载
  if (!existsSync(manifestPath)) {
    try {
      manifestPath = await downloadAndExtractRemoteSkill(name, SKILLS_ROOT);
    } catch {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `Skill "${name}" not found (local or remote)` }));
      return;
    }
  }

  try {
    await installSkill(manifestPath, { enginePort: getEnginePort() });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, name }));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: msg }));
  }
}

/**
 * POST /skills/remove   { "name": "weather" }
 */
export async function handleSkillRemove(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readBody(req);
  const name = String(body.name ?? "").trim();

  if (!name) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "name is required" }));
    return;
  }

  try {
    await removeSkill(name);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, name }));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: msg }));
  }
}

/**
 * POST /skills/upgrade   { "name": "weather" }
 *
 * 先找本地 skills/<name>/manifest.yaml，找不到则尝试从远程 Store 下载最新版。
 */
export async function handleSkillUpgrade(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readBody(req);
  const name = String(body.name ?? "").trim();

  if (!name) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "name is required" }));
    return;
  }

  let manifestPath = resolve(SKILLS_ROOT, name, "manifest.yaml");

  // 本地找不到 → 尝试从远程 Store 下载最新版
  if (!existsSync(manifestPath)) {
    try {
      manifestPath = await downloadAndExtractRemoteSkill(name, SKILLS_ROOT);
    } catch {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `Skill "${name}" not found (local or remote)` }));
      return;
    }
  }

  try {
    await upgradeSkill(name, manifestPath, { enginePort: getEnginePort() });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, name }));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: msg }));
  }
}

/**
 * POST /skills/rollback   { "name": "weather" }
 */
export async function handleSkillRollback(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const body = await readBody(req);
  const name = String(body.name ?? "").trim();

  if (!name) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "name is required" }));
    return;
  }

  try {
    await rollbackSkill(name, { enginePort: getEnginePort() });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, name }));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: msg }));
  }
}

/**
 * POST /skills/publish   { "dir": "./path/to/skill" }
 *
 * 打包并发布 Skill 到远程 Store。
 * 需要 ALICE_STORE_URL 和 ALICE_STORE_TOKEN 环境变量。
 */
export async function handleSkillPublish(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readBody(req);
  const dir = String(body.dir ?? ".").trim();

  const manifestPath = resolve(dir, "manifest.yaml");
  if (!existsSync(manifestPath)) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: `No manifest.yaml found in "${dir}"` }));
    return;
  }

  try {
    const raw = readFileSync(manifestPath, "utf-8");
    const manifest = ManifestSchema.parse(parseYaml(raw));

    // 创建临时 tarball（使用 execFileSync 避免 shell injection）
    const { execFileSync } = await import("node:child_process");
    const { tmpdir } = await import("node:os");
    const { mkdirSync, rmSync } = await import("node:fs");
    const tmpDir = resolve(tmpdir(), `alice-pkg-publish-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    const archivePath = resolve(tmpDir, `${manifest.name}.tar.gz`);
    execFileSync("tar", ["-czf", archivePath, "-C", resolve(dir), "."], { timeout: 30_000 });

    const hash = await publishToRemoteStore(
      archivePath,
      manifest as unknown as Record<string, unknown>,
    );

    rmSync(tmpDir, { recursive: true, force: true });

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, name: manifest.name, hash }));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: msg }));
  }
}

/**
 * GET /skills/upgrades
 *
 * 检查已安装 Skill 的可用升级（结果缓存 1 小时）。
 */
export async function handleSkillUpgrades(
  _req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  try {
    const candidates = await checkForUpgrades();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ upgrades: candidates }));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: msg }));
  }
}
