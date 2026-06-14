/**
 * irc — общие утилиты разбора аргументов.
 *
 * ADR-238: упрощено до чистых утилитарных функций; команды определены в irc.ts.
 *
 * Дизайн сигнатур команд (IRC-интуиция + строгий POSIX):
 *   irc say [--in TARGET] --text <text>
 *   irc reply [--in TARGET] --ref <msgId> --text <text>
 *   irc react [--in TARGET] --ref <msgId> --emoji <emoji>
 *   irc sticker [--in TARGET] --keyword <keyword>
 *   irc read [--in TARGET]
 *   irc tail [--in TARGET] [--count <number>]
 *   irc whois [--in TARGET] [--target <contact>]
 *   irc motd [--in TARGET]
 *   irc threads
 *   irc topic [--in TARGET]
 *   irc join --target <target>
 *   irc leave [--in TARGET]
 *   irc forward --from SOURCE --ref <msgId> [--to TARGET] [--comment <text>]
 *
 * --in TARGET = "в каком чате выполняется команда" (пространственный предлог, IRC "I'm in #channel").
 * --to TARGET используется только для forward (направление, "переслать в").
 * TARGET поддерживает @ID (стандарт чат-платформ), ~ID (обратная совместимость) и голое число.
 * Если не указан, контекст чата берётся автоматически из переменной окружения ALICE_CTX_TARGET_CHAT.
 * Алиасы совместимости: `0` / `me` / `@me` / `~me` / `current` / `here` / `this`
 * также разрешаются как текущий чат.
 *
 * @see docs/adr/238-citty-native-cli-redesign.md
 */

import { enginePost } from "../../skills/_lib/engine-client.js";
import { CliExecutionError } from "./cli-types.js";

// ── Общие утилиты разбора ──

const CURRENT_CHAT_ALIASES = new Set(["0", "me", "@me", "~me", "current", "here", "this"]);

/**
 * Разбирает --in TARGET (или --to/--from TARGET для forward).
 *
 * ADR-237: поддерживается разрешение имён.
 * - числовой ID / @число / ~число → возвращается напрямую как число
 * - имя / @имя → вызывается Engine API /resolve/name
 *
 * Если не указан, контекст чата берётся из переменной окружения ALICE_CTX_TARGET_CHAT.
 */
export async function resolveTarget(raw?: string): Promise<number> {
  const trimmed = raw?.trim();
  const currentChat = process.env.ALICE_CTX_TARGET_CHAT?.trim();
  const useCurrentChat = trimmed == null || trimmed === "" || CURRENT_CHAT_ALIASES.has(trimmed);
  const effective = useCurrentChat ? currentChat : trimmed;
  if (!effective) {
    throw new CliExecutionError("command_missing_argument", "missing target: use --in @ID");
  }

  // Убираем префикс @ или ~
  const stripped =
    effective.startsWith("@") || effective.startsWith("~") ? effective.slice(1) : effective;

  // Пытаемся разобрать как число
  const n = Number(stripped);
  if (Number.isFinite(n)) {
    return n;
  }

  // Не число → пробуем разрешить имя
  // Вызываем Engine API /resolve/name
  const result = (await enginePost("/resolve/name", { name: effective })) as {
    result?: { telegramId: number | null } | null;
  };

  if (result?.result?.telegramId != null) {
    return result.result.telegramId;
  }

  throw new CliExecutionError("command_invalid_target", `invalid target: "${effective}"`);
}

/**
 * Разбирает msgId, допуская префикс # в кавычках; интерфейс подсказок больше не показывает небезопасный для shell голый #.
 */
export function parseMsgId(raw: string): number {
  const stripped = raw.trim().replace(/^#/, "");
  if (/^(latest|last|recent)$/i.test(stripped)) {
    throw new CliExecutionError(
      "command_invalid_message_id",
      `invalid message ID: "${raw}" (use a visible current-chat msgId, never latest)`,
    );
  }
  if (!/^\d+$/.test(stripped)) {
    throw new CliExecutionError(
      "command_invalid_message_id",
      `invalid message ID: "${raw}" (expected a visible msgId like 5791)`,
    );
  }
  const n = Number(stripped);
  if (!Number.isSafeInteger(n) || n <= 0) {
    throw new CliExecutionError(
      "command_invalid_message_id",
      `invalid message ID: "${raw}" (expected a visible msgId like 5791)`,
    );
  }
  return n;
}

// ── Определение опции --in (общее для всех субкоманд, требующих target) ──

export const inOption = {
  type: "string" as const,
  description: "Target chat (@ID or numeric). Omit to use current chat context.",
};
