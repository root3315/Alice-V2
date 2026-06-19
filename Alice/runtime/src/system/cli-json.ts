/**
 * CLI выборка JSON-полей — стиль GitHub CLI (ADR-239).
 *
 * --json принимает список полей через запятую; неизвестные поля вызывают ошибку с перечислением допустимых.
 * Поведение соответствует GitHub CLI: `gh issue list --json invalid` → ошибка.
 *
 * Принципы FP-дизайна:
 * - discriminated union выражает режим вывода
 * - as const гарантирует иммутабельность
 * - дженерики сохраняют типовую информацию
 */

// ── Output Mode (Sum Type) ──

/** Режим вывода — discriminated union, полное покрытие на этапе компиляции. */
export type OutputMode =
  | { type: "human" } // человекочитаемый текст
  | { type: "json"; fields: string[] | undefined }; // JSON-режим; fields=undefined означает все поля

/** Разбирает режим вывода из аргумента --json. */
export function parseOutputMode(
  command: CommandName | string,
  jsonArg: string | undefined,
): OutputMode {
  // Нет аргумента → человекочитаемый режим
  if (jsonArg === undefined) return { type: "human" };

  // Пустая строка → JSON со всеми полями
  if (jsonArg === "") return { type: "json", fields: undefined };

  const requested = jsonArg
    .split(",")
    .map((f) => f.trim())
    .filter(Boolean);

  // Проверяем, есть ли команда в реестре
  const available = command in COMMAND_FIELDS ? COMMAND_FIELDS[command as CommandName] : undefined;

  // Команда не зарегистрирована → разрешаем любые поля
  if (!available) {
    return { type: "json", fields: requested.length > 0 ? requested : undefined };
  }

  // Валидация полей — Set для удобочитаемости
  const validSet = new Set<string>(available);
  const invalid = requested.filter((f) => !validSet.has(f));
  if (invalid.length > 0) {
    throw new Error(
      `Unknown JSON field: ${invalid.map((f) => `"${f}"`).join(", ")}\n` +
        `Available fields:\n  ${available.join("\n  ")}`,
    );
  }

  return { type: "json", fields: requested };
}

// ── Field Registry (Immutable) ──

/** Реестр доступных полей команд — as const гарантирует иммутабельность. */
export const COMMAND_FIELDS = {
  // Основные команды
  say: ["msgId", "chatId"] as const,
  reply: ["msgId", "chatId", "replyTo"] as const,
  react: ["success", "chatId", "msgId"] as const,
  sticker: ["msgId", "chatId"] as const,
  checklist: ["msgId", "chatId"] as const,
  check: ["msgId", "chatId"] as const,
  pin: ["ok", "chatId"] as const,
  unpin: ["ok", "chatId"] as const,
  "self-source": ["path", "content", "truncated", "entries", "dir", "error"] as const,
  "forum-topics": ["topics", "chatId"] as const,
  poll: ["msgId", "chatId"] as const,
  vote: ["voted", "chatId", "msgId"] as const,
  "index-pack": ["started", "shortName", "estimated", "message"] as const,
  table: ["msgId", "chatId"] as const,
  voice: ["msgId", "chatId"] as const,
  read: ["success"] as const,
  join: ["success", "chatId"] as const,
  leave: ["success"] as const,
  "send-file": ["msgId", "chatId", "path"] as const,
  download: ["path", "mime", "size"] as const,
  forward: ["forwardedMsgId", "commentMsgId"] as const,
  "album-search": [
    "assetId",
    "sourceChatId",
    "sourceMsgId",
    "captionText",
    "description",
    "wdTagsJson",
    "ocrText",
    "sourceStatus",
    "score",
    "snippet",
  ] as const,
  "album-send": ["msgId", "chatId", "assetId", "sendMode"] as const,

  // Команды запроса
  whois: ["chatId", "name", "chatType", "topic", "unread", "pendingDirected", "role"] as const,
  motd: ["mood", "valence", "tension"] as const,
  tail: [
    "id",
    "sender",
    "senderId",
    "text",
    "mediaType",
    "outgoing",
    "directed",
    "timestamp",
  ] as const,
  threads: ["id", "title", "priority", "status"] as const,
  topic: ["chatId", "topic"] as const,
} as const;

/** Тип имени команды — выводится из реестра, устраняет магические строки. */
export type CommandName = keyof typeof COMMAND_FIELDS;

// ── Output Filtering (Generic) ──

/** Фильтрует объект, оставляя только указанные поля. Дженерик сохраняет типовую информацию. */
export function filterFields<T extends Record<string, unknown>>(
  obj: T,
  fields: readonly string[] | undefined,
): Partial<T> {
  if (!fields || fields.length === 0) return obj;
  const result: Partial<T> = {};
  for (const key of Object.keys(obj) as (keyof T)[]) {
    if (fields.includes(key as string)) {
      result[key] = obj[key];
    }
  }
  return result;
}

/** Фильтрует поля элементов массива. */
export function filterArrayFields<T extends Record<string, unknown>>(
  arr: T[],
  fields: readonly string[] | undefined,
): Partial<T>[] {
  if (!fields || fields.length === 0) return arr;
  return arr.map((item) => filterFields(item, fields));
}

/** Единая точка входа фильтрации — обрабатывает одиночный объект или массив. */
export function filterOutput<T extends Record<string, unknown>>(
  data: T | T[],
  fields: readonly string[] | undefined,
): Partial<T> | Partial<T>[] {
  return Array.isArray(data) ? filterArrayFields(data, fields) : filterFields(data, fields);
}
