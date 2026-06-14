/**
 * Tick LLM вызов — транспорт структурированных блоков.
 *
 * Семантика:
 * - Один вызов generateText выводит JSON {script, afterward, residue?}
 * - Host выполняет только локальную предварительную валидацию скрипта; при ошибке допускается 1 структурированная правка
 * - После прохождения валидации скрипт выполняется напрямую; следующие раунды контролирует внешний tick / engagement
 *
 * @see docs/adr/246-transport-separation-block-first-execution.md
 * @see docs/adr/213-tool-calling-act-thread.md
 */
import { generateText } from "ai";
import type { ScriptExecutionResult } from "../../core/script-execution.js";
import { validateScript } from "../../core/script-validator.js";
import { executeShellScript } from "../../core/shell-executor.js";
import { writeAuditEvent } from "../../db/audit.js";
import { type AvailableProvider, selectProviderForFirstPass } from "../../llm/client.js";
import {
  CircuitOpenError,
  getBreakerState,
  ProviderUnavailableError,
  withResilience,
} from "../../llm/resilience.js";
import { type LLMResidue, parseTickStep, type TickStep } from "../../llm/schemas.js";
import type { Afterward } from "../../llm/tools.js";
import { createLogger } from "../../utils/logger.js";
import type { TCAssistantRoundTrace } from "./tc-loop.js";

const log = createLogger("tick/callLLM");

const BLOCK_TEMPERATURE = 0.7;
// 120s: claude CLI через прокси стартует процесс на каждый вызов (cold start),
// большой промпт мозга не всегда укладывается в 60с. Запас под локальный прокси.
const BLOCK_TIMEOUT_MS = 120_000;
// #23: opus медленнее (глубже рассуждает + холодный старт CLI). Даём больше времени,
// чтобы ops-тики в работач не падали по timeout и не откатывались на sonnet.
// Держим ВЫШЕ прокси-овского PROXY_OPUS_TIMEOUT_S (230с): прокси убьёт зависший первым.
const OPUS_BLOCK_TIMEOUT_MS = 240_000;
const MAX_BLOCK_REPAIR_RETRIES = 1;

interface ProviderAuditContext {
  provider: string;
  model: string;
  breakerState: string;
}

interface GeneratedBlockStep {
  step: TickStep;
  attempts: number;
  terminalSilence?: boolean;
  provider: Pick<AvailableProvider, "name" | "model">;
}

export type TickFailureKind = "provider_unavailable" | "llm_invalid";

export interface TickFailureResult {
  ok: false;
  failureKind: TickFailureKind;
  error: string;
}

export interface TickExecutionResult extends ScriptExecutionResult {
  afterward: Afterward;
  toolCallCount: number;
  assistantTurnCount?: number;
  bashCallCount?: number;
  signalCallCount?: number;
  budgetExhausted: boolean;
  rawScript: string;
  commandOutput: string;
  transcript?: TCAssistantRoundTrace[];
  llmResidue?: LLMResidue;
  llmProvider?: string;
  llmModel?: string;
}

export type TickCallResult = TickExecutionResult | TickFailureResult | null;

function buildCommandOutput(
  script: string,
  execution: Awaited<ReturnType<typeof executeShellScript>>,
): string {
  const outputLines = [
    ...execution.instructionErrors.map((line) => `instruction error\n${line}`),
    ...execution.errors.map((line) => `error\n${line}`),
    ...execution.logs,
  ];
  return `$ ${script}\n${outputLines.join("\n") || "(no output)"}`;
}

