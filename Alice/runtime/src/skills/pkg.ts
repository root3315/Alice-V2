/**
 * Skill 包管理器核心 — install/remove/list/sync/upgrade/rollback。
 *
 * 心智模型：Nix 风格包管理——声明式、内容寻址、原子切换。
 * 容器启动时 syncEnv() 收敛到 alice-env.yaml 声明的期望状态。
 *
 * @see docs/adr/201-os-for-llm.md
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { compileManifest } from "./compiler.js";
import { loadSkill, unloadSkill } from "./hot-loader.js";
import { ManifestSchema } from "./manifest.js";
import {
  exportInstalledSkillArtifacts,
  getAliceStoreRoot,
  getEntry,
  loadRegistry,
  type RegistryEntry,
  removeEntry,
  removeExportedSkillArtifacts,
  setEntry,
} from "./registry.js";
import { computeHash, installToStore, readFromStore, removeFromStore } from "./store.js";

/** Installed skill roots may point to workspace paths in dev or system paths in the runner. */
const DEFAULT_STORE_ROOT = getAliceStoreRoot();

function isValidBackend(raw: string): raw is RegistryEntry["backend"] {
  return raw === "shell" || raw === "http" || raw === "mcp";
}
function toValidBackend(raw: string): RegistryEntry["backend"] {
  if (isValidBackend(raw)) return raw;
  throw new Error(`Invalid skill backend "${raw}". Valid: shell, http, mcp`);
}

/** 构建注册表条目（installSkill/upgradeSkill/rollbackSkill 共用）。 */
function buildRegistryEntry(
  manifest: {
    name: string;
    version: string;
    actions: Array<{ name: string; category?: string }>;
    capabilities?: string[];
    runtime?: { backend?: string };
  },
  hash: string,
  storePath: string,
  commandPath: string,
  previousHash?: string,
): RegistryEntry {
  const rawBackend = manifest.runtime?.backend ?? "shell";
  const backend = toValidBackend(rawBackend);
  return {
    name: manifest.name,
    version: manifest.version,
    hash,
    storePath,
    commandPath,
    previousHash,
    installedAt: new Date().toISOString(),
    actions: manifest.actions.map((a) => a.name),
    categories: [...new Set(manifest.actions.map((a) => a.category ?? "app"))],
    capabilities: manifest.capabilities ?? [],
    backend,
  };
}

interface SkillPkgOptions {
  enginePort?: number;
  registryPath?: string;
  storeRoot?: string;
  binDir?: string;
}

function resolveStoreRoot(options?: SkillPkgOptions): string {
  return options?.storeRoot ?? DEFAULT_STORE_ROOT;
}

function resolveStoredSkillDir(hash: string, options?: SkillPkgOptions): string {
  return resolve(resolveStoreRoot(options), hash);
}

// ═══════════════════════════════════════════════════════════════════════════
// 公开 API
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 安装 Skill（从本地 manifest.yaml 路径）。
 *
 * 1. 读取 + 校验 manifest
 * 2. 内容寻址存储
 * 3. 编译 → TelegramActionDef[]
 * 4. 热加载注册
 * 5. 更新 registry.json
 */
export async function installSkill(manifestPath: string, opts?: SkillPkgOptions): Promise<void> {
  // 读取 manifest
  const raw = readFileSync(manifestPath, "utf-8");
  const parsed = parseYaml(raw);
  const manifest = ManifestSchema.parse(parsed);

  // 存储
  const { hash, storePath } = installToStore(
    raw,
    dirname(manifestPath),
    manifest.name,
    resolveStoreRoot(opts),
  );

  // 检查是否已安装同版本
  const existing = getEntry(manifest.name, opts?.registryPath);
  if (existing?.hash === hash) {
    return; // 幂等：同 hash 不重复安装
  }

  // 编译
  const actions = compileManifest(manifest, {
    installDir: storePath,
    enginePort: opts?.enginePort,
  });

  // 热加载
  loadSkill(actions, manifest);
  const exported = exportInstalledSkillArtifacts(
    {
      name: manifest.name,
      hash,
      storePath,
      commandPath: resolve(storePath, manifest.name),
    },
    {
      binDir: opts?.binDir,
      storeRoot: opts?.storeRoot,
    },
  );

  // 更新注册表
  setEntry(
    manifest.name,
    buildRegistryEntry(manifest, hash, storePath, exported.commandPath, existing?.hash),
    opts?.registryPath,
  );
}

/**
 * 卸载 Skill。
 *
 * 只移除当前版本的 store 条目，保留 previousHash 以备回滚。
 */
export async function removeSkill(name: string, opts?: SkillPkgOptions): Promise<void> {
  const entry = getEntry(name, opts?.registryPath);
  if (!entry) return;

  // 热卸载
  unloadSkill(entry.actions, entry.categories);
  removeExportedSkillArtifacts(name, { binDir: opts?.binDir });

  // 从存储中移除当前版本（保留 previousHash 用于回滚）
  removeFromStore(entry.hash, resolveStoreRoot(opts));

  // 更新注册表
  removeEntry(name, opts?.registryPath);
}

/**
 * 列出所有已安装 Skill。
 */
export function listSkills(registryPath?: string): RegistryEntry[] {
  const registry = loadRegistry(registryPath);
  return Object.values(registry);
}

/**
 * 同步到期望状态（alice-env.yaml 声明式收敛）。
 *
 * diff 期望 vs 当前 → install 缺失的 + remove 多余的。
 */
