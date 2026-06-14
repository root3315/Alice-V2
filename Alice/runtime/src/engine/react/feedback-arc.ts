/**
 * Обратная петля — перенесено из act/result.ts.
 *
 * Содержит: processResult (постобработка), updateReachability (обновление достижимости),
 * classifyFailure (классификация сбоев), adaptiveGamma (адаптивный возврат к среднему),
 * logPersonalityEvolution (журнал эволюции личности), computeEAProxy (прокси-метрика EA),
 * computeAdaptiveCooldown (адаптивное охлаждение).
 *
 * ADR-214 Wave B: полный переход на ScriptExecutionResult.
 * ExecutableResult / RecordedAction удалены. Сигналы messageSent и т.п. выводятся из completedActions.
 *
 * @see docs/adr/79-reachability-gc-mod-migration.md
 * @see docs/adr/90-reachability-recovery.md
 * @see docs/adr/53-audit-gap-closure.md
 * @see docs/adr/127-adaptive-rhythm-cooldown.md
 */

import { checkFeedbackGap } from "../../core/action-executor.js";
import type {
  ScriptExecutionErrorCode,
  ScriptExecutionResult,
} from "../../core/script-execution.js";
import {
  completedActionFacts,
  countCompletedSentActions,
  extractFirstExternalMessageId,
  hasCompletedSend,
  hasInternalCompletedAction,
} from "../../core/script-execution.js";
import { getDb } from "../../db/connection.js";
import { writeDecisionTrace } from "../../db/decision-trace.js";
import { writeFocusTransitionShadows } from "../../db/focus-transition-shadow.js";
import {
  makeActionId,
  pressureVectorFromDims,
  writeActionResult,
  writeFactMutation,
  writePressureDeltasForAction,
} from "../../db/observation-spine.js";
import { actionLog, personalityEvolutionLog } from "../../db/schema.js";
import { appraiseActionFailureEmotion } from "../../emotion/appraisal.js";
import { recordEmotionEpisode } from "../../emotion/graph.js";
import {
  ALICE_SELF,
  chatIdToContactId,
  EMOTIONAL_DISCHARGE_FACTOR,
  ensureChannelId,
} from "../../graph/constants.js";
import { findActiveConversation } from "../../graph/queries.js";
import type { WorldModel } from "../../graph/world-model.js";
import { computeExternalFeedback } from "../../mods/observer/external-feedback.js";
import { ACT_SILENCE_SAFETY_THRESHOLD } from "../../pressure/signal-decay.js";
import { createLogger } from "../../utils/logger.js";
import {
  extractBeatFeedback,
  extractBeatTypes,
  extractOutcomeFeedback,
} from "../../voices/beat-feedback.js";
import {
  personalityEvolutionBatch,
  VOICE_BY_INDEX,
  VOICE_INDEX,
} from "../../voices/personality.js";
import type { ActionQueueItem } from "../action-queue.js";
import { closeEpisodeFromAct } from "../episode.js";
import type { TickTcMeta } from "../tick/types.js";
import type { ActContext } from "./orchestrator.js";

const log = createLogger("react:feedback");

// ═══════════════════════════════════════════════════════════════════════════
// ADR-156: Дуга эмоционального разряда
// ═══════════════════════════════════════════════════════════════════════════

/**
 * После отправки сообщения запускает разряд эмоциональных фактов целевого контакта (E *= DISCHARGE_FACTOR).
 * Один ответ снимает 70% эмоционального давления. Последовательные ответы затухают дальше: два ответа → 91%.
 * @see docs/adr/156-emotional-reactivity-damping.md §коэффициент-разряда
 */
