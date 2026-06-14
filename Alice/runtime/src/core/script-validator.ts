/**
 * Предварительная валидация скрипта — лёгкий dry-run после вывода LLM и до выполнения в Docker.
 *
 * Уровни проверки:
 * 1. bash -n синтаксическая проверка (локальный spawn, миллисекунды)
 * 2. Проверка имён команд: является ли первый токен каждой непустой/некомментарной строки известной командой
 * 3. Предложения нечёткого совпадения: неизвестная команда → кандидаты с расстоянием Левенштейна ≤ 2
 *
 * Возвращает сообщения об ошибках, читаемые человеком/LLM, для обратной связи при повторе instructor.
 *
 * @see docs/adr/211-instructor-js-script-prevalidation.md
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

// logger зарезервирован (включить при необходимости)
// import { createLogger } from "../utils/logger.js";
// const log = createLogger("script-validator");

/**
 * Определить доступный путь к bash.
 *
 * На Windows `bash` из PATH обычно — System32\bash.exe (WSL-ретранслятор),
 * без доступного дистрибутива выдаёт ошибку "execvpe(/bin/bash) failed", которая ошибочно считается синтаксической.
 * Здесь приоритет отдаётся настоящему bash из Git for Windows; если не найден — на Windows возвращается null
 * → хостовая синтаксическая проверка пропускается (внутри Docker-контейнера команда всё равно выполнится и проверится).
 */
let _bashPath: string | null | undefined;
function resolveBash(): string | null {
  if (_bashPath !== undefined) return _bashPath;
  const candidates = [
    process.env.ALICE_BASH_PATH,
    "C:\\Program Files\\Git\\bin\\bash.exe",
    "C:\\Program Files\\Git\\usr\\bin\\bash.exe",
    "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
  ];
  for (const c of candidates) {
    if (c && existsSync(c)) {
      _bashPath = c;
      return c;
    }
  }
  // Не-Windows: bash из PATH, как правило, настоящий. Windows: bash из PATH — WSL-ретранслятор → пропускаем.
  _bashPath = process.platform === "win32" ? null : "bash";
  return _bashPath;
}

/** Признаки сбоя запуска (не синтаксическая ошибка): WSL-ретранслятор, отсутствие /bin/bash, ошибка exec и т.п. */
function isLaunchFailure(stderr: string): boolean {
  return (
    /WSL|execvpe|Relay|cannot execute|command not found|No such file or directory/i.test(stderr) &&
    !/line\s+\d+:/.test(stderr)
  );
}

// Набор известных команд — внедряется из CommandCatalog при запуске
let _knownCommands = new Set<string>([
  // Встроенные системные команды (всегда доступны)
  "irc",
  "album",
  "self",
  "alice-pkg",
  // Встроенные команды shell
  "echo",
  "printf",
  "set",
  "export",
  "read",
  "test",
  "true",
  "false",
  "exit",
  // Стандартные POSIX-утилиты
  "grep",
  "sed",
  "awk",
  "cat",
  "head",
  "tail",
  "wc",
  "sort",
  "uniq",
  "tr",
  "cut",
  "date",
  "sleep",
  // навигация по файлам (read-only) — нужна для чтения кода в /work/worki.
  // Без них валидатор ронял её `ls`-проверки → она думала «нет доступа».
  "ls",
  "find",
  "pwd",
]);

let _knownSubcommands = new Map<string, Set<string>>();

/** Внедрить дополнительные имена команд из CommandCatalog (вызывается при запуске). */
export function registerKnownCommands(names: Iterable<string>): void {
  for (const name of names) {
    _knownCommands.add(name);
  }
}

/** Внедрить имена подкоманд из реальных CLI-определений (вызывается при запуске). */
export function registerKnownSubcommands(command: string, names: Iterable<string>): void {
  _knownSubcommands.set(command, new Set(names));
}

/** Сброс (для тестов). */
export function resetKnownCommands(): void {
  _knownCommands = new Set(["irc", "album", "self", "engine", "alice-pkg"]);
  _knownSubcommands = new Map<string, Set<string>>();
}

/** Получить текущий набор известных команд (для тестов/отладки). */
export function getKnownCommands(): ReadonlySet<string> {
  return _knownCommands;
}

// ── Логика валидации ──────────────────────────────────────────────────────

export type ValidationErrorCode =
  | "no_executable"
  | "shell_syntax"
  | "invalid_message_ref"
  | "unknown_subcommand"
  | "unknown_command";

