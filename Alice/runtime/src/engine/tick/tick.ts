/**
 * Blackboard Tick основной цикл — buildPrompt → callLLM → updateBoard.
 *
 * ADR-214 Wave A: resolveQueries удалён (в shell-native архитектуре actions всегда пусты).
 *
 * Семантика основного цикла:
 * 1. buildPrompt → callLLM (генерирует один structured block и выполняет его)
 * 2. updateBoard: результат выполнения записывается в Blackboard
 * 3. Host принимает решение на двух уровнях:
 *    - afterward: направление диалога после завершения текущего раунда
 *    - intra-tick continuation: решение о немедленном продолжении на основе локальных observations / ошибок
 *
 * Условия завершения (ADR-216 + ADR-246):
 * - isTerminal(board) не null (бюджет исчерпан)
 * - Ошибки выполнения / ошибки инструкций → приоритет самокоррекции внутри того же tick, afterward не может переопределить
 * - afterward = waiting_reply / resting / fed_up / cooling_down → завершение при отсутствии ошибок
 * - afterward = watching и host обнаружил новый локальный follow-up контекст → продолжение внутри того же tick
 * - afterward = watching, но host не обнаружил нового локального follow-up контекста → передача внешнему watcher
 * - afterward = done и есть ошибки → самокоррекция с продолжением внутри того же tick
 * - во всех прочих случаях — завершение
 *
 * @see docs/adr/169-fire-query-auto-continuation.md
 * @see docs/adr/142-action-space-architecture/README.md
 * @see docs/adr/246-transport-separation-block-first-execution.md
 * @see docs/adr/256-tc-block-execution-fact-authority/README.md
 */

import type { ActionRuntimeConfig } from "../../core/action-executor.js";
import {
  type ExecutionObservation,
  hasCompletedSend,
  type ScriptExecutionErrorCode,
} from "../../core/script-execution.js";
import { logPromptSnapshot } from "../../diagnostics/prompt-log.js";
import { extractNumericId } from "../../graph/constants.js";
import type { AvailableProvider } from "../../llm/client.js";
import type { Afterward } from "../../llm/tools.js";
import { CROSS_CHAT_OBSERVATION_MARKER } from "../act/timeline.js";
import { drainBoard, isTerminal, updateBoard } from "./blackboard.js";
import type { TickCallResult, TickExecutionResult, TickFailureResult } from "./callLLM.js";
import { buildTickPrompt, type TickPromptContext } from "./prompt-builder.js";
import type {
  ActualContinuationReason,
  Blackboard,
  IntraTickContinuationReason,
  TickOutcome,
  TickResult,
  UnifiedTool,
} from "./types.js";

// ═══════════════════════════════════════════════════════════════════════════
// afterward → outcome маппинг
// ═══════════════════════════════════════════════════════════════════════════

const AFTERWARD_TO_OUTCOME: Record<Afterward, TickOutcome> = {
  done: "terminal",
  resting: "resting",
  fed_up: "fed_up",
  cooling_down: "cooling_down",
  waiting_reply: "waiting_reply",
  watching: "watching",
};

function describeExecutionErrorCode(code: ScriptExecutionErrorCode): string {
  switch (code) {
    case "command_invalid_target":
      return "не знаю, кто это";
    case "command_missing_argument":
      return "в команде не хватает обязательного параметра";
    case "command_arg_format":
    case "command_invalid_message_id":
    case "command_invalid_reply_ref":
      return "команда, похоже, написана неправильно";
    case "invalid_reaction":
      return "эту реакцию нельзя отправить";
    case "invalid_sticker_keyword":
      return "не нашла такой стикер";
    case "unreachable_telegram_user":
    case "telegram_hard_permanent":
    case "telegram_soft_permanent":
      return "до этого адресата сейчас не достучаться";
    case "voice_messages_forbidden":
      return "собеседник не разрешает присылать голосовые";
    case "timeout":
    case "provider_unavailable":
      return "внешний сервис временно недоступен";
    case "command_cross_chat_send":
      return "нельзя самой писать в другой чат";
    case "script_validation":
    case "shell_nonzero":
      return "команда не выполнилась";
  }
}

