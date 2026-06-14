/**
 * IRC команды — версия на чистых функциях (ADR-239, стиль GitHub CLI).
 *
 * Изменения ADR-239:
 * - --json принимает список полей через запятую (не boolean)
 * - команды возвращают rawResult для фильтрации полей
 * - форматирование вывода централизовано в makeRunner
 *
 * @see docs/adr/239-gh-cli-style-output-pipeline.md
 */

import type { ChatTailResponse } from "../core/chat-tail-contract.js";
import { sanitizeOutgoingText } from "../core/sandbox-schemas.js";
import {
  type CompletedAction,
  completedActionControlLine,
  type ExecutionObservation,
} from "../core/script-execution.js";
import { platformChannelId, telegramContactId } from "../graph/constants.js";
import {
  parseTelegramNativeId,
  parseTransportMessageId,
  parseTransportTargetId,
  stableTransportMessageId,
  type TransportTargetRef,
} from "../platform/transport.js";
import { ALLOWED_REACTIONS, normalizeReactionEmoji } from "../telegram/actions/shared.js";
import { renderConfirm, renderHuman, truncate } from "./cli-bridge.js";
import {
  type CliContext,
  type CliErrorDetail,
  CliExecutionError,
  makeDie,
  type SendResult,
} from "./cli-types.js";

export const OBSERVATION_PREFIX = "__ALICE_OBSERVATION__:";

interface TransportSendResult {
  platform?: string;
  target?: string;
  messageId?: string | null;
  nativeMessageId?: number | string | null;
}

interface ResolveTargetResult {
  target?: string;
}

interface TransportCommandTarget {
  ref: TransportTargetRef;
  chatId?: number;
}

function telegramTarget(chatId: number): string {
  return `channel:telegram:${chatId}`;
}

function telegramMessage(chatId: number, msgId: number): string {
  return stableTransportMessageId("telegram", String(chatId), msgId);
}

function transportChannelId(target: TransportCommandTarget): string {
  if (target.ref.kind === "channel") return target.ref.stableId;
  return platformChannelId(target.ref.platform, target.ref.nativeId);
}

function transportTargetLabel(target: TransportCommandTarget): string {
  return target.chatId == null ? target.ref.stableId : `@${target.chatId}`;
}

function graphGetPath(channelId: string, attr: string): string {
  return `/graph/${encodeURIComponent(channelId)}/${attr}`;
}

function actionLine(action: CompletedAction): string {
  return completedActionControlLine(action);
}

function nativeMsgId(result: SendResult | TransportSendResult | null): number | undefined {
  if (!result) return undefined;
  if (typeof (result as SendResult).msgId === "number") return (result as SendResult).msgId;
  const native = (result as TransportSendResult).nativeMessageId;
  return typeof native === "number" ? native : undefined;
}

async function resolveTransportTarget(
  ctx: CliContext,
  raw?: string,
): Promise<TransportCommandTarget> {
  const stable = parseTransportTargetId(raw?.trim());
  if (stable) {
    return {
      ref: stable,
      chatId:
        stable.platform === "telegram"
          ? (parseTelegramNativeId(stable.nativeId) ?? undefined)
          : undefined,
    };
  }

  const trimmed = raw?.trim();
  if (trimmed && !/^[@~]?-?\d+$/.test(trimmed)) {
    const resolved = (await ctx.engine.post("/resolve/target", { target: trimmed })) as {
      result?: ResolveTargetResult | null;
    } | null;
    const resolvedTarget = parseTransportTargetId(resolved?.result?.target);
    if (resolvedTarget) {
      return {
        ref: resolvedTarget,
        chatId:
          resolvedTarget.platform === "telegram"
            ? (parseTelegramNativeId(resolvedTarget.nativeId) ?? undefined)
            : undefined,
      };
    }
  }

  const chatId = await ctx.resolveTarget(raw);
  return {
    ref: parseTransportTargetId(telegramTarget(chatId)) as TransportTargetRef,
    chatId,
  };
}