export interface ValidationError {
  code: ValidationErrorCode;
  line: number;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
  /** Читаемое LLM резюме ошибок (для внедрения при повторе instructor). */
  summary: string;
}

/**
 * Лёгкий dry-run для валидации скрипта.
 * Не требует Docker, завершается за миллисекунды.
 */
export function validateScript(script: string): ValidationResult {
  const errors: ValidationError[] = [];

  // 0. Должна содержать хотя бы одну исполняемую команду (не комментарий, не пустая строка)
  //    Предотвращает отправку в Docker чистого естественного языка или только комментариев
  if (!hasExecutableCommand(script)) {
    errors.push({
      code: "no_executable",
      line: 1,
      message: "Script has no executable commands — only comments or empty lines",
    });
    return {
      valid: false,
      errors,
      summary: errors.map((e) => `line ${e.line}: ${e.message}`).join("\n"),
    };
  }

  // 1. bash -n синтаксическая проверка
  const syntaxErrors = checkBashSyntax(script);
  errors.push(...syntaxErrors);

  // 2. Проверка имён команд (только при синтаксически корректном скрипте, во избежание шума)
  if (syntaxErrors.length === 0) {
    errors.push(...checkIrcMessageRefs(script));
    const cmdErrors = checkCommandNames(script);
    errors.push(...cmdErrors);
    errors.push(...checkSubcommandNames(script));
  }

  const valid = errors.length === 0;
  const summary = valid ? "" : errors.map((e) => `line ${e.line}: ${e.message}`).join("\n");

  return { valid, errors, summary };
}

/** Содержит ли скрипт хотя бы одну исполняемую команду (не комментарий, не пустая строка, не чистое присваивание). */
function hasExecutableCommand(script: string): boolean {
  for (const line of script.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    return true;
  }
  return false;
}