/**
 * Контекст-скоупинг: прочитала ли команда этого раунда ДРУГОЙ чат (не текущую цель тика).
 *
 * Достоверный сигнал — структурированная метаданных наблюдения (ExecutionObservation.targetChatId),
 * а НЕ текст вывода. Команды чтения чужого чата (`irc tail --in ...`, `recent_chat --in ...`)
 * проставляют targetChatId; если он указывает на чат, отличный от текущей цели, значит в logs
 * этого раунда лежат реплики другого разговора. Их нельзя подавать как текущий контекст для ответа —
 * иначе их тон/цитаты протекают в композицию для текущего чата (cross-chat contamination).
 *
 * Сравнение по numeric id: targetChatId бывает и graph-id (`channel:telegram:X`), и сырым (`X`);
 * приватный чат делит numeric id между contact:X и channel:X.
 */
function readsAnotherChat(
  observations: readonly ExecutionObservation[],
  tickTarget: string | null,
): boolean {
  if (!tickTarget) return false;
  const tickNum = extractNumericId(tickTarget);
  if (tickNum == null) return false;
  for (const obs of observations) {
    if (!obs.targetChatId) continue;
    const obsNum = extractNumericId(obs.targetChatId);
    if (obsNum == null) continue;
    // targetChatId совпал с текущей целью → чтение СВОЕГО чата, не межчатовое.
    if (obsNum === tickNum) continue;
    return true;
  }
  return false;
}

interface IntraTickContinuationDecision {
  reason: IntraTickContinuationReason;
}

function isTickFailureResult(result: TickCallResult): result is TickFailureResult {
  return result != null && "ok" in result && result.ok === false;
}

function deriveIntraTickContinuation(
  execResult: TickExecutionResult,
  continuationTokens: ContinuationTokenSet,
): IntraTickContinuationDecision {
  if (hasCompletedSend(execResult)) {
    return { reason: "none" };
  }

  if (execResult.errors.length > 0 || execResult.instructionErrors.length > 0) {
    return { reason: "error_recovery" };
  }

  if (continuationTokens.actionableObservation) {
    switch (execResult.afterward) {
      case "done":
      case "waiting_reply":
      case "watching":
        return { reason: "local_observation_followup" };
      case "resting":
      case "fed_up":
      case "cooling_down":
        return { reason: "none" };
    }
  }

  if (execResult.afterward === "watching") {
    if (continuationTokens.newObservation) {
      return { reason: "local_observation_followup" };
    }
    return { reason: "none" };
  }

  return { reason: "none" };
}

function isActualContinuationReason(
  reason: IntraTickContinuationReason,
): reason is ActualContinuationReason {
  return reason !== "none";
}

interface ContinuationTokenSet {
  newObservation: boolean;
  actionableObservation: boolean;
}

function isActionableObservation(observation: ExecutionObservation): boolean {
  const intent = observation.payload?.intent;
  return observation.enablesContinuation && typeof intent === "string" && intent.length > 0;
}

function getTickSelectedProvider(
  ctx: TickPromptContext & { llmProvider?: AvailableProvider },
): AvailableProvider | undefined {
  return ctx.llmProvider;
}

