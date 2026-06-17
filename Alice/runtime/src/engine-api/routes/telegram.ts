/**
 * Engine API — Telegram syscall routes.
 *
 * POST /telegram/send    → { msgId: number | null }
 * POST /telegram/read    → { ok: true }
 * POST /telegram/react   → { ok: true }
 * POST /telegram/sticker → { msgId: number | null }
 * POST /telegram/checklist → { msgId: number | null }   (native tappable To-Do list)
 * POST /telegram/poll    → { msgId: number | null }     (native poll / опрос — free feature)
 * POST /telegram/table   → { msgId: number | null }     (scrollable rich table)
 * POST /telegram/join    → { ok: true }
 * POST /telegram/leave   → { ok: true }
 * POST /telegram/forward → { forwardedMsgId: number | null }
 *
 * LLM-facing surface should stay IRC-like (`irc`); these are syscalls.
 */

import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { ALLOWED_REACTIONS, normalizeReactionEmoji } from "../../telegram/actions/shared.js";
import { isTelegramActionError } from "../../telegram/errors.js";
import type { EngineApiDeps } from "../server.js";
import { TARGET_NOT_WHITELISTED_CODE, telegramTargetAllowed } from "../target-policy.js";

/**
 * ПРИВАТНОСТЬ: пересылка из приватного 1:1 чата (положительный Telegram id = пользователь) в ДРУГОЙ
 * чат запрещена — контент ЛС не должен утекать в группы/каналы через forward. Пересылка из
 * групп/каналов (id < 0, курирование) разрешена; пересылка внутри того же ЛС (to == from) безвредна.
 */
export function isPrivateForwardBlocked(fromChatId: number, toChatId: number): boolean {
  return fromChatId > 0 && toChatId !== fromChatId;
}

// ── Кэш дедупликации: предотвращает повторную отправку уже успешных сообщений при повторных попытках LLM ──

const DEDUPE_TTL_MS = 30_000;
const DEDUPE_MAX_SIZE = 1000;

interface DedupeEntry {
  msgId: number;
  ts: number;
}

const recentSends = new Map<string, DedupeEntry>();

function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

/** Порог очистки = 2×TTL, оставляет grace period во избежание гонки при удалении только что устаревших записей */
const DEDUPE_CLEANUP_MS = DEDUPE_TTL_MS * 2;

function dedupeCleanup(): void {
  const now = Date.now();
  for (const [key, entry] of recentSends) {
    if (now - entry.ts > DEDUPE_CLEANUP_MS) recentSends.delete(key);
  }
}

setInterval(dedupeCleanup, DEDUPE_CLEANUP_MS).unref();

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > 1024 * 1024) {
        req.destroy();
        reject(new Error("body too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf-8");
        resolve(raw.length > 0 ? JSON.parse(raw) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function badRequest(res: ServerResponse, error: string): void {
  res.writeHead(400, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error }));
}

function notConfigured(res: ServerResponse, action: string): void {
  res.writeHead(501, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: `telegram ${action} not configured` }));
}

function typedInputError(
  res: ServerResponse,
  code: string,
  error: string,
  details?: Record<string, unknown>,
): void {
  res.writeHead(400, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ code, error, ...details }));
}

function allowedReactionList(): string[] {
  return Array.from(ALLOWED_REACTIONS);
}

function ensureTargetAllowed(res: ServerResponse, deps: EngineApiDeps, chatId: number): boolean {
  if (telegramTargetAllowed(deps.targetWhitelist, chatId)) return true;
  typedInputError(res, TARGET_NOT_WHITELISTED_CODE, "target is outside Alice's allowed rooms", {
    target: `channel:telegram:${chatId}`,
  });
  return false;
}

function serverError(res: ServerResponse, fallback: string, err: unknown): void {
  if (isTelegramActionError(err)) {
    typedInputError(res, err.code, err.message, err.details);
    return;
  }

  // ADR-237: логируем полный стек ошибки для диагностики
  console.error(`[Engine API] ${fallback}:`, err instanceof Error ? err.stack : err);
  res.writeHead(500, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: err instanceof Error ? err.message : fallback }));
}

