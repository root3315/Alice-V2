import { defineCommand, renderUsage } from "citty";
import { EngineApiError, engineGet, enginePost } from "../../skills/_lib/engine-client.js";
import type { ExecutionObservation } from "../core/script-execution.js";
import { telegramChannelId } from "../graph/constants.js";
import { parseMsgId, resolveTarget } from "./chat-client.js";
import { renderConfirm } from "./cli-bridge.js";
import {
  assertCurrentChatForSend,
  checklistCommand,
  checklistCompleteCommand,
  forumTopicsCommand,
  pinCommand,
  selfSourceCommand,
  unpinCommand,
  indexPackCommand,
  joinCommand,
  leaveCommand,
  motdCommand,
  OBSERVATION_PREFIX,
  pollCommand,
  reactCommand,
  readCommand,
  replyCommand,
  sayCommand,
  stickerCommand,
  tableCommand,
  tailCommand,
  threadsCommand,
  voiceCommand,
  voteCommand,
  whoisCommand,
} from "./cli-commands.js";
import { createRealContext } from "./cli-io.js";
import { type CommandName, filterOutput, parseOutputMode } from "./cli-json.js";
import { findUnknownOption } from "./cli-strict.js";
import {
  type CliContext,
  type CliErrorCode,
  CliExecutionError,
  emitCliErrorCode,
  isCliErrorCode,
  makeDie,
} from "./cli-types.js";

/** Опция --in: целевой чат. */
const inOption = {
  type: "string" as const,
  description: "Target chat (@ID or numeric). Omit to use current chat context.",
  valueHint: "chatId",
};

/** Флаг --json: указывает поля вывода (через запятую). Без параметра — выводит все поля. */
const jsonFlag = {
  json: {
    type: "string" as const,
    description: "Output as JSON with specified fields (comma-separated). Omit for human-readable.",
    valueHint: "fields",
  },
};

/** Результат выполнения команды. */
interface CommandResult {
  action?: string;
  observation?: ExecutionObservation;
  output: string;
  /** Исходный объект результата (используется для фильтрации JSON-полей). */
  rawResult?: unknown;
}

/** Сигнатура функции run в citty. */
type CittyRun<A = Record<string, unknown>> = (ctx: { args: A }) => Promise<void>;

type ArgShape = Record<string, { alias?: string | readonly string[] | undefined }>;

/**
 * Создаёт исполнитель команды.
 * ADR-239: --json принимает список полей, валидирует и фильтрует вывод.
 */
function makeRunner<A extends { json?: string }>(
  command: CommandName,
  handler: (ctx: CliContext, args: A) => Promise<CommandResult>,
): CittyRun<A> {
  return async (cittyCtx) => {
    const ctx = createRealContext();
    const { json } = cittyCtx.args;

    try {
      const mode = parseOutputMode(command, json);
      const result = await handler(ctx, cittyCtx.args);

      if (result.action) console.log(result.action);
      if (result.observation) {
        console.log(`${OBSERVATION_PREFIX}${JSON.stringify(result.observation)}`);
      }

      switch (mode.type) {
        case "human":
          console.log(result.output);
          break;
        case "json": {
          const filtered = filterOutput(result.rawResult as Record<string, unknown>, mode.fields);
          console.log(JSON.stringify(filtered, null, 2));
          break;
        }
      }
    } catch (error) {
      const code = extractCliErrorCode(error);
      if (code) emitCliErrorCode(ctx.output, code);
      throw error;
    }
  };
}

function extractCliErrorCode(error: unknown): CliErrorCode | null {
  if (error instanceof CliExecutionError) return error.code;
  if (error instanceof EngineApiError && error.code && isCliErrorCode(error.code)) {
    return error.code;
  }
  return null;
}

const say = defineCommand({
  meta: { name: "say", description: "Send a message" },
  args: {
    ...jsonFlag,
    in: inOption,
    text: { type: "string", description: "Message text", required: true, valueHint: "message" },
    "resolve-thread": {
      type: "string",
      description: "Thread ID to resolve after sending",
      valueHint: "threadId",
    },
  },
  run: makeRunner("say", sayCommand),
});