function classifyContinuationTokens(
  execResult: TickExecutionResult,
  boardDelta: { hasNewObservations: boolean },
): ContinuationTokenSet {
  if (!boardDelta.hasNewObservations) {
    return { newObservation: false, actionableObservation: false };
  }
  if (execResult.errors.length > 0 || execResult.instructionErrors.length > 0) {
    return { newObservation: false, actionableObservation: false };
  }
  if (hasCompletedSend(execResult)) return { newObservation: false, actionableObservation: false };

  return {
    newObservation: execResult.observations.some((observation) => observation.enablesContinuation),
    actionableObservation: execResult.observations.some(isActionableObservation),
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Интерфейс внедрения зависимостей
// ═══════════════════════════════════════════════════════════════════════════

/** Внешние зависимости Tick-цикла (могут быть замокированы в тестах). */
export interface TickDeps {
  /** Вызов LLM — генерирует и выполняет один structured block, возвращает полный результат. */
  callLLM: (
    system: string,
    user: string,
    tick: number,
    target: string | null,
    voice: string,
    contextVars: Record<string, unknown> | undefined,
    selectedProvider?: AvailableProvider,
  ) => Promise<TickCallResult>;

  /** Переопределение построения prompt (для eval ablation-экспериментов). При отсутствии используется buildTickPrompt. */
  buildPrompt?: (
    board: Blackboard,
    allTools: readonly UnifiedTool[],
    ctx: TickPromptContext,
  ) => Promise<{ system: string; user: string }> | { system: string; user: string };

  /** Коллбэк после завершения каждого шага (для eval-диагностики). Вызывается после обращения к LLM. */
  onStep?: (info: { round: number; system: string; user: string; script: string | null }) => void;
}

// ═══════════════════════════════════════════════════════════════════════════
// Основной tick-цикл
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Blackboard Tick цикл — основная точка входа.
 *
 * Каждый шаг: buildTickPrompt → callLLM → updateBoard → inject errors
 * Завершение: isTerminal(board) не null или сигнал afterward прерывает цикл
 */
export async function tick(
  board: Blackboard,
  allTools: readonly UnifiedTool[],
  deps: TickDeps,
  ctx: TickPromptContext & {
    client: unknown;
    runtimeConfig: ActionRuntimeConfig;
  },
): Promise<TickResult> {
  const startTime = Date.now();
  let outcome: TickOutcome = "terminal";
  let lastExecResult: TickExecutionResult | null = null;
  let episodeRound = 0;
  const hostContinuationTrace: ActualContinuationReason[] = [];

  while (true) {
    // Проверка условий завершения
    const terminal = isTerminal(board);
    if (terminal != null) {
      outcome = terminal;
      break;
    }

    const round = board.budget.usedSteps;
    const obsBefore = board.observations.length;

    // ── Построение prompt ──
    const promptCtx: TickPromptContext = {
      ...ctx,
      messages: ctx.messages,
      observations: board.observations,
      round,
      episodeRound,
    };
    const { system, user } = deps.buildPrompt
      ? await deps.buildPrompt(board, allTools, promptCtx)
      : await buildTickPrompt(board, promptCtx);

    // ── Вызов LLM ──
    const execResult = await deps.callLLM(
      system,
      user,
      ctx.tick,
      ctx.item.target,
      ctx.item.action,
      board.contextVars as Record<string, unknown>,
      getTickSelectedProvider(ctx),
    );

    if (!execResult) {
      logPromptSnapshot({
        tick: ctx.tick,
        target: ctx.item.target,
        voice: ctx.item.action,
        round,
        observation: ctx.item.observation,
        system,
        user,
        script: null,
      });
      deps.onStep?.({ round, system, user, script: null });
      outcome = "empty";
      break;
    }

    if (isTickFailureResult(execResult)) {
      logPromptSnapshot({
        tick: ctx.tick,
        target: ctx.item.target,
        voice: ctx.item.action,
        round,
        observation: ctx.item.observation,
        system,
        user,
        script: null,
      });
      deps.onStep?.({ round, system, user, script: null });
      outcome = "empty";
      board.failureKind = execResult.failureKind;
      board.execution.errors.push(execResult.error);
      break;
    }

    lastExecResult = execResult;

    // ── Обновление Blackboard ──
    updateBoard(board, execResult);

    // ── ADR-213: результат выполнения → observations (фрактальное свёртывание: round → узел-факт) ──
    if (execResult.logs.length > 0) {
      const outputText = execResult.logs.slice(0, 50).join("\n");
      // Контекст-скоупинг: если в этом раунде читался ДРУГОЙ чат (`irc tail --in ...` и т.п.),
      // помечаем вывод служебным маркером — timeline обернёт его в рамку cross-chat
      // ("do NOT reply to these messages"), чтобы реплики чужого разговора не воспринимались
      // как текущий контекст для ответа. Достоверный сигнал берём из структурированной
      // метаданных наблюдения (targetChatId), а не из форматирования текста.
      const crossChat = readsAnotherChat(execResult.observations, ctx.item.target);
      const prefix = crossChat ? CROSS_CHAT_OBSERVATION_MARKER : "";
      board.observations.push(`${prefix}(Command output:\n${outputText})`);
    }

    // ── ADR-169: ошибки скрипта → observations (самокоррекция LLM) ──
    // ADR-237 улучшение: преобразование технических ошибок в описание на естественном языке
    if (execResult.errors.length > 0) {
      const naturalErrors =
        execResult.errorCodes.length > 0
          ? execResult.errorCodes.map(describeExecutionErrorCode)
          : execResult.errors;

      let obs = `(с последней командой что-то пошло не так:\n${naturalErrors.map((e) => `- ${e}`).join("\n")})`;

      // Уже выполненные действия
      if (execResult.completedActions.length > 0) {
        const doneLines = execResult.completedActions.map((a) => `- ${a}`).join("\n");
        obs += `\n(это уже сделано, не повторяй:\n${doneLines})`;
      }

      board.observations.push(obs);
    }

    // Ошибки инструкций (невалидная consult category, неверное число аргументов и т.п.) — не фатальны, но LLM должен знать
    if (execResult.instructionErrors.length > 0) {
      const errLines = execResult.instructionErrors.map((e) => `- ${e}`).join("\n");
      board.observations.push(`(Instruction issues:\n${errLines})`);
    }

    const hasNewObservations = board.observations.length > obsBefore;
    const continuationTokens = classifyContinuationTokens(execResult, { hasNewObservations });

    const continuation = deriveIntraTickContinuation(execResult, continuationTokens);

    // ── Сохранение snapshot prompt на диск ──
    logPromptSnapshot({
      tick: ctx.tick,
      target: ctx.item.target,
      voice: ctx.item.action,
      round,
      observation: ctx.item.observation,
      system,
      user,
      script: execResult.rawScript,
      execution: {
        afterward: execResult.afterward,
        toolCallCount: execResult.toolCallCount,
        assistantTurnCount: execResult.assistantTurnCount,
        bashCallCount: execResult.bashCallCount,
        signalCallCount: execResult.signalCallCount,
        budgetExhausted: execResult.budgetExhausted,
        transcript: execResult.transcript,
        commandOutput: execResult.commandOutput,
        thinks: execResult.thinks,
        queryLogs: execResult.queryLogs,
        instructionErrors: execResult.instructionErrors,
        errors: execResult.errors,
        hostContinuedInTick: isActualContinuationReason(continuation.reason),
        hostContinuationReason: continuation.reason,
      },
    });
    deps.onStep?.({ round, system, user, script: execResult.rawScript });

    if (isActualContinuationReason(continuation.reason)) {
      hostContinuationTrace.push(continuation.reason);
      episodeRound++;
      continue;
    }

    // ── Выход по сигналу afterward ──
    outcome = AFTERWARD_TO_OUTCOME[execResult.afterward] ?? "terminal";
    break;
  }

  const result = drainBoard(board, outcome, Date.now() - startTime, episodeRound);

  // ADR-235: Извлечение метаданных наблюдаемости из последнего результата TC-цикла
  if (lastExecResult) {
    const cmdLog = lastExecResult.commandOutput ?? "";
    if (lastExecResult.llmResidue) {
      result.llmResidue = lastExecResult.llmResidue;
    }
    result.tcMeta = {
      toolCallCount: lastExecResult.toolCallCount,
      budgetExhausted: lastExecResult.budgetExhausted,
      afterward: lastExecResult.afterward,
      commandLog: cmdLog.length > 4096 ? cmdLog.slice(0, 4096) : cmdLog,
      provider: lastExecResult.llmProvider,
      model: lastExecResult.llmModel,
    };
    if (hostContinuationTrace.length > 0) {
      result.tcMeta.hostContinuationTrace = hostContinuationTrace;
    }
  }

  return result;
}