function makeBlockResult(
  generated: GeneratedBlockStep,
  execution: Awaited<ReturnType<typeof executeShellScript>>,
): TickExecutionResult {
  return {
    afterward: generated.step.afterward,
    toolCallCount: 0,
    assistantTurnCount: generated.attempts,
    bashCallCount: 1,
    signalCallCount: 0,
    budgetExhausted: false,
    rawScript: generated.step.script,
    commandOutput: buildCommandOutput(generated.step.script, execution),
    llmResidue: generated.step.residue,
    llmProvider: generated.provider.name,
    llmModel: generated.provider.model,
    logs: execution.logs,
    errors: execution.errors,
    instructionErrors: execution.instructionErrors,
    errorCodes: execution.errorCodes,
    errorDetails: execution.errorDetails ?? [],
    duration: execution.duration,
    thinks: execution.thinks,
    queryLogs: execution.queryLogs,
    observations: execution.observations,
    completedActions: execution.completedActions,
    silenceReason: execution.silenceReason,
  };
}

function extractScriptComments(script: string): string[] {
  return script
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("#"))
    .map((line) => line.replace(/^#+\s?/, "").trim())
    .filter(Boolean);
}

function isNoExecutableValidation(validation: ReturnType<typeof validateScript>): boolean {
  return (
    validation.errors.length > 0 &&
    validation.errors.every((error) => error.code === "no_executable")
  );
}

function makeNoExecutableResult(generated: GeneratedBlockStep): TickExecutionResult {
  const thinks = extractScriptComments(generated.step.script);
  return {
    afterward: "done",
    toolCallCount: 0,
    assistantTurnCount: generated.attempts,
    bashCallCount: 0,
    signalCallCount: 0,
    budgetExhausted: false,
    rawScript: generated.step.script,
    commandOutput: `$ ${generated.step.script}\n(no executable command; treated as silence)`,
    llmResidue: generated.step.residue,
    llmProvider: generated.provider.name,
    llmModel: generated.provider.model,
    logs: [],
    errors: [],
    instructionErrors: [],
    errorCodes: [],
    errorDetails: [],
    duration: 0,
    thinks,
    queryLogs: [],
    observations: [],
    completedActions: [],
    silenceReason: "no_executable_script",
  };
}

function classifyTickFailure(error: unknown): TickFailureKind {
  if (error instanceof ProviderUnavailableError || error instanceof CircuitOpenError) {
    return "provider_unavailable";
  }
  const status = extractErrorStatus(error);
  if (status === 401 || status === 402 || status === 403) {
    return "provider_unavailable";
  }
  return "llm_invalid";
}

function extractErrorStatus(error: unknown): number | null {
  if (error == null || typeof error !== "object") return null;
  const obj = error as Record<string, unknown>;
  for (const key of ["statusCode", "status"]) {
    const value = obj[key];
    if (typeof value === "number" && value >= 100 && value < 600) return value;
  }
  return extractErrorStatus(obj.cause);
}

async function generateBlockStep(
  system: string,
  user: string,
  selectedProvider?: AvailableProvider,
): Promise<GeneratedBlockStep> {
  const { provider, model, name } = selectedProvider ?? selectProviderForFirstPass();
  // #23: opus получает больший таймаут (см. OPUS_BLOCK_TIMEOUT_MS).
  const timeoutMs = model === "opus" ? OPUS_BLOCK_TIMEOUT_MS : BLOCK_TIMEOUT_MS;
  const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
    { role: "system", content: system },
    { role: "user", content: user },
  ];

  for (let attempt = 0; attempt <= MAX_BLOCK_REPAIR_RETRIES; attempt++) {
    const result = await withResilience(
      () =>
        generateText({
          model: provider(model),
          messages,
          temperature: BLOCK_TEMPERATURE,
          maxRetries: 0,
          abortSignal: AbortSignal.timeout(timeoutMs),
        }),
      { maxRetries: 0 },
      name,
    );

    let step: TickStep;
    try {
      step = parseTickStep(result.text);
    } catch (error) {
      if (attempt === MAX_BLOCK_REPAIR_RETRIES) {
        throw error;
      }
      messages.push({
        role: "assistant",
        content: result.text,
      });
      messages.push({
        role: "user",
        content:
          "Your previous response was not a valid JSON object matching {script, afterward, residue?}.\n" +
          `${error instanceof Error ? error.message : String(error)}\n` +
          "Return only one corrected JSON object. Do not use markdown fences. Do not explain.",
      });
      continue;
    }

    const validation = validateScript(step.script);
    if (validation.valid) {
      return {
        step,
        attempts: attempt + 1,
        provider: { name, model },
      };
    }

    if (isNoExecutableValidation(validation) && extractScriptComments(step.script).length > 0) {
      log.info("Structured block has no executable commands; treating as silence", {
        summary: validation.summary,
      });
      return {
        step,
        attempts: attempt + 1,
        terminalSilence: true,
        provider: { name, model },
      };
    }

    if (attempt === MAX_BLOCK_REPAIR_RETRIES) {
      throw new Error(
        `Structured block validation failed after ${attempt + 1} attempts:\n${validation.summary}`,
      );
    }

    messages.push({
      role: "assistant",
      content: JSON.stringify(step, null, 2),
    });
    messages.push({
      role: "user",
      content:
        "Your previous structured block failed shell validation.\n" +
        `${validation.summary}\n` +
        "Use namespaced commands exactly as shown: irc reply/react/whois, self intend/diary/feel. " +
        "If you decide to stay silent, return a script with only # comments. " +
        "Return one corrected {script, afterward, residue?} object. Do not explain.",
    });
  }

  throw new Error("unreachable");
}