function messageRefForTarget(target: TransportCommandTarget, raw: string): string {
  const stable = parseTransportMessageId(raw.trim());
  if (stable) return stable.stableId;

  const msgId = parseMsgId(raw);
  if (target.ref.platform !== "telegram" || target.chatId == null) {
    throw new CliExecutionError(
      "command_invalid_message_id",
      `invalid message ID: "${raw}" (use a stable message ref for ${target.ref.platform})`,
    );
  }
  return telegramMessage(target.chatId, msgId);
}

function nativeTelegramMsgIdFromRef(messageRef: string): number | undefined {
  const parsed = parseTransportMessageId(messageRef);
  if (!parsed || parsed.platform !== "telegram") return undefined;
  return parseTelegramNativeId(parsed.messageNativeId) ?? undefined;
}

export function assertCurrentChatForSend(
  ctx: CliContext,
  chatId: number,
  die: (msg: string, code?: "command_cross_chat_send", detail?: CliErrorDetail) => never,
  source = "irc.send",
  payload?: Record<string, unknown>,
) {
  if (ctx.currentChatId == null || chatId === ctx.currentChatId) return;
  die(
    `refusing cross-chat send: current chat is @${ctx.currentChatId}, requested @${chatId}. No message was sent there. If you need that chat to become current, use self switch-chat --to @${chatId} --reason "...". Use irc forward for sharing content here.`,
    "command_cross_chat_send",
    {
      code: "command_cross_chat_send",
      source,
      currentChatId: String(ctx.currentChatId),
      requestedChatId: String(chatId),
      ...(payload ? { payload } : {}),
    },
  );
}

function assertCurrentTransportTargetForSend(
  ctx: CliContext,
  target: TransportCommandTarget,
  die: (msg: string, code?: "command_cross_chat_send", detail?: CliErrorDetail) => never,
  source = "irc.send",
  payload?: Record<string, unknown>,
) {
  if (ctx.currentChatId == null) return;
  if (target.ref.platform === "telegram" && target.chatId === ctx.currentChatId) return;
  const requestedLabel =
    target.ref.platform === "telegram" && target.chatId != null
      ? `@${target.chatId}`
      : target.ref.stableId;
  die(
    `refusing cross-chat send: current chat is @${ctx.currentChatId}, requested ${requestedLabel}. No message was sent there. If you need that chat to become current, use self switch-chat --to ${requestedLabel} --reason "...". Use irc forward for sharing content here.`,
    "command_cross_chat_send",
    {
      code: "command_cross_chat_send",
      source,
      currentChatId: String(ctx.currentChatId),
      requestedChatId: target.ref.stableId,
      ...(payload ? { payload } : {}),
    },
  );
}

// ── Command Result Types ──

/** Результат выполнения команды — содержит всё, что нужно вывести. */
export interface CommandResult {
  /** строка трассировки action (например `__ALICE_ACTION__:sent:chatId=xxx:msgId=yyy`). */
  action?: string;
  /** структурированный observation-факт; поток управления читает только его, не пытаясь разобрать семантику из текста output. */
  observation?: ExecutionObservation;
  /** основное содержимое вывода (человекочитаемый текст). */
  output: string;
  /** сырой объект результата (для фильтрации JSON-полей). */
  rawResult?: unknown;
}

/** Обработчик команды — принимает контекст и аргументы, возвращает результат для вывода. */
export type CommandHandler<T = Record<string, unknown>> = (
  ctx: CliContext,
  args: T,
) => Promise<CommandResult>;

function chatObservationMeta(
  ctx: CliContext,
  chatId: number,
  payload?: Record<string, unknown>,
): Pick<ExecutionObservation, "currentChatId" | "targetChatId" | "payload"> {
  return {
    currentChatId: ctx.currentChatId == null ? null : String(ctx.currentChatId),
    targetChatId: String(chatId),
    ...(payload ? { payload } : {}),
  };
}

// ── Say Command ──

export interface SayArgs {
  json?: string;
  in?: string;
  text: string;
  "resolve-thread"?: string; // thread ID to resolve after sending (CLI flag format)
}

