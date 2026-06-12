/**
 * 自适应墙钟 → tick 映射。
 *
 * 论文 §6.4 Definition 6.3:
 *   Δt(n) = Δt_min + (Δt_max - Δt_min) · exp(-API(n) / κ_t)
 *
 * API 高 → 间隔短（忙碌时快速响应）；API 低 → 间隔长（空闲时省资源）。
 * @see docs/adr/02-architecture-overview.md
 */

/** Agent 运行模态。 @see paper/ §6.2 Definition 6.2, ADR-190: wakeup, ADR-225: dormant */
export type AgentMode = "wakeup" | "patrol" | "conversation" | "consolidation" | "dormant";

/** 每模态的 tick 间隔约束。 */
export interface ModeTimingParams {
  dtMin: number; // ms
  dtMax: number; // ms
}

/** 模态默认时序参数（论文 §6.2，ADR-190: wakeup 3-10s, conversation 10-30s）。 */
export const MODE_TIMING: Record<AgentMode, ModeTimingParams> = {
  wakeup: { dtMin: 3_000, dtMax: 10_000 },
  patrol: { dtMin: 1_000, dtMax: 300_000 },
  // ADR-190: conversation dtMin 3s→10s, dtMax 5s→30s。
  // 异步 IM 不需要秒级轮询——Telegram 群聊回复不是实时对话。
  // 3s tick 导致每分钟 12-20 次完整 IAUS 评分，绝大多数产出 silence。
  conversation: { dtMin: 10_000, dtMax: 30_000 },
  consolidation: { dtMin: 30_000, dtMax: 600_000 },
  // ADR-225: 睡眠模态 — 极低频感知（1min-30min），仅维持被动事件接收。
  dormant: { dtMin: 60_000, dtMax: 1_800_000 },
};

export interface TickClockOptions {
  dtMin?: number;
  dtMax?: number;
  kappaT?: number;
  startTick?: number;
}

/** 自适应 Tick 管理器。 */
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

  /** 当前 tick。 */
  get tick(): number {
    return this._tick;
  }

  /**
   * 论文 Eq. adaptive-tick 精确实现。
   * Δt(n) = Δt_min + (Δt_max - Δt_min) · exp(-API(n) / κ_t)
   *
   * @param api 当前 API 聚合压力值
   * @param mode 当前运行模态（约束 dtMin/dtMax 范围）
   */
  computeInterval(api: number, mode: AgentMode = "patrol"): number {
    const timing = MODE_TIMING[mode];
    const effMin = Math.max(this.dtMin, timing.dtMin);
    const effMax = Math.min(this.dtMax, timing.dtMax);
    return effMin + (effMax - effMin) * Math.exp(-api / this.kappaT);
  }

  /**
   * 推进一个 tick，返回 dt（墙钟秒数）。
   * dt = 自上次 advance 以来的实际经过秒数。
   */
  advance(): { tick: number; dt: number } {
    this._tick++;
    const now = Date.now();
    const dt = (now - this._lastAdvanceMs) / 1000;
    this._lastAdvanceMs = now;
    return { tick: this._tick, dt };
  }

  /** 设置 tick（从快照恢复）。 */
  setTick(tick: number): void {
    this._tick = tick;
  }

  /** 上次 advance 的墙钟时间戳（ms）。 */
  get lastAdvanceMs(): number {
    return this._lastAdvanceMs;
  }
}
