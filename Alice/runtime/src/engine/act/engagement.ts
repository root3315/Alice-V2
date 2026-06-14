/**
 * ADR-107: Вспомогательные функции сессии просмотра — оценка давления, ожидание ответа, слияние результатов выполнения скриптов.
 *
 * ADR-214 Wave A: удалены actions/instructions/lastSilenceReason (мёртвые поля).
 * В shell-native архитектуре конвейер RecordedAction всегда пуст.
 *
 * @see docs/adr/107-engagement-session/README.md
 */
import {
  emptyScriptExecutionResult,
  mergeScriptExecutionResults,
  type ScriptExecutionResult,
} from "../../core/script-execution.js";
import { CHAT_TYPE_WEIGHTS, DUNBAR_TIER_WEIGHT, PRESSURE_SPECS } from "../../graph/constants.js";
import type { WorldModel } from "../../graph/world-model.js";
// ADR-222: CONVERSATION_INERTIA_BOOST удалён. Continuation использует фиксированный коэффициент 0.67 (≈ старый 1/1.5).
import type { GraphPerturbation } from "../../telegram/mapper.js";
import type { ActContext } from "../react/orchestrator.js";
import type { SubcycleResult } from "../react/types.js";

// ── EngagementSession: заменяет 10 параллельных переменных в loop.ts ────────────────

/**
 * ADR-107: Контейнер состояния сессии просмотра.
 * ADR-214 Wave A: удалены actions/instructions/lastSilenceReason/pendingActions/markAllExecuted.
 */
export class EngagementSession {
  execution: ScriptExecutionResult = emptyScriptExecutionResult();
  totalDuration = 0;
  errorCount = 0;
  subcycle = 0;
  elapsed = 0;
  outcome:
    | "complete"
    | "timeout"
    | "preempted"
    | "limit"
    | "llm_failed"
    | "observation_empty"
    | "resting"
    | "fed_up"
    | "cooling_down" = "complete";
  /** Параметризуемый лимит подциклов (для завершения в групповом чате). */
  private readonly _maxSubcycles: number;

  constructor(maxSubcycles: number = MAX_SUBCYCLES) {
    this._maxSubcycles = maxSubcycles;
  }

  /** ADR-235: метаданные наблюдаемости последнего TC-цикла. */
  lastTcMeta?: SubcycleResult["tcMeta"];
  /** Классификация последнего сбоя LLM-вызова. */
  failureKind?: SubcycleResult["failureKind"];

  /** Вбирает результат одного подцикла в накопитель уровня engagement. */
  absorb(sub: SubcycleResult): void {
    this.execution = mergeScriptExecutionResults([this.execution, sub.execution]);
    this.errorCount += sub.execution.errors.length;
    this.totalDuration += sub.duration;
    if (sub.tcMeta) this.lastTcMeta = sub.tcMeta;
    if (sub.failureKind) this.failureKind = sub.failureKind;
  }

  /** Проверяет, может ли engagement продолжаться (не превышены лимиты подциклов/длительности). */
  canContinue(): boolean {
    return this.subcycle < this._maxSubcycles && this.elapsed < MAX_ENGAGEMENT_DURATION;
  }

  /** Сливает накопленные данные в ScriptExecutionResult (для аудита в processResult). */
  toMergedResult(): ScriptExecutionResult {
    return this.execution;
  }
}

// ── ADR-107: Константы сессии просмотра ──────────────────────────────────────
// @see docs/adr/107-engagement-session/README.md §константы-дизайна
export const MAX_ENGAGEMENT_DURATION = 180_000; // Максимальная длительность одной сессии (3 мин)
export const EXPECT_REPLY_TIMEOUT = 60_000; // Лимит ожидания expect_reply (60 с)
export const STAY_TIMEOUT = 15_000; // Максимальное ожидание при stay (15 с)
export const PREEMPTION_FACTOR = 1.5; // Порог вытеснения: срочность нового события / удерживаемый hold
const TYPING_EXTENSION = 15_000; // Продление таймаута при каждом typing на 15 с
const MAX_TYPING_EXTEND_FACTOR = 2; // Максимальное продление — до 2× исходного таймаута
export const MAX_SUBCYCLES = 5; // Максимальное число подциклов в одной сессии

/**
 * ADR-107: Быстрая оценка срочности одного события. O(1), без обхода графа.
 * Используется в сессии просмотра для определения вытеснения более срочным событием.
 *
 * @see paper/ §7.5 Proposition (Quick Pressure Estimate)
 * @see docs/adr/107-engagement-session/README.md §preemption
 */
export function quickPressureEstimate(G: WorldModel, event: GraphPerturbation): number {
  let wTier = DUNBAR_TIER_WEIGHT[150];
  let wResponse = CHAT_TYPE_WEIGHTS.group.response;
  let wAttention = CHAT_TYPE_WEIGHTS.group.attention;

  const channelId = event.channelId;
  if (channelId && G.has(channelId)) {
    const attrs = G.getChannel(channelId);
    wTier =
      (DUNBAR_TIER_WEIGHT as Record<number, number>)[attrs.tier_contact as number] ??
      DUNBAR_TIER_WEIGHT[150];
    wResponse = CHAT_TYPE_WEIGHTS[attrs.chat_type].response;
    wAttention = CHAT_TYPE_WEIGHTS[attrs.chat_type].attention;
  }

  if (event.isDirected) {
    return wTier * wResponse;
  }

  if (event.type === "new_message" && event.isContinuation) {
    // ADR-222: вес continuation = directed × 0.67 (сохраняет числовую преемственность старого 1/1.5 ≈ 0.67)
    return wTier * wResponse * 0.67;
  }

  const kappaSensitivity = PRESSURE_SPECS.P5.kappaMin / PRESSURE_SPECS.P1.kappaMin;
  return wTier * wAttention * kappaSensitivity;
}

