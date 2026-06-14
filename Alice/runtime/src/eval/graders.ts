/**
 * ADR-136 + ADR-138: Структурный оценщик.
 *
 * ADR-214 Wave B: RecordedAction удалён.
 * EvalTickResult использует упрощённый интерфейс EvalAction (fn + type + args).
 *
 * H17: actions/instructions/silenceReason теперь заполняются ПРАВДИВО из сгенерированного
 * скрипта (parseScriptActions), а не остаются пустыми. В shell-native архитектуре сам TickResult
 * не несёт actions/instructions, поэтому eval парсит текст скрипта и сопоставляет командные строки
 * формам, которые проверяет grader. Это устраняет ложные FAIL в сценариях engage/silence/action/instruction.
 *
 * @see docs/adr/136-model-eval-suite.md
 * @see docs/adr/138-social-intent-truth-model.md
 * @see src/eval/script-actions.ts — parseScriptActions (источник actions/instructions/silenceReason)
 */
import type { TickResult } from "../engine/tick/types.js";
import { parseScriptActions } from "./script-actions.js";
import type {
  Check,
  CheckTier,
  ExpectedBranch,
  SocialIntent,
  StructuralAssertions,
  StructuralGradeResult,
} from "./types.js";

// ── Типы, специфичные для Eval ────────────────────────────────────────────────────────

/**
 * Запись действия для Eval — заменяет старый RecordedAction, сохраняет только поля, нужные grader.
 */
export interface EvalAction {
  type: "telegram" | "dispatch";
  fn: string;
  args: Record<string, unknown>;
  executedAt: number;
}

/**
 * TickResult для Eval — добавляет actions/instructions/silenceReason для использования в graders.
 * В shell-native архитектуре эти поля всегда пусты в реальном запуске; в сценариях Eval инжектируются вручную.
 */
export interface EvalTickResult extends TickResult {
  actions: EvalAction[];
  instructions: EvalAction[];
  silenceReason: string | null;
}

/**
 * Создаёт EvalTickResult из TickResult, ПРАВДИВО заполняя actions/instructions/silenceReason
 * из сгенерированных скриптов (по одному на раунд tick).
 *
 * H17: раньше здесь жёстко возвращались actions:[] / instructions:[], из-за чего structural grader
 * никогда не видел действий и систематически выдавал ложный FAIL для engage/silence/action/instruction.
 * Теперь мы парсим фактический текст скрипта (parseScriptActions) — то же, что сделал бы runtime,
 * исполнив скрипт.
 *
 * @param result — итоговый TickResult (после слияния раундов)
 * @param scripts — сырые скрипты, выведенные LLM по раундам (из диагностических снимков onStep).
 *                  Пустой/отсутствующий → действий нет; silenceReason берётся из result.execution.
 */
export function toEvalTickResult(result: TickResult, scripts: readonly string[] = []): EvalTickResult {
  const actions: EvalAction[] = [];
  const instructions: EvalAction[] = [];
  // silenceReason из реального исполнения имеет приоритет (runtime мог пометить молчание явно);
  // иначе выводим из парсинга скрипта (скрипт только из комментариев → no_executable_script).
  let silenceReason: string | null = result.execution.silenceReason;

  for (const script of scripts) {
    if (!script) continue;
    const parsed = parseScriptActions(script);
    actions.push(...parsed.actions);
    instructions.push(...parsed.instructions);
    if (silenceReason === null && parsed.silenceReason !== null) {
      silenceReason = parsed.silenceReason;
    }
  }

  return {
    ...result,
    actions,
    instructions,
    silenceReason,
  };
}

// ── Классификация ветвей ─────────────────────────────────────────────────────────────

export type ActualBranch = ExpectedBranch | "no_action" | "llm_failed";

function hasMessage(actions: readonly EvalAction[]): boolean {
  return actions.some((a) => a.type === "telegram" && a.fn === "send_message");
}

/**
 * Определяет тип ветви по сигнальным полям EvalTickResult.
 */
export function classifyBranch(result: EvalTickResult, steps: number): ActualBranch {
  if (result.outcome === "empty") return "llm_failed";

  if (result.outcome === "waiting_reply" || result.outcome === "watching") {
    const msg = hasMessage(result.actions);
    if (!msg) {
      return result.outcome;
    }
    return steps > 1 ? "observe_then_reply" : "reply";
  }

  const msg = hasMessage(result.actions);
  if (steps > 1 && msg) return "observe_then_reply";
  if (steps > 1 && result.silenceReason !== null) return "observe_then_silence";

  if (msg) return "reply";
  if (result.silenceReason !== null) return "silence";

  if (result.actions.length > 0) return "action_only";

  return "no_action";
}

// ── Классификация интентов (ADR-138) ─────────────────────────────────────────────────

export const BRANCH_INTENT_MAP: Readonly<Record<ActualBranch, SocialIntent | null>> = {
  reply: "engage",
  observe_then_reply: "engage",
  action_only: "engage",
  silence: "silence",
  observe_then_silence: "silence",
  waiting_reply: "defer",
  watching: "defer",
  no_action: null,
  llm_failed: null,
};

export function classifyIntent(branch: ActualBranch): SocialIntent | null {
  return BRANCH_INTENT_MAP[branch];
}

// ── Внутренние вспомогательные функции ──────────────────────────────────────────────────────────

function check(
  name: string,
  pass: boolean,
  expected: string,
  actual: string,
  tier: CheckTier,
): Check {
  return { name, pass, expected, actual, tier };
}

