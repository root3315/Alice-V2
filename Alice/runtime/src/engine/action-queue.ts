/**
 * Асинхронная очередь действий — вытеснение по приоритету давления.
 *
 * Поток ACT извлекает действия из очереди и выполняет их последовательно.
 * При переполнении вытесняется действие с наименьшим давлением (а не FIFO-сброс самого старого),
 * чтобы высокоприоритетные действия (напр. directed-ответы) не выдавливались низкоприоритетными.
 */

import { createLogger } from "../utils/logger.js";
import type { PressureDims } from "../utils/math.js";
import type { VoiceAction } from "../voices/personality.js";

const log = createLogger("action-queue");

export interface ActionQueueItem {
  enqueueTick: number;
  action: VoiceAction;
  target: string | null;
  pressureSnapshot: PressureDims;
  contributions: Record<string, Record<string, number>>;
  /** ADR-26: ID сущностей фокусного множества победившего голоса. */
  focalEntities?: string[];
  /** Структурированное обоснование действия со стороны движка (генерируется машиной, дополняет LLM think()). */
  reason?: string;
  /** D8: Кандидаты с V-max-оценкой (для fan-out). */
  vmaxScored?: Array<{
    action: string;
    target: string | null;
    V: number;
    bypassGates: boolean;
    bottleneck: string;
  }>;
  /** D8: Разброс V-max кандидатов (условие запуска fan-out). */
  vmaxSpread?: number;
  /** ADR-174: ID грани личности (управляет выбором guidance + whisper + example). */
  facetId?: string;
  /** ADR-215: Связанный episode ID. Используется в processResult потока act для закрытия episode. */
  episodeId?: string;
  /** ADR-215: Когнитивный остаток из вывода LLM (из TickStepSchema.residue). */
  llmResidue?: import("../llm/schemas.js").LLMResidue;
  /** ADR-258: typed observation spine identity. */
  observation?: {
    candidateId: string;
    enqueueId: string;
    api: number;
    apiPeak: number | null;
  };
}

export interface ActionQueueMetrics {
  queued: number;
  processing: number;
  active: number;
  waitingConsumers: number;
  maxDepth: number;
  overflowCount: number;
  saturation: number;
}

export type ActionQueueEnqueueResult =
  | { outcome: "accepted"; delivery: "queued" | "direct"; evicted?: undefined }
  | { outcome: "rejected_overflow"; delivery: "dropped"; evicted?: undefined }
  | { outcome: "accepted"; delivery: "queued"; evicted: ActionQueueItem };

/** Суммарный балл давления: сумма шести измерений давления. Используется для вытеснения при переполнении и сортировки планировщика. */
export function pressureScore(item: ActionQueueItem): number {
  return item.pressureSnapshot.reduce((s, p) => s + p, 0);
}

/**
 * Асинхронная очередь с приоритетами на Promise.
 * Сторона enqueue может добавлять из любого async-контекста, сторона dequeue блокируется в ожидании.
 * При переполнении вытесняется действие с наименьшим давлением (высокоприоритетные защищены).
 */
export class ActionQueue {
  static readonly MAX_DEPTH = 50;
  private items: ActionQueueItem[] = [];
  private waiters: ((item: ActionQueueItem | null) => void)[] = [];
  private _closed = false;
  /** Накопленное число сбросов при переполнении (используется для мониторинга). */
  private _overflowCount = 0;
  /**
   * Множество целей, которые обрабатываются потоком ACT в данный момент.
   * dequeue() атомарно добавляет цель, markComplete() освобождает.
   * Вместе с очередью items образует инвариант Engagement Exclusivity.
   */
  private processing = new Set<string>();