/** bash -n синтаксическая проверка. */
function checkBashSyntax(script: string): ValidationError[] {
  const bash = resolveBash();
  if (!bash) return []; // нет настоящего bash (Windows без git-bash) → пропускаем хост-проверку
  try {
    execFileSync(bash, ["-n"], {
      input: script,
      encoding: "utf-8",
      timeout: 3000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return [];
  } catch (e: unknown) {
    const err = e as { stderr?: string; code?: string };
    if (err.code === "ENOENT") return []; // bash не запустился → пропускаем
    const stderr = err.stderr ?? "";
    // Запуск bash провалился (WSL relay, нет /bin/bash, exec error) — это НЕ синтаксис.
    if (isLaunchFailure(stderr)) return [];
    const errors: ValidationError[] = [];

    // Разобрать вывод bash -n: "bash: line N: ..."
    for (const line of stderr.split("\n")) {
      const match = line.match(/line (\d+): (.+)/);
      if (match) {
        errors.push({
          code: "shell_syntax",
          line: Number.parseInt(match[1], 10),
          message: `syntax error: ${match[2]}`,
        });
      }
    }

    // Если структурированные ошибки не распознаны — вернуть хотя бы сырой stderr
    if (errors.length === 0 && stderr.trim()) {
      errors.push({
        code: "shell_syntax",
        line: 1,
        message: `syntax error: ${stderr.trim().slice(0, 200)}`,
      });
    }

    return errors;
  }
}

function checkIrcMessageRefs(script: string): ValidationError[] {
  const errors: ValidationError[] = [];
  const lines = splitLinesWithQuoteState(script);

  for (let i = 0; i < lines.length; i++) {
    const { line, startsInQuote } = lines[i];
    if (startsInQuote) continue;
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    if (/(^|[\s;])--ref(?:=|\s+)#?(?:latest|last|recent)\b/i.test(line)) {
      errors.push({
        code: "invalid_message_ref",
        line: i + 1,
        message:
          "invalid --ref alias; use a visible current-chat msgId such as 12099, never latest",
      });
    }
    if (/(^|[\s;])--ref(?:=|\s+)#\d+\b/.test(line)) {
      errors.push({
        code: "invalid_message_ref",
        line: i + 1,
        message:
          "bare --ref #msgId starts a shell comment; use --ref 12099 without #, or quote '#12099'",
      });
    }
    if (/(^|[\s;])--ref(?:=|\s+)(?:['"]?\$|\$\()/i.test(line)) {
      errors.push({
        code: "invalid_message_ref",
        line: i + 1,
        message: "--ref must be a literal visible msgId, not a shell variable or parsed CLI output",
      });
    }
  }

  return errors;
}

// ── Проверка имён команд ──────────────────────────────────────────────────
//
// Проверяются только имена команд верхнего уровня. Валидация подкоманд делегируется citty во время выполнения в контейнере —
// citty сам выдаёт "Unknown command", ошибка возвращается LLM через feedback-arc.
// @see citty resolveSubCommand → CLIError("E_UNKNOWN_COMMAND")

/** Проверка имён команд: является ли первый токен каждой непустой/некомментарной строки известным. */
function checkCommandNames(script: string): ValidationError[] {
  const errors: ValidationError[] = [];
  const lines = splitLinesWithQuoteState(script);

  for (let i = 0; i < lines.length; i++) {
    const { line, startsInQuote } = lines[i];
    if (startsInQuote) continue;
    const trimmed = line.trim();
    // Пропустить пустые строки, комментарии, shebang
    if (!trimmed || trimmed.startsWith("#")) continue;

    // Пропустить присваивания переменных shell (FOO=bar, foo=$(cmd), foo=`cmd`)
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(trimmed)) continue;

    // Извлечь первый токен (имя команды)
    const firstToken = trimmed.split(/[\s;|&(]/)[0];
    if (!firstToken) continue;

    // Пропустить ключевые слова shell
    if (SHELL_KEYWORDS.has(firstToken)) continue;

    if (!_knownCommands.has(firstToken)) {
      const suggestion = findClosest(firstToken, _knownCommands);
      const msg = suggestion
        ? `unknown command '${firstToken}', did you mean '${suggestion}'?`
        : `unknown command '${firstToken}'`;
      errors.push({ code: "unknown_command", line: i + 1, message: msg });
    }
  }

  return errors;
}

function checkSubcommandNames(script: string): ValidationError[] {
  const errors: ValidationError[] = [];
  const lines = splitLinesWithQuoteState(script);

  for (let i = 0; i < lines.length; i++) {
    const { line, startsInQuote } = lines[i];
    if (startsInQuote) continue;
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(trimmed)) continue;

    const tokens = trimmed.split(/\s+/);
    const command = tokens[0];
    const known = _knownSubcommands.get(command);
    if (!known) continue;

    const subcommand = tokens[1];
    if (!subcommand || subcommand.startsWith("-")) continue;
    if (known.has(subcommand)) continue;

    const suggestion = findClosest(subcommand, known);
    const msg = suggestion
      ? `unknown ${command} subcommand '${subcommand}', did you mean '${suggestion}'?`
      : `unknown ${command} subcommand '${subcommand}'`;
    errors.push({ code: "unknown_subcommand", line: i + 1, message: msg });
  }

  return errors;
}

interface ScriptLineState {
  line: string;
  startsInQuote: boolean;
}

function splitLinesWithQuoteState(script: string): ScriptLineState[] {
  const result: ScriptLineState[] = [];
  let quote: "'" | '"' | null = null;
  let escaped = false;

  for (const line of script.split("\n")) {
    result.push({ line, startsInQuote: quote !== null });

    for (const ch of line) {
      if (escaped) {
        escaped = false;
        continue;
      }

      if (quote === "'") {
        if (ch === "'") quote = null;
        continue;
      }

      if (quote === '"') {
        if (ch === "\\") {
          escaped = true;
          continue;
        }
        if (ch === '"') quote = null;
        continue;
      }

      if (ch === "#") break;
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === "'" || ch === '"') quote = ch;
    }
  }

  return result;
}

const SHELL_KEYWORDS = new Set([
  "if",
  "then",
  "else",
  "elif",
  "fi",
  "for",
  "do",
  "done",
  "while",
  "until",
  "case",
  "esac",
  "in",
  "function",
  "{",
  "}",
  "[[",
  "]]",
  "!",
]);

// ── Нечёткое совпадение ───────────────────────────────────────────────────

/** Расстояние Левенштейна. */
function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
  }
  return dp[m][n];
}

/** Найти ближайшее совпадение в наборе известных команд с расстоянием Левенштейна ≤ 2. */
function findClosest(input: string, candidates: ReadonlySet<string>): string | null {
  let best: string | null = null;
  let bestDist = 3; // порог
  for (const cmd of candidates) {
    // Быстрое отсечение: при разнице длин > 2 расстояние не может быть ≤ 2
    if (Math.abs(input.length - cmd.length) > 2) continue;
    const dist = levenshtein(input, cmd);
    if (dist < bestDist) {
      bestDist = dist;
      best = cmd;
    }
  }
  return best;
}
