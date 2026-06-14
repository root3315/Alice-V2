/**
 * H17: Извлечение действий/инструкций/сигнала молчания из сгенерированного shell-скрипта.
 *
 * Контекст проблемы:
 * В shell-native архитектуре (ADR-246) LLM выводит POSIX-скрипт, который runtime исполняет
 * в Docker-контейнере. Telegram-действия выполняются ВНУТРИ контейнера через Engine API,
 * а их факты возвращаются строками `__ALICE_ACTION__:` (см. shell-executor.ts).
 *
 * Eval-runner работает в режиме записи (recording mode): он НЕ исполняет контейнер и НЕ
 * имеет живого Engine API. Поэтому completedActions/silenceReason нельзя получить реальным
 * исполнением. Вместо этого мы детерминированно ПАРСИМ текст скрипта и сопоставляем командные
 * строки тем формам, которые ожидает структурный grader (graders.ts).
 *
 * Это эквивалентно намерению "Wave B на основе completedActions": мы воспроизводим, какие
 * действия СОВЕРШИЛ БЫ скрипт, не запуская песочницу.
 *
 * Сопоставление (источник истины — определения CLI):
 * - irc say|reply|voice|forward  → telegram action send_message (reply/voice несут replyTo из --ref)
 * - irc react                    → telegram action react (несёт emoji)
 * - irc sticker                  → telegram action send_sticker
 * - irc send-file                → telegram action send_file
 * - self <cmd>                   → dispatch instruction <snake_cmd> (напр. self feel → feel)
 * - skill App bin                → dispatch action use_<x>_app / google / visit
 * - irc read|tail|whois|...      → observe/query — НЕ действие/инструкция/молчание
 * - скрипт только из # коммент.  → silenceReason = "no_executable_script"
 *
 * @see src/system/irc-cli.ts — ircSubCommands (say/reply/react/sticker/voice/forward/...)
 * @see skills/system-bin/self.ts — self <cmd> → POST /cmd/<snake_cmd> (instruction)
 * @see skills/<name>/manifest.yaml — bin-имена App-навыков
 * @see src/engine/tick/callLLM.ts — makeNoExecutableResult (silenceReason = "no_executable_script")
 * @see src/eval/graders.ts — EvalAction (потребитель этих форм)
 */
import { validateScript } from "../core/script-validator.js";
import type { EvalAction } from "./graders.js";

/** Сигнал молчания, идентичный runtime makeNoExecutableResult (callLLM.ts). */
export const NO_EXECUTABLE_SILENCE = "no_executable_script";

/**
 * Сопоставление имени bin App-навыка → логическое имя fn, которое проверяют сценарии eval.
 *
 * Сценарии утверждают логические имена (use_weather_app), а LLM в скрипте вызывает bin-команду
 * навыка (weather). Этот мост — единственное место сопоставления двух слоёв именования.
 *
 * @see skills/<name>/manifest.yaml (поле name = командный токен)
 * @see src/eval/scenarios/apps.ts (actions.must = логические имена)
 */
const APP_COMMAND_TO_FN: Readonly<Record<string, string>> = {
  weather: "use_weather_app",
  calendar: "use_calendar_app",
  countdown: "use_countdown_app",
  video: "use_video_app",
  trending: "use_trending_app",
  music: "use_music_app",
  // google/visit совпадают с логическим именем сценария
  google: "google",
  visit: "visit",
};

/** Подкоманды irc, отправляющие исходящее сообщение (→ telegram send_message). */
const IRC_MESSAGE_SUBCOMMANDS = new Set(["say", "reply", "voice", "forward"]);

/** Подкоманды irc, являющиеся только наблюдением/запросом (не действие/молчание). */
const IRC_OBSERVE_SUBCOMMANDS = new Set([
  "read",
  "tail",
  "whois",
  "whoami",
  "motd",
  "threads",
  "topic",
  "join",
  "leave",
  "download",
]);

