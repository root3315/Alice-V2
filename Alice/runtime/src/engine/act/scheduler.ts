/**
 * ADR-130: Engagement Interleaving — кооперативный чередующийся планировщик.
 *
 * Заменяет последовательный single-consumer while-цикл startActLoop, вводя
 * чередующееся планирование нескольких engagement-ов.
 * subcycle (один раунд ReAct: LLM → Sandbox → Execute → Feedback) — минимальная неделимая единица.
 * Между subcycle-ами находятся естественные точки переключения — аналог поведения человека в IM:
 * «ответил на сообщение и переключился в другое окно».
 *
 * Ключевые инварианты:
 * 1. Атомарность subcycle — внутри subcycle не переключаемся (транзакционность CQRS)
 * 2. Engagement Exclusivity — не более одного активного engagement на цель (ADR-124)
 * 3. Изоляция целей Dispatcher — при переключении повторно задаём SET_CONTACT_TARGET / SET_CHAT_TARGET
 * 4. Согласованность графа — однопоточность Node.js + синхронные изменения внутри subcycle
 *
 * ADR-142: обобщённым BT-эквивалентом selectNextEngagement является tick/compose.ts::reactiveSelect.
 * В этом файле сохранена логика планирования, специфичная для engagement (initSlot, checkWatchers,
 * startWatcher и др.); compose.ts::reactiveSelect предоставляет универсальный приоритетный
 * селектор без зависимости от семантики engagement.
 *
 * @see docs/adr/130-engagement-interleaving.md
 * @see docs/adr/142-action-space-architecture/README.md
 */
import { ALICE_SELF, ensureChannelId, extractNumericId } from "../../graph/constants.js";
import { ChatTarget } from "../../prompt/types.js";
import { createLogger } from "../../utils/logger.js";
import { type ActionQueue, type ActionQueueItem, pressureScore } from "../action-queue.js";
import { captureGraphState } from "../closure-depth.js";
import type { ActContext } from "../react/orchestrator.js";
import {
  buildContextVars,
  type ContextVars,
  type ResolvedTarget,
  resolveTarget,
} from "../tick/target.js";
import {
  EngagementSession,
  EXPECT_REPLY_TIMEOUT,
  prepareEngagementWatch,
  prepareStayWatch,
  STAY_TIMEOUT,
  type WatchResult,
} from "./engagement.js";
import { fetchRecentMessages, type MessageRecord } from "./messages.js";

const log = createLogger("act:scheduler");

// ── Константы ADR-130 ──────────────────────────────────────────────────────

/** Максимальное число одновременных engagement-ов (консервативный конец шкалы Миллера 7±2). */
export const MAX_CONCURRENT_ENGAGEMENTS = 3;

/** Дополнительная задержка при переключении на другую цель (мс) — наблюдаемая «пауза при переключении». */
export const SWITCH_COST_MS = 1500;

// ── EngagementSlot ─────────────────────────────────────────────────────

/** Состояние слота планировщика. Только для runtime, не переиспользует лексику LLM afterward. */
export type SlotState = "ready" | "reply_watch" | "linger_watch" | "done";

/** Результат afterward, требующий неблокирующего наблюдения. */
export type DeferredTurnOutcome = "waiting_reply" | "watching";

/** Внутренний план наблюдения планировщика. Только для runtime, не экспонируется LLM. */
export type WatchPlan = "reply_window" | "linger_window";

export function watchPlanFromOutcome(outcome: DeferredTurnOutcome): WatchPlan {
  return outcome === "waiting_reply" ? "reply_window" : "linger_window";
}

/** Runtime-состояние неблокирующего наблюдателя (watcher). */
export interface ActiveWatcher {
  readonly plan: WatchPlan;
  readonly handle: ReturnType<typeof prepareEngagementWatch>;
  readonly promise: Promise<WatchResult>;
  readonly timeout: number;
}

function isWatchState(state: SlotState): state is "reply_watch" | "linger_watch" {
  return state === "reply_watch" || state === "linger_watch";
}

/**
 * Слот планировщика для одного активного engagement.
 * Каждый слот независимо хранит контекст выполнения — сериализация при переключении не нужна.
 *
 * Поля, определяемые на этапе инициализации, помечены readonly; изменяемы только state/urgency/liveMessages/watcher.
 */
export interface EngagementSlot {
  readonly item: ActionQueueItem;
  readonly session: EngagementSession;
  state: SlotState;
  urgency: number;
  /** Целевая информация, разрешённая на этапе Prepare. */
  readonly resolved: ResolvedTarget | null;
  readonly contextVars: ContextVars | undefined;
  /** Обновляемо — перечитывается между subcycle-ами. */
  liveMessages: MessageRecord[];
  readonly targetChatId: number | null;
  readonly targetChannelId: string | null;
  /** «Липкость» engagement (используется для оценки preemption). */
  readonly holdStrength: number;
  /** Снимок состояния графа для замера ClosureDepth. */
  readonly graphBefore: ReturnType<typeof captureGraphState>;
  /** Время начала engagement по настенным часам (мс). */
  readonly startMs: number;
  /** Состояние неблокирующего watcher. null = нет активного watcher. */
  watcher: ActiveWatcher | null;
  /**
   * Флаг вытеснения (preempt). Когда true, finalizeSlot пропускает markComplete,
   * поскольку target уже повторно поставлен в очередь — блокировка processing
   * должна принадлежать новому engagement.
   * @see C1 in adr130-review.md
   */
  preempted: boolean;
  /**
   * Burst settle: жёсткий предел «одна пауза-дочитывание на engagement».
   * true после того, как окно дочитывания уже было применено к этому слоту —
   * предотвращает голодание/зависание (никогда не откладываем дважды).
   */
  burstSettled: boolean;
}