export async function handleTelegramForward(
  action: string,
  req: IncomingMessage,
  res: ServerResponse,
  deps: EngineApiDeps,
): Promise<void> {
  let body: unknown;
  try {
    body = await readBody(req);
  } catch {
    badRequest(res, "invalid JSON body");
    return;
  }

  if (action === "send") {
    if (!deps.telegramSend) {
      notConfigured(res, "send");
      return;
    }
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      badRequest(res, 'body must be { "chatId": number, "text": string, "replyTo"?: number }');
      return;
    }
    const { chatId, text, replyTo } = body as {
      chatId?: number;
      text?: string;
      replyTo?: number;
    };
    if (typeof chatId !== "number" || typeof text !== "string" || text.length === 0) {
      badRequest(res, 'body must be { "chatId": number, "text": string, "replyTo"?: number }');
      return;
    }
    if (!ensureTargetAllowed(res, deps, chatId)) return;
    // Дедупликация: одинаковый chatId + text в течение 30 секунд → возвращаем кэшированный результат
    const dedupeKey = `${chatId}:${hashText(text)}`;
    const cached = recentSends.get(dedupeKey);
    if (cached && Date.now() - cached.ts < DEDUPE_TTL_MS) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ msgId: cached.msgId, deduplicated: true }));
      return;
    }
    // Защита от переполнения LRU
    if (recentSends.size >= DEDUPE_MAX_SIZE) dedupeCleanup();
    try {
      const result = await deps.telegramSend({ chatId, text, replyTo });
      if (result.msgId != null) {
        recentSends.set(dedupeKey, { msgId: result.msgId, ts: Date.now() });
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    } catch (err) {
      serverError(res, "send failed", err);
    }
    return;
  }

  if (action === "read") {
    if (!deps.telegramMarkRead) {
      notConfigured(res, "read");
      return;
    }
    if (
      body === null ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      typeof (body as { chatId?: unknown }).chatId !== "number"
    ) {
      badRequest(res, 'body must be { "chatId": number }');
      return;
    }
    try {
      const result = await deps.telegramMarkRead((body as { chatId: number }).chatId);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    } catch (err) {
      serverError(res, "read failed", err);
    }
    return;
  }

  if (action === "react") {
    if (!deps.telegramReact) {
      notConfigured(res, "react");
      return;
    }
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      badRequest(res, 'body must be { "chatId": number, "msgId": number, "emoji": string }');
      return;
    }
    const { chatId, msgId, emoji } = body as {
      chatId?: number;
      msgId?: number;
      emoji?: string;
    };
    if (typeof chatId !== "number" || typeof msgId !== "number" || typeof emoji !== "string") {
      badRequest(res, 'body must be { "chatId": number, "msgId": number, "emoji": string }');
      return;
    }
    if (!ensureTargetAllowed(res, deps, chatId)) return;
    const normalizedEmoji = normalizeReactionEmoji(emoji);
    if (!ALLOWED_REACTIONS.has(normalizedEmoji)) {
      typedInputError(res, "invalid_reaction", "invalid reaction: use a Telegram-supported emoji", {
        allowed: allowedReactionList(),
      });
      return;
    }
    try {
      const result = await deps.telegramReact({ chatId, msgId, emoji: normalizedEmoji });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    } catch (err) {
      serverError(res, "react failed", err);
    }
    return;
  }

  if (action === "join") {
    if (!deps.telegramJoin) {
      notConfigured(res, "join");
      return;
    }
    if (
      body === null ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      typeof (body as { chatIdOrLink?: unknown }).chatIdOrLink !== "string"
    ) {
      badRequest(res, 'body must be { "chatIdOrLink": string }');
      return;
    }
    try {
      const result = await deps.telegramJoin((body as { chatIdOrLink: string }).chatIdOrLink);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    } catch (err) {
      serverError(res, "join failed", err);
    }
    return;
  }

  if (action === "leave") {
    if (!deps.telegramLeave) {
      notConfigured(res, "leave");
      return;
    }
    if (
      body === null ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      typeof (body as { chatId?: unknown }).chatId !== "number"
    ) {
      badRequest(res, 'body must be { "chatId": number }');
      return;
    }
    try {
      const result = await deps.telegramLeave((body as { chatId: number }).chatId);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    } catch (err) {
      serverError(res, "leave failed", err);
    }
    return;
  }

  if (action === "sticker") {
    if (!deps.telegramSticker) {
      notConfigured(res, "sticker");
      return;
    }
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      badRequest(res, 'body must be { "chatId": number, "sticker": string }');
      return;
    }
    const { chatId, sticker } = body as {
      chatId?: number;
      sticker?: string;
    };
    if (typeof chatId !== "number" || typeof sticker !== "string" || sticker.length === 0) {
      badRequest(res, 'body must be { "chatId": number, "sticker": string }');
      return;
    }
    if (!ensureTargetAllowed(res, deps, chatId)) return;
    try {
      const result = await deps.telegramSticker({ chatId, sticker });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    } catch (err) {
      serverError(res, "sticker failed", err);
    }
    return;
  }

  if (action === "checklist") {
    if (!deps.telegramChecklist) {
      notConfigured(res, "checklist");
      return;
    }
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      badRequest(
        res,
        'body must be { "chatId": number, "items": string[], "title"?: string, "replyTo"?: number }',
      );
      return;
    }
    const { chatId, items, title, replyTo } = body as {
      chatId?: number;
      items?: unknown;
      title?: unknown;
      replyTo?: number;
    };
    if (
      typeof chatId !== "number" ||
      !Array.isArray(items) ||
      items.length === 0 ||
      !items.every((it) => typeof it === "string")
    ) {
      badRequest(
        res,
        'body must be { "chatId": number, "items": non-empty string[], "title"?: string, "replyTo"?: number }',
      );
      return;
    }
    if (title !== undefined && typeof title !== "string") {
      badRequest(res, '"title" must be a string');
      return;
    }
    if (!ensureTargetAllowed(res, deps, chatId)) return;
    try {
      const result = await deps.telegramChecklist({
        chatId,
        items: items as string[],
        title: title as string | undefined,
        replyTo,
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    } catch (err) {
      serverError(res, "checklist failed", err);
    }
    return;
  }

  if (action === "checklist-complete") {
    if (!deps.telegramChecklistComplete) {
      notConfigured(res, "checklist-complete");
      return;
    }
    const b = body as {
      chatId?: unknown;
      msgId?: unknown;
      completed?: unknown;
      uncompleted?: unknown;
    } | null;
    const isNumArray = (v: unknown): v is number[] =>
      Array.isArray(v) && v.every((n) => typeof n === "number");
    if (
      b === null ||
      typeof b !== "object" ||
      Array.isArray(b) ||
      typeof b.chatId !== "number" ||
      typeof b.msgId !== "number" ||
      !isNumArray(b.completed) ||
      !isNumArray(b.uncompleted)
    ) {
      badRequest(
        res,
        'body must be { "chatId": number, "msgId": number, "completed": number[], "uncompleted": number[] }',
      );
      return;
    }
    if (b.completed.length === 0 && b.uncompleted.length === 0) {
      badRequest(res, "nothing to toggle: completed and uncompleted are both empty");
      return;
    }
    if (!ensureTargetAllowed(res, deps, b.chatId)) return;
    try {
      const result = await deps.telegramChecklistComplete({
        chatId: b.chatId,
        msgId: b.msgId,
        completed: b.completed,
        uncompleted: b.uncompleted,
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    } catch (err) {
      serverError(res, "checklist-complete failed", err);
    }
    return;
  }

  if (action === "pin" || action === "unpin") {
    const dep = action === "pin" ? deps.telegramPin : deps.telegramUnpin;
    if (!dep) {
      notConfigured(res, action);
      return;
    }
    const b = body as { chatId?: unknown; msgId?: unknown } | null;
    if (
      b === null ||
      typeof b !== "object" ||
      Array.isArray(b) ||
      typeof b.chatId !== "number" ||
      typeof b.msgId !== "number"
    ) {
      badRequest(res, 'body must be { "chatId": number, "msgId": number }');
      return;
    }
    if (!ensureTargetAllowed(res, deps, b.chatId)) return;
    try {
      const result = await dep({ chatId: b.chatId, msgId: b.msgId });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    } catch (err) {
      serverError(res, `${action} failed`, err);
    }
    return;
  }

  if (action === "poll") {
    if (!deps.telegramPoll) {
      notConfigured(res, "poll");
      return;
    }
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      badRequest(
        res,
        'body must be { "chatId": number, "question": string, "options": string[], "multiple"?: boolean, "quiz"?: boolean, "correctOption"?: number, "replyTo"?: number }',
      );
      return;
    }
    const { chatId, question, options, multiple, quiz, correctOption, replyTo } = body as {
      chatId?: number;
      question?: unknown;
      options?: unknown;
      multiple?: unknown;
      quiz?: unknown;
      correctOption?: unknown;
      replyTo?: number;
    };
    if (
      typeof chatId !== "number" ||
      typeof question !== "string" ||
      question.trim().length === 0 ||
      !Array.isArray(options) ||
      options.length < 2 ||
      !options.every((o) => typeof o === "string")
    ) {
      badRequest(
        res,
        'body must be { "chatId": number, "question": non-empty string, "options": string[] (2-10), "multiple"?: boolean, "quiz"?: boolean, "correctOption"?: number, "replyTo"?: number }',
      );
      return;
    }
    if (multiple !== undefined && typeof multiple !== "boolean") {
      badRequest(res, '"multiple" must be a boolean');
      return;
    }
    if (quiz !== undefined && typeof quiz !== "boolean") {
      badRequest(res, '"quiz" must be a boolean');
      return;
    }
    if (correctOption !== undefined && typeof correctOption !== "number") {
      badRequest(res, '"correctOption" must be a number');
      return;
    }
    if (!ensureTargetAllowed(res, deps, chatId)) return;
    try {
      const result = await deps.telegramPoll({
        chatId,
        question,
        options: options as string[],
        multiple: multiple as boolean | undefined,
        quiz: quiz as boolean | undefined,
        correctOption: correctOption as number | undefined,
        replyTo,
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    } catch (err) {
      serverError(res, "poll failed", err);
    }
    return;
  }

  if (action === "vote") {
    if (!deps.telegramVote) {
      notConfigured(res, "vote");
      return;
    }
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      badRequest(res, 'body must be { "chatId": number, "msgId": number, "options": number[] }');
      return;
    }
    const { chatId, msgId, options } = body as {
      chatId?: number;
      msgId?: unknown;
      options?: unknown;
    };
    if (
      typeof chatId !== "number" ||
      typeof msgId !== "number" ||
      !Number.isInteger(msgId) ||
      msgId <= 0 ||
      !Array.isArray(options) ||
      options.length === 0 ||
      !options.every((o) => typeof o === "number" && Number.isInteger(o) && o >= 0)
    ) {
      badRequest(
        res,
        'body must be { "chatId": number, "msgId": positive int, "options": int[] (one or more 0-based option indexes) }',
      );
      return;
    }
    if (!ensureTargetAllowed(res, deps, chatId)) return;
    try {
      const result = await deps.telegramVote({
        chatId,
        msgId,
        options: options as number[],
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    } catch (err) {
      serverError(res, "vote failed", err);
    }
    return;
  }

  if (action === "table") {
    if (!deps.telegramTable) {
      notConfigured(res, "table");
      return;
    }
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      badRequest(
        res,
        'body must be { "chatId": number, "headers": string[], "rows": string[][], "title"?: string, "replyTo"?: number }',
      );
      return;
    }
    const { chatId, headers, rows, title, replyTo } = body as {
      chatId?: number;
      headers?: unknown;
      rows?: unknown;
      title?: unknown;
      replyTo?: number;
    };
    const headersOk = Array.isArray(headers) && headers.every((h) => typeof h === "string");
    const rowsOk =
      Array.isArray(rows) &&
      rows.every((r) => Array.isArray(r) && r.every((c) => typeof c === "string"));
    // Требуем хотя бы что-то наполняющее таблицу (заголовки или строки).
    if (
      typeof chatId !== "number" ||
      !headersOk ||
      !rowsOk ||
      ((headers as string[]).length === 0 && (rows as string[][]).length === 0)
    ) {
      badRequest(
        res,
        'body must be { "chatId": number, "headers": string[], "rows": string[][], "title"?: string, "replyTo"?: number }',
      );
      return;
    }
    if (title !== undefined && typeof title !== "string") {
      badRequest(res, '"title" must be a string');
      return;
    }
    if (!ensureTargetAllowed(res, deps, chatId)) return;
    try {
      const result = await deps.telegramTable({
        chatId,
        headers: headers as string[],
        rows: rows as string[][],
        title: title as string | undefined,
        replyTo,
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    } catch (err) {
      serverError(res, "table failed", err);
    }
    return;
  }

  if (action === "download") {
    if (!deps.telegramDownload) {
      notConfigured(res, "download");
      return;
    }
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      badRequest(res, 'body must be { "chatId": number, "msgId": number, "output": string }');
      return;
    }
    const { chatId, msgId, output } = body as {
      chatId?: number;
      msgId?: number;
      output?: string;
    };
    if (
      typeof chatId !== "number" ||
      typeof msgId !== "number" ||
      typeof output !== "string" ||
      output.length === 0
    ) {
      badRequest(res, 'body must be { "chatId": number, "msgId": number, "output": string }');
      return;
    }
    try {
      const result = await deps.telegramDownload({ chatId, msgId, output });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    } catch (err) {
      serverError(res, "download failed", err);
    }
    return;
  }

  if (action === "upload") {
    if (!deps.telegramUpload) {
      notConfigured(res, "upload");
      return;
    }
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      badRequest(
        res,
        'body must be { "chatId": number, "path": string, "caption"?: string, "replyTo"?: number }',
      );
      return;
    }
    const { chatId, path, caption, replyTo } = body as {
      chatId?: number;
      path?: string;
      caption?: string;
      replyTo?: number;
    };
    if (typeof chatId !== "number" || typeof path !== "string" || path.length === 0) {
      badRequest(res, 'body must be { "chatId": number, "path": string }');
      return;
    }
    if (!ensureTargetAllowed(res, deps, chatId)) return;
    try {
      const result = await deps.telegramUpload({ chatId, path, caption, replyTo });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    } catch (err) {
      serverError(res, "upload failed", err);
    }
    return;
  }

  if (action === "voice") {
    if (!deps.telegramVoice) {
      notConfigured(res, "voice");
      return;
    }
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      badRequest(
        res,
        'body must be { "chatId": number, "text": string, "emotion"?: string, "replyTo"?: number }',
      );
      return;
    }
    const { chatId, text, emotion, replyTo } = body as {
      chatId?: number;
      text?: string;
      emotion?: string;
      replyTo?: number;
    };
    if (typeof chatId !== "number" || typeof text !== "string" || text.length === 0) {
      badRequest(res, 'body must be { "chatId": number, "text": string }');
      return;
    }
    if (!ensureTargetAllowed(res, deps, chatId)) return;
    try {
      const result = await deps.telegramVoice({ chatId, text, emotion, replyTo });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    } catch (err) {
      serverError(res, "voice failed", err);
    }
    return;
  }

  if (action === "forward") {
    if (!deps.telegramForward) {
      notConfigured(res, "forward");
      return;
    }
    // ADR-206 W8: переадресация между чатами (fromChatId → toChatId) + необязательный комментарий
    const b = body as {
      fromChatId?: unknown;
      msgId?: unknown;
      toChatId?: unknown;
      comment?: unknown;
    } | null;
    if (
      b === null ||
      typeof b !== "object" ||
      Array.isArray(b) ||
      typeof b.fromChatId !== "number" ||
      typeof b.msgId !== "number" ||
      typeof b.toChatId !== "number"
    ) {
      badRequest(
        res,
        'body must be { "fromChatId": number, "msgId": number, "toChatId": number, "comment"?: string }',
      );
      return;
    }
    // ПРИВАТНОСТЬ (authoritative, промпт обойти не может): не пересылать из приватного 1:1 чата
    // (положительный Telegram id = пользователь) в ДРУГОЙ чат. Контент ЛС не должен утекать в
    // группы/каналы через forward. Пересылка из групп/каналов (id < 0 — курирование) разрешена;
    // пересылка внутри того же ЛС (to == from) бессмысленна, но безвредна — пропускаем.
    if (isPrivateForwardBlocked(b.fromChatId, b.toChatId)) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: "forward_from_private_blocked",
          message:
            "Forward from a private 1:1 chat into another chat is blocked for privacy. Personal stays personal.",
        }),
      );
      return;
    }
    if (!ensureTargetAllowed(res, deps, b.toChatId)) return;
    try {
      const result = await deps.telegramForward({
        fromChatId: b.fromChatId,
        msgId: b.msgId,
        toChatId: b.toChatId,
        comment: typeof b.comment === "string" ? b.comment : undefined,
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    } catch (err) {
      serverError(res, "forward failed", err);
    }
    return;
  }

  if (action === "index-sticker-pack") {
    if (!deps.telegramIndexStickerPack) {
      notConfigured(res, "index-sticker-pack");
      return;
    }
    const b = body as { shortName?: unknown; force?: unknown } | null;
    if (
      b === null ||
      typeof b !== "object" ||
      Array.isArray(b) ||
      typeof b.shortName !== "string" ||
      b.shortName.trim().length === 0
    ) {
      badRequest(res, 'body must be { "shortName": string, "force"?: boolean }');
      return;
    }
    try {
      const result = await deps.telegramIndexStickerPack({
        shortName: b.shortName.trim(),
        force: b.force === true,
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    } catch (err) {
      serverError(res, "index-sticker-pack failed", err);
    }
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "not found" }));
}
