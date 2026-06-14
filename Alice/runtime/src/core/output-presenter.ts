/**
 * Layer 2 Слой представления — преобразует результат выполнения shell в текст tool result, удобный для LLM.
 *
 * Четыре механизма:
 * 1. Бинарный защитник: обнаруживает null bytes / высокую долю управляющих символов
 * 2. Усечение вывода: при слишком длинном выводе сохраняет хвост (ошибки обычно в конце)
 * 3. Строка метаданных в конце: exit code + время выполнения
 * 4. Добавление stderr: при ошибке команды добавляет stderr
 *
 * @see docs/adr/213-tool-calling-act-thread.md
 * @see ~/.claude/refs/pi-mono/packages/coding-agent/src/core/tools/truncate.ts — справочная реализация truncateTail
 */

import type { ScriptExecutionResult } from "./script-execution.js";

/** Порог усечения */
const MAX_LINES = 200;
const MAX_BYTES = 50 * 1024; // 50KB

/** Если доля управляющих символов превышает это значение, вывод считается бинарным */
const BINARY_THRESHOLD = 0.1;

export interface PresentOptions {
  /** Переопределить exit code (по умолчанию выводится из errors: есть errors → 1, иначе 0) */
  exitCode?: number;
}

/**
 * Определяет, является ли содержимое бинарным (содержит null bytes или высокую долю управляющих символов).
 */
function isBinary(text: string): boolean {
  if (text.length === 0) return false;
  if (text.includes("\0")) return true;

  let controlCount = 0;
  const len = Math.min(text.length, 4096); // проверяем только первые 4KB
  for (let i = 0; i < len; i++) {
    const code = text.charCodeAt(i);
    // управляющие символы (кроме \t \n \r)
    if (code < 32 && code !== 9 && code !== 10 && code !== 13) {
      controlCount++;
    }
  }
  return controlCount / len > BINARY_THRESHOLD;
}

/**
 * Усечение с хвоста: сохраняет последние N строк / N байт (ошибки в конце).
 * Упрощённая версия truncateTail — без файла переполнения.
 */
function truncateTail(text: string): { content: string; truncated: boolean; totalLines: number } {
  const lines = text.split("\n");
  const totalLines = lines.length;
  const totalBytes = Buffer.byteLength(text, "utf-8");

  if (totalLines <= MAX_LINES && totalBytes <= MAX_BYTES) {
    return { content: text, truncated: false, totalLines };
  }

  // Собираем строки с хвоста в обратном порядке
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
 * Преобразует ScriptExecutionResult в текст tool result, удобный для LLM.
 *
 * Вход: logs[], errors[], duration из ScriptExecutionResult.
 * Выход: единая строка, готовая для передачи обратно LLM как tool result.
 */
export function presentToolResult(result: ScriptExecutionResult, opts?: PresentOptions): string {
  // ANSI escape-коды централизованно удаляются на входе в shell-executor.ts
  const stdout = result.logs.join("\n");
  const errors = result.errors;
  const exitCode = opts?.exitCode ?? (errors.length > 0 ? 1 : 0);
  const durationMs = result.duration;

  // Бинарный защитник
  if (isBinary(stdout)) {
    const size = Buffer.byteLength(stdout, "utf-8");
    return `[binary output, ${size} bytes]\n[exit:${exitCode} | ${durationMs}ms]`;
  }

  // Усечение
  const { content } = truncateTail(stdout);

  // Сборка
  const parts: string[] = [];
  if (content) parts.push(content);

  // stderr добавляется всегда (урок Manus: stderr — самая важная информация для агента, не только при ошибке)
  if (errors.length > 0) {
    parts.push(`[stderr] ${errors.join("\n")}`);
  }

  // Строка метаданных в конце
  parts.push(`[exit:${exitCode} | ${durationMs}ms]`);

  return parts.join("\n");
}
