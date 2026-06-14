/**
 * Skill реестр — индекс установленных Skill (CRUD для registry.json).
 *
 * @see docs/adr/201-os-for-llm.md
 */

import {
  accessSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { delimiter, dirname, resolve } from "node:path";
import { compileSkillExecutable, getAliceStoreRoot, wrapSkillExecutable } from "./store.js";

// Реэкспорт для использования в других модулях
export { getAliceStoreRoot } from "./store.js";

/** Путь к реестру по умолчанию. */
const DEFAULT_REGISTRY_PATH = resolve(import.meta.dirname ?? ".", "../../skills/registry.json");
/**
 * Runtime command-space roots.
 *
 * In development they default to workspace paths.
 * In a protected runner/container they can be rebound to system-style directories
 * like /opt/alice/bin and /opt/alice/share/man via environment variables.
 */
const DEFAULT_SYSTEM_BIN = process.env.ALICE_SYSTEM_BIN_DIR
  ? resolve(process.env.ALICE_SYSTEM_BIN_DIR)
  : resolve(import.meta.dirname ?? ".", "../../dist/bin");
const CONTAINER_SYSTEM_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

/** Запись реестра. */
export interface RegistryEntry {
  name: string;
  version: string;
  hash: string;
  /** Каталог установленных команд. По умолчанию = skills/store/{hash}. */
  storePath?: string;
  /** Точка входа установленной команды. По умолчанию = {storePath}/{name}. */
  commandPath?: string;
  /** Хеш предыдущей версии (для отката). */
  previousHash?: string;
  installedAt: string;
  /** Список экспортированных имён действий. */
  actions: string[];
  /** Список зарегистрированных ToolCategory. */
  categories: string[];
  /** Список запрошенных возможностей Engine API. */
  capabilities: string[];
  backend: "http" | "shell" | "mcp";
}

/** Структура реестра в памяти. */
export type Registry = Record<string, RegistryEntry>;

const BUILTIN_SYSTEM_REGISTRY: Registry = {
  "alice-system": {
    name: "alice-system",
    version: "1.0.0",
    hash: "builtin-system",
    storePath: DEFAULT_SYSTEM_BIN,
    commandPath: resolve(DEFAULT_SYSTEM_BIN, "irc"),
    installedAt: "2026-03-11T00:00:00.000Z",
    actions: ["irc", "album", "self", "engine", "alice-pkg"],
    categories: ["app"],
    capabilities: [
      "chat.read",
      "graph.read",
      "transport.send",
      "transport.read",
      "transport.react",
      "telegram.send",
      "telegram.read",
      "telegram.react",
      "telegram.join",
      "telegram.leave",
      "telegram.forward",
      "telegram.download",
      "telegram.upload",
      "dispatch",
      "query",
    ],
    backend: "shell",
  },
};

export function getBuiltInRegistry(): Registry {
  return { ...BUILTIN_SYSTEM_REGISTRY };
}

export function mergeRegistryWithBuiltIns(registry: Registry = loadRegistry()): Registry {
  return {
    ...getBuiltInRegistry(),
    ...registry,
  };
}

/**
 * Загрузить реестр. Если не существует — вернуть пустой объект.
 */
export function loadRegistry(registryPath: string = DEFAULT_REGISTRY_PATH): Registry {
  if (!existsSync(registryPath)) return {};
  try {
    const raw = readFileSync(registryPath, "utf-8");
    return JSON.parse(raw) as Registry;
  } catch (e) {
    // Реестр повреждён — возвращаем пустой, но не молча теряем данные
    console.warn(
      `[skills/registry] Failed to parse ${registryPath}, treating as empty:`,
      e instanceof Error ? e.message : String(e),
    );
    return {};
  }
}

/**
 * Сохранить реестр.
 */
export function saveRegistry(
  entries: Registry,
  registryPath: string = DEFAULT_REGISTRY_PATH,
): void {
  const dir = dirname(registryPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(registryPath, JSON.stringify(entries, null, 2));
}

/**
 * Получить одну запись.
 */
export function getEntry(name: string, registryPath?: string): RegistryEntry | undefined {
  const registry = mergeRegistryWithBuiltIns(loadRegistry(registryPath));
  return registry[name];
}

/**
 * Установить одну запись (upsert).
 */
export function setEntry(name: string, entry: RegistryEntry, registryPath?: string): void {
  const registry = loadRegistry(registryPath);
  registry[name] = entry;
  saveRegistry(registry, registryPath);
}

/**
 * Удалить одну запись.
 */
export function removeEntry(name: string, registryPath?: string): void {
  const registry = loadRegistry(registryPath);
  delete registry[name];
  saveRegistry(registry, registryPath);
}

/**
 * Разрешить каталог установленного Skill.
 */
export function resolveInstalledSkillDir(entry: RegistryEntry): string {
  return entry.storePath ?? resolve(getAliceStoreRoot(), entry.hash);
}

/**
 * Разрешить точку входа команды установленного Skill.
 */
export function resolveInstalledSkillCommand(entry: RegistryEntry): string {
  return entry.commandPath ?? resolve(resolveInstalledSkillDir(entry), entry.name);
}

/**
 * Каталог встроенных системных программ Alice.
 *
 * Семантически соответствует слою системных команд AI OS, наряду с пользовательскими Skill.
 */
export function getAliceSystemBinDir(): string {
  return DEFAULT_SYSTEM_BIN;
}

/** Public command exposure root for installed commands. */
export function getAliceBinDir(): string {
  return DEFAULT_SYSTEM_BIN;
}

/**
 * Перечислить встроенные системные команды Alice.
 *
 * Примечание: корневой каталог видимого системой bin одновременно является публичным
 * префиксом экспорта установленных skill, поэтому прямое сканирование каталога недопустимо —
 * оно ошибочно причислит skill к системным командам.
 * Истинный набор системных команд определяется builtin registry с проверкой наличия файлов.
 */
export function listAliceSystemCommands(systemBinDir: string = DEFAULT_SYSTEM_BIN): string[] {
  if (!existsSync(systemBinDir)) return [];

  return BUILTIN_SYSTEM_REGISTRY["alice-system"].actions
    .filter((name) => {
      const path = resolve(systemBinDir, name);
      try {
        return statSync(path).isFile();
      } catch {
        return false;
      }
    })
    .sort();
}

/** Проверить, является ли имя команды встроенной системной командой Alice. */
export function isAliceSystemCommand(
  name: string,
  systemBinDir: string = DEFAULT_SYSTEM_BIN,
): boolean {
  return listAliceSystemCommands(systemBinDir).includes(name);
}

/** Разрешить точку входа встроенной системной команды Alice. */
export function resolveAliceSystemCommand(
  name: string,
  systemBinDir: string = DEFAULT_SYSTEM_BIN,
): string {
  return resolve(systemBinDir, name);
}

/**
 * Сформировать PATH-префикс пространства команд Alice.
 *
 * Порядок:
 * 1. Каталог системных программ (alice-* + exported skills)
 * 2. Исходный PATH хоста
 */
export function buildAliceCommandPath(): string {
  const pathParts = [getAliceBinDir(), process.env.PATH].filter(Boolean);
  return pathParts.join(delimiter);
}

/** Build a deterministic container PATH instead of inheriting host developer state. */
export function buildAliceContainerCommandPath(binDir: string = getAliceBinDir()): string {
  // ВНУТРИ контейнера PATH всегда POSIX (":"). НЕ использовать node:path delimiter —
  // на Windows-хосте он ";", из-за чего "/opt/alice/bin" склеивается со следующей
  // записью и команды (irc/self/...) не находятся в контейнере.
  return [binDir, CONTAINER_SYSTEM_PATH].join(":");
}

/**
 * Сформировать среду выполнения для процесса Skill.
 *
 * - PATH: prepend Alice command space (system commands + installed skills)
 * - ALICE_SKILL: optional process identity
 */
export function buildInstalledSkillEnv(options?: {
  skillName?: string;
  extraEnv?: Record<string, string>;
}): Record<string, string> {
  return {
    ...(options?.extraEnv ?? {}),
    PATH: buildAliceCommandPath(),
    ALICE_SYSTEM_BIN_DIR: getAliceSystemBinDir(),
    ALICE_STORE_ROOT: getAliceStoreRoot(),
    ...(options?.skillName ? { ALICE_SKILL: options.skillName } : {}),
  };
}

export function buildInstalledSkillContainerEnv(options?: {
  skillName?: string;
  extraEnv?: Record<string, string>;
  binDir?: string;
}): Record<string, string> {
  const binDir = options?.binDir ?? getAliceBinDir();

  return {
    ...(options?.extraEnv ?? {}),
    PATH: buildAliceContainerCommandPath(binDir),
    ALICE_SYSTEM_BIN_DIR: binDir,
    ...(options?.skillName ? { ALICE_SKILL: options.skillName } : {}),
  };
}

export function isExecutableFile(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function isSymbolicLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

function isSkillWrapper(path: string, skillName: string): boolean {
  try {
    const text = readFileSync(path, "utf-8");
    return text.includes(`export ALICE_SKILL=${JSON.stringify(skillName)}`);
  } catch {
    return false;
  }
}

export function exportInstalledSkillArtifacts(
  entry: Pick<RegistryEntry, "name" | "hash" | "storePath" | "commandPath">,
  options?: { binDir?: string; storeRoot?: string },
): { commandPath: string } {
  const storeRoot = options?.storeRoot ?? getAliceStoreRoot();
  const binDir = options?.binDir ?? getAliceBinDir();
  const storePath = entry.storePath ?? resolve(storeRoot, entry.hash ?? entry.name);
  const commandPath = resolve(binDir, entry.name);
  const realPath = resolve(binDir, `.${entry.name}.real`);

  rmSync(commandPath, { force: true });
  const compiledPath = compileSkillExecutable(storePath, entry.name, binDir);
  wrapSkillExecutable(compiledPath, entry.name, { realPath });

  return { commandPath };
}

/**
 * При запуске убедиться, что исполняемые файлы всех установленных skill присутствуют в каталоге bin.
 */
export function ensureAllArtifacts(options?: {
  registryPath?: string;
  binDir?: string;
  storeRoot?: string;
}): { synced: number; fixed: number; broken: string[] } {
  const registry = loadRegistry(options?.registryPath);
  const binDir = options?.binDir ?? getAliceBinDir();
  const storeRoot = options?.storeRoot ?? getAliceStoreRoot();
  mkdirSync(binDir, { recursive: true });

  let synced = 0;
  let fixed = 0;
  const broken: string[] = [];

  for (const entry of Object.values(registry)) {
    const target = resolve(binDir, entry.name);

    // Проверить наличие исполняемой обёртки; старые symlink / ELF / неисполняемые файлы — переэкспортировать.
    const needsExport =
      !isExecutableFile(target) || isSymbolicLink(target) || !isSkillWrapper(target, entry.name);
    if (needsExport) {
      try {
        exportInstalledSkillArtifacts(entry, { binDir, storeRoot });
        synced++;
        if (!isExecutableFile(target)) {
          broken.push(entry.name);
        } else {
          fixed++;
        }
      } catch {
        broken.push(entry.name);
      }
    }
  }

  if (broken.length > 0) {
    console.warn(
      `[skill-registry] ${broken.length} skills have broken artifacts: ${broken.join(", ")}`,
    );
  }

  return { synced, fixed, broken };
}

export function removeExportedSkillArtifacts(name: string, options?: { binDir?: string }): void {
  const binDir = options?.binDir ?? getAliceBinDir();
  const exportedCommand = resolve(binDir, name);
  if (existsSync(exportedCommand)) {
    rmSync(exportedCommand, { force: true });
  }
}