const reply = defineCommand({
  meta: { name: "reply", description: "Reply to a message" },
  args: {
    ...jsonFlag,
    in: inOption,
    ref: {
      type: "string",
      description: "Visible current-chat message ID to reply to",
      required: true,
      valueHint: "msgId",
    },
    text: { type: "string", description: "Reply text", required: true, valueHint: "message" },
  },
  run: makeRunner("reply", replyCommand),
});

const react = defineCommand({
  meta: { name: "react", description: "React to a message" },
  args: {
    ...jsonFlag,
    in: inOption,
    ref: {
      type: "string",
      description: "Visible current-chat message ID to react to",
      required: true,
      valueHint: "msgId",
    },
    emoji: {
      type: "string",
      description: "Telegram reaction emoji, e.g. 👍 👎 ❤ 🔥 🥰 👏 😁 🤔 😢 🎉 👀 😴",
      required: true,
      valueHint: "telegram-reaction",
    },
  },
  run: makeRunner("react", reactCommand),
});

const sticker = defineCommand({
  meta: { name: "sticker", description: "Send a sticker by keyword" },
  args: {
    ...jsonFlag,
    in: inOption,
    keyword: {
      type: "string",
      description:
        "Sticker keyword. Use one of: happy, sad, angry, surprised, shy, tired, love, scared, wave, hug, cry, laugh, sleep, eat, dance, thumbsup, facepalm, peek.",
      required: true,
      valueHint: "happy|shy|laugh|hug|wave|peek",
    },
  },
  run: makeRunner("sticker", stickerCommand),
});

const checklist = defineCommand({
  meta: {
    name: "checklist",
    description:
      "Create/send a REAL tappable Telegram checklist (native To-Do list — each item is a live checkbox, not bullet text). Use when asked for a checklist / to-do list / step-by-step list with checkable items.",
  },
  args: {
    ...jsonFlag,
    in: inOption,
    items: {
      type: "string",
      description:
        'Checklist items as a JSON array of strings (robust to commas/quotes/newlines inside items). Example: \'["Купить хлеб","Полить цветы","Позвонить маме"]\'. Max 30 items, each ≤64 chars (clamped).',
      required: true,
      valueHint: '["item 1","item 2"]',
    },
    title: {
      type: "string",
      description: 'Optional title shown above the checklist (≤32 chars, clamped). Defaults to "Чеклист".',
      valueHint: "title",
    },
    ref: {
      type: "string",
      description: "Visible current-chat message ID to reply to",
      valueHint: "msgId",
    },
  },
  run: makeRunner("checklist", checklistCommand),
});

const check = defineCommand({
  meta: {
    name: "check",
    description:
      "Tick item(s) in an EXISTING tappable checklist as done/undone (native To-Do). Use to mark a task complete when it finishes — e.g. a deploy from a task landed in the work chat → check that item yourself. Items are 1-based by their order in the checklist.",
  },
  args: {
    ...jsonFlag,
    in: inOption,
    ref: {
      type: "string",
      description: "Message ID of the checklist to update",
      required: true,
      valueHint: "msgId",
    },
    done: {
      type: "string",
      description: '1-based item numbers to mark DONE, comma-separated (e.g. "2" or "1,3")',
      valueHint: "1,3",
    },
    undone: {
      type: "string",
      description: "1-based item numbers to mark UNDONE (uncheck), comma-separated",
      valueHint: "2",
    },
  },
  run: makeRunner("check", checklistCompleteCommand),
});

const pin = defineCommand({
  meta: {
    name: "pin",
    description:
      "Pin (закрепить) a message in the current chat — for important agreements, reminders, or a key checklist so it stays at the top. Needs admin rights in groups/channels.",
  },
  args: {
    ...jsonFlag,
    in: inOption,
    ref: {
      type: "string",
      description: "Message ID to pin",
      required: true,
      valueHint: "msgId",
    },
  },
  run: makeRunner("pin", pinCommand),
});

const unpin = defineCommand({
  meta: {
    name: "unpin",
    description: "Unpin (открепить) a previously pinned message in the current chat.",
  },
  args: {
    ...jsonFlag,
    in: inOption,
    ref: {
      type: "string",
      description: "Message ID to unpin",
      required: true,
      valueHint: "msgId",
    },
  },
  run: makeRunner("unpin", unpinCommand),
});