function safeAuditProviderContext(provider?: AvailableProvider): ProviderAuditContext | null {
  if (provider) {
    return {
      provider: provider.name,
      model: provider.model,
      breakerState: getBreakerState(provider.name),
    };
  }
  try {
    const provider = selectProviderForFirstPass();
    return {
      provider: provider.name,
      model: provider.model,
      breakerState: getBreakerState(provider.name),
    };
  } catch {
    return null;
  }
}

export async function callTickLLM(
  system: string,
  user: string,
  tick: number,
  target: string | null,
  voice: string,
  contextVars: Record<string, unknown> | undefined,
  selectedProvider?: AvailableProvider,
): Promise<TickCallResult> {
  // M3: LLM-вызов и исполнение шелла/песочницы — РАЗНЫЕ try. Падение Docker/sandbox — это
  // инфра-аутэйдж, а НЕ ошибка LLM; нельзя штрафовать настроение/каденс как llm_invalid (ADR-274).
  let generated: Awaited<ReturnType<typeof generateBlockStep>>;
  try {
    generated = await generateBlockStep(system, user, selectedProvider);
  } catch (e) {
    log.error("Tick LLM call failed", e);
    const provider = safeAuditProviderContext(selectedProvider);
    writeAuditEvent(tick, "error", "tick", "LLM call failed", {
      voice,
      target,
      error: e instanceof Error ? e.message : String(e),
      provider: provider?.provider ?? "none",
      model: provider?.model ?? "none",
      breakerState: provider?.breakerState ?? "unknown",
    });
    return {
      ok: false,
      failureKind: classifyTickFailure(e),
      error: e instanceof Error ? e.message : String(e),
    };
  }
  if (generated.terminalSilence) {
    return makeNoExecutableResult(generated);
  }
  try {
    const execution = await executeShellScript(generated.step.script, { contextVars });
    return makeBlockResult(generated, execution);
  } catch (e) {
    // Шелл/песочница упали (напр. Docker Desktop down) — LLM отработал, это host-проблема.
    log.error("Tick shell execution failed (host/sandbox infra)", e);
    const provider = safeAuditProviderContext(selectedProvider);
    writeAuditEvent(tick, "error", "tick", "shell execution failed", {
      voice,
      target,
      error: e instanceof Error ? e.message : String(e),
      provider: provider?.provider ?? "none",
      model: provider?.model ?? "none",
      breakerState: provider?.breakerState ?? "unknown",
    });
    return {
      ok: false,
      failureKind: "provider_unavailable",
      error: e instanceof Error ? e.message : String(e),
    };
  }
}
