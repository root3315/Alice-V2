/**
 * L2 Shell Backend — дочерний процесс stdin/stdout (LLM = пользователь терминала).
 *
 * Выполняет шаблон команды, параметры инжектируются через подстановку {{param}}.
 * stdout возвращается LLM как результат.
 *
 * @see docs/adr/201-os-for-llm.md
 */

import { execFile } from "node:child_process";

/**
 * Подстановка переменных шаблона (логика общая с http backend, но shell требует экранирования).
 */
export function interpolateShell(template: string, vars: Record<string, unknown>): string {
  return template.replace(/\{\{([^}]+)\}\}/g, (_, key: string) => {
    const value = vars[key.trim()];
    if (value == null) return "''";
    // shell-безопасность: оборачиваем в одинарные кавычки, внутренние экранируем через '\''
    const str = String(value);
    return `'${str.replace(/'/g, "'\\''")}'`;
  });
}

export interface ShellExecOptions {
  command: string;
  params: Record<string, unknown>;
  cwd?: string;
  timeout: number;
  /** Дополнительные переменные окружения (объединяются поверх process.env). */
  env?: Record<string, string>;
}

/**
 * Выполняет Shell-команду.
 *
 * @returns текст stdout
 */
export function executeShellCommand(opts: ShellExecOptions): Promise<string> {
  const cmd = interpolateShell(opts.command, opts.params);

  return new Promise((resolve, reject) => {
    execFile(
      "/bin/sh",
      ["-c", cmd],
      {
        cwd: opts.cwd,
        timeout: opts.timeout * 1000,
        maxBuffer: 1024 * 1024, // 1MB
        env: opts.env ? { ...process.env, ...opts.env } : undefined,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`Shell command failed: ${error.message}\nstderr: ${stderr}`));
          return;
        }
        resolve(stdout.trim());
      },
    );
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Raw command execution for shell-native system commands and installed app CLIs.
// @see docs/adr/201-os-for-llm.md
// ═══════════════════════════════════════════════════════════════════════════

export interface RawCommandOptions {
  cwd?: string;
  timeout: number;
  env?: Record<string, string>;
}

/**
 * Выполняет команду напрямую, минуя /bin/sh.
 *
 * args передаются массивом в execFile без shell-интерпретации (защита от инъекций).
 *
 * @param command путь к исполняемому файлу или имя команды из PATH
 * @param args массив аргументов
 * @param opts параметры выполнения
 * @returns текст stdout
 */
export function executeRawCommand(
  command: string,
  args: string[],
  opts: RawCommandOptions,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        cwd: opts.cwd,
        timeout: opts.timeout * 1000,
        maxBuffer: 1024 * 1024, // 1MB
        env: opts.env ? { ...process.env, ...opts.env } : undefined,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`Command failed: ${error.message}\nstderr: ${stderr}`));
          return;
        }
        resolve(stdout.trim());
      },
    );
  });
}