/**
 * ADR-108: Listen-First — разделяет регистрацию watcher и await на два этапа.
 */
export interface WatchResult {
  type: "reply" | "interrupt" | "timeout" | "activity";
  elapsed: number;
}

export function prepareEngagementWatch(
  ctx: ActContext,
  targetChannelId: string,
  holdStrength: number,
  opts?: { typingAware?: boolean },
): {
  await: (timeout: number) => Promise<WatchResult>;
  cancel: () => void;
} {
  const replyWatch = ctx.buffer.watch(
    (e) => e.type === "new_message" && e.channelId === targetChannelId && !e.senderIsBot,
  );
  const interruptWatch = ctx.buffer.watch(
    (e) =>
      e.type === "new_message" &&
      e.channelId !== targetChannelId &&
      quickPressureEstimate(ctx.G, e) > holdStrength * PREEMPTION_FACTOR,
  );

  return {
    async await(timeout: number) {
      const start = Date.now();
      let deadline = start + timeout;
      const maxDeadline = start + timeout * MAX_TYPING_EXTEND_FACTOR;

      if (!opts?.typingAware) {
        let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
        const timeoutPromise = new Promise<null>((resolve) => {
          timeoutHandle = setTimeout(() => resolve(null), timeout);
        });
        try {
          const result = await Promise.race([
            replyWatch.promise.then(() => ({ type: "reply" as const })),
            interruptWatch.promise.then(() => ({ type: "interrupt" as const })),
            timeoutPromise.then(() => ({ type: "timeout" as const })),
          ]);
          return { type: result.type, elapsed: Date.now() - start };
        } finally {
          if (timeoutHandle) clearTimeout(timeoutHandle);
          replyWatch.cancel();
          interruptWatch.cancel();
        }
      }

      try {
        while (true) {
          const remaining = deadline - Date.now();
          if (remaining <= 0) return { type: "timeout", elapsed: Date.now() - start };

          const typingWatch = ctx.buffer.watch(
            (e) => e.type === "typing" && e.channelId === targetChannelId,
          );

          let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
          const timeoutPromise = new Promise<null>((resolve) => {
            timeoutHandle = setTimeout(() => resolve(null), remaining);
          });

          const result = await Promise.race([
            replyWatch.promise.then(() => ({ type: "reply" as const })),
            interruptWatch.promise.then(() => ({ type: "interrupt" as const })),
            typingWatch.promise.then(() => ({ type: "typing" as const })),
            timeoutPromise.then(() => ({ type: "timeout" as const })),
          ]);

          if (timeoutHandle) clearTimeout(timeoutHandle);
          typingWatch.cancel();

          if (result.type === "typing") {
            deadline = Math.min(Date.now() + TYPING_EXTENSION, maxDeadline);
            continue;
          }

          return { type: result.type, elapsed: Date.now() - start };
        }
      } finally {
        replyWatch.cancel();
        interruptWatch.cancel();
      }
    },
    cancel() {
      replyWatch.cancel();
      interruptWatch.cancel();
    },
  };
}

export function prepareStayWatch(
  ctx: ActContext,
  targetChannelId: string,
  holdStrength: number,
): {
  await: (timeout: number) => Promise<WatchResult>;
  cancel: () => void;
} {
  const activityWatch = ctx.buffer.watch(
    // ADR-247: watching — это продолжение внимания, а не разрешение говорить.
    // Только directed-сообщение в целевой чат может заново разбудить linger-слот;
    // typing / ambient activity по-прежнему попадают в EventBuffer и переоцениваются
    // внешним контроллером по реальному давлению.
    // @see docs/adr/247-block-contract-over-transport.md §P1: разбиение `watching`
    (e) =>
      e.type === "new_message" &&
      e.channelId === targetChannelId &&
      e.isDirected === true &&
      !e.senderIsBot,
  );
  const interruptWatch = ctx.buffer.watch(
    (e) =>
      e.type === "new_message" &&
      e.channelId !== targetChannelId &&
      quickPressureEstimate(ctx.G, e) > holdStrength * PREEMPTION_FACTOR,
  );

  return {
    async await(timeout: number) {
      const start = Date.now();
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      const timeoutPromise = new Promise<null>((resolve) => {
        timeoutHandle = setTimeout(() => resolve(null), timeout);
      });
      try {
        const result = await Promise.race([
          activityWatch.promise.then(() => ({ type: "activity" as const })),
          interruptWatch.promise.then(() => ({ type: "interrupt" as const })),
          timeoutPromise.then(() => ({ type: "timeout" as const })),
        ]);
        return { type: result.type, elapsed: Date.now() - start };
      } finally {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        activityWatch.cancel();
        interruptWatch.cancel();
      }
    },
    cancel() {
      activityWatch.cancel();
      interruptWatch.cancel();
    },
  };
}
