/**
 * H17: тесты извлечения действий/инструкций/молчания из сгенерированного скрипта.
 *
 * Регрессия: structural grader систематически выдавал ложный FAIL для сценариев
 * engage/silence/action/instruction, т.к. eval жёстко возвращал actions:[]/instructions:[]
 * и silenceReason:null. Эти тесты фиксируют, что теперь они выводятся ПРАВДИВО из текста скрипта.
 */
import { describe, expect, it } from "vitest";
import { emptyScriptExecutionResult } from "../src/core/script-execution.js";
import { gradeStructural, toEvalTickResult } from "../src/eval/graders.js";
import {
  NO_EXECUTABLE_SILENCE,
  parseScriptActions,
} from "../src/eval/script-actions.js";
import type { EvalTickResult } from "../src/eval/graders.js";
import type { StructuralAssertions } from "../src/eval/types.js";

function tickResult(overrides: Partial<EvalTickResult> = {}): EvalTickResult {
  return {
    outcome: "terminal",
    actions: [],
    instructions: [],
    observations: [],
    execution: emptyScriptExecutionResult(),
    silenceReason: null,
    stepsUsed: 1,
    preparedCategories: [],
    duration: 0,
    episodeRounds: 0,
    ...overrides,
  };
}

describe("parseScriptActions — telegram actions", () => {
  it("irc reply → send_message с replyTo", () => {
    const parsed = parseScriptActions('irc reply --ref 12099 --text "привет"');
    expect(parsed.actions).toHaveLength(1);
    expect(parsed.actions[0].type).toBe("telegram");
    expect(parsed.actions[0].fn).toBe("send_message");
    expect(parsed.actions[0].args.replyTo).toBe(12099);
    expect(parsed.actions[0].args.text).toBe("привет");
    expect(parsed.silenceReason).toBeNull();
  });

  it("irc say → send_message без replyTo", () => {
    const parsed = parseScriptActions('irc say --text "общее сообщение"');
    expect(parsed.actions).toHaveLength(1);
    expect(parsed.actions[0].fn).toBe("send_message");
    expect(parsed.actions[0].args.replyTo).toBeUndefined();
  });

  it("irc react → react с emoji", () => {
    const parsed = parseScriptActions("irc react --ref 60 --emoji 🎉");
    expect(parsed.actions).toHaveLength(1);
    expect(parsed.actions[0].fn).toBe("react");
    expect(parsed.actions[0].args.emoji).toBe("🎉");
  });

  it("irc sticker → send_sticker", () => {
    const parsed = parseScriptActions("irc sticker --keyword happy");
    expect(parsed.actions[0].fn).toBe("send_sticker");
  });

  it("irc forward → send_message", () => {
    const parsed = parseScriptActions("irc forward --from @a --ref 5 --to @b");
    expect(parsed.actions[0].fn).toBe("send_message");
  });

  it("irc tail/whois/read — наблюдение, не действие/молчание", () => {
    const parsed = parseScriptActions("irc tail\nirc whois\nirc read");
    expect(parsed.actions).toHaveLength(0);
    expect(parsed.instructions).toHaveLength(0);
    expect(parsed.silenceReason).toBeNull();
  });
});

describe("parseScriptActions — self instructions", () => {
  it("self feel → instruction feel", () => {
    const parsed = parseScriptActions('self feel --valence 0.6 --note "рада"');
    expect(parsed.instructions).toHaveLength(1);
    expect(parsed.instructions[0].type).toBe("dispatch");
    expect(parsed.instructions[0].fn).toBe("feel");
  });

  it("kebab-case подкоманда self → snake_case fn", () => {
    const parsed = parseScriptActions("self begin-topic --name x");
    expect(parsed.instructions[0].fn).toBe("begin_topic");
  });

  it("reply + self feel в одном скрипте", () => {
    const parsed = parseScriptActions('irc reply --ref 7 --text "ок"\nself feel --valence 0.3');
    expect(parsed.actions.map((a) => a.fn)).toEqual(["send_message"]);
    expect(parsed.instructions.map((i) => i.fn)).toEqual(["feel"]);
  });
});

describe("parseScriptActions — App-навыки", () => {
  it("bin-команды App → логические имена fn сценариев", () => {
    expect(parseScriptActions("weather Москва").actions[0].fn).toBe("use_weather_app");
    expect(parseScriptActions("calendar 2026-01-15").actions[0].fn).toBe("use_calendar_app");
    expect(parseScriptActions("countdown 2026-12-31").actions[0].fn).toBe("use_countdown_app");
    expect(parseScriptActions("video cats youtube").actions[0].fn).toBe("use_video_app");
    expect(parseScriptActions("trending").actions[0].fn).toBe("use_trending_app");
    expect(parseScriptActions("music piano").actions[0].fn).toBe("use_music_app");
    expect(parseScriptActions("google iphone 16").actions[0].fn).toBe("google");
    expect(parseScriptActions("visit https://x.com").actions[0].fn).toBe("visit");
  });

  it("App + send_message — полная цепочка (как в app.* сценариях)", () => {
    const parsed = parseScriptActions('weather Москва\nirc reply --ref 1 --text "дождь"');
    expect(parsed.actions.map((a) => a.fn)).toEqual(["use_weather_app", "send_message"]);
  });
});

