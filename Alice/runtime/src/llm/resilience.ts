/**
 * LLM API уровень устойчивости: повторные попытки + экспоненциальная задержка + автоматический выключатель.
 *
 * Тройная защита:
 * 1. Экспоненциальная задержка с повторами (с jitter) — против кратковременных 429/5xx
 * 2. Автоматический выключатель (closed → open → half-open) — быстрый отказ при серии сбоев, предотвращает каскадное обрушение
 * 3. Таймаут AbortSignal — передаётся вызывающей стороной (60s таймаут в act.ts не изменяется)
 *
 * @see docs/adr/02-architecture-overview.md
 */
import { createLogger } from "../utils/logger.js";

const log = createLogger("resilience");

// -- Конфигурация -------------------------------------------------------------------

export interface ResilienceConfig {
  /** Максимальное число повторных попыток (без первого вызова). По умолчанию 2. */
  maxRetries: number;
  /** Базовая задержка отступления (мс). По умолчанию 1000. */
  baseDelay: number;
  /** Максимальная задержка отступления (мс). По умолчанию 15000. */
  maxDelay: number;
  /** Срабатывание автоматического выключателя после N последовательных сбоев. По умолчанию 5. */
  circuitThreshold: number;
  /** Время восстановления автоматического выключателя (мс). По умолчанию 60000. */
  circuitResetMs: number;
}

const DEFAULT_CONFIG: ResilienceConfig = {
  maxRetries: 2,
  baseDelay: 1000,
  maxDelay: 15000,
  circuitThreshold: 5,
  circuitResetMs: 60_000,
};

// -- Автоматический выключатель -----------------------------------------------------------------

export type CircuitState = "closed" | "open" | "half-open";

/** Тип события изменения состояния автоматического выключателя. */
export type BreakerEventType = "open" | "half-open" | "closed";

class CircuitBreaker {
  private state: CircuitState = "closed";
  private consecutiveFailures = 0;
  private lastFailureTime = 0;
  private probing = false; // H10: ровно один probe в half-open (anti thundering-herd)

  constructor(
    private readonly threshold: number,
    private readonly resetMs: number,
    private readonly onStateChange?: (event: BreakerEventType) => void,
  ) {}

  /**
   * Оценка перехода состояний, управляемого временем.
   * open и resetMs истёк → переход в half-open.
   * Вызывается из getState() и allowRequest(), чтобы состояние всегда было синхронно с реальным временем.
   */
  private tick(): void {
    if (this.state === "open" && Date.now() - this.lastFailureTime >= this.resetMs) {
      this.state = "half-open";
      log.info("Circuit breaker → half-open");
      this.onStateChange?.("half-open");
    }
  }

  /** Проверка, разрешён ли пропуск запроса. */
  allowRequest(): boolean {
    this.tick();
    if (this.state === "closed") return true;
    if (this.state === "half-open") {
      if (this.probing) return false; // H10: только один пробный запрос на восстановлении
      this.probing = true;
      return true;
    }
    return false; // open
  }

  /** Регистрация успеха. */
  recordSuccess(): void {
    if (this.state === "open") return; // H9: устаревший in-flight успех не воскрешает open breaker
    if (this.state === "half-open") {
      log.info("Circuit breaker → closed (probe succeeded)");
      this.onStateChange?.("closed");
    }
    this.state = "closed";
    this.consecutiveFailures = 0;
    this.probing = false; // H10
  }

  /** Регистрация сбоя. */
  recordFailure(): void {
    this.consecutiveFailures++;
    this.lastFailureTime = Date.now();
    this.probing = false; // H10: probe завершился → следующий half-open выдаст новый

    if (this.state === "half-open") {
      // Проба не удалась, снова открываем
      this.state = "open";
      log.warn("Circuit breaker → open (probe failed)");
      this.onStateChange?.("open");
      return;
    }

    if (this.state === "closed" && this.consecutiveFailures >= this.threshold) {
      this.state = "open";
      log.warn("Circuit breaker → open", {
        failures: this.consecutiveFailures,
        threshold: this.threshold,
      });
      this.onStateChange?.("open");
    }
  }

  getState(): CircuitState {
    this.tick();
    return this.state;
  }
}

// -- Определение повторяемых ошибок -----------------------------------------------------------

/** Определяет, можно ли повторить попытку при данной ошибке (429, 502, 503, 504, таймаут, сетевая ошибка). */
function isRetryable(error: unknown): boolean {
  if (error instanceof Error) {
    // Таймаут
    if (error.name === "AbortError" || error.name === "TimeoutError") return true;
  }

  const nodeCode = extractErrorCode(error);
  if (nodeCode === "ETIMEDOUT" || nodeCode === "ECONNRESET" || nodeCode === "ECONNREFUSED") {
    return true;
  }

  // HTTP-статус код (Vercel AI SDK и openai SDK оба выставляют status на объекте ошибки)
  const status = extractStatus(error);
  if (status !== null) {
    // 429 Too Many Requests, 502/503/504 серверные ошибки
    return status === 429 || status === 502 || status === 503 || status === 504;
  }

  return false;
}

