/**
 * Shell-native script executor.
 *
 * This is the primary Alice truth model: the LLM writes a POSIX sh script and the
 * runtime executes it inside a Docker container (alice-skill-runner image).
 *
 * All LLM-controlled scripts are forced through container isolation.
 * Host execution was removed — LLM must never have unsandboxed shell access.
 */

import { DEFAULT_DOCKER_IMAGE } from "../skills/backends/docker.js";
import { ALICE_HOME, executeAliceSandboxProcess } from "../skills/container-runner.js";
import { buildInstalledSkillEnv } from "../skills/registry.js";
import { createLogger } from "../utils/logger.js";
import {
  COMPLETED_ACTION_CONTROL_PREFIX,
  decodeCompletedAction,
  type ExecutionObservation,
  isExecutionObservation,
  isScriptExecutionErrorCode,
  isScriptExecutionErrorDetail,
  type ScriptExecutionErrorDetail,
  type ScriptExecutionResult,
} from "./script-execution.js";
import { validateScript } from "./script-validator.js";

const log = createLogger("shell-executor");
const ACTION_PREFIX = COMPLETED_ACTION_CONTROL_PREFIX;
const ERROR_PREFIX = "__ALICE_ERROR__:";
const ERROR_DETAIL_PREFIX = "__ALICE_ERROR_DETAIL__:";
const OBSERVATION_PREFIX = "__ALICE_OBSERVATION__:";

/**
 * Централизованная очистка: удаление шума из вывода CLI, который LLM не должен видеть.
 *
 * Очистка в одной точке входа данных (парсинг stdout/stderr в shell-executor)
 * даёт выигрыш по всей цепочке — output-presenter, observations и рендеринг prompt получают чистый текст.
 */

// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape-коды
const ANSI_ESCAPE_RE = /\x1b\[[0-9;]*[A-Za-z]/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: OSC-последовательности (заголовок терминала и т.п.)
const OSC_RE = /\x1b\][^\x07]*\x07/g;
// В некоторых цепочках ESC теряется, оставляя обрывки вида `[4m` / `[22m`.
// Здесь напрямую матчим завершающие буквы ANSI/CSI — лучше срезать лишний шум, чем передавать мусор LLM.
const ORPHAN_ANSI_FRAGMENT_RE = /\[[0-9;]{1,6}(?:m|[ABCDHJKSTfhlmnsu])/g;
// Символы нулевой ширины / BOM не несут смысла для LLM и проявляются как «мусор».
const INVISIBLE_NOISE_RE = /[\u200b-\u200f\u2060\ufeff]/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: остаточные управляющие символы (\b backspace, \x7f DEL и т.д.; \t \n \r оставляем)
const CONTROL_CHAR_RE = /[\x00-\x08\x0b\x0c\x0e-\x1a\x7f]/g;

function sanitizeForLLM(text: string): string {
  return text
    .replace(ANSI_ESCAPE_RE, "") // [36m, [1m, [0m и прочие цвета/жирный/сброс
    .replace(OSC_RE, "") // OSC-последовательности (установка заголовка терминала и т.п.)
    .replace(ORPHAN_ANSI_FRAGMENT_RE, "") // обрывки [4m / [1m / [22m, лишившиеся ESC
    .replace(INVISIBLE_NOISE_RE, "") // невидимый шум: пробел нулевой ширины, BOM и др.
    .replace(CONTROL_CHAR_RE, ""); // остаточные управляющие символы
}

// Порт Engine API (вводится после старта index.ts)
let _enginePort = 0;
export function setEnginePort(port: number) {
  _enginePort = port;
}
export function getEnginePort(): number {
  return _enginePort;
}

/** Возвращает переменную окружения { ALICE_ENGINE_URL } (localhost на стороне хоста). При незаданном порте возвращает пустой объект. */
export function engineUrlEnv(): Record<string, string> {
  return _enginePort ? { ALICE_ENGINE_URL: `http://127.0.0.1:${_enginePort}` } : {};
}

export { ALICE_HOME };

/**
 * Известные системные команды Alice (используются при нормализации однострочных скриптов).
 * @see src/skills/registry.ts — BUILTIN_SYSTEM_REGISTRY
 */
// Зарезервировано: regex для определения команд (используется при рефакторинге preprocessScript)
// const ALICE_COMMANDS = /\b(irc|album|self|engine|alice-pkg)\b/;

function preprocessScript(script: string): string {
  let s = script.trim();
  if (/^```(?:sh|bash|shell)\n?/i.test(s)) {
    s = s.replace(/^```(?:sh|bash|shell)\n?/i, "");
    s = s.replace(/\n?```$/, "");
  }
  s = s.trim();
  // Structured outputs sometimes preserve the markdown language label as the
  // first script line. The executor already invokes /bin/sh; strip the label.
  s = s.replace(/^(?:sh|bash|shell)\s*\n/i, "").trim();

  // ── Нормализация однострочных скриптов ──
  // LLM иногда выдаёт однострочный скрипт: `# мысль1# мысль2irc say "hello" self feel ...`
  // В shell комментарий `#` поглощает всю строку, обнуляя все команды.
  // Исправление: вставляем перенос строки перед границей # и перед именами известных команд.
  if (!s.includes("\n")) {
    // 1. Вставляем перенос строки перед mid-line `# ` (разбиваем внутренний монолог)
    s = s.replace(/(?<=\S)\s*(?=# )/g, "\n");
    // 2. Вставляем перенос строки перед именами известных команд (разбиваем команды)
    //    (?<=['"。！？.!?\s]) требует кавычки, знак препинания или пробел перед — не ломаем слова
    //    \b требует полного имени команды — self в `self-conscious` (за ним `-`) не совпадает
    s = s.replace(
      /(?<=['"\u3002\uff01\uff1f.!?\s])((?:irc|album|self|engine|alice-pkg)\b)/g,
      "\n$1",
    );
  }

  return s.trim();
}

/**
 * Извлекает комментарии `# ...` из исходного скрипта как внутренний монолог LLM (thinks).
 *
 * Shell-контракт: "Use `# ...` comments as your inner monologue".
 * Эти комментарии — когнитивный след LLM (ReAct Thought), который должен попасть в
 * пайплайн thinks[] → feedback-arc reasoning → action_log.reasoning.
 *
 * @see docs/adr/70-react-loop-mapping.md — think() → ReAct Thought
 * @see docs/adr/163-expand-instruction-bt-native-disclosure.md — think — единственный Cognitive-примитив
 */
function extractThinks(script: string): string[] {
  const thinks: string[] = [];
  for (const line of script.split("\n")) {
    const trimmed = line.trim();
    // Пропускаем shebang, пустые комментарии и разделители секций
    if (trimmed.startsWith("#!")) continue;
    if (trimmed === "#") continue;
    if (/^#+$/.test(trimmed)) continue;
    if (trimmed.startsWith("# ")) {
      thinks.push(trimmed.slice(2));
    }
  }
  return thinks;
}

function toEnvValue(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function buildContextEnv(contextVars?: Record<string, unknown>): Record<string, string> {
  const env: Record<string, string> = {};
  if (!contextVars) return env;

  // Все contextVars вводятся с префиксом ALICE_CTX_ (напр. ALICE_CTX_TARGET_CHAT).
  // CLI-команды при отсутствии --to автоматически используют ALICE_CTX_TARGET_CHAT как fallback.

  const chatName = toEnvValue(contextVars.CHAT_NAME);
  if (chatName) env.ALICE_CHAT_NAME = chatName;

  for (const [key, value] of Object.entries(contextVars)) {
    const rendered = toEnvValue(value);
    if (rendered == null) continue;
    env[`ALICE_CTX_${key}`] = rendered;
  }

  return env;
}

function parseObservationControlLine(line: string): ExecutionObservation | string {
  const payload = line.slice(OBSERVATION_PREFIX.length);
  try {
    const parsed: unknown = JSON.parse(payload);
    if (isExecutionObservation(parsed)) return parsed;
    return "invalid __ALICE_OBSERVATION__: expected {kind,source,text,enablesContinuation}";
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `invalid __ALICE_OBSERVATION__: ${message}`;
  }
}

function parseErrorDetailControlLine(line: string): ScriptExecutionErrorDetail | string {
  const payload = line.slice(ERROR_DETAIL_PREFIX.length);
  try {
    const parsed: unknown = JSON.parse(payload);
    if (isScriptExecutionErrorDetail(parsed)) return parsed;
    return "invalid __ALICE_ERROR_DETAIL__: expected structured error detail";
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `invalid __ALICE_ERROR_DETAIL__: ${message}`;
  }
}

export async function executeShellScript(
  script: string,
  opts: { contextVars?: Record<string, unknown> },
): Promise<ScriptExecutionResult> {
  const startedAt = Date.now();
  const processed = preprocessScript(script);
  const result: ScriptExecutionResult = {
    logs: [],
    errors: [],
    instructionErrors: [],
    errorCodes: [],
    errorDetails: [],
    duration: 0,
    thinks: [],
    queryLogs: [],
    observations: [],
    completedActions: [],
    completedActionFacts: [],
    silenceReason: null,
  };

  // Извлекаем # комментарии из исходника скрипта как когнитивный след (thinks).
  // Извлечение до выполнения — мысли фиксируются даже при последующей ошибке скрипта.
  result.thinks = extractThinks(processed);

  if (!processed) {
    result.errors.push("Empty shell script");
    result.duration = Date.now() - startedAt;
    return result;
  }

  const validation = validateScript(processed);
  if (!validation.valid) {
    result.instructionErrors.push(
      ...validation.errors.map((err) => `line ${err.line}: ${err.message}`),
    );
    result.errorCodes.push("script_validation");
    result.duration = Date.now() - startedAt;
    return result;
  }

  const env = buildInstalledSkillEnv({
    skillName: "alice-system",
    // ALICE_ENGINE_URL вводится централизованно через buildDockerExecConfig в docker.ts
    // (через host.docker.internal:PORT).
    extraEnv: buildContextEnv(opts.contextVars),
  });

  const execResult = await executeInContainer(`set -e\n${processed}`, env);

  // Централизованная очистка: одна точка входа — выигрыш по всей цепочке
  const cleanStdout = sanitizeForLLM(execResult.stdout);
  const cleanStderr = sanitizeForLLM(execResult.stderr);

  const stdoutLines = cleanStdout
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);

  const visibleStdout = stdoutLines.filter((line) => {
    if (line.startsWith(ACTION_PREFIX)) {
      const rawAction = line.slice(ACTION_PREFIX.length);
      const action = decodeCompletedAction(rawAction);
      result.completedActions.push(rawAction);
      result.completedActionFacts?.push(action);
      if (action.kind === "malformed") {
        result.instructionErrors.push(`invalid __ALICE_ACTION__: ${action.reason}`);
      }
      return false; // фильтруем — не попадает в visible logs
    }
    if (line.startsWith(OBSERVATION_PREFIX)) {
      const observation = parseObservationControlLine(line);
      if (typeof observation === "string") {
        result.instructionErrors.push(observation);
      } else {
        result.observations.push(observation);
      }
      return false;
    }
    return true;
  });
  if (visibleStdout.length > 0) {
    result.logs.push(...visibleStdout);
  }

  const stderrLines = cleanStderr
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
  const visibleStderr = stderrLines.filter((line) => {
    if (line.startsWith(ERROR_DETAIL_PREFIX)) {
      const detail = parseErrorDetailControlLine(line);
      if (typeof detail === "string") {
        result.instructionErrors.push(detail);
      } else {
        result.errorDetails?.push(detail);
      }
      return false;
    }
    if (line.startsWith(ERROR_PREFIX)) {
      const code = line.slice(ERROR_PREFIX.length);
      if (isScriptExecutionErrorCode(code)) result.errorCodes.push(code);
      return false;
    }
    return true;
  });
  if (visibleStderr.length > 0) {
    result.errors.push(visibleStderr.join("\n"));
  }
  if (execResult.code !== 0 && visibleStderr.length === 0) {
    result.errors.push(`Shell exited with status ${execResult.code}`);
    result.errorCodes.push("shell_nonzero");
  }

  result.duration = Date.now() - startedAt;
  log.debug("Executed shell script", {
    duration: result.duration,
    stdoutLines: visibleStdout.length,
    stderr: result.errors.length,
  });
  return result;
}

// ═══════════════════════════════════════════════════════════════════════════
// Execution backends
// ═══════════════════════════════════════════════════════════════════════════

interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

/**
 * Container-isolated execution via Docker.
 *
 * Монтирует пространство команд Alice с хоста в соответствующие пути внутри контейнера,
 * чтобы LLM-скрипты имели доступ ко всем системным командам и установленным Skill.
 *
 * TCP-связь не зависит от монтирования сокета → все контейнеры единообразно используют gVisor (sandboxed).
 */
function executeInContainer(script: string, env: Record<string, string>): Promise<ExecResult> {
  return executeAliceSandboxProcess({
    command: script,
    image: DEFAULT_DOCKER_IMAGE,
    enginePort: _enginePort,
    skillName: "alice-system",
    network: true,
    memory: "1g",
    timeout: 35,
    env,
    includeAliceHome: true,
  });
}
