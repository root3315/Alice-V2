/**
 * Авто-обновление Skill — незаметное обновление в промежутках между тиками.
 *
 * Дискретное сознание агента: каждый тик — пробуждение, промежуток — «бессознательное» состояние.
 * Авто-обновление выполняется в промежутке и для Alice полностью незаметно.
 *
 * Phase 0: проверка локальной файловой системы (обнаружение изменений manifest.yaml).
 * Phase 1: запрос к удалённому registry-серверу.
 *
 * @see docs/adr/201-os-for-llm.md
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { upgradeSkill } from "./pkg.js";
import { loadRegistry } from "./registry.js";
import { computeHash } from "./store.js";

/** Директория skills по умолчанию (локальный источник Skill). */
const SKILLS_DIR = resolve(import.meta.dirname ?? ".", "../../skills");

/** Интервал проверки обновлений (в тиках). По умолчанию 60 ≈ раз в час. */
const CHECK_INTERVAL = 60;

/** Тик последней проверки. */
let lastCheckTick = 0;

export interface UpgradeCandidate {
  name: string;
  currentVersion: string;
  currentHash: string;
  newManifestPath: string;
  newHash: string;
}

/**
 * Проверяет наличие доступных обновлений Skill (Phase 0: обнаружение локальных изменений файлов).
 *
 * Сканирует manifest.yaml в директории skills/ и сравнивает хэш с записью в registry.
 */
export function checkUpgrades(): UpgradeCandidate[] {
  const registry = loadRegistry();
  const candidates: UpgradeCandidate[] = [];

  if (!existsSync(SKILLS_DIR)) return candidates;

  // Сканируем непосредственные поддиректории skills/
  const entries = readdirSync(SKILLS_DIR, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name === "store") continue; // Пропускаем директорию store

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
 * Применяет обновление (атомарное переключение).
 */
export async function applyUpgrade(candidate: UpgradeCandidate): Promise<void> {
  await upgradeSkill(candidate.name, candidate.newManifestPath);
}

/**
 * Вызывается в промежутке между тиками: проверяет обновления каждые N тиков.
 *
 * Точка интеграции: вызывается в конце тик-цикла evolve.ts.
 *
 * @param currentTick текущий номер тика
 * @param log функция логирования
 * @returns список имён обновлённых Skill
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
