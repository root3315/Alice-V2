/**
 * Ядро менеджера пакетов Skill — install/remove/list/sync/upgrade/rollback.
 *
 * Ментальная модель: управление пакетами в стиле Nix — декларативное, с адресацией по содержимому, атомарным переключением.
 * При запуске контейнера syncEnv() приводит систему к желаемому состоянию, объявленному в alice-env.yaml.
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

/** Формирует запись реестра (общая логика для installSkill/upgradeSkill/rollbackSkill). */
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
// Публичный API
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Устанавливает Skill (из локального пути к manifest.yaml).
 *
 * 1. Чтение + валидация manifest
 * 2. Хранение с адресацией по содержимому
 * 3. Компиляция → TelegramActionDef[]
 * 4. Горячая загрузка и регистрация
 * 5. Обновление registry.json
 */
export async function installSkill(manifestPath: string, opts?: SkillPkgOptions): Promise<void> {
  // Читаем manifest
  const raw = readFileSync(manifestPath, "utf-8");
  const parsed = parseYaml(raw);
  const manifest = ManifestSchema.parse(parsed);

  // Сохраняем в хранилище
  const { hash, storePath } = installToStore(
    raw,
    dirname(manifestPath),
    manifest.name,
    resolveStoreRoot(opts),
  );

  // Проверяем, не установлена ли уже та же версия
  const existing = getEntry(manifest.name, opts?.registryPath);
  if (existing?.hash === hash) {
    return; // Идемпотентность: один и тот же hash не устанавливается повторно
  }

  // Компилируем
  const actions = compileManifest(manifest, {
    installDir: storePath,
    enginePort: opts?.enginePort,
  });

  // Горячая загрузка
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

  // Обновляем реестр
  setEntry(
    manifest.name,
    buildRegistryEntry(manifest, hash, storePath, exported.commandPath, existing?.hash),
    opts?.registryPath,
  );
}

/**
 * Удаляет Skill.
 *
 * Удаляет только запись текущей версии из store, сохраняя previousHash для возможного отката.
 */
export async function removeSkill(name: string, opts?: SkillPkgOptions): Promise<void> {
  const entry = getEntry(name, opts?.registryPath);
  if (!entry) return;

  // Горячая выгрузка
  unloadSkill(entry.actions, entry.categories);
  removeExportedSkillArtifacts(name, { binDir: opts?.binDir });

  // Удаляем текущую версию из хранилища (previousHash сохраняется для отката)
  removeFromStore(entry.hash, resolveStoreRoot(opts));

  // Обновляем реестр
  removeEntry(name, opts?.registryPath);
}

/**
 * Возвращает список всех установленных Skill.
 */
export function listSkills(registryPath?: string): RegistryEntry[] {
  const registry = loadRegistry(registryPath);
  return Object.values(registry);
}

/**
 * Синхронизирует к желаемому состоянию (декларативная конвергенция по alice-env.yaml).
 *
 * Сравнивает желаемое с текущим → устанавливает отсутствующее + удаляет лишнее.
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

  // Устанавливаем отсутствующее / обновляем изменившееся
  for (const [name, path] of desired) {
    if (!current[name]) {
      const manifestPath = resolve(dirname(envPath), path);
      await installSkill(manifestPath, opts);
      installed.push(name);
    } else {
      // Проверяем, изменился ли manifest (сравнение по hash)
      const manifestPath = resolve(dirname(envPath), path);
      const raw = readFileSync(manifestPath, "utf-8");
      const newHash = computeHash(raw);
      if (current[name].hash !== newHash) {
        await upgradeSkill(name, manifestPath, opts);
        upgraded.push(name);
      }
    }
  }

  // Удаляем лишнее (только то, что есть в registry, но отсутствует в env)
  for (const name of Object.keys(current)) {
    if (!desired.has(name)) {
      await removeSkill(name, opts);
      removed.push(name);
    }
  }

  return { installed, upgraded, removed };
}

/**
 * Обновляет Skill до новой версии.
 *
 * Атомарное переключение: загрузка новой версии → компиляция → выгрузка старой → загрузка новой → обновление registry.
 * Старая версия остаётся в store для возможного отката.
 */
export async function upgradeSkill(
  name: string,
  newManifestPath: string,
  opts?: SkillPkgOptions,
): Promise<void> {
  const existing = getEntry(name, opts?.registryPath);
  if (!existing) {
    // Если не существует — просто устанавливаем
    await installSkill(newManifestPath, opts);
    return;
  }

  // Читаем новый manifest
  const raw = readFileSync(newManifestPath, "utf-8");
  const parsed = parseYaml(raw);
  const manifest = ManifestSchema.parse(parsed);

  // Сохраняем новую версию в хранилище
  const { hash, storePath } = installToStore(
    raw,
    dirname(newManifestPath),
    manifest.name,
    resolveStoreRoot(opts),
  );
  if (hash === existing.hash) return; // Та же версия — не обновляем

  // Компилируем новую версию (сначала компиляция — при сбое старая версия продолжает работать; это и есть настоящая атомарность)
  const actions = compileManifest(manifest, {
    installDir: storePath,
    enginePort: opts?.enginePort,
  });

  // Атомарное переключение: только после успешной компиляции выгружаем старую версию и загружаем новую
  unloadSkill(existing.actions, existing.categories);
  try {
    loadSkill(actions, manifest);
  } catch (e) {
    // loadSkill завершился ошибкой — пытаемся восстановить старую версию
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

  // Обновляем реестр (сохраняем previousHash для возможного отката)
  setEntry(
    name,
    buildRegistryEntry(manifest, hash, storePath, exported.commandPath, existing.hash),
    opts?.registryPath,
  );
}

/**
 * Откатывает к предыдущей версии.
 *
 * Читает manifest, соответствующий previousHash, из store и перекомпилирует/перезагружает его.
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

  // Разбираем старый manifest
  const parsed = parseYaml(prevContent);
  const manifest = ManifestSchema.parse(parsed);
  const storePath = resolveStoredSkillDir(entry.previousHash, opts);

  // Компилируем старую версию
  const actions = compileManifest(manifest, {
    installDir: storePath,
    enginePort: opts?.enginePort,
  });

  // Атомарное переключение
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

  // Обновляем реестр (previousHash указывает на текущую версию, обеспечивая двунаправленное переключение)
  setEntry(
    name,
    buildRegistryEntry(manifest, entry.previousHash, storePath, exported.commandPath, entry.hash),
    opts?.registryPath,
  );
}