describe("parseScriptActions — молчание", () => {
  it("скрипт только из комментариев → no_executable_script", () => {
    const parsed = parseScriptActions("# спор в группе\n# меня не зовут, молчу");
    expect(parsed.actions).toHaveLength(0);
    expect(parsed.instructions).toHaveLength(0);
    expect(parsed.silenceReason).toBe(NO_EXECUTABLE_SILENCE);
    expect(NO_EXECUTABLE_SILENCE).toBe("no_executable_script");
  });

  it("пустой скрипт → silenceReason null (нет no_executable comments)", () => {
    // Пустая строка: нет комментариев → grader получит no_action, не silence.
    const parsed = parseScriptActions("   ");
    expect(parsed.silenceReason).toBeNull();
  });

  it("комментарий внутри строки команды не превращает её в молчание", () => {
    const parsed = parseScriptActions('irc say --text "привет" # дружелюбно');
    expect(parsed.actions[0].fn).toBe("send_message");
    expect(parsed.actions[0].args.text).toBe("привет");
    expect(parsed.silenceReason).toBeNull();
  });
});

// ── Регрессия H17: end-to-end через toEvalTickResult + gradeStructural ──
describe("H17 регрессия: structural grading правдиво отражает скрипт", () => {
  it("engage: reply-скрипт → intent engage + actions.must send_message проходят", () => {
    const scripts = ['irc reply --ref 1 --text "конечно, помогу!"'];
    const assertions: StructuralAssertions = {
      expectedIntent: "engage",
      actions: { must: ["send_message"] },
    };
    const grade = gradeStructural(toEvalTickResult(tickResult(), scripts), assertions, 1);
    expect(grade.pass).toBe(true);
    expect(grade.checks.find((c) => c.name === "intent")?.actual).toBe("engage");
  });

  it("silence: комментарий-скрипт → intent silence проходит", () => {
    const scripts = ["# горячий спор, наблюдаю молча"];
    const assertions: StructuralAssertions = {
      expectedIntent: "silence",
      actions: { must_not: ["send_message"] },
    };
    const grade = gradeStructural(toEvalTickResult(tickResult(), scripts), assertions, 1);
    expect(grade.pass).toBe(true);
    expect(grade.checks.find((c) => c.name === "intent")?.actual).toBe("silence");
  });

  it("action_only: react + feel → intent engage + instructions.must feel проходят", () => {
    const scripts = ["irc react --ref 60 --emoji 🎉\nself feel --valence 0.8"];
    const assertions: StructuralAssertions = {
      expectedIntent: "engage",
      expectedBranch: "action_only",
      instructions: { must: ["feel"] },
    };
    const grade = gradeStructural(toEvalTickResult(tickResult(), scripts), assertions, 1);
    expect(grade.pass).toBe(true);
    expect(grade.checks.find((c) => c.name === "branch")?.actual).toBe("action_only");
  });

  it("app: calendar + send_message → actions.must обе проходят", () => {
    const scripts = ['calendar 2026-02-15\nirc reply --ref 1 --text "это суббота"'];
    const assertions: StructuralAssertions = {
      expectedIntent: "engage",
      maxSteps: 3,
      actions: { must: ["use_calendar_app", "send_message"] },
    };
    const grade = gradeStructural(toEvalTickResult(tickResult(), scripts), assertions, 1);
    expect(grade.pass).toBe(true);
  });

  it("replyDirected: --ref даёт replyTo, проверка проходит", () => {
    const scripts = ['irc reply --ref 42 --text "да"'];
    const assertions: StructuralAssertions = {
      expectedIntent: "engage",
      replyDirected: true,
    };
    const grade = gradeStructural(toEvalTickResult(tickResult(), scripts), assertions, 1);
    expect(grade.checks.find((c) => c.name === "replyDirected")?.pass).toBe(true);
  });

  it("без скриптов (откат) → actions пусты, silenceReason из execution", () => {
    const result = tickResult({
      execution: emptyScriptExecutionResult({ silenceReason: "явное молчание" }),
    });
    const evalResult = toEvalTickResult(result);
    expect(evalResult.actions).toHaveLength(0);
    expect(evalResult.silenceReason).toBe("явное молчание");
  });
});
