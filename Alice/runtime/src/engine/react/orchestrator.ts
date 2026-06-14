/**
 * ReAct внешний цикл + чередующееся планирование — замена старых loop.ts:411-595 + координации scheduler.ts.
 *
 * Сохраняет всю семантику ADR-130 чередующегося планирования:
 * - параллельность нескольких engagement (консервативный предел Миллера 7±2 = 3)
 * - атомарность subcycle + эксклюзивность engagement
 * - неблокирующий режим expect_reply/stay
 * - стоимость переключения (SWITCH_COST_MS)
 *
 * Ключевые изменения (vs старый loop.ts):
 * - ADR-142: внутренний вызов `runTickSubcycle` (Blackboard Tick + конвейер SAA)
 * - после возврата subcycle вызывается `evaluateAndReflect()` (D9)
 * - processItem поддерживает `decideFanOut()` (D8) поиск по дереву условий
 *
 * @see docs/adr/140-react-efficiency-architecture.md
 * @see docs/adr/130-engagement-interleaving.md
 */
import type { TelegramClient } from "@mtcute/node";

import type { Config } from "../../config.js";
// ADR-214 Wave A: ExecutionStats, executeRecordedActions, mergeScriptExecutionResults удалены.
// applyFeedbackArc больше не вызывается. Wave B выполнит очистку.
import type { Dispatcher } from "../../core/dispatcher.js";
import {
  type CompletedAction,
  completedActionFacts,
  type ScriptExecutionResult,
} from "../../core/script-execution.js";
import { getDb } from "../../db/connection.js";
import { writeQueueTrace } from "../../db/observation-spine.js";
import { extractNumericId, PRESSURE_TYPICAL_SCALES } from "../../graph/constants.js";
import type { WorldModel } from "../../graph/world-model.js";
import { ChatTarget } from "../../prompt/types.js";
import type { EventBuffer } from "../../telegram/events.js";
import { isGroupOutboundBlocked } from "../../telegram/membership-guard.js";
import { createLogger } from "../../utils/logger.js";
import type { PressureDims } from "../../utils/math.js";
import type { PersonalityVector } from "../../voices/personality.js";
import { fetchRecentMessages } from "../act/messages.js";
import {
  awaitAnyWakeup,
  checkWatchers,
  type DeferredTurnOutcome,
  type EngagementSlot,
  initSlot,
  MAX_CONCURRENT_ENGAGEMENTS,
  releaseSlot,
  SWITCH_COST_MS,
  selectNextEngagement,
  startWatcher,
  watchPlanFromOutcome,
} from "../act/scheduler.js";
import type { ActionQueue, ActionQueueItem } from "../action-queue.js";
import { measureClosureDepth } from "../closure-depth.js";
import { commitActEvents } from "../consciousness.js";
import { runTickSubcycle } from "../tick/bridge.js";
import { processResult } from "./feedback-arc.js";

const log = createLogger("react:orchestrator");

/** Минимальное структурированное окно отсутствия для afterward=resting. Более длинные ночные ритмы управляются dormant FSM. */
const RESTING_DURATION_MS = 30 * 60 * 1000;

function isConversationOutput(action: CompletedAction): boolean {
  return action.kind === "sent" || action.kind === "voice" || action.kind === "sticker";
}

function hasConversationOutput(result: ScriptExecutionResult): boolean {
  return completedActionFacts(result).some(isConversationOutput);
}

// ── ActContext: контекст цикла действий (совместим со старым loop.ts) ────────────────────────

/**
 * Контекст ACT-цикла — внедрение зависимостей во время выполнения потока действий.
 *
 * Сохраняет типовую совместимость с ActContext из старого loop.ts.
 */
