import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/core/shell-executor.js", () => ({
  executeShellScript: vi.fn(),
}));

vi.mock("../src/llm/resilience.js", () => ({
  withResilience: vi.fn(async (fn: () => Promise<unknown>) => await fn()),
}));

const { runTCLoop, TC_MAX_TOOL_CALLS } = await import("../src/engine/tick/tc-loop.js");
const { executeShellScript } = await import("../src/core/shell-executor.js");
const { withResilience } = await import("../src/llm/resilience.js");

function bashToolCall(id: string, command: string) {
  return {
    id,
    type: "function" as const,
    function: {
      name: "bash",
      arguments: JSON.stringify({ command }),
    },
  };
}

function signalToolCall(id: string, afterward: unknown) {
  return {
    id,
    type: "function" as const,
    function: {
      name: "signal",
      arguments: JSON.stringify({ afterward }),
    },
  };
}

function makeOpenAI(responses: unknown[]) {
  const create = vi.fn();
  for (const response of responses) create.mockResolvedValueOnce(response);
  return {
    chat: {
      completions: {
        create,
      },
    },
  } as const;
}

function okResult(label: string) {
  return {
    logs: [`ok:${label}`],
    errors: [],
    instructionErrors: [],
    errorCodes: [],
    errorDetails: [],
    duration: 0,
    thinks: [],
    queryLogs: [],
    observations: [],
    completedActions: [],
    silenceReason: null,
  };
}

describe("runTCLoop", () => {
  beforeEach(() => {
    vi.mocked(executeShellScript).mockReset();
  });

  it("hard-stops when one assistant message asks for more tool calls than the remaining budget", async () => {
    vi.mocked(executeShellScript).mockImplementation(async (command: string) => okResult(command));

    const openai = makeOpenAI([
      {
        choices: [
          {
            finish_reason: "tool_calls",
            message: {
              role: "assistant",
              content: "",
              tool_calls: Array.from({ length: TC_MAX_TOOL_CALLS + 1 }, (_, idx) =>
                bashToolCall(`call_${idx + 1}`, `echo ${idx + 1}`),
              ),
            },
          },
        ],
      },
    ]);

    const result = await runTCLoop({
      openai: openai as never,
      model: "test-model",
      providerName: "test",
      systemPrompt: "sys",
      userMessage: "usr",
    });

    expect(openai.chat.completions.create).toHaveBeenCalledTimes(1);
    expect(openai.chat.completions.create).toHaveBeenCalledWith(expect.any(Object), {
      maxRetries: 0,
    });
    expect(vi.mocked(withResilience).mock.calls[0]?.[1]).toMatchObject({ maxRetries: 0 });
    expect(executeShellScript).toHaveBeenCalledTimes(TC_MAX_TOOL_CALLS);
    expect(result.toolCallCount).toBe(TC_MAX_TOOL_CALLS);
    expect(result.budgetExhausted).toBe(true);
    expect(result.rawScript.split("\n\n")).toHaveLength(TC_MAX_TOOL_CALLS);
    expect(result.transcript?.[0]?.toolCalls).toHaveLength(TC_MAX_TOOL_CALLS);
  });

  it("triggers stop-loss after the same retry-worthy error class repeats twice", async () => {
    vi.mocked(executeShellScript).mockResolvedValue({
      logs: [],
      errors: ['Error: invalid target: "@ghost"'],
      instructionErrors: [],
      errorCodes: ["command_invalid_target"],
      duration: 0,
      thinks: [],
      queryLogs: [],
      observations: [],
      completedActions: [],
      silenceReason: null,
    });

    const openai = makeOpenAI([
      {
        choices: [
          {
            finish_reason: "tool_calls",
            message: {
              role: "assistant",
              content: "",
              tool_calls: [bashToolCall("call_1", "irc whois --target @ghost")],
            },
          },
        ],
      },
      {
        choices: [
          {
            finish_reason: "tool_calls",
            message: {
              role: "assistant",
              content: "",
              tool_calls: [bashToolCall("call_2", "irc whois --target @ghost")],
            },
          },
        ],
      },
      {
        choices: [
          {
            finish_reason: "tool_calls",
            message: {
              role: "assistant",
              content: "",
              tool_calls: [bashToolCall("call_3", 'irc say --text "still trying"')],
            },
          },
        ],
      },
    ]);

    const result = await runTCLoop({
      openai: openai as never,
      model: "test-model",
      providerName: "test",
      systemPrompt: "sys",
      userMessage: "usr",
    });

    expect(openai.chat.completions.create).toHaveBeenCalledTimes(2);
    expect(executeShellScript).toHaveBeenCalledTimes(2);
    expect(result.toolCallCount).toBe(2);
    expect(result.budgetExhausted).toBe(false);
    expect(result.instructionErrors).toContain(
      "stop-loss: repeated invalid target twice; stop retrying in this episode",
    );
    expect(result.transcript?.[1]?.toolCalls[0]?.instructionErrors).toContain(
      "stop-loss: repeated invalid target twice; stop retrying in this episode",
    );
  });

  it("preserves structured execution error details across bash tool aggregation", async () => {
    vi.mocked(executeShellScript).mockResolvedValue({
      logs: [],
      errors: ["refusing cross-chat send"],
      instructionErrors: [],
      errorCodes: ["command_cross_chat_send"],
      errorDetails: [
        {
          code: "command_cross_chat_send",
          source: "irc.reply",
          currentChatId: "-1001",
          requestedChatId: "-1002",
          payload: { replyTo: 9 },
        },
      ],
      duration: 0,
      thinks: [],
      queryLogs: [],
      observations: [],
      completedActions: [],
      silenceReason: null,
    });

    const openai = makeOpenAI([
      {
        choices: [
          {
            finish_reason: "tool_calls",
            message: {
              role: "assistant",
              content: "",
              tool_calls: [bashToolCall("call_1", 'irc reply --in -1002 --ref 9 --text "hi"')],
            },
          },
        ],
      },
      {
        choices: [
          {
            finish_reason: "stop",
            message: {
              role: "assistant",
              content: "done",
            },
          },
        ],
      },
    ]);

    const result = await runTCLoop({
      openai: openai as never,
      model: "test-model",
      providerName: "test",
      systemPrompt: "sys",
      userMessage: "usr",
    });

    expect(result.errorCodes).toEqual(["command_cross_chat_send"]);
    expect(result.errorDetails).toEqual([
      expect.objectContaining({
        code: "command_cross_chat_send",
        source: "irc.reply",
        currentChatId: "-1001",
        requestedChatId: "-1002",
      }),
    ]);
  });

  it("falls back invalid signal afterward to done instead of recording an impossible value", async () => {
    const openai = makeOpenAI([
      {
        choices: [
          {
            finish_reason: "tool_calls",
            message: {
              role: "assistant",
              content: "",
              tool_calls: [signalToolCall("call_1", "later")],
            },
          },
        ],
      },
      {
        choices: [
          {
            finish_reason: "stop",
            message: {
              role: "assistant",
              content: "done",
            },
          },
        ],
      },
    ]);

    const result = await runTCLoop({
      openai: openai as never,
      model: "test-model",
      providerName: "test",
      systemPrompt: "sys",
      userMessage: "usr",
    });

    expect(result.afterward).toBe("done");
    expect(result.transcript?.[0]?.toolCalls[0]?.afterward).toBe("done");
    expect(result.transcript?.[0]?.toolCalls[0]?.args).toEqual({ afterward: "later" });
  });
});
