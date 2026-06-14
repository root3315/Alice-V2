/**
 * Автоматическая проверка обновлений Skill.
 *
 * Периодически запрашивает удалённый Store, проверяя наличие новых версий установленных Skill.
 * Вызывается из evolve tick (с низкой частотой, например раз в 100 тиков).
 *
 * Результаты проверки кэшируются на 1 час во избежание частых сетевых запросов.
 *
 * @see docs/adr/201-os-for-llm.md
 */

import { createLogger } from "../utils/logger.js";
import { mergeRegistryWithBuiltIns } from "./registry.js";
import { getRemoteStoreUrl, searchRemoteStore } from "./remote-store.js";

const log = createLogger("upgrade-checker");

/** Информация об обновляемом Skill. */
export interface UpgradeCandidate {
  name: string;
  currentVersion: string;
  availableVersion: string;
}

/** Кэш: временная метка и результат последней проверки. */
let lastCheckAt = 0;
let cachedCandidates: UpgradeCandidate[] = [];
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 час

/**
 * Проверить наличие доступных обновлений для всех установленных Skill.
 *
 * Возвращает список Skill, требующих обновления. Результат кэшируется на 1 час.
 * Если удалённый Store не настроен или недоступен — возвращает пустой массив.
 */
export async function checkForUpgrades(force = false): Promise<UpgradeCandidate[]> {
  // Удалённый Store не настроен → пропустить
  if (!getRemoteStoreUrl()) return [];

  // Кэш актуален → вернуть сразу
  if (!force && Date.now() - lastCheckAt < CACHE_TTL_MS) {
    return cachedCandidates;
  }

  const registry = mergeRegistryWithBuiltIns();
  const installedEntries = Object.values(registry).filter(
    (e) => e.name !== "alice-system", // Пропустить встроенный системный пакет
  );

  if (installedEntries.length === 0) {
    lastCheckAt = Date.now();
    cachedCandidates = [];
    return [];
  }

  // Запросить удалённый Store (за один раз, чтобы избежать N запросов)
  const remoteSkills = await searchRemoteStore();
  if (!remoteSkills) {
    // Store недоступен — сохраняем старый кэш, но обновляем временную метку (чтобы не ретраить слишком часто)
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

/** Получить кэшированный список кандидатов на обновление (без сетевых запросов). */
export function getCachedUpgrades(): UpgradeCandidate[] {
  return cachedCandidates;
}

/** Очистить кэш (для тестов). */
export function clearUpgradeCache(): void {
  lastCheckAt = 0;
  cachedCandidates = [];
}
