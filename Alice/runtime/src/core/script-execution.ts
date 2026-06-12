/**
 * Script execution result types.
 *
 * The shell-native executor (`shell-executor.ts`) is the execution backend.
 * This module provides the shared result types used across the tick pipeline.
 *
 * ADR-214 Wave B: ScriptExecutionResult 是唯一的执行结果类型。
 * ExecutableResult / RecordedAction 已删除——shell-native 架构下 Telegram 动作
 * 通过容器内 Engine API HTTP 直接执行，结果以 completedActions 字符串追踪。
 */

export type ExecutionObservationKind =
  | "new_message_context"
  | "query_result"
  | "state_snapshot"
  | "read_ack"
  | "empty";

export interface ExecutionObservation {
  kind: ExecutionObservationKind;
  source: string;
  text: string;
  enablesContinuation: boolean;
  currentChatId?: string | null;
  targetChatId?: string | null;
  payload?: Record<string, unknown>;
}

export const COMPLETED_ACTION_CONTROL_PREFIX = "__ALICE_ACTION__:";

export type CompletedAction =
  | { kind: "sent"; chatId: string; msgId: string; messageRef?: string }
  | { kind: "voice"; chatId: string; msgId: string }
  | { kind: "sticker"; chatId: string; msgId: string }
  | { kind: "react"; chatId: string; msgId: string; emoji?: string }
  | { kind: "sent-file"; chatId: string; msgId?: string; path?: string }
  | { kind: "forwarded"; fromChatId: string; toChatId: string; msgId: string }
  | { kind: "internal"; command: string }
  | { kind: "downloaded"; chatId: string; msgId: string; path?: string }
  | { kind: "unknown"; raw: string }
  | { kind: "malformed"; raw: string; reason: string };

export interface ScriptExecutionErrorDetail {
  code: ScriptExecutionErrorCode;
  source: string;
  currentChatId?: string | null;
  requestedChatId?: string | null;
  payload?: Record<string, unknown>;
}

export const EXECUTION_OBSERVATION_KINDS: readonly ExecutionObservationKind[] = [
  "new_message_context",
  "query_result",
  "state_snapshot",
  "read_ack",
  "empty",
] as const;

export function isExecutionObservationKind(value: unknown): value is ExecutionObservationKind {
  return (
    typeof value === "string" && (EXECUTION_OBSERVATION_KINDS as readonly string[]).includes(value)
  );
}

export function isExecutionObservation(value: unknown): value is ExecutionObservation {
  if (!value || typeof value !== "object") return false;
  const observation = value as Record<string, unknown>;
  return (
    isExecutionObservationKind(observation.kind) &&
    typeof observation.source === "string" &&
    typeof observation.text === "string" &&
    typeof observation.enablesContinuation === "boolean" &&
    (observation.currentChatId == null || typeof observation.currentChatId === "string") &&
    (observation.targetChatId == null || typeof observation.targetChatId === "string") &&
    (observation.payload == null ||
      (typeof observation.payload === "object" && !Array.isArray(observation.payload)))
  );
}

/** Unified script execution result used across the tick pipeline. */
export interface ScriptExecutionResult {
  logs: string[];
  errors: string[];
  instructionErrors: string[];
  /** 机器可解析错误码。运行时控制只能读取这里，不能从自然语言日志猜语义。 */
  errorCodes: ScriptExecutionErrorCode[];
  /** 机器可解析错误细节。仅供诊断事实写入；控制流不得从自然语言日志反推。 */
  errorDetails?: ScriptExecutionErrorDetail[];
  duration: number;
  thinks: string[];
  queryLogs: Array<{ fn: string; result: string }>;
  /** 机器可解析 observation fact。续轮控制只能读取这里，不能从 logs/queryLogs 猜语义。 */
  observations: ExecutionObservation[];
  /** 已完成的动作（shell 脚本输出的 __ALICE_ACTION__ 行）。格式: "sent:chatId=X:msgId=Y" 等。 */
  completedActions: string[];
  /** 已完成动作的机器可解析事实。语义判断以这里为准，completedActions 仅保留兼容。 */
  completedActionFacts?: CompletedAction[];
  /** LLM 主动选择沉默的原因（null = 非沉默）。 */
  silenceReason: string | null;
}

export function emptyScriptExecutionResult(
  overrides: Partial<ScriptExecutionResult> = {},
): ScriptExecutionResult {
  return {
    logs: overrides.logs ?? [],
    errors: overrides.errors ?? [],
    instructionErrors: overrides.instructionErrors ?? [],
    errorCodes: overrides.errorCodes ?? [],
    errorDetails: overrides.errorDetails ?? [],
    duration: overrides.duration ?? 0,
    thinks: overrides.thinks ?? [],
    queryLogs: overrides.queryLogs ?? [],
    observations: overrides.observations ?? [],
    completedActions: overrides.completedActions ?? [],
    completedActionFacts:
      overrides.completedActionFacts ??
      (overrides.completedActions ?? []).map((action) => decodeCompletedAction(action)),
    silenceReason: overrides.silenceReason ?? null,
  };
}

