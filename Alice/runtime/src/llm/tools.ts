/**
 * ADR-233: определения инструментов для нативного Tool Use.
 *
 * Один инструмент `bash` (выполнение POSIX sh скриптов) + инструмент `signal` (семантика afterward).
 *
 * Новое определение Flow-сигналов в цикле TC:
 * - В старой архитектуре `watching` = "жду промежуточного результата" (intra-episode, поглощается TC)
 * - В TC `watching` = "после этого хода я хочу продолжать следить за этим чатом" (inter-episode состояние поведения)
 * - Продолжать ли выполнение внутри одного тика — решает хост на основе локальных observations / обратной связи по ошибкам
 *
 * @see docs/adr/233-native-toolcall-bt-hybrid.md
 * @see nanoclaw (Bash tool), pi-mono (BashOperations)
 */
import type OpenAI from "openai";

/** Значения afterward для инструмента Signal — единый источник, другие модули импортируют этот тип. */
export const AFTERWARD_VALUES = [
  "done",
  "waiting_reply",
  "watching",
  "resting",
  "fed_up",
  "cooling_down",
] as const;

export type Afterward = (typeof AFTERWARD_VALUES)[number];

export function isAfterward(value: unknown): value is Afterward {
  return typeof value === "string" && AFTERWARD_VALUES.includes(value as Afterward);
}

/**
 * Инструмент `bash` — выполняет POSIX sh скрипты (в Docker-контейнере).
 *
 * Дизайн с одним инструментом: все возможности Алисы открыты через CLI-команды (irc/self/engine/app),
 * LLM пишет чистый bash-скрипт, который выполняется в контейнере.
 *
 * Согласовано с NanoClaw/pi-mono: название инструмента `bash` точно отражает техническую суть.
 */
export const TOOL_BASH: OpenAI.Chat.Completions.ChatCompletionTool = {
  type: "function" as const,
  function: {
    name: "bash",
    description:
      "Execute bash commands in a sandboxed Docker container. " +
      "Available commands: irc (Telegram), self (perception/memory), " +
      "engine (system), app (weather, music, etc). " +
      "TIP: Use '<command> --help' to discover usage. " +
      "You can chain commands with pipes and redirects. " +
      "Use 'echo' for scratchpad reasoning, '#' for comments.",
    parameters: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description:
            "Multi-line POSIX sh script. " +
            "IMPORTANT: write one command per line, separated by newlines. " +
            "Examples:\n" +
            "  'irc tail --count 5'\n" +
            "  'self feel curious\\nirc say --text \"hello\"'\n" +
            "  'weather tokyo | grep -i sun'",
        },
      },
      required: ["command"],
    },
  },
};

/**
 * Инструмент `signal` — выражает поведенческую инструкцию оркестратора после завершения episode.
 *
 * Flow-сигналы управляют только inter-episode семантикой (что делать после завершения episode).
 * Цепочка инструментов intra-episode свободно контролируется циклом TC без flow-сигналов.
 */
export const TOOL_SIGNAL: OpenAI.Chat.Completions.ChatCompletionTool = {
  type: "function" as const,
  function: {
    name: "signal",
    description:
      "Signal how this conversation should continue after your turn. " +
      "Call this ONCE at the end of your turn. " +
      "If you don't call signal, default is 'done'. " +
      "\n\n" +
      "done: finished (default if you don't call signal).\n" +
      "waiting_reply: you said something and expect their response.\n" +
      "watching: after this turn, stay engaged with this chat because something is still unfolding " +
      "or you want to keep the thread warm. Immediate same-tick follow-up is host-controlled.\n" +
      "resting: only when you are actually going to sleep or leaving Telegram for a while; not for ordinary low energy.\n" +
      "fed_up: walk away (closes conversation).\n" +
      "cooling_down: only when the current room is spammy or toxic and needs distance; freezes chat for ~30 min.",
    parameters: {
      type: "object",
      properties: {
        afterward: {
          type: "string",
          enum: AFTERWARD_VALUES,
          description: "How the conversation should continue. Default: done.",
        },
      },
      required: ["afterward"],
    },
  },
};

/** ADR-233 список инструментов — экспортируется для использования в цикле TC. */
export const ADR233_TOOLS: OpenAI.Chat.Completions.ChatCompletionTool[] = [TOOL_BASH, TOOL_SIGNAL];

/**
 * Извлекает параметры tool_use из ответа LLM.
 */
export function extractToolUseParams(
  toolCall: OpenAI.Chat.Completions.ChatCompletionMessageToolCall,
): { name: string; args: Record<string, unknown> } {
  // ChatCompletionMessageToolCall = FunctionToolCall | CustomToolCall
  // обрабатываем только тип function (стандартный LLM tool_use)
  if (toolCall.type !== "function") {
    return { name: "unknown", args: {} };
  }

  try {
    const args = JSON.parse(toolCall.function.arguments) as Record<string, unknown>;
    return { name: toolCall.function.name, args };
  } catch {
    return { name: toolCall.function.name, args: {} };
  }
}