const selfSource = defineCommand({
  meta: {
    name: "self-source",
    description:
      "Read your OWN source — the code and personality you're literally made of (READ-ONLY). SOUL.md is your core self; src/**.ts is your engine; docs/** explains the design. Use --path <file> to read one file, or --list <dir> (e.g. --list . , --list src, --list src/mods) to browse. Secrets and data are off-limits by design.",
  },
  args: {
    ...jsonFlag,
    path: {
      type: "string",
      description: "File to read (e.g. SOUL.md, src/mods/soul.mod.ts)",
      valueHint: "file",
    },
    list: {
      type: "string",
      description: 'Directory to browse (".", "src", "src/mods")',
      valueHint: "dir",
    },
  },
  run: makeRunner("self-source", selfSourceCommand),
});

const forumTopics = defineCommand({
  meta: {
    name: "forum-topics",
    description:
      "List the forum topics (темы) of a forum supergroup — each topic's id + title. READ-ONLY. Use when asked which topics/темы exist in a forum, or to find a topic's id before replying into it. Defaults to the current chat; pass --in <chat> for another.",
  },
  args: {
    ...jsonFlag,
    in: inOption,
  },
  run: makeRunner("forum-topics", forumTopicsCommand),
});

const poll = defineCommand({
  meta: {
    name: "poll",
    description:
      "Send a poll / опрос — вопрос + варианты (native Telegram poll, FREE, no Premium). Use when asked to vote / poll the group / collect opinions. Optional --multiple (multi-select) or --quiz with --correct (quiz mode).",
  },
  args: {
    ...jsonFlag,
    in: inOption,
    question: {
      type: "string",
      description: "Poll question (≤255 chars, clamped). Example: 'Куда пойдём в пятницу?'",
      required: true,
      valueHint: "question",
    },
    options: {
      type: "string",
      description:
        'Answer options as a JSON array of strings (robust to commas/quotes/newlines) or one per line. Example: \'["Кафе","Кино","Дома"]\'. 2-10 options, each ≤100 chars (clamped).',
      required: true,
      valueHint: '["option 1","option 2"]',
    },
    multiple: {
      type: "boolean",
      description: "Allow selecting multiple options (multi-answer poll).",
    },
    quiz: {
      type: "boolean",
      description: "Quiz mode (one correct answer). Requires --correct.",
    },
    correct: {
      type: "string",
      description: "0-based index of the correct option (quiz mode). Example: --correct 1",
      valueHint: "0",
    },
    ref: {
      type: "string",
      description: "Visible current-chat message ID to reply to",
      valueHint: "msgId",
    },
  },
  run: makeRunner("poll", pollCommand),
});

const vote = defineCommand({
  meta: {
    name: "vote",
    description:
      "Vote in an existing Telegram poll / опрос (native sendVote, FREE, no Premium). Use to take part in group life, or when asked to vote — on your own initiative when you find it useful too. Pick options by their order in the poll (0-based: the first option is 0, the second is 1, ...). Regular polls let you change your vote later; quizzes do not.",
  },
  args: {
    ...jsonFlag,
    in: inOption,
    ref: {
      type: "string",
      description: "Visible current-chat message ID of the poll to vote in",
      required: true,
      valueHint: "msgId",
    },
    options: {
      type: "string",
      description:
        "Chosen option(s) as 0-based indexes into the poll's options (in their displayed order). One index for a single-choice poll, several for a multi-choice poll. Accepts '0', '0,2', '0 2', or JSON '[0,2]'. Single-choice polls use only the first index.",
      required: true,
      valueHint: "0 | [0,2]",
    },
  },
  run: makeRunner("vote", voteCommand),
});

