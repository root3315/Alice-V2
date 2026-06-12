/**
 * Skill 自动升级 — tick 间隙无感升级。
 *
 * Agent 离散意识：每次 tick 是一次觉醒，tick 间隙是"无意识"状态。
 * 自动升级在 tick 间隙执行，对 Alice 完全无感。
 *
 * Phase 0: 本地文件系统检查（manifest.yaml 变更检测）。
 * Phase 1: 远程 registry 服务器查询。
 *
 * @see docs/adr/201-os-for-llm.md
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { upgradeSkill } from "./pkg.js";
import { loadRegistry } from "./registry.js";
import { computeHash } from "./store.js";

/** 默认 skills 目录（本地 Skill 源）。 */
const SKILLS_DIR = resolve(import.meta.dirname ?? ".", "../../skills");

/** 升级检查间隔（tick 数）。默认 60 ≈ 每小时。 */
const CHECK_INTERVAL = 60;

/** 上次检查的 tick。 */
let lastCheckTick = 0;

export interface UpgradeCandidate {
  name: string;
  currentVersion: string;
  currentHash: string;
  newManifestPath: string;
  newHash: string;
}

/**
 * 检查是否有可升级的 Skill（Phase 0: 本地文件变更检测）。
 *
 * 扫描 skills/ 目录下的 manifest.yaml，比较 hash 与 registry 中的记录。
 */
export function checkUpgrades(): UpgradeCandidate[] {
  const registry = loadRegistry();
  const candidates: UpgradeCandidate[] = [];

  if (!existsSync(SKILLS_DIR)) return candidates;

  // 扫描 skills/ 下的直接子目录
  const entries = readdirSync(SKILLS_DIR, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name === "store") continue; // 跳过 store 目录

    const manifestPath = join(SKILLS_DIR, entry.name, "manifest.yaml");
    if (!existsSync(manifestPath)) continue;

    const content = readFileSync(manifestPath, "utf-8");
    const newHash = computeHash(content);

    const installed = registry[entry.name];
    if (installed && installed.hash !== newHash) {
      candidates.push({
        name: entry.name,
        currentVersion: installed.version,
        currentHash: installed.hash,
        newManifestPath: manifestPath,
        newHash,
      });
    }
  }

  return candidates;
}

/**
 * 应用升级（原子切换）。
 */
export async function applyUpgrade(candidate: UpgradeCandidate): Promise<void> {
  await upgradeSkill(candidate.name, candidate.newManifestPath);
}

/**
 * tick 间隙调用：每 N 个 tick 检查一次升级。
 *
 * 集成点：在 evolve.ts 的 tick 循环末尾调用。
 *
 * @param currentTick 当前 tick 数
 * @param log 日志函数
 * @returns 升级的 Skill 名列表
 */
export async function maybeAutoUpgrade(
  currentTick: number,
  log: {
    info(msg: string, data?: Record<string, unknown>): void;
    warn(msg: string, data?: Record<string, unknown>): void;
  },
): Promise<string[]> {
  if (currentTick - lastCheckTick < CHECK_INTERVAL) return [];
  lastCheckTick = currentTick;

  const candidates = checkUpgrades();
  if (candidates.length === 0) return [];

  const upgraded: string[] = [];
  for (const c of candidates) {
    try {
      await applyUpgrade(c);
      upgraded.push(c.name);
      log.info("auto-upgrade: skill upgraded", {
        name: c.name,
        from: c.currentVersion,
        hash: c.newHash,
      });
    } catch (e) {
      log.warn("auto-upgrade: failed", {
        name: c.name,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return upgraded;
}
