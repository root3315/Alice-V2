/**
 * DeliberationState — рабочая память конвейера evolve (средний временной масштаб).
 *
 * Заполняет пробел между тремя временными масштабами:
 * - Медленный (дни-недели): WorldModel (социальный граф, память, отношения)
 * - Средний (несколько tick, внутри интерактивного фрагмента): DeliberationState (усталость голоса, накопление тишины, сохранение импульсов) ← этот модуль
 * - Быстрый (один tick): чистая функция computeTickPlan
 *
 * Ограничения проектирования:
 * - Не нарушает контракт чистой функции computeTickPlan — DeliberationState является частью входных данных
 * - Все обновления состояния выполняются в applyPlan — граница побочных эффектов не меняется
 * - Не сохраняется в БД — живёт только в рамках жизненного цикла процесса (обнуляется при перезапуске, соответствует семантике «рабочей памяти»)
 *
 * @see docs/adr/75-deliberation-state/75-deliberation-state.md
 * @see paper-five-dim/ Eq. voice-fatigue: φ_v(n) = min(1, (n - n_v^last) / K_v)
 * @see paper-pomdp/ Def 5.3: VoI(null)
 */

import type { VoiceAction } from "../voices/personality.js";

// ═══════════════════════════════════════════════════════════════════════════
// Типы
// ═══════════════════════════════════════════════════════════════════════════

/** Подавленный, но ценный импульс к действию (переносится между tick). */
export interface PendingImpulse {
  /** Тип голосового действия. */
  action: VoiceAction;
  /** ID целевой сущности. */
  target: string;
  /** Net Social Value на момент создания. */
  netValue: number;
  /** Tick, на котором возник импульс. */
  originTick: number;
  /** ADR-110: Настенное время возникновения импульса (мс). */
  originMs: number;
  /** Множитель затухания netValue за каждый tick (0, 1). */
  decay: number;
  /**
   * Эмоциональная значимость [0, 1].
   * Импульсы с высоким salience затухают медленнее (decay = 0.7 + 0.15 × salience).
   * По умолчанию 0 (деградирует до IMPULSE_DEFAULT_DECAY).
   * @see docs/adr/151-algorithm-audit/priority-ranking.md #3
   */
  salience: number;
}

/**
 * DeliberationState — межтиковая рабочая память конвейера evolve.
 *
 * Жизненный цикл: в рамках процесса (без сохранения). Обнуляется при перезапуске.
 */
export interface DeliberationState {
  // ── Усталость голоса — Eq. voice-fatigue из статьи ──
  /** ADR-110: Настенное время последней победы каждого голоса (мс). */
  voiceLastWon: Record<VoiceAction, number>;

  // ── Сохранение импульсов — удержание Inner Thoughts ──
  /** Кандидаты с высоким V, подавленные VoI/gate, переносятся между tick. */
  pendingImpulses: PendingImpulse[];

  // ── Отслеживание тишины ──
  /** Причина последней тишины (строка gate reason). */
  lastSilenceReason: string | null;

  // ── Родословная действий — контекст принятия решения для последнего действия ──
  /** Снимок обдумывания последнего фактически выполненного действия. */
  lastDeliberation: {
    voice: VoiceAction;
    target: string | null;
    netValue: number;
    tick: number;
  } | null;
}

// ═══════════════════════════════════════════════════════════════════════════
// Константы
// ═══════════════════════════════════════════════════════════════════════════

/**
 * ADR-110: Окно охлаждения голоса (секунды).
 *
 * После победы голоса требуется K_v секунд для полного восстановления громкости.
 * По умолчанию 300 секунд (5 минут) — примерно длина короткого разговора.
 *
 * @see paper-five-dim/ Eq. voice-fatigue: φ_v = min(1, elapsedS / K_v)
 */
export const DEFAULT_VOICE_COOLDOWN = 300;

/**
 * ADR-110: Максимальный TTL сохранения импульса (миллисекунды).
 * Импульсы старше этого срока автоматически отбрасываются. 300_000 мс = 5 минут.
 */
export const IMPULSE_MAX_TTL_MS = 300_000;

/**
 * Максимальное количество сохраняемых импульсов.
 * Предотвращает бесконечное накопление.
 */
export const IMPULSE_MAX_COUNT = 3;

/**
 * Минимальный порог V для добавления импульса в очередь.
 * Кандидаты с V ниже этого значения не стоят переноса между tick.
 */
export const IMPULSE_MIN_VALUE = 0.05;

/**
 * Множитель затухания импульса по умолчанию за каждый tick.
 * 0.7 означает, что после 3 tick V снижается до 34%.
 */
export const IMPULSE_DEFAULT_DECAY = 0.7;

/**
 * Максимальное увеличение множителя затухания за счёт salience.
 * decay = IMPULSE_DEFAULT_DECAY + IMPULSE_SALIENCE_DECAY_BOOST × salience
 * salience=0 → decay=0.7, salience=1 → decay=0.85 (период полураспада ~4.3 tick).
 * @see docs/adr/151-algorithm-audit/priority-ranking.md #3
 */
export const IMPULSE_SALIENCE_DECAY_BOOST = 0.15;

/**
 * ADR-189: Скорость затухания VoI(null) по настенному времени (в секунду).
 *
 * VoI_effective = VoI_raw / (1 + silenceDurationS × rate)
 *
 * Калибровка: 0.15 за patrol-tick / 60 с за patrol-tick = 0.0025 в секунду.
 * Смысл: после 60 с тишины затухание ~0.87, после 300 с ~0.57.
 * Эквивалентно старому поведению в режиме patrol, но в режиме conversation (tick 3 с) затухание больше не происходит слишком быстро.
 *
 * @see paper-pomdp/ Def 5.3: VoI(null)
 */