export interface ActContext {
  client: TelegramClient;
  G: WorldModel;
  config: Config;
  queue: ActionQueue;
  personality: PersonalityVector;
  getCurrentTick: () => number;
  getCurrentPressures: () => PressureDims;
  onPersonalityUpdate: (pv: PersonalityVector) => void;
  /** Mod Dispatcher. */
  dispatcher: Dispatcher;
  /** ADR-107: ссылка на EventBuffer для отслеживания ответов и событий вытеснения во время сессии просмотра. */
  buffer: EventBuffer;
  /** ADR-173: отложенная запись подтверждённых действий в recentActions evolve (только реальные действия Telegram). */
  recordAction: (action: string, target: string | null) => void;
  /** ADR-190: уведомить поток evolve о результате вызова LLM (успех/неудача), управляет экспоненциальной задержкой на уровне планировщика. */
  reportLLMOutcome: (success: boolean) => void;
}

/**
 * Проверка устаревания: значительно ли изменилось поле давлений после постановки в очередь.
 *
 * P1-2: L2-расстояние вычисляется после нормализации. Без нормализации L2 доминируется P1/P4 (порядок ~200),
 * и резкие изменения P5 (порядок ~3) почти не способны вызвать staleness. После нормализации к [0,1] все измерения равнозначны.
 * @see .claude/sessions/review-runtime-G6oHOR/worker-2-engine-core.md §P1-2
 */
function isStale(
  item: ActionQueueItem,
  currentPressures: PressureDims,
  threshold: number,
): boolean {
  if (item.reason === "wakeup") return false;

  let sum = 0;
  for (let i = 0; i < 6; i++) {
    const scale = PRESSURE_TYPICAL_SCALES[i] || 1;
    const diff = (item.pressureSnapshot[i] - currentPressures[i]) / scale;
    sum += diff * diff;
  }
  return Math.sqrt(sum) > threshold;
}

// ADR-214 Wave A: applyFeedbackArc удалён (зависел от ExecutionStats, входит в мёртвый конвейер).
// В shell-native архитектуре действия Telegram выполняются через HTTP Engine API,
// декремент pending_directed и обновление reachability обрабатываются маршрутами Engine API.

/**
 * Завершение engagement slot: защитный flush + processResult + cooldown + снятие блокировки.
 * Извлечено из логики постобработки старого startActLoop.
 */
async function finalizeSlot(ctx: ActContext, slot: EngagementSlot): Promise<void> {
  const { item, session, graphBefore } = slot;
  const tick = ctx.getCurrentTick();

  try {
    // ADR-214 Wave A: защитный flush удалён.
    // В shell-native архитектуре pendingActions всегда пуст — действия Telegram выполняются напрямую через Engine API HTTP внутри контейнера.

    // processResult: однократный вызов с передачей метрик engagement
    const mergedResult = session.toMergedResult();
    const closureResult = measureClosureDepth(graphBefore, ctx.G);
    processResult(
      ctx,
      item,
      tick,
      mergedResult,
      session.errorCount,
      closureResult.maxDepth,
      {
        subcycles: session.subcycle,
        durationMs: session.elapsed,
        outcome: session.outcome,
        failureKind: session.failureKind,
      },
      session.lastTcMeta,
    );
    // ADR-173: отложенная запись — записываем в recentActions после подтверждения действия
    // ADR-215 Wave 2: все типы действий (включая observe) учитываются в rateCap, предотвращает гиперактивность внутреннего цикла
    // Различие: реальные действия Telegram (есть completedActions) vs внутренние действия (silence/observe/llm_failed)
    // Оба потребляют бюджет внимания, но socialCost и netValue для внутренних действий считаются иначе
    ctx.recordAction(item.action, item.target);
    // ADR-274: provider outage / quota is runtime health, not LLM quality backoff.
    // Billing incidents already block execution; they must not also poison cadence.
    ctx.reportLLMOutcome(
      session.outcome !== "llm_failed" || session.failureKind === "provider_unavailable",
    );
  } finally {
    // освобождаем сигнал наблюдаемости
    releaseSlot(ctx, slot);
    // C1 fix: вытесненный slot не снимает блокировку processing — target уже повторно поставлен в очередь,
    // блокировка должна быть унаследована новым engagement, иначе короткое окно без блокировки нарушит Exclusivity.
    if (item.target && !slot.preempted) ctx.queue.markComplete(item.target);
  }

  // ADR-130: cooldown переведён в неблокирующий режим
  // обновляем last_alice_action_ms канала, позволяя proactive_cooldown потока EVOLVE обрабатывать это естественно
  if (slot.targetChannelId && ctx.G.has(slot.targetChannelId)) {
    ctx.G.updateChannel(slot.targetChannelId, { last_alice_action_ms: Date.now() });
  }
}