function extractErrorCode(error: unknown): string | null {
  if (error == null || typeof error !== "object") return null;
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string") return code;
  const cause = (error as { cause?: unknown }).cause;
  return cause ? extractErrorCode(cause) : null;
}

/** Извлекает HTTP-статус из различных форматов ошибок. */
function extractStatus(error: unknown): number | null {
  if (error == null || typeof error !== "object") return null;
  const obj = error as Record<string, unknown>;
  // Vercel AI SDK: APICallError.statusCode, openai SDK: .status
  for (const key of ["statusCode", "status"]) {
    const val = obj[key];
    if (typeof val === "number" && val >= 100 && val < 600) return val;
  }
  // Вложено в cause
  if (obj.cause && typeof obj.cause === "object") {
    return extractStatus(obj.cause);
  }
  return null;
}

// -- Вычисление задержки отступления ---------------------------------------------------------------

/** Экспоненциальная задержка с jitter. */
function backoffDelay(attempt: number, baseDelay: number, maxDelay: number): number {
  const exponential = baseDelay * 2 ** attempt;
  // full jitter: [0, min(exponential, maxDelay)]
  const capped = Math.min(exponential, maxDelay);
  return Math.random() * capped;
}

// -- Экземпляры автоматических выключателей per-provider (ADR-123 §D5) -----------------------------------

const _breakers = new Map<string, CircuitBreaker>();

/** Слушатель изменения состояния автоматического выключателя. */
type BreakerListener = (providerName: string, event: BreakerEventType) => void;
const _breakerListeners: BreakerListener[] = [];

function emitBreakerEvent(name: string, event: BreakerEventType): void {
  for (const listener of _breakerListeners) {
    try {
      listener(name, event);
    } catch (e) {
      log.warn("Breaker listener error", e);
    }
  }
}

/**
 * Регистрация слушателя изменения состояния автоматического выключателя. Вызывается один раз при запуске.
 * @see docs/adr/129-llm-voice-loss-awareness.md
 */
export function onBreakerStateChange(listener: BreakerListener): void {
  _breakerListeners.push(listener);
}

function getBreaker(name: string, config: ResilienceConfig): CircuitBreaker {
  let breaker = _breakers.get(name);
  if (!breaker) {
    breaker = new CircuitBreaker(config.circuitThreshold, config.circuitResetMs, (event) => {
      emitBreakerEvent(name, event);
    });
    _breakers.set(name, breaker);
  }
  return breaker;
}

/** Запрос состояния автоматического выключателя для указанного провайдера (без создания нового экземпляра). */
export function getBreakerState(name: string): CircuitState {
  return _breakers.get(name)?.getState() ?? "closed";
}

/** Сброс всех автоматических выключателей и слушателей (для тестирования). */
export function resetCircuitBreaker(): void {
  _breakers.clear();
  _breakerListeners.length = 0;
}

// -- Публичный API ---------------------------------------------------------------

export class CircuitOpenError extends Error {
  constructor() {
    super("Circuit breaker is open — LLM calls temporarily disabled");
    this.name = "CircuitOpenError";
  }
}

export class ProviderUnavailableError extends Error {
  constructor(readonly cause: unknown) {
    super("LLM provider unavailable after resilience retries");
    this.name = "ProviderUnavailableError";
  }
}

/**
 * Оборачивает асинхронный LLM-вызов в уровень устойчивости.
 *
 * @example
 * ```ts
 * const { object } = await withResilience(() =>
 *   generateObject({ model, schema, system, prompt, temperature: 0.7 })
 * );
 * ```
 */
export async function withResilience<T>(
  fn: () => Promise<T>,
  config: Partial<ResilienceConfig> = {},
  providerName = "default",
): Promise<T> {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const breaker = getBreaker(providerName, cfg);

  // Проверка автоматического выключателя
  if (!breaker.allowRequest()) {
    throw new CircuitOpenError();
  }

  let lastError: unknown;

  for (let attempt = 0; attempt <= cfg.maxRetries; attempt++) {
    try {
      const result = await fn();
      breaker.recordSuccess();
      return result;
    } catch (error) {
      lastError = error;

      // Не повторяемые ошибки бросаются сразу (400, 401, 403 и т.д.)
      if (!isRetryable(error)) {
        breaker.recordFailure();
        throw error;
      }

      // Последняя попытка, повторов больше не будет
      if (attempt === cfg.maxRetries) {
        breaker.recordFailure();
        break;
      }

      // Ожидание с отступлением
      const delay = backoffDelay(attempt, cfg.baseDelay, cfg.maxDelay);
      log.warn("LLM call failed, retrying", {
        attempt: attempt + 1,
        maxRetries: cfg.maxRetries,
        delayMs: Math.round(delay),
        error: error instanceof Error ? error.message : String(error),
      });

      await new Promise((resolve) => setTimeout(resolve, delay));

      // Повторная проверка выключателя перед retry (мог сработать другим вызовом во время ожидания).
      // getState(), а НЕ allowRequest(): этот вызов уже держит probe-слот в half-open;
      // allowRequest() отклонил бы его собственный retry (probing=true) и запер бы breaker (fix H10-регрессии).
      if (breaker.getState() === "open") {
        throw new CircuitOpenError();
      }
    }
  }

  throw new ProviderUnavailableError(lastError);
}