function dischargeEmotionalFacts(G: WorldModel, channelId: string): void {
  const contactId = chatIdToContactId(channelId);
  if (!contactId || !G.has(contactId)) return;
  const neighbors = G.getNeighbors(contactId, "knows");
  let discharged = 0;
  for (const nid of neighbors) {
    if (G.getNodeType(nid) !== "fact") continue;
    const f = G.getFact(nid);
    if (f.reactivity != null && f.reactivity > 0) {
      G.updateFact(nid, {
        reactivity: f.reactivity * EMOTIONAL_DISCHARGE_FACTOR,
        reactivity_ms: Date.now(),
      });
      discharged++;
    }
  }
  if (discharged > 0) {
    log.info("Emotional discharge after message", { channelId, factsAffected: discharged });
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Утилиты разбора completedActions
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Извлекает текст сообщения первого действия отправки из completedActions.
 * Формат completedActions: "sent:chatId=X:msgId=Y".
 * Важно: completedActions не содержит текст сообщения — он присутствует в параметрах вызова Engine API,
 * но не возвращается обратно в shell-executor. Возвращает null.
 */
function extractFirstSentMessageText(_result: ScriptExecutionResult): string | null {
  // В shell-native архитектуре текст сообщения не возвращается в completedActions
  return null;
}

function isCommandMisuseError(result: ScriptExecutionResult): boolean {
  return result.errorCodes.some(
    (code) =>
      code === "command_cross_chat_send" ||
      code === "command_invalid_target" ||
      code === "command_invalid_message_id" ||
      code === "command_invalid_reply_ref",
  );
}

type ExecutionOutcomeKind =
  | "message_sent"
  | "silence"
  | "provider_failed"
  | "validation_failed"
  | "command_misuse"
  | "telegram_failed"
  | "script_failed"
  | "internal_success"
  | "observe_success";

interface ExecutionOutcome {
  kind: ExecutionOutcomeKind;
  actionType: string;
  success: boolean;
  finalDecision: "execute" | "fail" | "stop";
}

function isTelegramFailure(result: ScriptExecutionResult): boolean {
  return result.errorCodes.some(
    (code) =>
      code === "invalid_reaction" ||
      code === "invalid_sticker_keyword" ||
      code === "unreachable_telegram_user" ||
      code === "voice_messages_forbidden" ||
      code === "telegram_hard_permanent" ||
      code === "telegram_soft_permanent" ||
      code === "timeout",
  );
}

function classifyExecutionOutcome(
  result: ScriptExecutionResult,
  llmFailed: boolean,
  messageSent: boolean,
  failureKind?: EngagementMetrics["failureKind"],
): ExecutionOutcome {
  const internalCompleted = hasInternalCompletedAction(result);

  if (messageSent) {
    return {
      kind: "message_sent",
      actionType: "message",
      success: true,
      finalDecision: "execute",
    };
  }

  if (isCommandMisuseError(result)) {
    return {
      kind: "command_misuse",
      actionType: "command_misuse",
      success: false,
      finalDecision: "fail",
    };
  }

  if (isTelegramFailure(result)) {
    return {
      kind: "telegram_failed",
      actionType: "telegram_failed",
      success: false,
      finalDecision: "fail",
    };
  }

  if (result.silenceReason) {
    return {
      kind: "silence",
      actionType: "silence",
      success: true,
      finalDecision: "stop",
    };
  }

  if (internalCompleted) {
    return {
      kind: "internal_success",
      actionType: "internal",
      success: true,
      finalDecision: "execute",
    };
  }

  if (llmFailed && failureKind === "provider_unavailable") {
    return {
      kind: "provider_failed",
      actionType: "provider_failed",
      success: false,
      finalDecision: "fail",
    };
  }

  if (llmFailed || result.errorCodes.includes("script_validation")) {
    return {
      kind: "validation_failed",
      actionType: "validation_failed",
      success: false,
      finalDecision: "fail",
    };
  }

  if (result.errors.length > 0 || result.instructionErrors.length > 0) {
    return {
      kind: "script_failed",
      actionType: "script_failed",
      success: false,
      finalDecision: "fail",
    };
  }

  return {
    kind: "observe_success",
    actionType: "observe",
    success: true,
    finalDecision: "execute",
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// ADR-185 §3: Петля обратной связи результат действия → Mood
// ═══════════════════════════════════════════════════════════════════════════

/** ADR-185 §3: положительный коэффициент при отсутствии rate_outcome, но отправленном сообщении. */
const NUDGE_SENT_FALLBACK = 0.3;
/** ADR-185 §3: отрицательный коэффициент при сбое LLM. */
const NUDGE_LLM_FAILED = -0.5;
/** ADR-185 §3: дополнительный положительный коэффициент для глубокого диалога (subcycles > 2). */
const NUDGE_DEEP_CONVERSATION = 0.3;

/**
 * ADR-185 §3: тонкая настройка mood по результату действия — закрывает разрыв в петле "действие→эмоция".
 *
 * ADR-214 Wave B: параметр изменён на ScriptExecutionResult.
 * В shell-native rate_outcome выполняется через Engine API dispatch
 * и не отслеживается в completedActions. В текущей реализации rate_outcome всегда пуст,
 * деградирует до NUDGE_SENT_FALLBACK (сообщение отправлено, но явная оценка отсутствует).
 *
 * @see docs/adr/185-cross-pollination-from-llm-agent-landscape.md §3
 */
export function applyOutcomeMoodNudge(
  G: WorldModel,
  executionResult: ScriptExecutionResult,
  messageSent: boolean,
  llmFailed: boolean,
  nudgeScale: number,
  subcycles?: number,
  targetId?: string,
  failureKind?: EngagementMetrics["failureKind"],
): void {
  if (!G.has(ALICE_SELF)) return;

  let delta = 0;

  if (llmFailed) {
    delta = nudgeScale * NUDGE_LLM_FAILED;
  } else if (messageSent) {
    // shell-native: rate_outcome выполняется через dispatch, не отслеживается в completedActions.
    // Деградирует до fallback: сообщение отправлено, явная оценка отсутствует → лёгкий позитив.
    delta = nudgeScale * NUDGE_SENT_FALLBACK;

    // Бонус за глубокий диалог
    if (subcycles != null && subcycles > 2) {
      delta += nudgeScale * NUDGE_DEEP_CONVERSATION;
    }
  }
  // silence → delta = 0, возврат без изменений

  if (llmFailed || executionResult.errorCodes.length > 0) {
    appraiseActionFailureEmotion(G, {
      targetId,
      errorCodes: executionResult.errorCodes,
      failureKind,
      nowMs: Date.now(),
    });
    return;
  }

  if (delta === 0) return;

  recordEmotionEpisode(G, {
    kind: llmFailed ? "tired" : "pleased",
    valence: llmFailed ? -0.25 : 0.25,
    arousal: llmFailed ? 0.35 : 0.25,
    intensity: Math.min(0.45, Math.abs(delta) * 4),
    confidence: 0.7,
    nowMs: Date.now(),
    cause: {
      type: "action_result",
      summary: llmFailed
        ? "The last response attempt failed before it could land."
        : subcycles != null && subcycles > 2
          ? "A deeper exchange completed successfully."
          : "A message was sent successfully.",
    },
  });

  // ADR-268: self affect authority is the emotion episode ledger.
  // Do not mirror this into legacy self mood_valence / mood_set_ms.
}

// ═══════════════════════════════════════════════════════════════════════════
// Дуга обратной связи достижимости
// ═══════════════════════════════════════════════════════════════════════════

// ADR-79 M1: константы дуги обратной связи Reachability
// @see docs/adr/79-reachability-gc-mod-migration.md

/** λ экспоненциального затухания — 3 сбоя → score ≈ 0.22, выровнен с ExplorationGuard threshold=3. */
const REACHABILITY_LAMBDA = 2;

/** ADR-90 W2: коэффициент сглаживания EMA при восстановлении — первый успех 0.22→0.61, второй 0.61→0.81. */
const REACHABILITY_RECOVERY_ALPHA = 0.5;
/** ADR-90 W2: порог очистки failure_type — failure_type сбрасывается только при восстановлении score выше этого значения. */
const REACHABILITY_CLEAR_THRESHOLD = 0.8;

/** Тип сбоя ACT: permanent (выкинут/заблокирован/недействительный peer) или transient (таймаут/лимит). */
export type FailureType = "permanent" | "transient";
/**
 * ADR-90 W4: подтип permanent failure.
 * hard — необратимо на уровне пользователя (удалён аккаунт/заблокирован) → обнуление социальных обязательств
 * soft — недостижимость на уровне канала (выкинут/не вступил) → обязательства сохраняются, принудительные действия блокируются
 */
export type FailureSubtype = "hard" | "soft";

/**
 * ADR-79 M1 + ADR-90 W4: выводит тип и подтип сбоя из структурированных кодов ошибок.
 * permanent → цель недостижима (выкинут/заблокирован/удалён аккаунт)
 * transient → временный сбой (таймаут/лимит/сетевые колебания)
 */
export function classifyFailure(executionResult: {
  errorCodes: readonly ScriptExecutionErrorCode[];
}): {
  type: FailureType;
  subtype: FailureSubtype | null;
} {
  if (executionResult.errorCodes.includes("telegram_hard_permanent")) {
    return { type: "permanent", subtype: "hard" };
  }
  if (
    executionResult.errorCodes.includes("telegram_soft_permanent") ||
    executionResult.errorCodes.includes("unreachable_telegram_user")
  ) {
    return { type: "permanent", subtype: "soft" };
  }
  return { type: "transient", subtype: null };
}

/**
 * ADR-79 M1 + ADR-90 W2/W4: обновляет оценку достижимости узла графа.
 *
 * При сбое инкрементирует failures и затухает score.
 * При успехе восстановление EMA постепенное (без прыжка до 1.0); при score ≥ 0.8 сбрасывается failure_type.
 * permanent hard failure → обнуление социальных обязательств (аккаунт необратимо недостижим).
 * permanent soft failure → обязательства сохраняются, shouldBypassGates блокируется.
 */
export function updateReachability(
  G: WorldModel,
  target: string,
  success: boolean,
  executionResult: { errorCodes: readonly ScriptExecutionErrorCode[] },
): void {
  if (!target || !G.has(target)) return;

  // Отслеживание Reachability только для узлов channel
  if (G.getNodeType(target) !== "channel") return;

  if (!success) {
    const attrs = G.getChannel(target);
    const oldFailures = attrs.consecutive_act_failures ?? 0;
    const newFailures = oldFailures + 1;
    const score = Math.exp(-newFailures / REACHABILITY_LAMBDA);
    const { type: failureType, subtype } = classifyFailure(executionResult);

    const failPatch: Partial<import("../../graph/entities.js").ChannelAttrs> = {
      consecutive_act_failures: newFailures,
      reachability_score: score,
      failure_type: failureType,
    };
    if (subtype) failPatch.failure_subtype = subtype;

    // Если целевой канал признан недостижимым, снимаем локальные обязательства ответа с этого канала.
    // Если тот же контакт продолжает общение в другом канале, обязательства должны возникнуть из фактов того канала.
    if (failureType === "permanent") {
      failPatch.pending_directed = 0;
      failPatch.mentions_alice = false;
      log.info("Reachability permanent — cleared target-local social obligations", {
        target,
        subtype,
      });
    }
    G.updateChannel(target, failPatch);

    log.info("Reachability degraded", {
      target,
      failures: newFailures,
      score,
      failureType,
      subtype,
    });
  } else {
    const attrs = G.getChannel(target);
    const oldFailures = attrs.consecutive_act_failures ?? 0;
    if (oldFailures > 0) {
      // ADR-90 W2: постепенное восстановление EMA — без прыжка до 1.0
      const oldScore = attrs.reachability_score ?? 0;
      const newScore =
        oldScore * (1 - REACHABILITY_RECOVERY_ALPHA) + 1.0 * REACHABILITY_RECOVERY_ALPHA;
      const recoverPatch: Partial<import("../../graph/entities.js").ChannelAttrs> = {
        consecutive_act_failures: Math.max(0, oldFailures - 1),
        reachability_score: newScore,
      };

      // failure_type сбрасывается только при восстановлении score выше порога
      if (newScore >= REACHABILITY_CLEAR_THRESHOLD) {
        recoverPatch.failure_type = null;
        recoverPatch.failure_subtype = null;
        log.info("Reachability fully restored", { target, score: newScore });
      } else {
        log.info("Reachability recovering", {
          target,
          score: newScore,
          threshold: REACHABILITY_CLEAR_THRESHOLD,
        });
      }
      G.updateChannel(target, recoverPatch);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// EA Proxy + эволюция личности
// ═══════════════════════════════════════════════════════════════════════════

/**
 * ADR-69: прокси-метрика эффективного прогресса — EA_proxy(t) = observationValue / max(1, actionCount)
 *
 * ADR-214 Wave B: вычисляется на основе completedActions.
 * В shell-native dispatch-действия (self_note, self_feel и т.п.) не отслеживаются в completedActions,
 * observationValue деградирует до 0. actionCount считается по префиксу "sent:".
 * EA_proxy в текущей архитектуре всегда возвращает 0 — сохраняется как чисто диагностическая метрика, может быть расширена позже.
 */
export function computeEAProxy(result: ScriptExecutionResult): number {
  // shell-native: dispatch-действия не в completedActions, observationValue = 0
  const observationValue = 0;
  const actionCount = countCompletedSentActions(result);
  return observationValue / Math.max(1, actionCount);
}

/**
 * ADR-53 #2: запись атрибуции изменений вектора личности.
 * @see docs/adr/53-audit-gap-closure.md
 */
export function logPersonalityEvolution(
  tick: number,
  voiceIdx: number,
  feedbackSignal: number,
  source: "beat" | "outcome" | "decay",
  beatType?: string | null,
  targetEntity?: string | null,
): void {
  if (feedbackSignal === 0) return;
  try {
    getDb()
      .insert(personalityEvolutionLog)
      .values({
        tick,
        dimension: VOICE_BY_INDEX[voiceIdx] ?? `unknown_${voiceIdx}`,
        delta: feedbackSignal,
        source,
        beatType: beatType ?? null,
        targetEntity: targetEntity ?? null,
      })
      .run();
  } catch (e) {
    log.warn("Failed to write personality evolution log", e);
  }
}

/**
 * Адаптивный возврат к среднему γ — чем сильнее дрейф, тем сильнее возвращающая сила.
 *
 * При personality_health === "alert" γ × 3 (ускоренный возврат),
 * чтобы личность не деградировала из-за устойчивой односторонней обратной связи (проблема winner-takes-all).
 *
 * ADR-46 F7c: при alert γ ×2 → ×3 (ускоренный возврат, согласован с ограничением F7a и более низким порогом F7b).
 * @see docs/adr/45-real-data-validation.md §3.6
 */
export function adaptiveGamma(G: WorldModel, baseGamma: number): number {
  if (!G.has("self")) return baseGamma;
  const health = G.getAgent("self").personality_health;
  if (health === "alert") return baseGamma * 3;
  return baseGamma;
}

// ═══════════════════════════════════════════════════════════════════════════
// Engagement Metrics
// ═══════════════════════════════════════════════════════════════════════════

/** ADR-108: телеметрия сессии вовлечения. */
export interface EngagementMetrics {
  subcycles: number;
  durationMs: number;
  outcome: string;
  failureKind?: import("../tick/callLLM.js").TickFailureKind;
}

// ═══════════════════════════════════════════════════════════════════════════
// processResult — постобработка: обратная петля + журнал действий + эволюция личности
// ═══════════════════════════════════════════════════════════════════════════

type TcMeta = TickTcMeta;

/** Постобработка: обратная петля + журнал действий + эволюция личности. */
export function processResult(
  ctx: ActContext,
  item: ActionQueueItem,
  tick: number,
  executionResult: ScriptExecutionResult,
  errorCount: number,
  closureDepth?: number,
  engagementMetrics?: EngagementMetrics,
  tcMeta?: TcMeta,
): void {
  // ADR-129: правильно помечать success=false при сбое LLM-вызова
  const llmFailed = engagementMetrics?.outcome === "llm_failed";
  const messageSent = hasCompletedSend(executionResult);
  const outcome = classifyExecutionOutcome(
    executionResult,
    llmFailed,
    messageSent,
    engagementMetrics?.failureKind,
  );
  const success = outcome.success && errorCount === 0 && executionResult.errors.length === 0;

  if (item.target && ctx.G.has(item.target) && ctx.G.getNodeType(item.target) === "channel") {
    const shouldUpdateReachability = messageSent || isTelegramFailure(executionResult);
    if (shouldUpdateReachability) {
      updateReachability(ctx.G, item.target, success, executionResult);
    }
  }

  // ADR-95 W1+W2+W4: охлаждение тишины + тишина как восприятие + затухание сигнала directed
  // @see docs/adr/95-prompt-log-behavioral-audit.md §5
  // ADR-101: защитный шлюз — эти атрибуты принадлежат только channel, в не-channel узлы писать нельзя
  // D-I: тишина определяется финальным outcome; исторические ошибки сохраняются только в аудите, не загрязняют action_type.
  // Восстановительная тишина с ошибками не расходует pending_directed, чтобы незакрытые обязательства не пропадали незаметно.
  const isSilence = outcome.kind === "silence";
  if (item.target && ctx.G.has(item.target) && ctx.G.getNodeType(item.target) === "channel") {
    if (messageSent) {
      // ADR-158: завершение исходящей дуги обратной связи.
      const pd = Number(ctx.G.getChannel(item.target).pending_directed ?? 0);
      ctx.G.updateChannel(item.target, {
        consecutive_act_silences: 0,
        pending_directed: Math.max(0, pd - 1),
        unread: 0,
        unread_ewms: 0,
      });
      // ADR-156 D2: разряд
      dischargeEmotionalFacts(ctx.G, item.target);

      // ADR-158 страховка: turn_state диалога → other_turn.
      const channelForConv = ensureChannelId(item.target) ?? item.target;
      const convId = findActiveConversation(ctx.G, channelForConv);
      if (convId && ctx.G.has(convId)) {
        ctx.G.updateConversation(convId, {
          turn_state: "other_turn",
          last_activity_ms: Date.now(),
        });
      }
    } else if (llmFailed && engagementMetrics?.failureKind === "provider_unavailable") {
      log.warn("LLM provider unavailable — not treating as social silence", {
        target: item.target,
      });
    } else if (llmFailed) {
      // ADR-156 исправление цикла 2: сбой LLM ≈ принудительная тишина.
      const prevSil = Number(ctx.G.getChannel(item.target).consecutive_act_silences ?? 0);
      const failPatch: Partial<import("../../graph/entities.js").ChannelAttrs> = {
        consecutive_act_silences: Math.max(prevSil, ACT_SILENCE_SAFETY_THRESHOLD + 1),
        last_act_silence_ms: Date.now(),
      };
      const pd = Number(ctx.G.getChannel(item.target).pending_directed ?? 0);
      if (pd > 0) failPatch.pending_directed = pd - 1;
      ctx.G.updateChannel(item.target, failPatch);
      log.warn("LLM failed — clamping act_silences as forced silence", {
        target: item.target,
        newSilences: Math.max(prevSil, ACT_SILENCE_SAFETY_THRESHOLD + 1),
      });
    } else if (isSilence) {
      const prevSil = Number(ctx.G.getChannel(item.target).consecutive_act_silences ?? 0);
      const silPatch: Partial<import("../../graph/entities.js").ChannelAttrs> = {
        consecutive_act_silences: prevSil + 1,
        last_act_silence_ms: Date.now(),
      };

      const oldUnread = Number(ctx.G.getChannel(item.target).unread ?? 0);
      if (oldUnread > 0) {
        silPatch.unread = Math.ceil(oldUnread * 0.5);
        const oldEwms = Number(ctx.G.getChannel(item.target).unread_ewms ?? 0);
        if (oldEwms > 0) silPatch.unread_ewms = oldEwms * 0.5;
      }

      const pd = Number(ctx.G.getChannel(item.target).pending_directed ?? 0);
      if (pd > 0 && executionResult.errors.length === 0) silPatch.pending_directed = pd - 1;

      ctx.G.updateChannel(item.target, silPatch);
    } else if (outcome.kind === "command_misuse") {
      log.warn("Command misuse — not treating as social silence", {
        target: item.target,
        errorCount,
        scriptErrors: executionResult.errors.length,
      });
    } else if (outcome.success) {
      const pd = Number(ctx.G.getChannel(item.target).pending_directed ?? 0);
      if (pd > 0) {
        ctx.G.updateChannel(item.target, { pending_directed: pd - 1 });
      }
    } else if (!success) {
      // Ошибки скрипта (цель недостижима, 500 и т.п.) ≈ неудавшаяся попытка действия.
      // Сброс давления эквивалентен тишине — Alice попыталась, но не доставила; бесконечные повторы недопустимы.
      // Инкремент act_silences заставляет канал пропускаться через шлюз после превышения ACT_SILENCE_SAFETY_THRESHOLD.
      const prevSil = Number(ctx.G.getChannel(item.target).consecutive_act_silences ?? 0);
      const errPatch: Partial<import("../../graph/entities.js").ChannelAttrs> = {
        consecutive_act_silences: prevSil + 1,
        last_act_silence_ms: Date.now(),
      };
      const pd = Number(ctx.G.getChannel(item.target).pending_directed ?? 0);
      if (pd > 0) errPatch.pending_directed = pd - 1;
      ctx.G.updateChannel(item.target, errPatch);
      log.warn("Script error — treating as failed action attempt", {
        target: item.target,
        errorCount,
        scriptErrors: executionResult.errors.length,
        // WS-0: раньше логировался только счётчик → причина была не видна.
        // Теперь пишем сам stderr (обрезанный) + машинные коды для диагностики.
        errors: executionResult.errors.map((e) => e.slice(0, 300)).slice(0, 5),
        errorCodes: executionResult.errorCodes,
        newSilences: prevSil + 1,
      });
    } else {
      // ADR-218 F2: успешный observe (не сообщение, не тишина, не ошибка) — сохранение сигнала.
      // Alice «увидела» цель, но не ответила. Расходуем 1 единицу сигнала обязательства, чтобы
      // pending_directed не оставался бесконечно накопленным, порождая бесконечный цикл bypass.
      // Далее социальное давление «прочитал но не ответил» естественно перехватывается охлаждением отношений P3.
      const pd = Number(ctx.G.getChannel(item.target).pending_directed ?? 0);
      if (pd > 0) {
        ctx.G.updateChannel(item.target, { pending_directed: pd - 1 });
      }
    }
  }

  // ADR-43 §P0: проверка разрыва в петле обратной связи
  const feedbackGap = checkFeedbackGap(executionResult);

  // ADR-199 W1: автоматическая обратная запись состояния — принудительное замыкание петли
  const autoWriteback: Record<string, string> = {};

  // ADR-199 W1.1: улучшение качества self_feel — больше не инжектировать "neutral", а выводить valence
  if (feedbackGap.isMissing && item.target) {
    try {
      const ext = computeExternalFeedback(ctx.G, item.target, Date.now() - 60_000, Date.now());
      const valence = ext.score > 0.2 ? "positive" : ext.score < -0.2 ? "negative" : "neutral";
      ctx.dispatcher.dispatch("feel", {
        target: item.target,
        valence,
        reason: `auto: inferred from external signals (${ext.signals.join(",") || "none"})`,
      });
      autoWriteback.feel = valence;
      log.info("Auto-injected feel (feedback gap, inferred)", {
        target: item.target,
        valence,
        extScore: ext.score,
        signals: ext.signals,
      });
    } catch (e) {
      log.warn("Failed to auto-inject self_feel", e);
    }
  }

  // ADR-185 §3: тонкая настройка mood по результату действия
  applyOutcomeMoodNudge(
    ctx.G,
    executionResult,
    messageSent,
    llmFailed,
    ctx.config.moodNudgeScale,
    engagementMetrics?.subcycles,
    item.target ?? undefined,
    engagementMetrics?.failureKind,
  );

  const unresolvedFeedbackGap = feedbackGap.isMissing && autoWriteback.feel == null;

  // Запись журнала действий
  try {
    const actionType = outcome.actionType;
    const messageText = extractFirstSentMessageText(executionResult);
    let reasoning: string | null =
      executionResult.thinks.length > 0
        ? executionResult.thinks.slice(0, 3).join("; ")
        : (executionResult.silenceReason ?? null);

    // ADR-70: автоматически распечатанные результаты query добавляются к reasoning
    if (executionResult.queryLogs.length > 0) {
      const querySummary = executionResult.queryLogs
        .map((l) => `[${l.fn}] ${l.result.slice(0, 100)}`)
        .join("; ");
      reasoning = reasoning
        ? `${reasoning} | queries: ${querySummary}`
        : `queries: ${querySummary}`;
    }

    // ADR-69: диагностическая метрика EA_proxy
    const eaProxy = computeEAProxy(executionResult);

    const actionRow = getDb()
      .insert(actionLog)
      .values({
        tick,
        voice: item.action,
        target: item.target,
        actionType,
        chatId: item.target ?? null,
        messageText,
        confidence: null, // ADR-131 D4: не заполнять фиктивными данными, null = возможность оценки уверенности ещё отсутствует
        reasoning,
        success: outcome.success,
        observationGap: unresolvedFeedbackGap ? 1 : 0,
        closureDepth: closureDepth ?? null,
        eaProxy,
        engagementSubcycles: engagementMetrics?.subcycles ?? null,
        engagementDurationMs: engagementMetrics?.durationMs ?? null,
        engagementOutcome: engagementMetrics?.outcome ?? null,
        autoWriteback: Object.keys(autoWriteback).length > 0 ? JSON.stringify(autoWriteback) : null,
        tcToolCallCount: tcMeta?.toolCallCount ?? null,
        tcBudgetExhausted: tcMeta?.budgetExhausted ?? null,
        tcAfterward: tcMeta?.afterward ?? null,
        tcCommandLog: tcMeta?.commandLog ?? null,
        tcHostContinuationTrace: tcMeta?.hostContinuationTrace
          ? JSON.stringify(tcMeta.hostContinuationTrace)
          : null,
        llmProvider: tcMeta?.provider ?? null,
        llmModel: tcMeta?.model ?? null,
      })
      .returning({ id: actionLog.id })
      .get();
    const actionId = makeActionId(actionRow.id);
    const typedResult = outcome.success
      ? outcome.kind === "observe_success" || outcome.kind === "silence"
        ? "no_op"
        : "success"
      : "typed_failure";
    const failureCode = outcome.success
      ? "N/A"
      : (executionResult.errorCodes[0] ?? outcome.kind ?? "unknown_failure");

    writeActionResult({
      actionId,
      tick,
      enqueueId: item.observation?.enqueueId ?? null,
      candidateId: item.observation?.candidateId ?? null,
      actionLogId: actionRow.id,
      target: item.target,
      actionType,
      result: typedResult,
      failureCode,
      externalMessageId: extractFirstExternalMessageId(executionResult),
      completedActionRefs: executionResult.completedActions,
      executionObservations: executionResult.observations,
    });
    writeFocusTransitionShadows({
      tick,
      actionId,
      actionLogId: actionRow.id,
      candidateId: item.observation?.candidateId ?? null,
      sourceTarget: item.target,
      errorDetails: executionResult.errorDetails ?? [],
      observations: executionResult.observations,
      completedActions: executionResult.completedActions,
    });
    writeFactMutation({
      mutationId: `mutation:${actionId}:auto_writeback`,
      actionId,
      sourceTick: tick,
      factNamespace: Object.keys(autoWriteback).length > 0 ? "graph" : "diagnostic",
      entityNamespace: item.target ? "channel" : "none",
      entityId: item.target,
      mutationKind: Object.keys(autoWriteback).length > 0 ? "update" : "none",
      delta: Object.keys(autoWriteback).length > 0 ? autoWriteback : undefined,
      authorityTable: Object.keys(autoWriteback).length > 0 ? "graph_nodes" : "action_log",
    });
    const pressureAfter = ctx.getCurrentPressures();
    writePressureDeltasForAction({
      sourceTick: item.enqueueTick,
      actionTick: tick,
      relatedCandidateId: item.observation?.candidateId ?? null,
      relatedActionId: actionId,
      pressureBefore: pressureVectorFromDims(
        item.pressureSnapshot,
        item.observation?.api ?? item.pressureSnapshot.reduce((sum, value) => sum + value, 0),
        item.observation?.apiPeak ?? null,
      ),
      pressureAfter: pressureVectorFromDims(
        pressureAfter,
        pressureAfter.reduce((sum, value) => sum + value, 0),
      ),
    });

    writeDecisionTrace({
      tick,
      phase: "act",
      target: item.target,
      actionLogId: actionRow.id,
      finalDecision: outcome.finalDecision,
      reason: actionType,
      payload: {
        selectedAction: item.action,
        block: {
          completedActions: executionResult.completedActions,
          errors: executionResult.errors,
          instructionErrors: executionResult.instructionErrors,
          errorCodes: executionResult.errorCodes,
          errorDetails: executionResult.errorDetails ?? [],
          silenceReason: executionResult.silenceReason,
        },
        hostExecution: {
          success: outcome.success,
          messageSent,
          llmFailed,
          outcome: outcome.kind,
          errorCount,
          closureDepth: closureDepth ?? null,
          feedbackGap: unresolvedFeedbackGap,
          engagement: engagementMetrics ?? null,
          tcMeta: tcMeta ?? null,
        },
        observations: executionResult.logs,
      },
    });
  } catch (e) {
    log.warn("Failed to write action log", e);
  }

  // ADR-199 W2: обратная запись резюме действия в состояние observer mod → инжекция в следующий prompt
  // В shell-native dispatch-действия не в completedActions; stateChanges выводятся из completedActions
  try {
    const stateChanges: string[] = [];
    for (const action of completedActionFacts(executionResult)) {
      if (action.kind === "sent" || action.kind === "voice") stateChanges.push("sent a message");
      else if (action.kind === "sticker") stateChanges.push("sent a sticker");
      else if (action.kind === "forwarded") stateChanges.push("forwarded a message");
      else if (action.kind === "sent-file") stateChanges.push("sent a file");
      else if (action.kind === "downloaded") stateChanges.push("downloaded media");
      else if (action.kind === "internal") stateChanges.push(`updated ${action.command}`);
    }
    if (stateChanges.length === 0 && messageSent) stateChanges.push("sent a message");
    const autoWbEntries = Object.entries(autoWriteback).map(([k, v]) => `auto-${k}:${v}`);
    ctx.dispatcher.dispatch("SET_LAST_ACTION_RECAP", {
      tick,
      target: item.target ?? null,
      messageSent,
      stateChanges,
      autoWriteback: autoWbEntries,
      timestamp: Date.now(),
    });
  } catch (e) {
    log.warn("Failed to write action recap", e);
  }

  // ADR-23/31 эволюция личности
  // Статья Def 3.6 eq 14: суммируем все delta → один возврат к среднему → одна проекция.
  const beatFeedback = extractBeatFeedback(executionResult);
  const outcomeFeedback = extractOutcomeFeedback(executionResult);
  const actionIdx = VOICE_INDEX[item.action] ?? -1;
  const allFeedback = [...(beatFeedback ?? []), ...(outcomeFeedback ?? [])];

  if (allFeedback.length > 0) {
    const gamma = adaptiveGamma(ctx.G, ctx.config.meanReversion);
    const newPersonality = personalityEvolutionBatch(
      ctx.personality,
      allFeedback.map((fb) => ({ actionIdx: fb.voice, feedback: fb.magnitude })),
      ctx.config.learningRate,
      gamma,
      ctx.config.piHome,
      ctx.config.piMin,
    );
    ctx.onPersonalityUpdate(newPersonality);

    const beatTypes = extractBeatTypes(executionResult);
    const primaryBeatType = beatTypes[0] ?? null;
    if (beatFeedback) {
      for (const fb of beatFeedback) {
        logPersonalityEvolution(tick, fb.voice, fb.magnitude, "beat", primaryBeatType, item.target);
      }
    }
    if (outcomeFeedback) {
      for (const fb of outcomeFeedback) {
        logPersonalityEvolution(tick, fb.voice, fb.magnitude, "outcome", null, item.target);
      }
    }
  } else if (actionIdx >= 0) {
    const feedback = success ? 0.3 : -0.3;
    const newPersonality = personalityEvolutionBatch(
      ctx.personality,
      [{ actionIdx, feedback }],
      ctx.config.learningRate,
      adaptiveGamma(ctx.G, ctx.config.meanReversion),
      ctx.config.piHome,
      ctx.config.piMin,
    );
    logPersonalityEvolution(tick, actionIdx, feedback, "decay", null, item.target);
    ctx.onPersonalityUpdate(newPersonality);
  }

  // ADR-215: закрытие Episode — слияние двух источников (LLM residue + структурные сигналы).
  if (item.episodeId) {
    try {
      closeEpisodeFromAct(
        item.episodeId,
        {
          messageSent,
          isSilence,
          success,
          errorCount,
          scriptErrors: executionResult.errors.length,
          silenceReason: executionResult.silenceReason ?? null,
          engagementOutcome: engagementMetrics?.outcome ?? null,
          subcycles: engagementMetrics?.subcycles ?? 1,
          durationMs: engagementMetrics?.durationMs ?? 0,
          target: item.target,
          tick,
        },
        item.llmResidue,
      );
    } catch (e) {
      log.warn("Episode close from act failed", e);
    }
  }

  log.info("Action executed", {
    tick,
    voice: item.action,
    completedActions: executionResult.completedActions.length,
    thinks: executionResult.thinks.length,
    thinksPreview: executionResult.thinks[0]?.slice(0, 80) ?? null,
    errorCount,
    scriptErrors: executionResult.errors.length,
    // WS-0 ext: показать сам stderr и в success-пути (есть ошибки команд), не только при script_failed.
    errors:
      executionResult.errors.length > 0
        ? executionResult.errors.map((e) => e.slice(0, 200)).slice(0, 3)
        : undefined,
    errorCodes: executionResult.errorCodes.length > 0 ? executionResult.errorCodes : undefined,
    afterward: engagementMetrics?.outcome ?? null,
    subcycles: engagementMetrics?.subcycles ?? 1,
    outcome: outcome.kind,
    success: outcome.success,
    hostClean: success,
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Адаптивное охлаждение ритма — cooldown компенсирует длительность engagement для поддержания целевого общего периода.
// @see docs/adr/127-adaptive-rhythm-cooldown.md
// ═══════════════════════════════════════════════════════════════════════════

/** Параметры адаптивного охлаждения (вход чистой функции, удобен для тестирования). */
export interface AdaptiveCooldownOpts {
  engagementMs: number;
  consecutiveOutgoing: number;
  chatType: string;
  isConversationActive: boolean;
}

// -- Константы --

/** Базовый период активного диалога (мс). */
const TAU_BASE_CONVERSATION = 4000;
/** Базовый период при неактивном / проактивном режиме (мс). */
const TAU_BASE_PROACTIVE = 7000;
/** Дополнительная задержка на каждое последовательно отправленное сообщение (мс). */
const ALPHA_CONSECUTIVE = 1500;
/** Множитель периода для групп / супергрупп. */
const M_CHAT_GROUP = 1.5;
/** Абсолютный нижний предел охлаждения (мс). */
const TAU_FLOOR = 800;

/**
 * Вычисляет длительность адаптивного охлаждения.
 *
 * τ_target = (τ_base + α · consecutive_outgoing) × m_chat
 * cooldown = max(τ_floor, τ_target − engagement_ms) × jitter
 *
 * Чистая функция — не зависит от внешнего состояния, напрямую тестируется.
 * @see docs/adr/127-adaptive-rhythm-cooldown.md
 */
export function computeAdaptiveCooldown(opts: AdaptiveCooldownOpts): number {
  const tauBase = opts.isConversationActive ? TAU_BASE_CONVERSATION : TAU_BASE_PROACTIVE;
  const mChat = opts.chatType === "group" || opts.chatType === "supergroup" ? M_CHAT_GROUP : 1.0;
  const tauTarget = (tauBase + ALPHA_CONSECUTIVE * opts.consecutiveOutgoing) * mChat;
  const jitter = 0.8 + Math.random() * 0.4; // [0.8, 1.2]
  return Math.max(TAU_FLOOR, tauTarget - opts.engagementMs) * jitter;
}