export async function syncEnv(
  envPath: string,
  opts?: SkillPkgOptions,
): Promise<{
  installed: string[];
  upgraded: string[];
  removed: string[];
}> {
  if (!existsSync(envPath)) {
    throw new Error(`env file not found: ${envPath}`);
  }

  const raw = readFileSync(envPath, "utf-8");
  const env = parseYaml(raw) as {
    skills?: Array<{ name: string; path: string }>;
  };

  const desired = new Map((env.skills ?? []).map((s) => [s.name, s.path]));
  const current = loadRegistry(opts?.registryPath);

  const installed: string[] = [];
  const upgraded: string[] = [];
  const removed: string[] = [];

  // Install 缺失的 / upgrade 变更的
  for (const [name, path] of desired) {
    if (!current[name]) {
      const manifestPath = resolve(dirname(envPath), path);
      await installSkill(manifestPath, opts);
      installed.push(name);
    } else {
      // 检查 manifest 是否变更（hash 比较）
      const manifestPath = resolve(dirname(envPath), path);
      const raw = readFileSync(manifestPath, "utf-8");
      const newHash = computeHash(raw);
      if (current[name].hash !== newHash) {
        await upgradeSkill(name, manifestPath, opts);
        upgraded.push(name);
      }
    }
  }

  // Remove 多余的（只移除 registry 中存在但 env 中没有的）
  for (const name of Object.keys(current)) {
    if (!desired.has(name)) {
      await removeSkill(name, opts);
      removed.push(name);
    }
  }

  return { installed, upgraded, removed };
}

/**
 * 升级 Skill 到新版本。
 *
 * 原子切换：下载新版 → compile → unload 旧版 → load 新版 → 更新 registry。
 * 旧版保留在 store 中可回滚。
 */
export async function upgradeSkill(
  name: string,
  newManifestPath: string,
  opts?: SkillPkgOptions,
): Promise<void> {
  const existing = getEntry(name, opts?.registryPath);
  if (!existing) {
    // 不存在则直接安装
    await installSkill(newManifestPath, opts);
    return;
  }

  // 读取新 manifest
  const raw = readFileSync(newManifestPath, "utf-8");
  const parsed = parseYaml(raw);
  const manifest = ManifestSchema.parse(parsed);

  // 存储新版本
  const { hash, storePath } = installToStore(
    raw,
    dirname(newManifestPath),
    manifest.name,
    resolveStoreRoot(opts),
  );
  if (hash === existing.hash) return; // 同版本不升级

  // 编译新版（先编译，失败时旧版仍在运行——真正的原子性）
  const actions = compileManifest(manifest, {
    installDir: storePath,
    enginePort: opts?.enginePort,
  });

  // 原子切换：编译成功后才卸载旧版 + 加载新版
  unloadSkill(existing.actions, existing.categories);
  try {
    loadSkill(actions, manifest);
  } catch (e) {
    // loadSkill 失败——尝试恢复旧版
    const prevContent = readFromStore(existing.hash);
    if (prevContent) {
      const prevManifest = ManifestSchema.parse(parseYaml(prevContent));
      const prevActions = compileManifest(prevManifest, {
        installDir: resolveStoredSkillDir(existing.hash, opts),
        enginePort: opts?.enginePort,
      });
      loadSkill(prevActions, prevManifest);
    }
    throw e;
  }
  const exported = exportInstalledSkillArtifacts(
    {
      name: manifest.name,
      hash,
      storePath,
      commandPath: resolve(storePath, manifest.name),
    },
    {
      binDir: opts?.binDir,
      storeRoot: opts?.storeRoot,
    },
  );

  // 更新注册表（保留 previousHash 用于回滚）
  setEntry(
    name,
    buildRegistryEntry(manifest, hash, storePath, exported.commandPath, existing.hash),
    opts?.registryPath,
  );
}

/**
 * 回滚到上一版本。
 *
 * 从 store 读取 previousHash 对应的 manifest，重新编译加载。
 */
export async function rollbackSkill(name: string, opts?: SkillPkgOptions): Promise<void> {
  const entry = getEntry(name, opts?.registryPath);
  if (!entry?.previousHash) {
    throw new Error(`No previous version available for ${name}`);
  }

  const prevContent = readFromStore(entry.previousHash, resolveStoreRoot(opts));
  if (!prevContent) {
    throw new Error(`Previous version ${entry.previousHash} not found in store`);
  }

  // 解析旧 manifest
  const parsed = parseYaml(prevContent);
  const manifest = ManifestSchema.parse(parsed);
  const storePath = resolveStoredSkillDir(entry.previousHash, opts);

  // 编译旧版
  const actions = compileManifest(manifest, {
    installDir: storePath,
    enginePort: opts?.enginePort,
  });

  // 原子切换
  unloadSkill(entry.actions, entry.categories);
  loadSkill(actions, manifest);
  const exported = exportInstalledSkillArtifacts(
    {
      name: manifest.name,
      hash: entry.previousHash,
      storePath,
      commandPath: resolve(storePath, manifest.name),
    },
    {
      binDir: opts?.binDir,
      storeRoot: opts?.storeRoot,
    },
  );

  // 更新注册表（previousHash 指向当前版本，实现双向切换）
  setEntry(
    name,
    buildRegistryEntry(manifest, entry.previousHash, storePath, exported.commandPath, entry.hash),
    opts?.registryPath,
  );
}