export const SILENCE_VOI_DECAY_RATE = 0.0025;

// ═══════════════════════════════════════════════════════════════════════════
// Фабрика
// ═══════════════════════════════════════════════════════════════════════════

/** Создаёт пустой DeliberationState (используется при запуске процесса). */
export function createDeliberationState(): DeliberationState {
  const voiceLastWon: Record<VoiceAction, number> = {
    diligence: -Infinity,
    curiosity: -Infinity,
    sociability: -Infinity,
    caution: -Infinity,
  };
  return {
    voiceLastWon,
    pendingImpulses: [],
    lastSilenceReason: null,
    lastDeliberation: null,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Функции обновления (вызываются в applyPlan)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Обновляет состояние deliberation при постановке действия в очередь.
 *
 * - Записывает tick победившего голоса (усталость голоса)
 * - Сбрасывает счётчик последовательной тишины
 * - Записывает родословную действия
 * - Удаляет из pendingImpulses импульсы, соответствующие данному target (уже выполнены)
 */
export function onActionEnqueued(
  state: DeliberationState,
  tick: number,
  voice: VoiceAction,
  target: string | null,
  netValue: number,
  nowMs: number = Date.now(),
): void {
  state.voiceLastWon[voice] = nowMs;
  state.lastSilenceReason = null;
  state.lastDeliberation = { voice, target, netValue, tick };
  // Удаляем выполненные импульсы (совпадение по target или по voice+target)
  state.pendingImpulses = state.pendingImpulses.filter(
    (imp) => !(imp.target === target && imp.action === voice),
  );
}

/**
 * Обновляет состояние deliberation при тишине.
 *
 * - Увеличивает счётчик последовательной тишины
 * - Записывает причину тишины
 * - Затухает netValue в pendingImpulses, отбрасывает устаревшие импульсы
 */
export function onSilence(
  state: DeliberationState,
  _tick: number,
  reason: string,
  nowMs: number = Date.now(),
): void {
  state.lastSilenceReason = reason;
  // ADR-110: Затухание + отбраковка (используется настенный TTL)
  state.pendingImpulses = state.pendingImpulses
    .map((imp) => ({ ...imp, netValue: imp.netValue * imp.decay }))
    .filter(
      (imp) => imp.netValue >= IMPULSE_MIN_VALUE && nowMs - imp.originMs < IMPULSE_MAX_TTL_MS,
    );
}

/**
 * Добавляет подавленного высокоценного кандидата в очередь сохранения импульсов.
 *
 * Вызывается когда: VoI-deferred или gate-rejected, но V > IMPULSE_MIN_VALUE.
 *
 * Модуляция salience: decay = 0.7 + 0.15 × (salience ?? 0).
 * Импульсы с высокой эмоциональной значимостью затухают медленнее и дольше сохраняются в рабочей памяти.
 * @see docs/adr/151-algorithm-audit/priority-ranking.md #3
 */
export function addImpulse(
  state: DeliberationState,
  impulse: Omit<PendingImpulse, "decay" | "salience" | "originMs"> & {
    originMs?: number;
    salience?: number;
  },
): void {
  if (impulse.netValue < IMPULSE_MIN_VALUE) return;
  const salience = Math.max(0, Math.min(1, impulse.salience ?? 0));
  const decay = IMPULSE_DEFAULT_DECAY + IMPULSE_SALIENCE_DECAY_BOOST * salience;
  // Дедупликация: для одинакового action+target оставляем только последний
  state.pendingImpulses = state.pendingImpulses.filter(
    (imp) => !(imp.action === impulse.action && imp.target === impulse.target),
  );
  state.pendingImpulses.push({
    ...impulse,
    originMs: impulse.originMs ?? Date.now(),
    salience,
    decay,
  });
  // Ограничение ёмкости: оставляем с наибольшим V
  if (state.pendingImpulses.length > IMPULSE_MAX_COUNT) {
    state.pendingImpulses.sort((a, b) => b.netValue - a.netValue);
    state.pendingImpulses = state.pendingImpulses.slice(0, IMPULSE_MAX_COUNT);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Расчёт усталости голоса (используется в loudness.ts)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * ADR-110: Вычисляет коэффициент усталости голоса φ_v (на основе настенного времени).
 *
 * φ_v = min(1, elapsedS / K_v)
 *
 * - φ_v = 0: только что победил, полная усталость
 * - φ_v = 1: восстановился, усталости нет
 *
 * @param nowMs - текущее настенное время (мс)
 * @param voiceLastWonMs - настенное время последней победы голоса (мс)
 * @param cooldown - окно охлаждения K_v (секунды)
 * @returns коэффициент усталости в диапазоне [0, 1]
 *
 * @see paper-five-dim/ Eq. voice-fatigue
 */
export function voiceFatigue(
  nowMs: number,
  voiceLastWonMs: number,
  cooldown: number = DEFAULT_VOICE_COOLDOWN,
): number {
  if (voiceLastWonMs === -Infinity) return 1; // Нет истории → нет усталости
  const elapsedS = (nowMs - voiceLastWonMs) / 1000;
  if (elapsedS <= 0) return 0; // Одновременно → полная усталость
  return Math.min(1, elapsedS / Math.max(cooldown, 1));
}
