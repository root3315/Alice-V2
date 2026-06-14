/**
 * CLI определения типов — абстракция IO-интерфейса (ADR-235 FP-улучшение).
 *
 * Разделяет логику команд и реализацию IO, делая обработку команд юнит-тестируемой.
 *
 * @see docs/adr/235-cli-human-readable-output.md
 */

// ── Engine Client ──

/** Интерфейс клиента Engine API. */
export interface EngineClient {
  /** POST-запрос, возвращает разобранный JSON или null. */
  post: (path: string, body: unknown) => Promise<unknown | null>;

  /** GET-запрос, возвращает разобранный JSON или null. */
  get: (path: string) => Promise<unknown | null>;

  /** POST для Query-эндпоинтов (автоматически распаковывает {ok, result}). */
  query: (path: string, body: unknown) => Promise<unknown | null>;
}

// ── Output ──

/** Интерфейс вывода. */
export interface Output {
  /** Стандартный вывод. */
  log: (msg: string) => void;

  /** Стандартный поток ошибок. */
  error: (msg: string) => void;

  /** Завершение процесса. */
  exit: (code: number) => never;
}

// ── Structured Error Protocol ──

export const CLI_ERROR_PREFIX = "__ALICE_ERROR__:";
export const CLI_ERROR_DETAIL_PREFIX = "__ALICE_ERROR_DETAIL__:";

export const CLI_ERROR_CODES = [
  "command_cross_chat_send",
  "command_invalid_target",
  "command_invalid_message_id",
  "command_invalid_reply_ref",
  "command_missing_argument",
  "command_arg_format",
  "invalid_reaction",
  "invalid_sticker_keyword",
  "unreachable_telegram_user",
  "voice_messages_forbidden",
  "album_asset_not_found",
  "album_source_missing",
  "album_source_inaccessible",
  "album_forward_restricted",
  "album_send_failed",
  "telegram_hard_permanent",
  "telegram_soft_permanent",
  "timeout",
] as const;

export type CliErrorCode = (typeof CLI_ERROR_CODES)[number];

export interface CliErrorDetail {
  code: CliErrorCode;
  source: string;
  currentChatId?: string | null;
  requestedChatId?: string | null;
  payload?: Record<string, unknown>;
}

export function isCliErrorCode(value: string): value is CliErrorCode {
  return (CLI_ERROR_CODES as readonly string[]).includes(value);
}

export class CliExecutionError extends Error {
  constructor(
    readonly code: CliErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "CliExecutionError";
  }
}

export function emitCliErrorCode(output: Output, code: CliErrorCode): void {
  output.error(`${CLI_ERROR_PREFIX}${code}`);
}

export function emitCliErrorDetail(output: Output, detail: CliErrorDetail): void {
  output.error(`${CLI_ERROR_DETAIL_PREFIX}${JSON.stringify(detail)}`);
}

// ── Target Resolver ──

/** Разрешает ID целевого чата (возвращает number для Engine API). */
export type TargetResolver = (target: string | undefined) => Promise<number>;

// ── Command Context ──

/** Контекст выполнения команды — содержит все IO-зависимости. */
export interface CliContext {
  engine: EngineClient;
  output: Output;
  resolveTarget: TargetResolver;
  /** ID чата текущего контекста выполнения; команды отправки используют его для блокировки межчатовых инициативных сообщений. */
  currentChatId?: number;
}

// ── Result Types ──

/** Результат отправки сообщения. */
export interface SendResult {
  msgId?: number;
  deliveredAs?: "voice" | "text";
  fallbackReason?: string;
}

/** Результат загрузки файла. */
export interface DownloadResult {
  path?: string;
  mime?: string;
  size?: number;
}

/** Результат пересылки сообщения. */
export interface ForwardResult {
  forwardedMsgId?: number;
  commentMsgId?: number;
}

// ── Error Formatting ──

/** Форматирует ошибку CLI (чистая функция). */
export function formatCliError(cliName: string, msg: string): string {
  return `✗ ${cliName}: ${msg}`;
}

/** Создаёт функцию завершения с ошибкой (замыкание). */
export function makeDie(
  output: Output,
  cliName: string,
): (msg: string, code?: CliErrorCode, detail?: CliErrorDetail) => never {
  return (msg: string, code?: CliErrorCode, detail?: CliErrorDetail): never => {
    if (code) emitCliErrorCode(output, code);
    if (detail) emitCliErrorDetail(output, detail);
    output.error(formatCliError(cliName, msg));
    output.exit(1);
  };
}

// ── Re-export Command Args Types ──

// Эти типы определены в cli-commands.ts, re-export для удобства использования
export type {
  CommandResult,
  JoinArgs,
  LeaveArgs,
  MotdArgs,
  ReactArgs,
  ReadArgs,
  ReplyArgs,
  SayArgs,
  StickerArgs,
  TailArgs,
  ThreadsArgs,
  VoiceArgs,
  WhoisArgs,
} from "./cli-commands.js";
