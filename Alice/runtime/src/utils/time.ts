/**
 * Адаптивное отображение настенных часов → tick.
 *
 * Статья §6.4 Definition 6.3:
 *   Δt(n) = Δt_min + (Δt_max - Δt_min) · exp(-API(n) / κ_t)
 *
 * API высокий → интервал короткий (быстрый отклик в нагрузке); API низкий → интервал длинный (экономия ресурсов в покое).
 * @see docs/adr/02-architecture-overview.md
 */

/** Режим работы агента. @see paper/ §6.2 Definition 6.2, ADR-190: wakeup, ADR-225: dormant */
export type AgentMode = "wakeup" | "patrol" | "conversation" | "consolidation" | "dormant";

/** Ограничения интервала tick для каждого режима. */
export interface ModeTimingParams {
  dtMin: number; // ms
  dtMax: number; // ms
}

/** Параметры тайминга по умолчанию для каждого режима (статья §6.2, ADR-190: wakeup 3-10s, conversation 10-30s). */
export const MODE_TIMING: Record<AgentMode, ModeTimingParams> = {
  wakeup: { dtMin: 3_000, dtMax: 10_000 },
  patrol: { dtMin: 1_000, dtMax: 300_000 },
  // ADR-190: conversation dtMin 3s→10s, dtMax 5s→30s.
  // Асинхронный IM не требует опроса каждую секунду — ответы в Telegram-группе не являются диалогом в реальном времени.
  // tick в 3s даёт 12-20 полных оценок IAUS в минуту, большинство из которых производят silence.
  conversation: { dtMin: 10_000, dtMax: 30_000 },
  consolidation: { dtMin: 30_000, dtMax: 600_000 },
  // ADR-225: режим сна — крайне редкое восприятие (1min-30min), только пассивный приём событий.
  dormant: { dtMin: 60_000, dtMax: 1_800_000 },
};

export interface TickClockOptions {
  dtMin?: number;
  dtMax?: number;
  kappaT?: number;
  startTick?: number;
}

/** Адаптивный менеджер Tick. */
export class TickClock {
  private _tick: number;
  private _lastAdvanceMs: number;
  private readonly dtMin: number;
  private readonly dtMax: number;
  private readonly kappaT: number;

  constructor(opts: TickClockOptions = {}) {
    this.dtMin = opts.dtMin ?? 1_000;
    this.dtMax = opts.dtMax ?? 300_000;
    this.kappaT = opts.kappaT ?? 1.0;
    this._tick = opts.startTick ?? 0;
    this._lastAdvanceMs = Date.now();
  }

  /** Текущий tick. */
  get tick(): number {
    return this._tick;
  }

  /**
   * Точная реализация уравнения adaptive-tick из статьи.
   * Δt(n) = Δt_min + (Δt_max - Δt_min) · exp(-API(n) / κ_t)
   *
   * @param api Текущее агрегированное значение давления API
   * @param mode Текущий режим работы (ограничивает диапазон dtMin/dtMax)
   */
  computeInterval(api: number, mode: AgentMode = "patrol"): number {
    const timing = MODE_TIMING[mode];
    const effMin = Math.max(this.dtMin, timing.dtMin);
    const effMax = Math.min(this.dtMax, timing.dtMax);
    return effMin + (effMax - effMin) * Math.exp(-api / this.kappaT);
  }

  /**
   * Продвигает один tick, возвращает dt (секунды настенных часов).
   * dt = фактическое время, прошедшее с последнего advance.
   */
  advance(): { tick: number; dt: number } {
    this._tick++;
    const now = Date.now();
    const dt = (now - this._lastAdvanceMs) / 1000;
    this._lastAdvanceMs = now;
    return { tick: this._tick, dt };
  }

  /** Устанавливает tick (восстановление из снапшота). */
  setTick(tick: number): void {
    this._tick = tick;
  }

  /** Временная метка настенных часов последнего advance (мс). */
  get lastAdvanceMs(): number {
    return this._lastAdvanceMs;
  }
}