// ── API планировщика ─────────────────────────────────────────────────────────

/**
 * Инициализирует слот engagement.
 * Выполняет фазу Prepare: получает сообщения, разрешает цель, устанавливает цель Dispatcher.
 */
export async function initSlot(ctx: ActContext, item: ActionQueueItem): Promise<EngagementSlot> {
  const targetChatId = item.target ? extractNumericId(item.target) : null;
  const targetChatType =
    item.target && ctx.G.has(item.target) ? ctx.G.getChannel(item.target).chat_type : undefined;
  const recentMessages = targetChatId
    ? await fetchRecentMessages(ctx.client, targetChatId, ctx.config, {
        chatType: targetChatType,
      })
    : [];

  const resolved = item.target ? resolveTarget(ctx.G, item.target) : null;
  const contextVars = resolved ? buildContextVars(ctx, item, resolved) : undefined;
  const targetChannelId = item.target ? ensureChannelId(item.target) : null;
  const holdStrength = Math.max(...item.pressureSnapshot, 3.0);
  const graphBefore = captureGraphState(ctx.G);

  // Сигнал наблюдаемости thinking_target
  const tick = ctx.getCurrentTick();
  if (item.target && ctx.G.has(ALICE_SELF)) {
    ctx.G.updateAgent(ALICE_SELF, { thinking_target: item.target });
    if (ctx.G.has(item.target)) {
      ctx.G.updateChannel(item.target, { alice_thinking_since: tick });
    }
  }

  // M4: до 5 сообщений за engagement и в группе, и в лс — она сама решает сколько (не режем до 2).
  const maxSubcycles = ChatTarget.isGroupChat(targetChatType ?? "private") ? 5 : undefined;

  return {
    item,
    session: new EngagementSession(maxSubcycles),
    state: "ready",
    urgency: pressureScore(item),
    resolved,
    contextVars,
    liveMessages: recentMessages,
    targetChatId,
    targetChannelId,
    holdStrength,
    graphBefore,
    startMs: Date.now(),
    watcher: null,
    preempted: false,
    burstSettled: false,
  };
}

/**
 * ADR-130: выбирает следующий engagement в состоянии ready — приоритет у наиболее срочного.
 * Один проход O(n).
 */
export function selectNextEngagement(active: EngagementSlot[]): EngagementSlot | null {
  let best: EngagementSlot | null = null;
  for (const slot of active) {
    if (slot.state === "ready" && (best === null || slot.urgency > best.urgency)) {
      best = slot;
    }
  }
  return best;
}

/**
 * Проверяет, есть ли событие пробуждения для watch-слота.
 * Неблокирующая — только проверяет, жив ли watcher.
 *
 * Безопасность опирается на однопоточную модель Node.js: присваивания
 * `watcher = null; state = "ready"` в handleWatchResult выполняются синхронно
 * в одной микрозадаче и не могут быть прерваны синхронным обходом checkWatchers.
 */
export function checkWatchers(active: EngagementSlot[]): void {
  for (const slot of active) {
    if (isWatchState(slot.state) && slot.watcher === null) {
      // watcher уже потреблён или отсутствует — помечаем done
      slot.state = "done";
    }
  }
}

/**
 * Ожидает завершения или таймаута watcher любого watch-слота.
 * Вызывается, когда ни один слот не находится в состоянии ready (блокирует до появления
 * планируемого слота). Также ожидает новые элементы в ActionQueue (пробуждение при непустой очереди).
 */
export async function awaitAnyWakeup(active: EngagementSlot[], _queue: ActionQueue): Promise<void> {
  const promises: Promise<unknown>[] = [];

  for (const slot of active) {
    if (isWatchState(slot.state) && slot.watcher) {
      promises.push(slot.watcher.promise);
    }
  }

  // Добавляем короткий таймер как страховку (polling) — чтобы не зависнуть, если все watcher-ы ждут бесконечно.
  // Примечание: функция не слушает новые элементы очереди напрямую — возврат в главный цикл через 500ms polling.
  let timerHandle: ReturnType<typeof setTimeout> | undefined;
  const timerPromise = new Promise<void>((resolve) => {
    timerHandle = setTimeout(resolve, 500);
  });
  promises.push(timerPromise);

  await Promise.race(promises);
  if (timerHandle != null) clearTimeout(timerHandle);
}