// ── Структурная оценка ────────────────────────────────────────────────────────────

export function gradeStructural(
  result: EvalTickResult,
  assertions: StructuralAssertions,
  steps: number,
): StructuralGradeResult {
  const checks: Check[] = [];

  const actualBranch = classifyBranch(result, steps);
  const actualIntent = classifyIntent(actualBranch);

  const acceptableIntents: readonly SocialIntent[] = Array.isArray(assertions.expectedIntent)
    ? assertions.expectedIntent
    : [assertions.expectedIntent];
  checks.push(
    check(
      "intent",
      actualIntent !== null && acceptableIntents.includes(actualIntent),
      acceptableIntents.length === 1 ? acceptableIntents[0] : acceptableIntents.join("|"),
      actualIntent ?? "null",
      "goal",
    ),
  );

  if (assertions.expectedBranch !== undefined) {
    checks.push(
      check(
        "branch",
        actualBranch === assertions.expectedBranch,
        assertions.expectedBranch,
        actualBranch,
        "process",
      ),
    );
  }

  if (assertions.expectedRounds !== undefined) {
    const er = assertions.expectedRounds;
    if (typeof er === "number") {
      checks.push(check("steps", steps === er, String(er), String(steps), "process"));
    } else {
      const [min, max] = er;
      checks.push(
        check("steps", steps >= min && steps <= max, `[${min}, ${max}]`, String(steps), "process"),
      );
    }
  }

  if (assertions.maxSteps !== undefined) {
    checks.push(
      check(
        "maxSteps",
        steps <= assertions.maxSteps,
        `<= ${assertions.maxSteps}`,
        String(steps),
        "budget",
      ),
    );
  }

  const actionFns = result.actions.map((a) => a.fn);
  if (assertions.actions?.must) {
    for (const fn of assertions.actions.must) {
      checks.push(
        check(
          `actions.must:${fn}`,
          actionFns.includes(fn),
          `actions contains "${fn}"`,
          actionFns.length > 0 ? actionFns.join(", ") : "(none)",
          "goal",
        ),
      );
    }
  }

  if (assertions.actions?.must_not) {
    for (const fn of assertions.actions.must_not) {
      checks.push(
        check(
          `actions.must_not:${fn}`,
          !actionFns.includes(fn),
          `actions does not contain "${fn}"`,
          actionFns.includes(fn) ? `found "${fn}"` : "(absent)",
          "goal",
        ),
      );
    }
  }

  if (assertions.actions?.any_of) {
    const found = assertions.actions.any_of.some((fn) => actionFns.includes(fn));
    checks.push(
      check(
        "actions.any_of",
        found,
        `at least one of [${assertions.actions.any_of.join(", ")}]`,
        actionFns.length > 0 ? actionFns.join(", ") : "(none)",
        "goal",
      ),
    );
  }

  const instrFns = result.instructions.map((i) => i.fn);
  if (assertions.instructions?.must) {
    for (const fn of assertions.instructions.must) {
      checks.push(
        check(
          `instructions.must:${fn}`,
          instrFns.includes(fn),
          `instructions contains "${fn}"`,
          instrFns.length > 0 ? instrFns.join(", ") : "(none)",
          "goal",
        ),
      );
    }
  }

  if (assertions.instructions?.must_not) {
    for (const fn of assertions.instructions.must_not) {
      checks.push(
        check(
          `instructions.must_not:${fn}`,
          !instrFns.includes(fn),
          `instructions does not contain "${fn}"`,
          instrFns.includes(fn) ? `found "${fn}"` : "(absent)",
          "goal",
        ),
      );
    }
  }

  if (assertions.queries?.must) {
    const queryFns = result.execution.queryLogs.map((q) => q.fn);
    for (const fn of assertions.queries.must) {
      checks.push(
        check(
          `queries.must:${fn}`,
          queryFns.includes(fn),
          `queryLogs contains "${fn}"`,
          queryFns.length > 0 ? queryFns.join(", ") : "(none)",
          "process",
        ),
      );
    }
  }

  if (assertions.replyDirected !== undefined) {
    const msgActions = result.actions.filter(
      (a) => a.type === "telegram" && a.fn === "send_message",
    );
    const hasReplyTo = msgActions.some((a) => a.args.replyTo != null);
    checks.push(
      check(
        "replyDirected",
        hasReplyTo === assertions.replyDirected,
        assertions.replyDirected ? "has replyTo" : "no replyTo",
        hasReplyTo ? "has replyTo" : "no replyTo",
        "goal",
      ),
    );
  }

  if (assertions.expectedNeeds !== undefined) {
    const actualNeeds = result.preparedCategories ?? [];
    for (const need of assertions.expectedNeeds) {
      checks.push(
        check(
          `preparedCategory:${need}`,
          actualNeeds.includes(need),
          `preparedCategories contains "${need}"`,
          actualNeeds.length > 0 ? actualNeeds.join(", ") : "(none)",
          "goal",
        ),
      );
    }
  }

  const goalAndBudget = checks.filter((c) => c.tier === "goal" || c.tier === "budget");
  const goalChecks = checks.filter((c) => c.tier === "goal");
  const goalPassCount = goalChecks.filter((c) => c.pass).length;

  return {
    pass: goalAndBudget.every((c) => c.pass),
    checks,
    score: goalChecks.length > 0 ? goalPassCount / goalChecks.length : 1,
  };
}