/**
 * Очистка всех завершённых slot: асинхронное завершение и освобождение.
 * Возвращает отфильтрованный массив активных slot.
 * Промисы финализации добавляются в Set `pending` и удаляются автоматически после завершения.
 */
function cleanupDoneSlots(
  ctx: ActContext,
  active: EngagementSlot[],
  pending: Set<Promise<void>>,
): EngagementSlot[] {
  const remaining: EngagementSlot[] = [];

  for (const slot of active) {
    if (slot.state !== "done") {
      remaining.push(slot);
      continue;
    }
    // асинхронная финализация (не блокирует планировщик при продолжении диспетчеризации других engagement)
    const p = finalizeSlot(ctx, slot).catch((err) => {
      log.error("Failed to finalize engagement slot", {
        target: slot.item.target,
        error: err instanceof Error ? err.message : String(err),
      });
    });
    pending.add(p);
    // автоматически удаляется из Set после завершения, предотвращает бесконечный рост
    p.then(
      () => pending.delete(p),
      () => pending.delete(p),
    );
  }

  return remaining;
}

/**
 * ADR-140: Запуск ReAct-цикла — версия с чередующимся планированием (замена старого startActLoop).
 *
 * Общая структура почти идентична старому startActLoop — чередующееся планирование, управление slot,
 * switch cost и staleness check сохранены. Отличия:
 * - ADR-142: внутренний вызов `runTickSubcycle` (Blackboard Tick + двухуровневая фильтрация SAA)
 * - после возврата subcycle поддерживается D8 fan-out + D9 reflection (координируется orchestrator)
 *
 * @see docs/adr/140-react-efficiency-architecture.md
 * @see docs/adr/130-engagement-interleaving.md
 */
