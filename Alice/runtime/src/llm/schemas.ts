/**
 * Schema действий LLM (определения Zod).
 *
 * История эволюции schema:
 * - V2 (ADR-64): разделение message + sideEffects (три поля: reasoning/message/sideEffects) — удалено
 * - V3 (ADR-66): Script-First схождение (одно поле: script) — удалено, влито в TickStepSchema
 * - V4 (ADR-142): Blackboard Tick (needs + script) — удалено
 * - V5 (§16): Script-only — shell manual виден плоско, поле needs на уровне JSON больше не нужно
 *
 * @see docs/adr/64-runtime-theory-alignment-audit.md
 * @see docs/adr/66-runtime-practice-review.md
 * @see docs/adr/163-expand-instruction-bt-native-disclosure.md §16
 */
import { z } from "zod";
import { AFTERWARD_VALUES } from "./tools.js";

// ── §16: Script-only Schema ────────────────────────────────────────
//
// JSON schema оставляет только поле script; обнаружение команд берут на себя shell manual и `<command> --help`.
// Старый механизм активации needs/man/prepare выведен из обычного пути, чтобы исключить бэкдор массовой активации без intent.

/**
 * Schema действий LLM — используется конвейером Blackboard Tick.
 *
 * script: POSIX sh скрипт (нативное выполнение в shell).
 *   Использует пространство команд Alice (irc / self / engine / app CLIs).
 *
 * @see docs/adr/163-expand-instruction-bt-native-disclosure.md §16
 */
/**
 * Нормализация скрипта из вывода LLM:
 * 1. Снятие markdown-ограждений
 * 2. Разбивка однострочных многокомандных скриптов (частый деградированный паттерн LLM)
 *
 * @see preprocessScript in shell-executor.ts — двойная защита, здесь первый рубеж
 */
const ALICE_COMMAND_RE = /\b(?:irc|album|self|engine|alice-pkg)\b/;
/** Экспортируется для использования в пути callTickLLM generateText. */
export function normalizeScript(raw: string): string {
  let s = raw.trim();
  if (!s) return "# no action";
  // Снятие markdown-ограждений
  if (/^```(?:sh|bash|shell)?\n?/i.test(s)) {
    s = s.replace(/^```(?:sh|bash|shell)?\n?/i, "");
    s = s.replace(/\n?```$/, "");
    s = s.trim();
  }
  if (!s) return "# no action";
  // Some providers leak the markdown language label into the JSON string:
  // {"script":"sh\nirc read"}. The script already runs inside a shell, so a
  // leading language label is transport noise, not an Alice command.
  s = s.replace(/^(?:sh|bash|shell)\s*\n/i, "").trim();
  if (!s) return "# no action";
  // Нормализация однострочного скрипта: вставка переноса перед границами комментариев `# ` и именами известных команд
  if (!s.includes("\n") && ALICE_COMMAND_RE.test(s)) {
    // Вставка переноса перед mid-line `# ` (разбивка внутреннего монолога)
    s = s.replace(/(?<=\S)\s*(?=# )/g, "\n");
    // Вставка переноса перед именами известных команд
    s = s.replace(/(?<=['"。！？.!?\s])(?=(?:irc|album|self|engine|alice-pkg)\b)/g, "\n");
    s = s.trim();
  }
  return s;
}

/**
 * ADR-215: когнитивный остаток, напрямую выражаемый LLM.
 * Семантика принадлежит LLM — код лишь предоставляет структуру, не принимая решения вместо LLM.
 */
export const ResidueSchema = z.object({
  feeling: z
    .enum(["unresolved", "interrupted", "curious", "settled"])
    .describe(
      "How you feel as this conversation ends. " +
        "unresolved: something is bothering you that you couldn't express. " +
        "interrupted: you were cut off and want to come back. " +
        "curious: something caught your attention elsewhere. " +
        "settled: you're at peace — conversation ended naturally.",
    ),
  toward: z
    .string()
    .optional()
    .describe(
      "If your mind drifts to someone or somewhere, their @id (e.g. @7785440246). Omit if nowhere specific.",
    ),
  reason: z.string().max(200).optional().describe("Why, in a few words."),
});
export type LLMResidue = z.infer<typeof ResidueSchema>;

function formatSchemaError(error: {
  issues: Array<{ path: Array<string | number>; message: string }>;
}): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
      return `${path}: ${issue.message}`;
    })
    .join("\n");
}

function parseJsonCandidate(text: string): unknown {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const candidate = (fenced?.[1] ?? trimmed).trim();

  try {
    return JSON.parse(candidate);
  } catch (firstError) {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(candidate.slice(start, end + 1));
      } catch {
        // Report the original error; it best describes the model's response shape.
      }
    }
    throw firstError;
  }
}

function normalizeResidue(value: unknown): unknown {
  if (value === null) return undefined;
  if (typeof value === "object") {
    if (Array.isArray(value)) return undefined;
    const record = value as Record<string, unknown>;
    const feeling = normalizeResidueFeeling(record.feeling);
    if (!feeling) return undefined;
    return {
      feeling,
      ...(typeof record.toward === "string" && record.toward.trim()
        ? { toward: record.toward.trim() }
        : {}),
      ...(typeof record.reason === "string" && record.reason.trim()
        ? { reason: record.reason.trim().slice(0, 200) }
        : {}),
    };
  }
  if (typeof value !== "string") return value;

  const feeling = normalizeResidueFeeling(value);
  return feeling ? { feeling } : undefined;
}

function normalizeResidueFeeling(value: unknown): LLMResidue["feeling"] | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toLowerCase();
  if (!trimmed || trimmed === "none" || trimmed === "null" || trimmed === "settled") {
    return null;
  }
  if (["unresolved", "interrupted", "curious"].includes(trimmed)) {
    return trimmed as LLMResidue["feeling"];
  }
  return null;
}