export interface ParsedScriptActions {
  /** Telegram-сайд-эффекты + вызовы App (то, что сценарии проверяют через actions.*). */
  actions: EvalAction[];
  /** Когнитивные/учётные инструкции self (то, что сценарии проверяют через instructions.*). */
  instructions: EvalAction[];
  /** Сигнал молчания: установлен, только если скрипт не содержит исполняемых команд. */
  silenceReason: string | null;
}

interface ParsedLine {
  tokens: string[];
}

/**
 * Разбивает одну строку скрипта на shell-подобные токены с учётом кавычек.
 *
 * Поддерживает '...' (буквально), "..." (с экранированием \") и обрезает комментарий `#`,
 * начинающийся вне кавычек. Этого достаточно для извлечения имени команды и пар --flag value
 * из скриптов, генерируемых LLM (полноценный shell-парсер здесь не нужен).
 */
function tokenizeLine(line: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let hasToken = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];

    if (quote === "'") {
      if (ch === "'") quote = null;
      else current += ch;
      continue;
    }
    if (quote === '"') {
      if (ch === "\\" && i + 1 < line.length) {
        current += line[i + 1];
        i++;
      } else if (ch === '"') {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }

    // вне кавычек
    if (ch === "#") break; // начало комментария — конец значимых токенов
    if (ch === "'" || ch === '"') {
      quote = ch;
      hasToken = true;
      continue;
    }
    if (ch === "\\" && i + 1 < line.length) {
      current += line[i + 1];
      i++;
      hasToken = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (hasToken) {
        tokens.push(current);
        current = "";
        hasToken = false;
      }
      continue;
    }
    current += ch;
    hasToken = true;
  }
  if (hasToken) tokens.push(current);
  return tokens;
}

/**
 * Разбивает скрипт на исполняемые строки (без shebang/комментариев/пустых),
 * также разделяя простые `;`-соединённые команды на верхнем уровне.
 */
function parseExecutableLines(script: string): ParsedLine[] {
  const lines: ParsedLine[] = [];
  for (const rawLine of script.split("\n")) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const tokens = tokenizeLine(rawLine);
    if (tokens.length === 0) continue;

    // Разбиваем на границе ';' (поддержка `irc react ...; self feel ...` в одной строке).
    let segment: string[] = [];
    for (const tok of tokens) {
      if (tok === ";") {
        if (segment.length > 0) lines.push({ tokens: segment });
        segment = [];
        continue;
      }
      segment.push(tok);
    }
    if (segment.length > 0) lines.push({ tokens: segment });
  }
  return lines;
}

/** Извлекает значение --flag (или --flag=value) из массива токенов. */
function flagValue(tokens: string[], flag: string): string | undefined {
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok === flag) {
      const next = tokens[i + 1];
      if (next !== undefined && !next.startsWith("--")) return next;
      return undefined;
    }
    if (tok.startsWith(`${flag}=`)) return tok.slice(flag.length + 1);
  }
  return undefined;
}

/** kebab-case → snake_case (повторяет self.ts toSnake для имён инструкций). */
function toSnake(kebab: string): string {
  return kebab.replace(/-/g, "_");
}

function buildSendMessageArgs(tokens: string[]): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  const text = flagValue(tokens, "--text");
  if (text !== undefined) args.text = text;
  // reply/voice используют --ref как visible msgId, на который отвечают → replyTo (проверяет replyDirected).
  const ref = flagValue(tokens, "--ref");
  if (ref !== undefined) {
    const numeric = Number.parseInt(ref, 10);
    args.replyTo = Number.isNaN(numeric) ? ref : numeric;
  }
  return args;
}

/**
 * Парсит одну командную строку (массив токенов) в действие/инструкцию (или ничего).
 * Возвращает категорию для агрегации вызывающим кодом.
 */