const indexPack = defineCommand({
  meta: {
    name: "index-pack",
    description:
      "Learn/index a WHOLE sticker pack via the vision model so each sticker gets a rich semantic tag. HEAVY one-off operation (takes minutes) — use ONLY when explicitly asked to learn/index a specific sticker pack, NOT on a whim. Runs in the BACKGROUND: returns immediately, reports when done. Indexed packs are marked curated (kept even if not installed in the account).",
  },
  args: {
    ...jsonFlag,
    set: {
      type: "string",
      description: "Sticker pack short name (the addstickers/<shortName> id). Required.",
      required: true,
      valueHint: "shortName",
    },
    force: {
      type: "boolean",
      description: "Re-index even stickers already richly tagged for this pack.",
    },
  },
  run: makeRunner("index-pack", indexPackCommand),
});

const table = defineCommand({
  meta: {
    name: "table",
    description:
      "Create/send a scrollable rich Telegram table (real document-grade table with header row, not ASCII art / markdown pipes). Use when asked to show a table / comparison / structured grid.",
  },
  args: {
    ...jsonFlag,
    in: inOption,
    headers: {
      type: "string",
      description:
        'Column header cells as a JSON array of strings. Example: \'["Имя","Цена","Наличие"]\'.',
      required: true,
      valueHint: '["col 1","col 2"]',
    },
    rows: {
      type: "string",
      description:
        'Body rows as a JSON array of string arrays (each inner array = one row, cells in column order). Example: \'[["Яблоко","50₽","да"],["Груша","80₽","нет"]]\'. Robust to commas/quotes/newlines inside cells.',
      required: true,
      valueHint: '[["a","b"],["c","d"]]',
    },
    title: {
      type: "string",
      description: "Optional title shown above the table",
      valueHint: "title",
    },
    ref: {
      type: "string",
      description: "Visible current-chat message ID to reply to",
      valueHint: "msgId",
    },
  },
  run: makeRunner("table", tableCommand),
});

const voice = defineCommand({
  meta: { name: "voice", description: "Send a voice message (text-to-speech)" },
  args: {
    ...jsonFlag,
    in: inOption,
    emotion: {
      type: "string",
      description: "Emotion: happy, sad, angry, calm, whisper, ...",
      valueHint: "emotion",
    },
    ref: {
      type: "string",
      description: "Visible current-chat message ID to reply to",
      valueHint: "msgId",
    },
    text: { type: "string", description: "Text to speak", required: true, valueHint: "message" },
  },
  run: makeRunner("voice", voiceCommand),
});

const read = defineCommand({
  meta: { name: "read", description: "Mark chat as read" },
  args: {
    ...jsonFlag,
    in: inOption,
  },
  run: makeRunner("read", readCommand),
});

const tail = defineCommand({
  meta: { name: "tail", description: "Show recent messages" },
  args: {
    ...jsonFlag,
    in: inOption,
    count: {
      type: "string",
      description: "Number of messages",
      default: "20",
      alias: "c",
      valueHint: "number",
    },
  },
  run: makeRunner("tail", tailCommand),
});

const whois = defineCommand({
  meta: { name: "whois", description: "Look up a contact or the current chat room" },
  args: {
    ...jsonFlag,
    in: inOption,
    target: {
      type: "string",
      description: "Contact name or @ID (omit for room info)",
      valueHint: "userId",
    },
  },
  run: makeRunner("whois", whoisCommand),
});

const whoami = defineCommand({
  meta: {
    name: "whoami",
    description: "Show the current chat ID (hidden compatibility alias)",
    hidden: true,
  },
  args: {
    ...jsonFlag,
    in: inOption,
  },
  async run({ args }) {
    const chatId = await resolveTarget(args.in as string | undefined);
    outputMode("whoami", args.json, { chatId }, `chat: ${chatId}`);
  },
});

const motd = defineCommand({
  meta: { name: "motd", description: "Show chat mood and atmosphere" },
  args: {
    ...jsonFlag,
    in: inOption,
  },
  run: makeRunner("motd", motdCommand),
});

const threads = defineCommand({
  meta: { name: "threads", description: "Show open discussion threads" },
  args: jsonFlag,
  run: makeRunner("threads", threadsCommand),
});

const join = defineCommand({
  meta: { name: "join", description: "Join a chat" },
  args: {
    ...jsonFlag,
    target: {
      type: "string",
      description: "Chat ID, @username, or invite link",
      required: true,
      valueHint: "target",
    },
  },
  run: makeRunner("join", joinCommand),
});