/** Логика команды say. */
export async function sayCommand(ctx: CliContext, args: SayArgs): Promise<CommandResult> {
  const die = makeDie(ctx.output, "irc");

  const target = await resolveTransportTarget(ctx, args.in);
  const text = sanitizeOutgoingText(args.text);

  if (!text.trim()) die("say requires non-empty text", "command_missing_argument");
  assertCurrentTransportTargetForSend(ctx, target, die, "irc.say");

  const result = (await ctx.engine.post("/transport/send", {
    target: target.ref.stableId,
    text,
  })) as TransportSendResult | null;

  const msgId = nativeMsgId(result);
  const action =
    msgId != null && target.chatId != null
      ? actionLine({
          kind: "sent",
          chatId: String(target.chatId),
          msgId: String(msgId),
          messageRef: telegramMessage(target.chatId, msgId),
        })
      : undefined;

  // ADR-240: resolve thread after sending message
  if (args["resolve-thread"]) {
    const threadId = Number(args["resolve-thread"]);
    if (!Number.isFinite(threadId) || threadId <= 0) {
      die("--resolve-thread requires a positive integer thread ID", "command_arg_format");
    }
    try {
      await ctx.engine.post("/dispatch/resolve_topic", { threadId });
    } catch (err) {
      // Don't fail the entire command if resolve fails
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`[resolve-thread] Failed to resolve thread #${threadId}: ${errMsg}`);
    }
  }

  return {
    action,
    output: renderConfirm("Sent", `"${truncate(text)}"`),
    rawResult: {
      msgId,
      chatId: target.chatId,
      target: target.ref.stableId,
      messageId: result?.messageId,
    },
  };
}

// ── Reply Command ──

export interface ReplyArgs {
  json?: string;
  in?: string;
  ref: string;
  text: string;
}