export async function startReActLoop(ctx: ActContext): Promise<void> {
  let active: EngagementSlot[] = [];
  let lastTarget: string | null = null;
  /** Отслеживание асинхронной финализации — при закрытии ожидаем все pending finalization. Автоудаляются после завершения. */
  const pendingFinalizations = new Set<Promise<void>>();

  while (!ctx.queue.closed) {
    // ── 1. Приём новых item (без блокировки, заполняем до MAX_CONCURRENT) ──
    while (active.length < MAX_CONCURRENT_ENGAGEMENTS) {
      const item =
        active.length === 0
          ? await ctx.queue.dequeue() // блокирующее ожидание при пустой очереди
          : ctx.queue.tryDequeue(); // неблокирующая попытка при непустой
      if (!item) break;

      // Staleness check
      // исключение directed_override: решение об обязательном действии основывается на pending_directed (медленный сигнал),
      // не должно аннулироваться естественным дрейфом несвязанных измерений давления (P1/P3/P6).
      const tick = ctx.getCurrentTick();
      const currentP = ctx.getCurrentPressures();
      if (
        item.reason !== "directed_override" &&
        isStale(item, currentP, ctx.config.stalenessThreshold)
      ) {
        log.info("Action stale → skip", {
          tick,
          enqueueTick: item.enqueueTick,
          action: item.action,
        });
        if (item.target) ctx.queue.markComplete(item.target);
        if (item.observation) {
          const metrics = ctx.queue.getMetrics();
          writeQueueTrace({
            tick,
            candidateId: item.observation.candidateId,
            enqueueId: item.observation.enqueueId,
            enqueueOutcome: "accepted",
            fate: "expired",
            queueDepth: metrics.queued,
            activeCount: metrics.active,
            saturation: metrics.saturation,
            reasonCode: "stale_pressure_snapshot",
          });
        }
        continue;
      }

      // Проверка членства в группе — перехватываем до initSlot (fetchRecentMessages + сборка prompt),
      // чтобы не тратить токены LLM на группы, из которых уже вышли.
      if (item.target) {
        const rawId = extractNumericId(item.target) ?? item.target;
        let memberBlocked = false;
        try {
          memberBlocked = await isGroupOutboundBlocked(ctx.client, ctx.G, item.target, rawId);
        } catch (err) {
          // C1+C2: транзиентная ошибка проверки членства не должна ни ронять ACT-поток,
          // ни оставлять processing-lock на таргете навсегда. Снимаем lock и пропускаем.
          log.warn("membership check failed → release lock + skip", {
            target: item.target,
            error: err instanceof Error ? err.message : String(err),
          });
          ctx.queue.markComplete(item.target);
          continue;
        }
        if (memberBlocked) {
          log.info("Engagement skipped: not a group member", { target: item.target });
          ctx.queue.markComplete(item.target);
          if (item.observation) {
            const metrics = ctx.queue.getMetrics();
            writeQueueTrace({
              tick,
              candidateId: item.observation.candidateId,
              enqueueId: item.observation.enqueueId,
              enqueueOutcome: "accepted",
              fate: "dropped",
              queueDepth: metrics.queued,
              activeCount: metrics.active,
              saturation: metrics.saturation,
              reasonCode: "membership_blocked",
            });
          }
          continue;
        }
      }

      if (item.observation) {
        const metrics = ctx.queue.getMetrics();
        writeQueueTrace({
          tick,
          candidateId: item.observation.candidateId,
          enqueueId: item.observation.enqueueId,
          enqueueOutcome: "accepted",
          fate: "executed",
          queueDepth: metrics.queued,
          activeCount: metrics.active,
          saturation: metrics.saturation,
          reasonCode: "slot_created",
        });
      }
      let slot: EngagementSlot;
      try {
        slot = await initSlot(ctx, item);
      } catch (err) {
        // C1+C2: ошибка инициализации слота (fetchRecentMessages: flood-wait/дисконнект) не должна
        // ни ронять весь ACT-поток, ни оставлять processing-lock на таргете навсегда.
        log.error("initSlot failed → release lock + skip", {
          target: item.target,
          error: err instanceof Error ? err.message : String(err),
        });
        if (item.target) ctx.queue.markComplete(item.target);
        continue;
      }
      active.push(slot);
      log.info("Engagement slot created", {
        target: item.target,
        activeSlots: active.length,
        urgency: slot.urgency.toFixed(2),
      });
    }

    if (active.length === 0) continue;

    // ── 2. Проверяем, не разбудило ли watch slot какое-либо событие ──
    checkWatchers(active);

    // ── 3. Выбираем следующий готовый engagement ──
    const next = selectNextEngagement(active);
    if (!next) {
      // все slot в режиме runtime watch — ждём пробуждения любого из них
      await awaitAnyWakeup(active, ctx.queue);
      // после пробуждения продолжаем цикл (checkWatchers обновит состояние)
      // очищаем завершённые slot
      active = cleanupDoneSlots(ctx, active, pendingFinalizations);
      continue;
    }

    // ── 4. Стоимость переключения (когнитивный разрыв при переходе к другой цели) ──
    if (lastTarget && lastTarget !== next.item.target) {
      await new Promise((resolve) => setTimeout(resolve, SWITCH_COST_MS));
      log.info("Switch cost applied", {
        from: lastTarget,
        to: next.item.target,
        costMs: SWITCH_COST_MS,
      });
    }
    lastTarget = next.item.target;

    // ── 5. Устанавливаем цель Dispatcher ──
    ctx.dispatcher.dispatch("SET_CONTACT_TARGET", { nodeId: next.item.target ?? "" });
    ctx.dispatcher.dispatch("SET_CHAT_TARGET", {
      chatId: next.item.target ?? "",
      liveMessageCount: next.liveMessages.length,
    });

    // ── 6. Выполняем один subcycle ──
    next.session.subcycle++;

    // получаем свежие сообщения (новые могли прийти пока выполнялись другие engagement)
    if (next.session.subcycle > 1 && next.targetChatId) {
      const prevMessageCount = next.liveMessages.length;
      const chatType =
        next.item.target && ctx.G.has(next.item.target)
          ? ctx.G.getChannel(next.item.target).chat_type
          : undefined;
      next.liveMessages = await fetchRecentMessages(ctx.client, next.targetChatId, ctx.config, {
        chatType,
      });

      // D2: Observation Quality Gate — пропускаем вызов LLM, если в канале нет новых сообщений.
      // Личные чаты/группы не проверяются — Alice должна активно участвовать в разговоре, не ожидая триггера "есть новые сообщения".
      // @see docs/adr/242-command-interface-standardization.md §Phase 3
      if (ChatTarget.isChannelChat(chatType) && next.liveMessages.length <= prevMessageCount) {
        log.info("D2: No new messages since last subcycle → terminate", {
          target: next.item.target,
          subcycle: next.session.subcycle,
          prevCount: prevMessageCount,
          newCount: next.liveMessages.length,
        });
        next.session.outcome = "observation_empty";
        next.state = "done";
        active = cleanupDoneSlots(ctx, active, pendingFinalizations);
        continue;
      }
    }

    const tick = ctx.getCurrentTick();

    // D8: точка решения fan-out (в будущем управляется decideFanOut(), сейчас — единственный путь)
    // D9: точка оценки reflection (в будущем управляется evaluateAndReflect())
    const sub = await runTickSubcycle(
      ctx,
      next.item,
      tick,
      next.targetChatId,
      next.liveMessages,
      next.resolved,
      next.contextVars,
      next.session,
    );
    next.session.absorb(sub);

    // ADR-204: emit событий потока сознания (уровень исполнения)
    try {
      // ADR-214 Wave A: SubcycleResult больше не содержит actions/instructions.
      // shell-native побочные эффекты передаются через execution.completedActions.
      commitActEvents(
        getDb(),
        tick,
        Date.now(),
        { instructions: [], actions: [], completedActions: sub.execution.completedActions },
        next.item.target ?? null,
      );
    } catch (e) {
      log.warn("consciousness act-emit failed", e);
    }

    // ADR-214 Wave A: фаза SPEAK удалена.
    // В shell-native архитектуре pendingActions всегда пуст — действия Telegram выполняются напрямую через Engine API HTTP внутри контейнера.
    // executeRecordedActions и correction tick больше не вызываются.

    // ── 8. BRANCH — обновляем состояние slot ──
    // ADR-169: разрешение запросов и возобновление по ошибкам встроены в основной цикл tick().
    // sub.outcome — финальное намерение цикла tick, внешняя коррекция возобновления не нужна.
    if (
      sub.outcome === "terminal" ||
      sub.outcome === "empty" ||
      sub.outcome === "resting" ||
      sub.outcome === "fed_up" ||
      sub.outcome === "cooling_down"
    ) {
      if (sub.outcome === "empty") {
        next.session.outcome = "llm_failed";
      } else if (sub.outcome === "resting") {
        const hasVisibleEffect = hasConversationOutput(sub.execution);
        next.session.outcome = hasVisibleEffect ? "resting" : "complete";
        if (!hasVisibleEffect) {
          log.info("resting ignored for non-visible action", {
            target: next.targetChannelId,
            completedActions: sub.execution.completedActions,
          });
          next.state = "done";
          active = cleanupDoneSlots(ctx, active, pendingFinalizations);
          continue;
        }
        const now = Date.now();
        if (ctx.G.has("self")) {
          ctx.G.updateAgent("self", {
            resting_since_ms: now,
            resting_until_ms: now + RESTING_DURATION_MS,
            resting_reason: "afterward=resting",
          });
        }
        if (next.targetChannelId) {
          const { findActiveConversation } = await import("../../graph/queries.js");
          const convId = findActiveConversation(ctx.G, next.targetChannelId);
          if (convId && ctx.G.has(convId)) {
            ctx.G.updateConversation(convId, {
              state: "closing",
              turn_state: "closed",
              closing_since_ms: now,
            });
            log.info("resting: conversation → closing", {
              target: next.targetChannelId,
              convId,
            });
          }
          if (ctx.G.has(next.targetChannelId)) {
            ctx.G.updateChannel(next.targetChannelId, { pending_directed: 0 });
          }
        }
      } else if (sub.outcome === "fed_up" || sub.outcome === "cooling_down") {
        const hasVisibleEffect = hasConversationOutput(sub.execution);
        next.session.outcome = hasVisibleEffect ? sub.outcome : "complete";
        if (!hasVisibleEffect) {
          log.info("leave/cooling ignored for non-visible action", {
            target: next.targetChannelId,
            outcome: sub.outcome,
            completedActions: sub.execution.completedActions,
          });
          next.state = "done";
          active = cleanupDoneSlots(ctx, active, pendingFinalizations);
          continue;
        }
        // Обещание прощания: переводим активный conversation цели в closing + turn_state: closed.
        // LLM решает уйти (семантика), код реализует структурные последствия (автомат состояний).
        if (next.targetChannelId) {
          const { findActiveConversation } = await import("../../graph/queries.js");
          const convId = findActiveConversation(ctx.G, next.targetChannelId);
          if (convId && ctx.G.has(convId)) {
            ctx.G.updateConversation(convId, {
              state: "closing",
              turn_state: "closed",
              closing_since_ms: Date.now(),
            });
            log.info("leave: conversation → closing", {
              target: next.targetChannelId,
              convId,
            });
          }
          // ADR-217: социальное избегание — записываем атрибут aversion, мультипликативно модулирует ценность цели на уровне IAUS.
          // act_silences больше не инжектируются (это канал инфраструктурных сбоев, семантически другой).
          // Восстановление управляется экспоненциальным затуханием по времени (группы τ=2ч, личные чаты τ=8ч), не сбрасывается directed-сообщениями.
          // @see docs/adr/217-pressure-field-aversion-gap.md §Вариант D
          if (ctx.G.has(next.targetChannelId)) {
            const patch: Partial<import("../../graph/entities.js").ChannelAttrs> = {
              pending_directed: 0,
              aversion: sub.outcome === "cooling_down" ? 1.0 : 0.8,
              aversion_ms: Date.now(),
            };
            ctx.G.updateChannel(next.targetChannelId, patch);
          }
        }
      }
      next.state = "done";
    } else if (sub.outcome === "waiting_reply" || sub.outcome === "watching") {
      // ADR-130: deferred afterward переведён в неблокирующий режим
      // afterward LLM — это диалоговая семантика; планировщик внутренне преобразует её в runtime watch plan.
      startWatcher(ctx, next, watchPlanFromOutcome(sub.outcome as DeferredTurnOutcome));
      log.info(`Engagement ${sub.outcome}`, {
        target: next.item.target,
        subcycle: next.session.subcycle,
        elapsed: next.session.elapsed,
        activeSlots: active.length,
      });
    }

    // проверяем, не исчерпан ли engagement
    if (next.state === "ready" && !next.session.canContinue()) {
      next.session.outcome = "limit";
      next.state = "done";
    }

    // ── 10. Очищаем завершённые slot ──
    active = cleanupDoneSlots(ctx, active, pendingFinalizations);
  }

  // При закрытии: ожидаем завершения всех асинхронных финализаций + очищаем оставшиеся slot
  await Promise.allSettled([...pendingFinalizations]);
  for (const slot of active) {
    await finalizeSlot(ctx, slot);
  }

  log.info("ReAct loop stopped");
}