export const TickStepSchema = z.object({
  script: z
    .preprocess(
      (value) => (typeof value === "string" ? normalizeScript(value) : value),
      z.string().min(1, "Script must not be empty"),
    )
    .describe(
      "A multi-line POSIX sh script file. " +
        "IMPORTANT: write one command per line, separated by newlines (\\n). " +
        "Use # comments on their own line for scratchpad reasoning. " +
        "Commands: irc (Telegram I/O), self (perception/queries), engine (instructions).",
    ),
  afterward: z
    .enum(AFTERWARD_VALUES)
    .describe(
      "What should happen to this chat after your turn. " +
        "done: finished — said what you wanted, nothing more to do (most common, use this by default). " +
        "waiting_reply: you JUST SAID something and are waiting for THEIR response — " +
        "if you asked a question, you must use this, not done. " +
        "watching: after this turn, stay engaged with this chat because something is still unfolding " +
        "or you want to keep the thread warm. The host may continue immediately if fresh local " +
        "observations appear; otherwise it will keep watching this chat for the next turn. " +
        "resting: only when you are actually going to sleep or leaving Telegram for a while — " +
        "the host should stop ordinary follow-up until rest expires. Do not use it for ordinary low energy. " +
        "fed_up: the room is draining or hostile — walk away (penalty: closes the conversation). " +
        "cooling_down: only when the current room is spammy or toxic and needs distance — " +
        "take a break (penalty: freezes this chat for ~30 min).",
    ),
  // ADR-215: Episode residue — LLM напрямую выражает когнитивный остаток.
  // Optional: заполняется только при наличии непереработанных ощущений. В большинстве случаев не заполняется.
  residue: z
    .preprocess(normalizeResidue, ResidueSchema.optional())
    .describe(
      "Only fill this if something feels unfinished or unresolved as you leave this conversation. " +
        "Most of the time, omit this entirely.",
    ),
});
export type TickStep = z.infer<typeof TickStepSchema>;

export function parseTickStep(text: string): TickStep {
  let json: unknown;
  try {
    json = parseJsonCandidate(text);
  } catch (error) {
    throw new Error(
      `Structured block JSON parse failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const parsed = TickStepSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(
      `Structured block schema validation failed:\n${formatSchemaError(parsed.error)}`,
    );
  }
  return parsed.data;
}
