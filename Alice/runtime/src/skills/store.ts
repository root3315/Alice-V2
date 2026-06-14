/**
 * Контентно-адресуемое хранилище — SHA256 в стиле Nix + структура каталогов.
 *
 * В store/{hash}/ хранятся manifest.yaml + исходный код.
 * Одинаковый manifest + одинаковая версия = одинаковый hash → идемпотентная установка, без дублей.
 *
 * При установке компилируется в статический исполняемый бинарник через Go.
 *
 * @see docs/adr/201-os-for-llm.md
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";

/** Корневой каталог хранилища. */
const DEFAULT_STORE_ROOT = process.env.ALICE_STORE_ROOT
  ? resolve(process.env.ALICE_STORE_ROOT)
  : resolve(import.meta.dirname ?? ".", "../../skills/store");

/** Получить корневой каталог хранилища. */
export function getAliceStoreRoot(): string {
  return DEFAULT_STORE_ROOT;
}

/**
 * Скомпилировать skill в статический бинарник Go.
 *
 * Приоритет — уже скомпилированный бинарник в dist/bin/ (артефакт make),
 * иначе используется `go build` из cmd/skills/{name}/.
 *
 * В соответствии с Makefile: CGO_ENABLED=0 go build -ldflags="-s -w"
 */
export function compileSkillExecutable(
  _storePath: string,
  skillName: string,
  binDir: string,
): string {
  const outputFile = join(binDir, skillName);
  const runtimeDir = resolve(import.meta.dirname ?? ".", "../..");

  // Убедиться, что целевой каталог существует
  mkdirSync(binDir, { recursive: true });

  // 1) Приоритет: готовый бинарник в dist/bin/ (артефакт make)
  const prebuilt = join(runtimeDir, "dist", "bin", skillName);
  if (existsSync(prebuilt)) {
    cpSync(prebuilt, outputFile);
    chmodSync(outputFile, 0o755);
    return outputFile;
  }

  // 2) Компилировать через Go из cmd/skills/{name}/
  const goSource = join(runtimeDir, "cmd", "skills", skillName);
  if (!existsSync(goSource)) {
    throw new Error(
      `Skill "${skillName}": no prebuilt binary in dist/bin/ and no Go source in cmd/skills/${skillName}/`,
    );
  }

  // Удалить старый файл (если существует)
  rmSync(outputFile, { force: true });

  const result = spawnSync(
    "go",
    ["build", "-ldflags=-s -w", "-o", outputFile, `./${join("cmd", "skills", skillName)}`],
    {
      encoding: "utf-8",
      cwd: runtimeDir,
      timeout: 120000,
      env: { ...process.env, CGO_ENABLED: "0" },
    },
  );

  if (result.status !== 0 || !existsSync(outputFile)) {
    throw new Error(
      `Failed to compile skill "${skillName}": ${result.stderr || result.error?.message || "unknown error"}`,
    );
  }

  chmodSync(outputFile, 0o755);
  return outputFile;
}

export function wrapSkillExecutable(
  commandPath: string,
  skillName: string,
  options?: { realPath?: string },
): string {
  const realPath = options?.realPath ?? join(resolve(commandPath, ".."), `.${skillName}.real`);
  const realBasename = basename(realPath);
  rmSync(realPath, { force: true });
  renameSync(commandPath, realPath);
  writeFileSync(
    commandPath,
    [
      "#!/usr/bin/env sh",
      `export ALICE_SKILL=${JSON.stringify(skillName)}`,
      'self_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)',
      `exec "$self_dir/${realBasename}" "$@"`,
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  return commandPath;
}

/**
 * Вычислить SHA256-хеш содержимого manifest.
 * Контентная адресация = одинаковое содержимое → одинаковый hash.
 */
export function computeHash(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

/**
 * Синхронизировать каталог _lib в корень store.
 *
 * Skill могут ссылаться на `../../_lib/engine-client.ts`,
 * поэтому на уровне store нужно поддерживать ту же структуру относительных путей.
 */
export function ensureStoreLib(storeRoot: string = DEFAULT_STORE_ROOT): void {
  // _lib находится в каталоге skills/ (родительский каталог store)
  const libSource = resolve(storeRoot, "../_lib");
  const libTarget = join(storeRoot, "_lib");

  if (existsSync(libSource) && !existsSync(libTarget)) {
    cpSync(libSource, libTarget, { recursive: true });
  }
}

/**
 * Установить manifest в контентно-адресуемое хранилище.
 *
 * @param manifestContent Исходное содержимое manifest.yaml
 * @param sourceDir Каталог с исходным кодом пакета Skill (необязательно). При указании весь пакет копируется в store.
 * @param storeRoot Корневой каталог хранилища
 * @returns { hash, storePath }
 */
export function installToStore(
  manifestContent: string,
  sourceDir?: string,
  _skillName?: string,
  storeRoot: string = DEFAULT_STORE_ROOT,
): { hash: string; storePath: string } {
  const hash = computeHash(manifestContent);
  const storePath = join(storeRoot, hash);

  if (!existsSync(storePath)) {
    if (sourceDir) {
      // Store contains the full package body so installed skills stay runnable
      // even after the source workspace changes.
      cpSync(sourceDir, storePath, { recursive: true });

      // Синхронизировать каталог _lib в корень store (поддержка ссылок ../../_lib)
      ensureStoreLib(storeRoot);
    } else {
      mkdirSync(storePath, { recursive: true });
    }
    writeFileSync(join(storePath, "manifest.yaml"), manifestContent);
  }

  return { hash, storePath };
}

/**
 * Прочитать содержимое manifest из хранилища.
 */
export function readFromStore(hash: string, storeRoot: string = DEFAULT_STORE_ROOT): string | null {
  const filePath = join(storeRoot, hash, "manifest.yaml");
  if (!existsSync(filePath)) return null;
  return readFileSync(filePath, "utf-8");
}

/**
 * Удалить из хранилища.
 */
export function removeFromStore(hash: string, storeRoot: string = DEFAULT_STORE_ROOT): void {
  const storePath = join(storeRoot, hash);
  if (existsSync(storePath)) {
    rmSync(storePath, { recursive: true });
  }
}

/**
 * Проверить, существует ли hash в хранилище.
 */
export function existsInStore(hash: string, storeRoot: string = DEFAULT_STORE_ROOT): boolean {
  return existsSync(join(storeRoot, hash, "manifest.yaml"));
}