export function mergeScriptExecutionResults(
  results: readonly ScriptExecutionResult[],
): ScriptExecutionResult {
  const merged = emptyScriptExecutionResult();
  for (const result of results) {
    merged.logs.push(...result.logs);
    merged.errors.push(...result.errors);
    merged.instructionErrors.push(...result.instructionErrors);
    merged.errorCodes.push(...result.errorCodes);
    merged.errorDetails?.push(...(result.errorDetails ?? []));
    merged.duration += result.duration;
    merged.thinks.push(...result.thinks);
    merged.queryLogs.push(...result.queryLogs);
    merged.observations.push(...result.observations);
    merged.completedActions.push(...result.completedActions);
    merged.completedActionFacts?.push(...completedActionFacts(result));
    if (result.silenceReason && !merged.silenceReason) {
      merged.silenceReason = result.silenceReason;
    }
  }
  return merged;
}

export const SCRIPT_EXECUTION_ERROR_CODES = [
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
  "telegram_hard_permanent",
  "telegram_soft_permanent",
  "timeout",
  "provider_unavailable",
  "script_validation",
  "shell_nonzero",
] as const;

export type ScriptExecutionErrorCode = (typeof SCRIPT_EXECUTION_ERROR_CODES)[number];

export function isScriptExecutionErrorCode(value: string): value is ScriptExecutionErrorCode {
  return (SCRIPT_EXECUTION_ERROR_CODES as readonly string[]).includes(value);
}

export function isScriptExecutionErrorDetail(value: unknown): value is ScriptExecutionErrorDetail {
  if (!value || typeof value !== "object") return false;
  const detail = value as Record<string, unknown>;
  if (typeof detail.code !== "string" || !isScriptExecutionErrorCode(detail.code)) return false;
  if (typeof detail.source !== "string" || detail.source.length === 0) return false;
  if (
    detail.currentChatId !== undefined &&
    detail.currentChatId !== null &&
    typeof detail.currentChatId !== "string"
  ) {
    return false;
  }
  if (
    detail.requestedChatId !== undefined &&
    detail.requestedChatId !== null &&
    typeof detail.requestedChatId !== "string"
  ) {
    return false;
  }
  if (
    detail.payload !== undefined &&
    (detail.payload === null || typeof detail.payload !== "object" || Array.isArray(detail.payload))
  ) {
    return false;
  }
  return true;
}

// ── completedActions codec ────────────────────────────────────────────────

function malformedCompletedAction(raw: string, reason: string): CompletedAction {
  return { kind: "malformed", raw, reason };
}

function splitAction(raw: string): { kind: string; body: string } | null {
  const sep = raw.indexOf(":");
  if (sep < 0) return null;
  return { kind: raw.slice(0, sep), body: raw.slice(sep + 1) };
}

function decodeFields(body: string): Record<string, string> {
  const fields: Record<string, string> = {};
  let pos = 0;
  while (pos < body.length) {
    const eq = body.indexOf("=", pos);
    if (eq < 0) break;
    const key = body.slice(pos, eq);
    const nextKey = body.slice(eq + 1).search(/:[A-Za-z][A-Za-z0-9-]*=/);
    const valueEnd = nextKey < 0 ? body.length : eq + 1 + nextKey;
    fields[key] = body.slice(eq + 1, valueEnd);
    pos = valueEnd + 1;
  }
  return fields;
}

function requireField(
  raw: string,
  fields: Record<string, string>,
  key: string,
): string | CompletedAction {
  const value = fields[key];
  return value ? value : malformedCompletedAction(raw, `missing ${key}`);
}