function classifyCommand(
  tokens: string[],
  executedAt: number,
): { kind: "action" | "instruction"; action: EvalAction } | null {
  const command = tokens[0];
  const sub = tokens[1];

  if (command === "irc") {
    if (!sub || sub.startsWith("-")) return null;
    if (IRC_MESSAGE_SUBCOMMANDS.has(sub)) {
      return {
        kind: "action",
        action: {
          type: "telegram",
          fn: "send_message",
          args: buildSendMessageArgs(tokens),
          executedAt,
        },
      };
    }
    if (sub === "react") {
      const emoji = flagValue(tokens, "--emoji");
      return {
        kind: "action",
        action: {
          type: "telegram",
          fn: "react",
          args: emoji !== undefined ? { emoji } : {},
          executedAt,
        },
      };
    }
    if (sub === "sticker") {
      const keyword = flagValue(tokens, "--keyword");
      return {
        kind: "action",
        action: {
          type: "telegram",
          fn: "send_sticker",
          args: keyword !== undefined ? { keyword } : {},
          executedAt,
        },
      };
    }
    if (sub === "send-file") {
      return {
        kind: "action",
        action: { type: "telegram", fn: "send_file", args: {}, executedAt },
      };
    }
    // read/tail/whois/... — наблюдение/запрос: не действие.
    if (IRC_OBSERVE_SUBCOMMANDS.has(sub)) return null;
    return null;
  }

  if (command === "self") {
    if (!sub || sub.startsWith("-")) return null;
    // Каждая инструкция self → внутреннее действие fn=<snake_cmd> (self feel → feel).
    // Запросы (pressure/reminders/...) тоже проходят сюда; сценарии проверяют только инструкции
    // (feel и т. п.), поэтому отображение всех безопасно — лишние записи не вредят.
    return {
      kind: "instruction",
      action: { type: "dispatch", fn: toSnake(sub), args: {}, executedAt },
    };
  }

  // App-навыки (weather/calendar/google/visit/...) → действие с логическим именем сценария.
  const appFn = APP_COMMAND_TO_FN[command];
  if (appFn) {
    return {
      kind: "action",
      action: { type: "dispatch", fn: appFn, args: {}, executedAt },
    };
  }

  // Прочие команды (echo/grep/date/album/alice-pkg/...) не относятся к социальным
  // действиям/инструкциям, проверяемым grader.
  return null;
}

/**
 * Извлекает действия/инструкции/сигнал молчания из сгенерированного скрипта.
 *
 * Молчание определяется тем же критерием, что и runtime: если у скрипта нет исполняемых команд
 * (validateScript возвращает только no_executable), это намеренное молчание.
 *
 * @param script — сырой скрипт, выведенный LLM (до preprocessing — мы парсим его так же построчно)
 */
export function parseScriptActions(script: string): ParsedScriptActions {
  const actions: EvalAction[] = [];
  const instructions: EvalAction[] = [];

  const lines = parseExecutableLines(script);

  // Молчание: исполняемых команд нет. Совпадает с runtime makeNoExecutableResult (callLLM.ts),
  // который трактует скрипт как намеренное молчание, только если validateScript вернул no_executable
  // И присутствует хотя бы один комментарий (внутренний монолог "почему молчу"). Чистый пустой
  // скрипт без комментариев — вырожденный случай, не молчание (grader → no_action).
  if (lines.length === 0) {
    const validation = validateScript(script);
    const onlyNoExecutable =
      validation.errors.length > 0 &&
      validation.errors.every((error) => error.code === "no_executable");
    const hasComment = script.split("\n").some((line) => line.trim().startsWith("#"));
    return {
      actions,
      instructions,
      silenceReason: onlyNoExecutable && hasComment ? NO_EXECUTABLE_SILENCE : null,
    };
  }

  let counter = 0;
  for (const line of lines) {
    const classified = classifyCommand(line.tokens, counter++);
    if (!classified) continue;
    if (classified.kind === "action") actions.push(classified.action);
    else instructions.push(classified.action);
  }

  return { actions, instructions, silenceReason: null };
}
