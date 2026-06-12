/**
 * ExplorationGuard — L2 代码级探索保护。
 *
 * 滑动窗口 budget + cooldown + 观察窗口 + circuit breaker，
 * 防止 Alice 在探索新群组/频道时触发 Telegram 限流或社交越界。
 *
 * @see docs/adr/53-audit-gap-closure.md §ExplorationGuard
 * @see OpenClaw circuit breaker (nostr-bus.ts)
 * @see mtcute FloodWaiter (flood-waiter.ts)
 */

// ═══════════════════════════════════════════════════════════════════════════
// 配置
// ═══════════════════════════════════════════════════════════════════════════

export interface ExplorationConfig {
  /** 24h 内最大 join 次数 */
  maxJoinsPerDay: number;
  /** 1h 内最大 search 次数 */
  maxSearchPerHour: number;
  /** 两次 join 之间的冷却（ms） */
  joinCooldownMs: number;
  /** 两次 search 之间的冷却（ms） */
  searchCooldownMs: number;
  /** join 后搜索冷却（ms）：刚加入群组后不立即搜索 */
  postJoinSearchCooldownMs: number;
  /** 加入新频道后的静默观察期（秒） */
  silentDurationS: number;
  /** 静默期后的学徒期（秒，从 join 开始计） */
  apprenticeDurationS: number;
  /** 学徒期内最大消息数 */
  apprenticeMaxMessages: number;
  /** Circuit breaker: 连续失败阈值 */
  circuitBreakerThreshold: number;
  /** Circuit breaker: open 持续时间（ms） */
  circuitBreakerOpenMs: number;
}

const DEFAULT_CONFIG: ExplorationConfig = {
  maxJoinsPerDay: 5,
  maxSearchPerHour: 10,
  joinCooldownMs: 3_600_000, // 1h
  searchCooldownMs: 300_000, // 5min
  postJoinSearchCooldownMs: 1_800_000, // 30min
  silentDurationS: 600, // 10 分钟
  apprenticeDurationS: 1800, // 30 分钟
  apprenticeMaxMessages: 3,
  circuitBreakerThreshold: 3,
  circuitBreakerOpenMs: 3_600_000, // 1h
};

// ═══════════════════════════════════════════════════════════════════════════
// Circuit Breaker 内部状态
// ═══════════════════════════════════════════════════════════════════════════

type CircuitState = "closed" | "open" | "half-open";

interface CircuitBreaker {
  state: CircuitState;
  consecutiveFailures: number;
  openedAt: number; // timestamp when opened
}

// ═══════════════════════════════════════════════════════════════════════════
// ExplorationGuard
// ═══════════════════════════════════════════════════════════════════════════

export class ExplorationGuard {
  readonly config: ExplorationConfig;

  // 滑动窗口 budget
  private joinTimestamps: number[] = [];
  private searchTimestamps: number[] = [];

  // Cooldown（-1 = 尚未发生过）
  private lastJoinTime = -1;
  private lastSearchTime = -1;

  // Per-action circuit breakers
  private breakers = new Map<string, CircuitBreaker>();

  // 时间源（测试可注入）
  private _now: () => number;

