/**
 * Layer 2 呈现层 — 将 shell 执行结果转为 LLM 友好的 tool result 文本。
 *
 * 四个机制：
 * 1. 二进制守卫：检测 null bytes / 高比例控制字符
 * 2. 输出截断：超长输出保留尾部（错误通常在末尾）
 * 3. 元数据尾行：exit code + 耗时
 * 4. stderr 附加：命令失败时附加 stderr
 *
 * @see docs/adr/213-tool-calling-act-thread.md
 * @see ~/.claude/refs/pi-mono/packages/coding-agent/src/core/tools/truncate.ts — truncateTail 参考
 */

import type { ScriptExecutionResult } from "./script-execution.js";

/** 截断阈值 */
const MAX_LINES = 200;
const MAX_BYTES = 50 * 1024; // 50KB

/** 控制字符占比超过此值视为二进制输出 */
const BINARY_THRESHOLD = 0.1;

export interface PresentOptions {
  /** 覆盖 exit code（默认从 errors 推断：有 errors → 1，否则 0） */
  exitCode?: number;
}

/**
 * 检测内容是否为二进制（含 null bytes 或高比例控制字符）。
 */
function isBinary(text: string): boolean {
  if (text.length === 0) return false;
  if (text.includes("\0")) return true;

  let controlCount = 0;
  const len = Math.min(text.length, 4096); // 只检查前 4KB
  for (let i = 0; i < len; i++) {
    const code = text.charCodeAt(i);
    // 控制字符（排除 \t \n \r）
    if (code < 32 && code !== 9 && code !== 10 && code !== 13) {
      controlCount++;
    }
  }
  return controlCount / len > BINARY_THRESHOLD;
}

/**
 * 尾部截断：保留最后 N 行 / N 字节（错误在末尾）。
 * 简化版 truncateTail — 不需要溢出文件。
 */
function truncateTail(text: string): { content: string; truncated: boolean; totalLines: number } {
  const lines = text.split("\n");
  const totalLines = lines.length;
  const totalBytes = Buffer.byteLength(text, "utf-8");

  if (totalLines <= MAX_LINES && totalBytes <= MAX_BYTES) {
    return { content: text, truncated: false, totalLines };
  }

  // 从尾部倒序收集行
  const kept: string[] = [];
  let bytes = 0;
  for (let i = lines.length - 1; i >= 0 && kept.length < MAX_LINES; i--) {
    const lineBytes = Buffer.byteLength(lines[i], "utf-8") + (kept.length > 0 ? 1 : 0);
    if (bytes + lineBytes > MAX_BYTES) break;
    kept.unshift(lines[i]);
    bytes += lineBytes;
  }

  const sizeKB = (totalBytes / 1024).toFixed(0);
  const header = `--- output truncated (${totalLines} lines, ${sizeKB}KB) ---`;
  return { content: `${header}\n${kept.join("\n")}`, truncated: true, totalLines };
}

/**
 * 将 ScriptExecutionResult 呈现为 LLM 友好的 tool result 文本。
 *
 * 输入：ScriptExecutionResult 的 logs[]、errors[]、duration。
 * 输出：单个字符串，可直接作为 tool result 传回 LLM。
 */
export function presentToolResult(result: ScriptExecutionResult, opts?: PresentOptions): string {
  // ANSI 转义码已在 shell-executor.ts 入口处中心化剥离
  const stdout = result.logs.join("\n");
  const errors = result.errors;
  const exitCode = opts?.exitCode ?? (errors.length > 0 ? 1 : 0);
  const durationMs = result.duration;

  // 二进制守卫
  if (isBinary(stdout)) {
    const size = Buffer.byteLength(stdout, "utf-8");
    return `[binary output, ${size} bytes]\n[exit:${exitCode} | ${durationMs}ms]`;
  }

  // 截断
  const { content } = truncateTail(stdout);

  // 组装
  const parts: string[] = [];
  if (content) parts.push(content);

  // stderr 始终附加（Manus 教训：stderr 是 agent 最需要的信息，不只是失败时）
  if (errors.length > 0) {
    parts.push(`[stderr] ${errors.join("\n")}`);
  }

  // 元数据尾行
  parts.push(`[exit:${exitCode} | ${durationMs}ms]`);

  return parts.join("\n");
}