const leave = defineCommand({
  meta: { name: "leave", description: "Leave current chat" },
  args: {
    ...jsonFlag,
    in: inOption,
  },
  run: makeRunner("leave", leaveCommand),
});

const ACTION_PREFIX = "__ALICE_ACTION__:";

function gval(res: unknown): unknown {
  return (res as { value?: unknown } | null)?.value ?? null;
}

function outputMode(
  command: CommandName | string,
  json: string | undefined,
  rawResult: unknown,
  humanText: string,
): void {
  const mode = parseOutputMode(command, json);
  switch (mode.type) {
    case "human":
      console.log(humanText);
      break;
    case "json": {
      const filtered = filterOutput(rawResult as Record<string, unknown>, mode.fields);
      console.log(JSON.stringify(filtered, null, 2));
      break;
    }
  }
}

const topic = defineCommand({
  meta: { name: "topic", description: "Show chat topic" },
  args: {
    ...jsonFlag,
    in: inOption,
  },
  async run({ args }) {
    const chatId = await resolveTarget(args.in as string | undefined);
    const topicResult = await engineGet(`/graph/${telegramChannelId(chatId)}/topic`);
    const topicValue = gval(topicResult);
    const rawResult = { chatId, topic: topicValue };
    outputMode("topic", args.json, rawResult, topicValue ? `Topic: "${topicValue}"` : "(no topic)");
  },
});

const download = defineCommand({
  meta: { name: "download", description: "Download a file attachment from a message" },
  args: {
    ...jsonFlag,
    in: inOption,
    ref: {
      type: "string",
      description: "Visible current-chat message ID containing the attachment",
      required: true,
      valueHint: "msgId",
    },
    output: {
      type: "string",
      description: "Output path (must be under $ALICE_HOME)",
      required: true,
      valueHint: "path",
    },
  },
  async run({ args }) {
    const ctx = createRealContext();
    const chatId = await resolveTarget(args.in as string | undefined);
    const msgId = parseMsgId(args.ref as string);
    const outputPath = (args.output as string).trim();

    const result = (await enginePost("/telegram/download", {
      chatId,
      msgId,
      output: outputPath,
    })) as { path?: string; mime?: string; size?: number } | null;

    if (result?.path) {
      console.log(`${ACTION_PREFIX}downloaded:chatId=${chatId}:msgId=${msgId}:path=${result.path}`);
      console.log(
        `${OBSERVATION_PREFIX}${JSON.stringify({
          kind: "query_result",
          source: "irc.download",
          text: `downloaded attachment from #${msgId} to ${result.path}`,
          enablesContinuation: true,
          currentChatId: ctx.currentChatId == null ? null : String(ctx.currentChatId),
          targetChatId: String(chatId),
          payload: {
            intent: "send_downloaded_file",
            path: result.path,
            sourceChatId: chatId,
            sourceMsgId: msgId,
            mime: result.mime ?? null,
            size: result.size ?? null,
          },
        })}`,
      );
    }

    const detail = result?.path ?? outputPath;
    const size = result?.size != null ? ` (${result.size} bytes)` : "";
    outputMode("download", args.json, result, renderConfirm("Downloaded", `${detail}${size}`));
  },
});

const sendFile = defineCommand({
  meta: { name: "send-file", description: "Send a local file to a chat" },
  args: {
    ...jsonFlag,
    in: inOption,
    path: {
      type: "string",
      description: "File path (must be under $ALICE_HOME)",
      required: true,
      valueHint: "file",
    },
    caption: { type: "string", description: "Optional caption", valueHint: "message" },
    ref: {
      type: "string",
      description: "Visible current-chat message ID to reply to",
      valueHint: "msgId",
    },
  },
  async run({ args }) {
    const ctx = createRealContext();
    const die = makeDie(ctx.output, "irc");
    const chatId = await resolveTarget(args.in as string | undefined);
    assertCurrentChatForSend(
      ctx,
      chatId,
      die,
      "irc.send-file",
      args.ref ? { replyRef: args.ref } : undefined,
    );
    const filePath = (args.path as string).trim();

    const body: Record<string, unknown> = { chatId, path: filePath };
    if (args.caption) body.caption = args.caption;
    if (args.ref) body.replyTo = parseMsgId(args.ref as string);

    const result = (await enginePost("/telegram/upload", body)) as { msgId?: number } | null;

    if (result?.msgId != null) {
      console.log(`${ACTION_PREFIX}sent-file:chatId=${chatId}:path=${filePath}`);
    }
    outputMode("send-file", args.json, result, renderConfirm("Sent file", filePath));
  },
});

const forward = defineCommand({
  meta: {
    name: "forward",
    description: "Forward a message to another chat (with optional comment)",
  },
  args: {
    ...jsonFlag,
    from: {
      type: "string",
      description: "Source chat (@ID or numeric)",
      required: true,
      valueHint: "chatId",
    },
    ref: {
      type: "string",
      description: "Message ID to forward",
      required: true,
      valueHint: "msgId",
    },
    to: {
      type: "string",
      description: "Destination chat (@ID or numeric). Omit to use current chat context.",
      valueHint: "chatId",
    },
    comment: {
      type: "string",
      description: "Optional comment (attached as reply to forwarded message)",
      default: "",
      valueHint: "message",
    },
  },
  async run({ args }) {
    const fromChatId = await resolveTarget(args.from as string);
    const msgId = parseMsgId(args.ref as string);
    const toChatId = await resolveTarget(args.to as string | undefined);
    const comment = (args.comment as string | undefined)?.trim() || undefined;

    const result = (await enginePost("/telegram/forward", {
      fromChatId,
      msgId,
      toChatId,
      ...(comment && { comment }),
    })) as { forwardedMsgId?: number; commentMsgId?: number } | null;

    if (result?.forwardedMsgId != null) {
      console.log(
        `${ACTION_PREFIX}forwarded:from=${fromChatId}:to=${toChatId}:msgId=${result.forwardedMsgId}`,
      );
    }
    if (result?.commentMsgId != null) {
      console.log(`${ACTION_PREFIX}sent:chatId=${toChatId}:msgId=${result.commentMsgId}`);
    }
    outputMode(
      "forward",
      args.json,
      result,
      renderConfirm("Forwarded", `#${msgId} → @${toChatId}`),
    );
  },
});