  constructor(config?: Partial<ExplorationConfig>, now?: () => number) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this._now = now ?? (() => Date.now());
  }

  // ── Budget 检查 ──────────────────────────────────────────────────────────

  /** 检查是否可以 join chat */
  canJoin(): { allowed: boolean; reason?: string } {
    const now = this._now();

    // Circuit breaker
    const cb = this.getBreaker("join");
    if (cb.state === "open") {
      if (now - cb.openedAt >= this.config.circuitBreakerOpenMs) {
        cb.state = "half-open";
      } else {
        return { allowed: false, reason: "circuit breaker open for join" };
      }
    }

    // 滑动窗口：24h 内 join 次数
    this.pruneTimestamps(this.joinTimestamps, 24 * 60 * 60 * 1000, now);
    if (this.joinTimestamps.length >= this.config.maxJoinsPerDay) {
      return {
        allowed: false,
        reason: `join budget exhausted (${this.config.maxJoinsPerDay}/day)`,
      };
    }

    // Cooldown：上次 join 距今
    if (this.lastJoinTime >= 0 && now - this.lastJoinTime < this.config.joinCooldownMs) {
      const remainMs = this.config.joinCooldownMs - (now - this.lastJoinTime);
      return { allowed: false, reason: `join cooldown (${Math.ceil(remainMs / 1000)}s remaining)` };
    }

    return { allowed: true };
  }

  /** 检查是否可以搜索 */
  canSearch(type: "public" | "global"): { allowed: boolean; reason?: string } {
    const now = this._now();

    // Circuit breaker
    const cb = this.getBreaker(`search_${type}`);
    if (cb.state === "open") {
      if (now - cb.openedAt >= this.config.circuitBreakerOpenMs) {
        cb.state = "half-open";
      } else {
        return { allowed: false, reason: `circuit breaker open for search_${type}` };
      }
    }

    // 滑动窗口：1h 内 search 次数
    this.pruneTimestamps(this.searchTimestamps, 60 * 60 * 1000, now);
    if (this.searchTimestamps.length >= this.config.maxSearchPerHour) {
      return {
        allowed: false,
        reason: `search budget exhausted (${this.config.maxSearchPerHour}/hour)`,
      };
    }

    // Cooldown：上次 search 距今
    if (this.lastSearchTime >= 0 && now - this.lastSearchTime < this.config.searchCooldownMs) {
      const remainMs = this.config.searchCooldownMs - (now - this.lastSearchTime);
      return {
        allowed: false,
        reason: `search cooldown (${Math.ceil(remainMs / 1000)}s remaining)`,
      };
    }

    // post-join search cooldown：join 后不能立即搜索
    if (this.lastJoinTime >= 0 && now - this.lastJoinTime < this.config.postJoinSearchCooldownMs) {
      const remainMs = this.config.postJoinSearchCooldownMs - (now - this.lastJoinTime);
      return {
        allowed: false,
        reason: `post-join search cooldown (${Math.ceil(remainMs / 1000)}s remaining)`,
      };
    }

    return { allowed: true };
  }

  // ── 观察窗口 ────────────────────────────────────────────────────────────

  /** 获取频道的观察阶段。nowMs = 当前墙钟时间，joinMs = 加入时的墙钟时间。 */
  getObservationPhase(joinMs: number, nowMs: number): "silent" | "apprentice" | "normal" {
    const elapsedS = (nowMs - joinMs) / 1000;
    if (elapsedS < this.config.silentDurationS) return "silent";
    if (elapsedS < this.config.apprenticeDurationS) return "apprentice";
    return "normal";
  }

  // ── 事件记录 ────────────────────────────────────────────────────────────

  recordJoin(): void {
    const now = this._now();
    this.joinTimestamps.push(now);
    this.lastJoinTime = now;
  }

  recordLeave(): void {
    // 目前仅占位，未来可统计 join-leave 间隔
  }

  recordSearch(): void {
    const now = this._now();
    this.searchTimestamps.push(now);
    this.lastSearchTime = now;
  }

  // ── Circuit Breaker ─────────────────────────────────────────────────────

  recordFailure(action: string): void {
    const cb = this.getBreaker(action);
    cb.consecutiveFailures++;

    if (cb.state === "half-open") {
      // 半开试探失败 → 回到 open
      cb.state = "open";
      cb.openedAt = this._now();
    } else if (cb.consecutiveFailures >= this.config.circuitBreakerThreshold) {
      cb.state = "open";
      cb.openedAt = this._now();
    }
  }

  recordSuccess(action: string): void {
    const cb = this.getBreaker(action);
    cb.consecutiveFailures = 0;
    cb.state = "closed";
  }

  /** 获取 breaker 状态（测试用，纯派生不 mutate）。 */
  getBreakerState(action: string): CircuitState {
    const cb = this.getBreaker(action);
    if (cb.state === "open" && this._now() - cb.openedAt >= this.config.circuitBreakerOpenMs) {
      return "half-open";
    }
    return cb.state;
  }

  // ── 内部工具 ────────────────────────────────────────────────────────────

  private getBreaker(action: string): CircuitBreaker {
    let cb = this.breakers.get(action);
    if (!cb) {
      cb = { state: "closed", consecutiveFailures: 0, openedAt: 0 };
      this.breakers.set(action, cb);
    }
    return cb;
  }

  private pruneTimestamps(arr: number[], windowMs: number, now: number): void {
    const cutoff = now - windowMs;
    while (arr.length > 0 && arr[0] <= cutoff) {
      arr.shift();
    }
  }
}
