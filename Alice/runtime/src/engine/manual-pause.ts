/**
 * Ручная пауза (owner-панель: /pause N, /resume в ЛС владельца).
 *
 * Пока nowMs < pausedUntilMs, FSM режимов (transitionMode в evolve.ts) принудительно
 * держит Алису в dormant: перцепция и память живут, но инициатива/действия спят —
 * как ночное тихое окно, только по команде владельца. Directed-сообщение близкого
 * контакта (в т.ч. самого владельца) по-прежнему может разбудить её на ответ —
 * пауза глушит САМОинициативу, а не прямое обращение.
 *
 * Состояние в памяти процесса: рестарт движка = автоматический resume (честно и просто).
 */

let _pausedUntilMs = 0;

/** Поставить паузу до указанного момента (wall-clock, мс). */
export function setManualPause(untilMs: number): void {
  _pausedUntilMs = Math.max(0, untilMs);
}

/** Снять паузу (/resume). */
export function clearManualPause(): void {
  _pausedUntilMs = 0;
}

/** До какого момента пауза (0 = не активна). */
export function manualPauseUntil(): number {
  return _pausedUntilMs;
}

/** Активна ли ручная пауза сейчас. */
export function isManuallyPaused(nowMs: number): boolean {
  return nowMs < _pausedUntilMs;
}