export const ircSubCommands = {
  say,
  reply,
  react,
  sticker,
  checklist,
  check,
  pin,
  unpin,
  "self-source": selfSource,
  "forum-topics": forumTopics,
  poll,
  vote,
  "index-pack": indexPack,
  table,
  voice,
  read,
  tail,
  whois,
  whoami,
  motd,
  threads,
  topic,
  join,
  leave,
  download,
  "send-file": sendFile,
  forward,
} as const;

export const ircCommand = defineCommand({
  meta: {
    name: "irc",
    description: "Telegram system chat client for Alice",
  },
  subCommands: ircSubCommands,
});

function isFlagLike(token: string): boolean {
  return token.startsWith("-") && token !== "-" && !/^-?\d/.test(token);
}

export async function validateIrcRawArgs(rawArgs: string[]): Promise<void> {
  if (rawArgs.includes("--help") || rawArgs.includes("-h")) return;
  if (rawArgs.length === 1 && rawArgs[0] === "--version") return;

  const subCommandIndex = rawArgs.findIndex((arg) => !isFlagLike(arg));
  if (subCommandIndex < 0) return;

  for (const token of rawArgs.slice(0, subCommandIndex)) {
    if (!isFlagLike(token)) continue;
    console.log(await renderUsage(ircCommand));
    console.error(`Unknown option ${token}`);
    process.exit(1);
  }

  const subCommandName = rawArgs[subCommandIndex] as keyof typeof ircSubCommands;
  const subCommand = ircSubCommands[subCommandName];
  if (!subCommand) return;

  const argsDef = (subCommand.args ?? {}) as ArgShape;
  const unknown = findUnknownOption(rawArgs.slice(subCommandIndex + 1), argsDef);
  if (!unknown) return;

  console.log(
    await renderUsage(
      subCommand as Parameters<typeof renderUsage>[0],
      ircCommand as Parameters<typeof renderUsage>[1],
    ),
  );
  console.error(`Unknown option ${unknown}`);
  process.exit(1);
}
