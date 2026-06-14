/**
 * ExplorationGuard — защита исследования на уровне кода L2.
 *
 * Скользящее окно бюджета + cooldown + окно наблюдения + circuit breaker,
 * предотвращает триггер ограничений Telegram или социальные нарушения при исследовании новых групп/каналов Алисой.
 *
 * @see docs/adr/53-audit-gap-closure.md §ExplorationGuard
 * @see OpenClaw circuit breaker (nostr-bus.ts)
 * @see mtcute FloodWaiter (flood-waiter.ts)
 */

// ═══════════════════════════════════════════════════════════════════════════
// Конфигурация
// ═══════════════════════════════════════════════════════════════════════════

export interface ExplorationConfig {
  /** Максимальное число join за 24ч */
  maxJoinsPerDay: number;
  /** Максимальное число search за 1ч */
  maxSearchPerHour: number;
  /** Пауза между двумя join (мс) */
  joinCooldownMs: number;
  /** Пауза между двумя search (мс) */
  searchCooldownMs: number;
  /** Пауза поиска после join (мс): не искать сразу после вступления в группу */
  postJoinSearchCooldownMs: number;
  /** Период молчаливого наблюдения после вступления в канал (секунды) */
  silentDurationS: number;
  /** Период ученичества после тишины (секунды, отсчёт от join) */
  apprenticeDurationS: number;
  /** Максимальное число сообщений в период ученичества */
  apprenticeMaxMessages: number;
  /** Circuit breaker: порог последовательных сбоев */
  circuitBreakerThreshold: number;
  /** Circuit breaker: длительность состояния open (мс) */
  circuitBreakerOpenMs: number;
}

const DEFAULT_CONFIG: ExplorationConfig = {
  maxJoinsPerDay: 5,
  maxSearchPerHour: 10,
  joinCooldownMs: 3_600_000, // 1h
  searchCooldownMs: 300_000, // 5min
  postJoinSearchCooldownMs: 1_800_000, // 30min
  silentDurationS: 600, // 10 минут
  apprenticeDurationS: 1800, // 30 минут
  apprenticeMaxMessages: 3,
  circuitBreakerThreshold: 3,
  circuitBreakerOpenMs: 3_600_000, // 1h
};

// ═══════════════════════════════════════════════════════════════════════════
// Внутреннее состояние Circuit Breaker
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

  // Бюджет скользящего окна
  private joinTimestamps: number[] = [];
  private searchTimestamps: number[] = [];

  // Cooldown (-1 = ещё не происходило)
  private lastJoinTime = -1;
  private lastSearchTime = -1;

  // Per-action circuit breakers
  private breakers = new Map<string, CircuitBreaker>();

  // Источник времени (инжектируется в тестах)
  private _now: () => number;

  constructor(config?: Partial<ExplorationConfig>, now?: () => number) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this._now = now ?? (() => Date.now());
  }

  // ── Проверка бюджета ──────────────────────────────────────────────────────────

  /** Проверяет, можно ли выполнить join chat */
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

    // Скользящее окно: число join за 24ч
    this.pruneTimestamps(this.joinTimestamps, 24 * 60 * 60 * 1000, now);
    if (this.joinTimestamps.length >= this.config.maxJoinsPerDay) {
      return {
        allowed: false,
        reason: `join budget exhausted (${this.config.maxJoinsPerDay}/day)`,
      };
    }

    // Cooldown: время с последнего join
    if (this.lastJoinTime >= 0 && now - this.lastJoinTime < this.config.joinCooldownMs) {
      const remainMs = this.config.joinCooldownMs - (now - this.lastJoinTime);
      return { allowed: false, reason: `join cooldown (${Math.ceil(remainMs / 1000)}s remaining)` };
    }

    return { allowed: true };
  }

  /** Проверяет, можно ли выполнить поиск */
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

    // Скользящее окно: число search за 1ч
    this.pruneTimestamps(this.searchTimestamps, 60 * 60 * 1000, now);
    if (this.searchTimestamps.length >= this.config.maxSearchPerHour) {
      return {
        allowed: false,
        reason: `search budget exhausted (${this.config.maxSearchPerHour}/hour)`,
      };
    }

    // Cooldown: время с последнего search
    if (this.lastSearchTime >= 0 && now - this.lastSearchTime < this.config.searchCooldownMs) {
      const remainMs = this.config.searchCooldownMs - (now - this.lastSearchTime);
      return {
        allowed: false,
        reason: `search cooldown (${Math.ceil(remainMs / 1000)}s remaining)`,
      };
    }

    // post-join search cooldown: нельзя искать сразу после join
    if (this.lastJoinTime >= 0 && now - this.lastJoinTime < this.config.postJoinSearchCooldownMs) {
      const remainMs = this.config.postJoinSearchCooldownMs - (now - this.lastJoinTime);
      return {
        allowed: false,
        reason: `post-join search cooldown (${Math.ceil(remainMs / 1000)}s remaining)`,
      };
    }

    return { allowed: true };
  }

  // ── Окно наблюдения ────────────────────────────────────────────────────────────

  /** Возвращает фазу наблюдения канала. nowMs = текущее реальное время, joinMs = реальное время вступления. */
  getObservationPhase(joinMs: number, nowMs: number): "silent" | "apprentice" | "normal" {
    const elapsedS = (nowMs - joinMs) / 1000;
    if (elapsedS < this.config.silentDurationS) return "silent";
    if (elapsedS < this.config.apprenticeDurationS) return "apprentice";
    return "normal";
  }

  // ── Запись событий ────────────────────────────────────────────────────────────

  recordJoin(): void {
    const now = this._now();
    this.joinTimestamps.push(now);
    this.lastJoinTime = now;
  }

  recordLeave(): void {
    // Пока только заглушка, в будущем можно отслеживать интервал join-leave
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
      // Пробный запрос в half-open провалился → возврат в open
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

  /** Возвращает состояние breaker (для тестов, чистое производное, без мутаций). */
  getBreakerState(action: string): CircuitState {
    const cb = this.getBreaker(action);
    if (cb.state === "open" && this._now() - cb.openedAt >= this.config.circuitBreakerOpenMs) {
      return "half-open";
    }
    return cb.state;
  }

  // ── Внутренние утилиты ────────────────────────────────────────────────────────────

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