export function decodeCompletedAction(raw: string): CompletedAction {
  const action = splitAction(raw);
  if (!action) return { kind: "unknown", raw };
  const fields = decodeFields(action.body);

  switch (action.kind) {
    case "sent": {
      const chatId = requireField(raw, fields, "chatId");
      if (typeof chatId !== "string") return chatId;
      const msgId = requireField(raw, fields, "msgId");
      if (typeof msgId !== "string") return msgId;
      return { kind: "sent", chatId, msgId, messageRef: fields.message };
    }
    case "voice": {
      const chatId = requireField(raw, fields, "chatId");
      if (typeof chatId !== "string") return chatId;
      const msgId = requireField(raw, fields, "msgId");
      if (typeof msgId !== "string") return msgId;
      return { kind: "voice", chatId, msgId };
    }
    case "sticker": {
      const chatId = requireField(raw, fields, "chatId");
      if (typeof chatId !== "string") return chatId;
      const msgId = requireField(raw, fields, "msgId");
      if (typeof msgId !== "string") return msgId;
      return { kind: "sticker", chatId, msgId };
    }
    case "react": {
      const chatId = requireField(raw, fields, "chatId");
      if (typeof chatId !== "string") return chatId;
      const msgId = requireField(raw, fields, "msgId");
      if (typeof msgId !== "string") return msgId;
      return { kind: "react", chatId, msgId, emoji: fields.emoji };
    }
    case "sent-file": {
      const chatId = requireField(raw, fields, "chatId");
      if (typeof chatId !== "string") return chatId;
      const msgId = fields.msgId;
      const path = fields.path;
      if (!msgId && !path) return malformedCompletedAction(raw, "missing msgId or path");
      return { kind: "sent-file", chatId, msgId, path };
    }
    case "forwarded": {
      const fromChatId = requireField(raw, fields, "from");
      if (typeof fromChatId !== "string") return fromChatId;
      const toChatId = requireField(raw, fields, "to");
      if (typeof toChatId !== "string") return toChatId;
      const msgId = requireField(raw, fields, "msgId");
      if (typeof msgId !== "string") return msgId;
      return { kind: "forwarded", fromChatId, toChatId, msgId };
    }
    case "internal": {
      const command = requireField(raw, fields, "command");
      if (typeof command !== "string") return command;
      return { kind: "internal", command };
    }
    case "downloaded": {
      const chatId = requireField(raw, fields, "chatId");
      if (typeof chatId !== "string") return chatId;
      const msgId = requireField(raw, fields, "msgId");
      if (typeof msgId !== "string") return msgId;
      return { kind: "downloaded", chatId, msgId, path: fields.path };
    }
    default:
      return { kind: "unknown", raw };
  }
}

export function encodeCompletedAction(action: CompletedAction): string {
  switch (action.kind) {
    case "sent":
      return `sent:chatId=${action.chatId}:msgId=${action.msgId}${
        action.messageRef ? `:message=${action.messageRef}` : ""
      }`;
    case "voice":
      return `voice:chatId=${action.chatId}:msgId=${action.msgId}`;
    case "sticker":
      return `sticker:chatId=${action.chatId}:msgId=${action.msgId}`;
    case "react":
      return `react:chatId=${action.chatId}:msgId=${action.msgId}${
        action.emoji ? `:emoji=${action.emoji}` : ""
      }`;
    case "sent-file": {
      const msgId = action.msgId ? `:msgId=${action.msgId}` : "";
      const path = action.path ? `:path=${action.path}` : "";
      return `sent-file:chatId=${action.chatId}${msgId}${path}`;
    }
    case "forwarded":
      return `forwarded:from=${action.fromChatId}:to=${action.toChatId}:msgId=${action.msgId}`;
    case "internal":
      return `internal:command=${action.command}`;
    case "downloaded":
      return `downloaded:chatId=${action.chatId}:msgId=${action.msgId}${
        action.path ? `:path=${action.path}` : ""
      }`;
    case "unknown":
    case "malformed":
      return action.raw;
  }
}

export function completedActionControlLine(action: CompletedAction): string {
  return `${COMPLETED_ACTION_CONTROL_PREFIX}${encodeCompletedAction(action)}`;
}

export function completedActionFacts(result: {
  completedActions?: readonly string[];
  completedActionFacts?: readonly CompletedAction[];
}): CompletedAction[] {
  if (result.completedActionFacts) return [...result.completedActionFacts];
  return (result.completedActions ?? []).map((action) => decodeCompletedAction(action));
}

export function isTelegramSideEffect(action: CompletedAction): boolean {
  return (
    action.kind === "sent" ||
    action.kind === "voice" ||
    action.kind === "sticker" ||
    action.kind === "react" ||
    action.kind === "sent-file" ||
    action.kind === "forwarded"
  );
}

export function hasInternalCompletedAction(result: {
  completedActions?: readonly string[];
  completedActionFacts?: readonly CompletedAction[];
}): boolean {
  return completedActionFacts(result).some((action) => action.kind === "internal");
}

export function countCompletedSentActions(result: {
  completedActions?: readonly string[];
  completedActionFacts?: readonly CompletedAction[];
}): number {
  return completedActionFacts(result).filter((action) => action.kind === "sent").length;
}

export function extractFirstExternalMessageId(result: {
  completedActions?: readonly string[];
  completedActionFacts?: readonly CompletedAction[];
}): string | null {
  const sent = completedActionFacts(result).find((action) => action.kind === "sent");
  if (!sent || sent.kind !== "sent") return null;
  return `${sent.chatId}:${sent.msgId}`;
}

/**
 * completedActions 是否包含真实出站消息动作。
 * 唯一传感器是 __ALICE_ACTION__。自然语言确认行只允许给人看，不能反向进入控制流。
 */
export function hasCompletedSend(result: {
  completedActions?: readonly string[];
  completedActionFacts?: readonly CompletedAction[];
}): boolean {
  return countTelegramSideEffects(result) > 0;
}

export function countTelegramSideEffects(result: {
  completedActions?: readonly string[];
  completedActionFacts?: readonly CompletedAction[];
}): number {
  return completedActionFacts(result).filter(isTelegramSideEffect).length;
}