/** Конфигурация watcher: фабричная функция + таймаут + соответствующее состояние слота. */
interface WatchConfig {
  readonly slotState: "reply_watch" | "linger_watch";
  readonly timeout: number;
  readonly create: (
    ctx: ActContext,
    channelId: string,
    holdStrength: number,
  ) => ReturnType<typeof prepareEngagementWatch>;
}

/** Отображение runtime watch-плана → конфигурация. */
const WATCH_CONFIG: Record<WatchPlan, WatchConfig> = {
  reply_window: {
    slotState: "reply_watch",
    timeout: EXPECT_REPLY_TIMEOUT,
    create: (ctx, channelId, holdStrength) =>
      prepareEngagementWatch(ctx, channelId, holdStrength, { typingAware: true }),
  },
  linger_window: {
    slotState: "linger_watch",
    timeout: STAY_TIMEOUT,
    create: (ctx, channelId, holdStrength) => prepareStayWatch(ctx, channelId, holdStrength),
  },
};

/**
 * Запускает неблокирующий watcher для слота.
 * Результат watcher автоматически передаётся в handleWatchResult через promise .then.
 */
export function startWatcher(ctx: ActContext, slot: EngagementSlot, plan: WatchPlan): void {
  if (!slot.targetChannelId) {
    slot.state = "done";
    return;
  }

  const config = WATCH_CONFIG[plan];
  const handle = config.create(ctx, slot.targetChannelId, slot.holdStrength);
  const promise = handle.await(config.timeout).then((result) => {
    handleWatchResult(ctx, slot, result);
    return result;
  });

  slot.watcher = { plan, handle, promise, timeout: config.timeout };
  slot.state = config.slotState;
}

/**
 * Обрабатывает результат watcher — обновляет состояние слота.
 * Вызывается автоматически при resolve promise watcher.
 *
 * Исход таймаута определяется `watcher.plan` (а не `slot.state`), чтобы
 * handleWatchResult не зависел от текущего состояния слота — при асинхронном
 * resolve promise значение slot.state могло быть изменено другим путём.
 */
function handleWatchResult(ctx: ActContext, slot: EngagementSlot, result: WatchResult): void {
  // C3 guard: если watcher уже очищен releaseSlot (путь shutdown/cleanup),
  // пропускаем весь handler — избегаем побочных эффектов на уже финализированном слоте.
  if (!slot.watcher) return;

  // Захватываем plan, затем очищаем watcher (plan нужен для определения исхода таймаута)
  const plan = slot.watcher.plan;
  slot.session.elapsed += result.elapsed;
  slot.watcher = null;

  switch (result.type) {
    case "reply":
    case "activity":
      // Ответ/активность получены — переходим в ready, следующий subcycle подтянет новые сообщения
      slot.state = "ready";
      log.info("Watcher event received", {
        target: slot.item.target,
        type: result.type,
        elapsed: result.elapsed,
      });
      break;

    case "interrupt":
      // Вытеснено более срочным событием — повторно ставим в очередь
      // Помечаем preempted: finalizeSlot пропускает markComplete, блокировка processing переходит к новому engagement
      slot.session.outcome = "preempted";
      slot.preempted = true;
      ctx.queue.enqueue({
        action: slot.item.action,
        target: slot.item.target,
        reason: "engagement_interrupted",
        pressureSnapshot: ctx.getCurrentPressures(),
        contributions: slot.item.contributions,
        focalEntities: slot.item.focalEntities, // M8: сохраняем focalEntities
        enqueueTick: ctx.getCurrentTick(),
      });
      slot.state = "done";
      log.info("Engagement preempted via watcher", { target: slot.item.target });
      break;

    case "timeout":
      // Исход таймаута зависит от runtime watch-плана:
      // reply_window истёк = собеседник не ответил → "timeout"
      // linger_window истёк = нормальное завершение ожидания → "complete"
      slot.session.outcome = plan === "reply_window" ? "timeout" : "complete";
      slot.state = "done";
      log.info("Watcher timeout", {
        target: slot.item.target,
        plan,
        elapsed: result.elapsed,
      });
      break;
  }
}

/**
 * Освобождает все ресурсы слота.
 * - Снимает блокировку processing
 * - Очищает сигналы наблюдаемости
 * - Отменяет watcher
 */
export function releaseSlot(ctx: ActContext, slot: EngagementSlot): void {
  // Отменяем watcher (если есть)
  if (slot.watcher) {
    slot.watcher.handle.cancel();
    slot.watcher = null;
  }

  // Очищаем сигналы наблюдаемости
  if (ctx.G.has(ALICE_SELF)) {
    // Очищаем только если thinking_target указывает на цель этого слота
    const current = ctx.G.getAgent(ALICE_SELF).thinking_target;
    if (current === slot.item.target) {
      ctx.G.updateAgent(ALICE_SELF, { thinking_target: null });
    }
  }
  if (slot.item.target && ctx.G.has(slot.item.target)) {
    ctx.G.updateChannel(slot.item.target, { alice_thinking_since: null });
  }
}