  /** Добавляет действие в очередь. При переполнении вытесняется действие с наименьшим давлением. */
  enqueue(item: ActionQueueItem): ActionQueueEnqueueResult {
    if (this._closed) return { outcome: "rejected_overflow", delivery: "dropped" };
    if (this.items.length >= ActionQueue.MAX_DEPTH) {
      // Находим действие с наименьшим давлением в очереди
      let minIdx = 0;
      let minScore = pressureScore(this.items[0]);
      for (let i = 1; i < this.items.length; i++) {
        const score = pressureScore(this.items[i]);
        if (score < minScore) {
          minScore = score;
          minIdx = i;
        }
      }
      const newScore = pressureScore(item);
      this._overflowCount++;
      if (newScore <= minScore) {
        // Новое действие имеет наименьший приоритет → отбрасываем его (не добавляем в очередь)
        log.warn("ActionQueue overflow, new item rejected (lowest priority)", {
          overflowCount: this._overflowCount,
          newTarget: item.target,
          newScore: newScore.toFixed(2),
        });
        // H3: дропнутый re-enqueue preempted-таргета не должен оставить processing-lock навсегда.
        if (item.target && !this.items.some((i) => i.target === item.target)) {
          this.processing.delete(item.target);
        }
        return { outcome: "rejected_overflow", delivery: "dropped" };
      }
      // Вытесняем существующее действие с наименьшим приоритетом
      const evicted = this.items.splice(minIdx, 1)[0];
      log.warn("ActionQueue overflow, lowest-priority item evicted", {
        overflowCount: this._overflowCount,
        evictedTick: evicted.enqueueTick,
        evictedTarget: evicted.target,
        evictedScore: minScore.toFixed(2),
        newScore: newScore.toFixed(2),
      });
      this.items.push(item);
      // H3: вытесненный item (мог быть preempted re-enqueue) — снять processing-lock, если его
      // больше нет в очереди, иначе таргет навсегда выпадает из всех будущих engagements.
      if (evicted.target && !this.items.some((i) => i.target === evicted.target)) {
        this.processing.delete(evicted.target);
      }
      return { outcome: "accepted", delivery: "queued", evicted };
    }
    const waiter = this.waiters.shift();
    if (waiter) {
      // Путь прямой доставки: элемент минует очередь и сразу принимается потребителем dequeue.
      // Атомарно устанавливаем processing (симметрично shift+add в dequeue).
      if (item.target) this.processing.add(item.target);
      waiter(item);
      return { outcome: "accepted", delivery: "direct" };
    } else {
      this.items.push(item);
      return { outcome: "accepted", delivery: "queued" };
    }
  }

  /**
   * ADR-130: Неблокирующее извлечение действия. Немедленно возвращает null, если очередь пуста.
   * Атомарно добавляет цель в множество processing.
   * Используется чередующимся планировщиком для заполнения свободных слотов при активном engagement.
   */
  tryDequeue(): ActionQueueItem | null {
    if (this.items.length === 0 || this._closed) return null;
    const item = this.items.shift() ?? null;
    if (item?.target) this.processing.add(item.target);
    return item;
  }

  /**
   * Блокирующее ожидание и извлечение действия. После закрытия возвращает null.
   * Атомарно добавляет цель в множество processing (однопоточность Node.js гарантирует неделимость синхронного кода).
   */
  async dequeue(): Promise<ActionQueueItem | null> {
    if (this.items.length > 0) {
      const item = this.items.shift() ?? null;
      if (item?.target) this.processing.add(item.target);
      return item;
    }
    if (this._closed) return null;
    // Путь waiter: processing устанавливается до вызова waiter(item) в enqueue
    return new Promise<ActionQueueItem | null>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  /** Просматривает первый элемент очереди без извлечения (ADR-54: для принятия решения о cooldown). */
  peek(): ActionQueueItem | null {
    return this.items[0] ?? null;
  }

  /**
   * Проверка Engagement Exclusivity: есть ли у цели активный engagement (в очереди ИЛИ в обработке).
   * Заменяет устаревшую двойную проверку countByTarget + thinking_target.
   */
  isTargetActive(target: string): boolean {
    return this.processing.has(target) || this.items.some((i) => i.target === target);
  }

  /** ADR-182 D3: Есть ли действие в процессе обработки. */
  hasActive(): boolean {
    return this.processing.size > 0;
  }

  /** ADR-186: Возвращает множество target всех активных engagement. */
  getActiveTargets(): ReadonlySet<string> {
    return this.processing;
  }

  /** ADR-252 Wave 1: Метрики обратного давления очереди/ACT только для чтения. */
  getMetrics(): ActionQueueMetrics {
    const queued = this.items.length;
    const processing = this.processing.size;
    const active = queued + processing;
    const maxDepth = ActionQueue.MAX_DEPTH;
    return {
      queued,
      processing,
      active,
      waitingConsumers: this.waiters.length,
      maxDepth,
      overflowCount: this._overflowCount,
      saturation: maxDepth > 0 ? Math.min(1, active / maxDepth) : 0,
    };
  }

  /**
   * Снятие блокировки processing. Вызывается циклом ACT в блоке finally,
   * чтобы все пути выхода (staleness skip / исключение / нормальное завершение) снимали блокировку.
   */
  markComplete(target: string): void {
    this.processing.delete(target);
  }

  /** Текущая длина очереди. */
  get length(): number {
    return this.items.length;
  }

  /** Накопленное число переполнений (для мониторинга). */
  get overflowCount(): number {
    return this._overflowCount;
  }

  /** Закрывает очередь и будит всех ожидающих. */
  close(): void {
    this._closed = true;
    this.processing.clear();
    for (const waiter of this.waiters) {
      waiter(null);
    }
    this.waiters = [];
  }

  get closed(): boolean {
    return this._closed;
  }
}
