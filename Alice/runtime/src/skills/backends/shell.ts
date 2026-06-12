/**
 * L2 Shell Backend — 子进程 stdin/stdout（LLM = 终端用户）。
 *
 * 执行命令模板，参数通过 {{param}} 替换注入。
 * stdout 作为结果返回给 LLM。
 *
 * @see docs/adr/201-os-for-llm.md
 */

import { execFile } from "node:child_process";

/**
 * 模板变量替换（与 http backend 共用逻辑，但 shell 需要转义）。
 */
export function interpolateShell(template: string, vars: Record<string, unknown>): string {
  return template.replace(/\{\{([^}]+)\}\}/g, (_, key: string) => {
    const value = vars[key.trim()];
    if (value == null) return "''";
    // shell 安全：单引号包裹，内部单引号用 '\'' 转义
    const str = String(value);
    return `'${str.replace(/'/g, "'\\''")}'`;
  });
}

export interface ShellExecOptions {
  command: string;
  params: Record<string, unknown>;
  cwd?: string;
  timeout: number;
  /** 额外环境变量（合并到 process.env 之上）。 */
  env?: Record<string, string>;
}

/**
 * 执行 Shell 命令。
 *
 * @returns stdout 文本
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
 * 直接执行命令，不经过 /bin/sh。
 *
 * args 作为数组传给 execFile，不经过 shell 解释（防注入）。
 *
 * @param command 可执行文件路径或 PATH 上的命令名
 * @param args 参数数组
 * @param opts 执行选项
 * @returns stdout 文本
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
