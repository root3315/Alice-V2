/**
 * Skill 自动升级检查。
 *
 * 定期查询远程 Store 检查已安装 Skill 是否有新版本。
 * 由 evolve tick 调用（低频，如每 100 tick 一次）。
 *
 * 检查结果缓存 1 小时，避免频繁网络请求。
 *
 * @see docs/adr/201-os-for-llm.md
 */

import { createLogger } from "../utils/logger.js";
import { mergeRegistryWithBuiltIns } from "./registry.js";
import { getRemoteStoreUrl, searchRemoteStore } from "./remote-store.js";

const log = createLogger("upgrade-checker");

/** 可升级的 Skill 信息。 */
export interface UpgradeCandidate {
  name: string;
  currentVersion: string;
  availableVersion: string;
}

/** 缓存：上次检查的时间戳和结果。 */
let lastCheckAt = 0;
let cachedCandidates: UpgradeCandidate[] = [];
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 小时

/**
 * 检查所有已安装 Skill 是否有可用升级。
 *
 * 返回需要升级的 Skill 列表。结果缓存 1 小时。
 * 远程 Store 未配置或不可用时返回空数组。
 */
export async function checkForUpgrades(force = false): Promise<UpgradeCandidate[]> {
  // 未配置远程 Store → 跳过
  if (!getRemoteStoreUrl()) return [];

  // 缓存有效 → 直接返回
  if (!force && Date.now() - lastCheckAt < CACHE_TTL_MS) {
    return cachedCandidates;
  }

  const registry = mergeRegistryWithBuiltIns();
  const installedEntries = Object.values(registry).filter(
    (e) => e.name !== "alice-system", // 跳过内置系统包
  );

  if (installedEntries.length === 0) {
    lastCheckAt = Date.now();
    cachedCandidates = [];
    return [];
  }

  // 查询远程 Store（一次性拉全部，避免 N 次请求）
  const remoteSkills = await searchRemoteStore();
  if (!remoteSkills) {
    // Store 不可用，保留旧缓存但更新时间戳（避免频繁重试）
    lastCheckAt = Date.now();
    return cachedCandidates;
  }

  const remoteMap = new Map(remoteSkills.map((s) => [s.name, s]));
  const candidates: UpgradeCandidate[] = [];

  for (const entry of installedEntries) {
    const remote = remoteMap.get(entry.name);
    if (!remote) continue;
    if (remote.version !== entry.version) {
      candidates.push({
        name: entry.name,
        currentVersion: entry.version,
        availableVersion: remote.version,
      });
    }
  }

  lastCheckAt = Date.now();
  cachedCandidates = candidates;

  if (candidates.length > 0) {
    log.info("Upgrades available", {
      count: candidates.length,
      skills: candidates.map((c) => `${c.name} ${c.currentVersion}→${c.availableVersion}`),
    });
  }

  return candidates;
}

/** 获取缓存的升级候选列表（不触发网络请求）。 */
export function getCachedUpgrades(): UpgradeCandidate[] {
  return cachedCandidates;
}

/** 清除缓存（测试用）。 */
export function clearUpgradeCache(): void {
  lastCheckAt = 0;
  cachedCandidates = [];
}