/** Разбирает ID сообщения (чистая функция). */
export function parseMsgId(raw: string): number {
  const normalized = raw.trim().replace(/^#/, "");
  if (/^(latest|last|recent)$/i.test(normalized)) {
    throw new CliExecutionError(
      "command_invalid_message_id",
      `invalid message ID: ${raw}; use a visible current-chat msgId, never latest`,
    );
  }
  if (!/^\d+$/.test(normalized)) {
    throw new CliExecutionError(
      "command_invalid_message_id",
      `invalid message ID: ${raw}; use a visible current-chat msgId`,
    );
  }
  const n = Number(normalized);
  if (!Number.isSafeInteger(n) || n <= 0) {
    throw new CliExecutionError(
      "command_invalid_message_id",
      `invalid message ID: ${raw}; use a visible current-chat msgId`,
    );
  }
  return n;
}

/** Логика команды reply. */
export async function replyCommand(ctx: CliContext, args: ReplyArgs): Promise<CommandResult> {
  const die = makeDie(ctx.output, "irc");

  const target = await resolveTransportTarget(ctx, args.in);
  let replyToMessage = "";
  try {
    replyToMessage = messageRefForTarget(target, args.ref);
  } catch (err) {
    die(
      err instanceof Error ? err.message : "invalid reply ref; use a visible current-chat msgId",
      "command_invalid_reply_ref",
    );
  }
  const text = sanitizeOutgoingText(args.text);
  const replyTo = nativeTelegramMsgIdFromRef(replyToMessage);

  if (!text.trim()) die("reply requires non-empty text", "command_missing_argument");
  assertCurrentTransportTargetForSend(ctx, target, die, "irc.reply", { replyToMessage });

  const result = (await ctx.engine.post("/transport/send", {
    target: target.ref.stableId,
    text,
    replyTo: replyToMessage,
  })) as TransportSendResult | null;

  const msgId = nativeMsgId(result);
  const action =
    msgId != null && target.chatId != null
      ? actionLine({
          kind: "sent",
          chatId: String(target.chatId),
          msgId: String(msgId),
          messageRef: telegramMessage(target.chatId, msgId),
        })
      : undefined;

  return {
    action,
    output: renderConfirm(
      "Replied to",
      `${replyTo == null ? replyToMessage : `#${replyTo}`}: "${truncate(text)}"`,
    ),
    rawResult: {
      msgId,
      chatId: target.chatId,
      target: target.ref.stableId,
      messageId: result?.messageId,
      replyTo,
      replyToMessage,
    },
  };
}

// ── React Command ──

export interface ReactArgs {
  json?: string;
  in?: string;
  ref: string;
  emoji: string;
}

function allowedReactionList(): string {
  return Array.from(ALLOWED_REACTIONS).join(" ");
}

/** Логика команды react. */
export async function reactCommand(ctx: CliContext, args: ReactArgs): Promise<CommandResult> {
  const die = makeDie(ctx.output, "irc");
  const target = await resolveTransportTarget(ctx, args.in);
  const messageRef = messageRefForTarget(target, args.ref);
  const msgId = nativeTelegramMsgIdFromRef(messageRef);
  const emoji = normalizeReactionEmoji(args.emoji);
  if (!ALLOWED_REACTIONS.has(emoji)) {
    die(
      `invalid reaction ${JSON.stringify(args.emoji)}; use one of: ${allowedReactionList()}`,
      "invalid_reaction",
    );
  }

  await ctx.engine.post("/transport/react", {
    target: target.ref.stableId,
    message: messageRef,
    emoji,
  });

  return {
    action:
      msgId != null && target.chatId != null
        ? actionLine({ kind: "react", chatId: String(target.chatId), msgId: String(msgId) })
        : undefined,
    output: renderConfirm(`Reacted ${emoji} to`, msgId == null ? messageRef : `#${msgId}`),
    rawResult: {
      success: true,
      chatId: target.chatId,
      msgId,
      target: target.ref.stableId,
      message: messageRef,
    },
  };
}

// ── Sticker Command ──

export interface StickerArgs {
  json?: string;
  in?: string;
  keyword: string;
}

/** Логика команды sticker. */
export async function stickerCommand(ctx: CliContext, args: StickerArgs): Promise<CommandResult> {
  const die = makeDie(ctx.output, "irc");

  const chatId = await ctx.resolveTarget(args.in);
  const keyword = args.keyword.trim();

  if (!keyword) die("sticker requires non-empty keyword", "command_missing_argument");
  assertCurrentChatForSend(ctx, chatId, die, "irc.sticker");

  const result = (await ctx.engine.post("/telegram/sticker", {
    chatId,
    sticker: keyword,
  })) as SendResult | null;

  const action =
    result?.msgId != null
      ? actionLine({ kind: "sticker", chatId: String(chatId), msgId: String(result.msgId) })
      : undefined;

  return {
    action,
    output: renderConfirm("Sent sticker", keyword),
    rawResult: { msgId: result?.msgId, chatId },
  };
}

// ── Voice Command ──

export interface VoiceArgs {
  json?: string;
  in?: string;
  emotion?: string;
  ref?: string;
  text: string;
}

/** Логика команды voice. */
export async function voiceCommand(ctx: CliContext, args: VoiceArgs): Promise<CommandResult> {
  const die = makeDie(ctx.output, "irc");

  const chatId = await ctx.resolveTarget(args.in);
  const text = sanitizeOutgoingText(args.text);

  if (!text) die("voice requires non-empty text", "command_missing_argument");
  assertCurrentChatForSend(
    ctx,
    chatId,
    die,
    "irc.voice",
    args.ref ? { replyRef: args.ref } : undefined,
  );

  const body: Record<string, unknown> = { chatId, text };
  if (args.emotion) body.emotion = args.emotion;
  if (args.ref) body.replyTo = parseMsgId(args.ref);

  const result = (await ctx.engine.post("/telegram/voice", body)) as SendResult | null;
  const deliveredAs = result?.deliveredAs ?? "voice";

  const action =
    result?.msgId != null
      ? actionLine({
          kind: deliveredAs === "text" ? "sent" : "voice",
          chatId: String(chatId),
          msgId: String(result.msgId),
        })
      : undefined;

  return {
    action,
    output: renderConfirm(
      deliveredAs === "text" ? "Sent text fallback" : "Sent voice",
      `"${truncate(text)}"`,
    ),
    rawResult: {
      msgId: result?.msgId,
      chatId,
      deliveredAs,
      fallbackReason: result?.fallbackReason,
    },
  };
}

// ── Read Command ──

export interface ReadArgs {
  json?: string;
  in?: string;
}

/** Логика команды read. */
export async function readCommand(ctx: CliContext, args: ReadArgs): Promise<CommandResult> {
  const target = await resolveTransportTarget(ctx, args.in);
  await ctx.engine.post("/transport/read", { target: target.ref.stableId });

  return {
    observation: {
      kind: "read_ack",
      source: "irc.read",
      text: `marked chat ${target.ref.stableId} as read`,
      enablesContinuation: false,
      ...(target.chatId == null
        ? {
            currentChatId: ctx.currentChatId == null ? null : String(ctx.currentChatId),
            targetChatId: target.ref.stableId,
          }
        : chatObservationMeta(ctx, target.chatId)),
    },
    output: renderConfirm("Marked as read"),
    rawResult: { success: true },
  };
}

// ── Tail Command ──

export interface TailArgs {
  json?: string;
  in?: string;
  count: string;
}

/** Логика команды tail. */
export async function tailCommand(ctx: CliContext, args: TailArgs): Promise<CommandResult> {
  const die = makeDie(ctx.output, "irc");

  const target = await resolveTransportTarget(ctx, args.in);
  const channelId = transportChannelId(target);
  const label = transportTargetLabel(target);
  const count = Number(args.count);

  if (!Number.isFinite(count)) die("tail count must be a number", "command_arg_format");

  const result = (await ctx.engine.get(
    `/chat/${encodeURIComponent(channelId)}/tail?limit=${count}`,
  )) as ChatTailResponse | null;

  // Помечаем источник (для удалённых чатов)
  const isRemote = args.in != null;
  const header = isRemote ? `[tail ${label}]\n` : "";

  const messages = result?.messages ?? [];
  if (messages.length === 0) {
    return {
      observation: {
        kind: "empty",
        source: "irc.tail",
        text: `no messages in chat ${label}`,
        enablesContinuation: false,
        ...(target.chatId == null
          ? {
              currentChatId: ctx.currentChatId == null ? null : String(ctx.currentChatId),
              targetChatId: channelId,
              payload: { count },
            }
          : chatObservationMeta(ctx, target.chatId, { count })),
      },
      output: `${header}(no messages)`,
      rawResult: [],
    };
  }

  const lines: string[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    const sender = m.sender ?? "?";
    const text = m.text ?? "";
    const prefix = m.id != null ? `(msgId ${m.id}) ` : "";
    lines.push(`${i + 1}. ${prefix}${sender}: "${truncate(text, 80)}"`);
  }

  return {
    observation: {
      kind: "new_message_context",
      source: "irc.tail",
      text: header + lines.join("\n"),
      enablesContinuation: true,
      ...(target.chatId == null
        ? {
            currentChatId: ctx.currentChatId == null ? null : String(ctx.currentChatId),
            targetChatId: channelId,
            payload: { count, messageCount: messages.length },
          }
        : chatObservationMeta(ctx, target.chatId, { count, messageCount: messages.length })),
    },
    output: header + lines.join("\n"),
    rawResult: messages,
  };
}

// ── Whois Command ──

export interface WhoisArgs {
  json?: string;
  in?: string;
  target?: string;
}

/** Извлекает value из ответа по атрибуту графа (чистая функция). */
export function gval(res: unknown): unknown {
  return (res as { value?: unknown } | null)?.value ?? null;
}

/** Логика команды whois. */
export async function whoisCommand(ctx: CliContext, args: WhoisArgs): Promise<CommandResult> {
  const target = args.target?.trim() || undefined;

  if (target) {
    // whois NAME/@ID → профиль контакта
    const stripped = target.startsWith("@") || target.startsWith("~") ? target.slice(1) : target;

    // Пробуем разобрать как числовой ID
    const n = Number(stripped);
    let contactId: string;

    if (Number.isFinite(n)) {
      contactId = telegramContactId(n);
    } else {
      // Пробуем разрешить имя
      const resolveResult = (await ctx.engine.post("/resolve/name", { name: target })) as {
        result?: { telegramId: number | null } | null;
      };
      if (resolveResult?.result?.telegramId != null) {
        contactId = telegramContactId(resolveResult.result.telegramId);
      } else {
        throw new Error(`contact not found: "${target}"`);
      }
    }

    const result = await ctx.engine.query("/query/contact_profile", { contactId });
    const output = renderHuman(result);
    return {
      observation: {
        kind: result == null ? "empty" : "query_result",
        source: "irc.whois",
        text: output,
        enablesContinuation: result != null,
      },
      output,
      rawResult: result,
    };
  }

  // whois (без аргументов) → информация о чате
  const targetRef = await resolveTransportTarget(ctx, args.in);
  const chatId = targetRef.chatId ?? targetRef.ref.stableId;
  const channelId = transportChannelId(targetRef);
  const [name, chatType, topic, unread, pendingDirected, aliceRole] = await Promise.all([
    ctx.engine.get(graphGetPath(channelId, "display_name")),
    ctx.engine.get(graphGetPath(channelId, "chat_type")),
    ctx.engine.get(graphGetPath(channelId, "topic")),
    ctx.engine.get(graphGetPath(channelId, "unread")),
    ctx.engine.get(graphGetPath(channelId, "pending_directed")),
    ctx.engine.get(graphGetPath(channelId, "alice_role")),
  ]);

  const data = {
    chatId,
    name: gval(name),
    chatType: gval(chatType),
    topic: gval(topic),
    unread: gval(unread) ?? 0,
    pendingDirected: gval(pendingDirected) ?? 0,
    role: gval(aliceRole),
  };

  const lines = [
    `Channel: ${data.name ?? chatId}`,
    data.chatType ? `Type: ${data.chatType}` : null,
    data.topic ? `Topic: "${data.topic}"` : null,
    `Unread: ${data.unread}`,
    `Pending directed: ${data.pendingDirected}`,
    data.role ? `Your role: ${data.role}` : null,
  ].filter((l): l is string => l != null);

  return {
    observation: {
      kind: "state_snapshot",
      source: "irc.whois",
      text: lines.join("\n"),
      enablesContinuation: true,
    },
    output: lines.join("\n"),
    rawResult: data,
  };
}

// ── Motd Command ──

export interface MotdArgs {
  json?: string;
  in?: string;
}

/** Логика команды motd. */
export async function motdCommand(ctx: CliContext, args: MotdArgs): Promise<CommandResult> {
  const target = await resolveTransportTarget(ctx, args.in);
  const result = await ctx.engine.query("/query/chat_mood", { chatId: transportChannelId(target) });

  const output = renderHuman(result);
  return {
    observation: {
      kind: result == null ? "empty" : "query_result",
      source: "irc.motd",
      text: output,
      enablesContinuation: result != null,
    },
    output,
    rawResult: result,
  };
}

// ── Threads Command ──

export interface ThreadsArgs {
  json?: string;
}

/** Логика команды threads. */
export async function threadsCommand(ctx: CliContext, _args: ThreadsArgs): Promise<CommandResult> {
  const result = await ctx.engine.query("/query/open_topics", {});
  const output = renderHuman(result);
  const hasThreads = Array.isArray(result) ? result.length > 0 : result != null;
  return {
    observation: {
      kind: hasThreads ? "query_result" : "empty",
      source: "irc.threads",
      text: output,
      enablesContinuation: hasThreads,
    },
    output,
    rawResult: result,
  };
}

// ── Join Command ──

export interface JoinArgs {
  json?: string;
  target: string;
}

/** Логика команды join. */
export async function joinCommand(ctx: CliContext, args: JoinArgs): Promise<CommandResult> {
  const die = makeDie(ctx.output, "irc");

  const chatIdOrLink = args.target.trim();
  if (!chatIdOrLink) die("join requires a target", "command_missing_argument");

  const result = await ctx.engine.post("/telegram/join", { chatIdOrLink });

  return { output: renderConfirm("Joined", chatIdOrLink), rawResult: result };
}

// ── Leave Command ──

export interface LeaveArgs {
  json?: string;
  in?: string;
}

/** Логика команды leave. */
export async function leaveCommand(ctx: CliContext, args: LeaveArgs): Promise<CommandResult> {
  const chatId = await ctx.resolveTarget(args.in);
  const result = await ctx.engine.post("/telegram/leave", { chatId });

  return { output: renderConfirm("Left chat"), rawResult: result };
}
