/**
 * Эфемерный трекер набора текста (typing) — делает «окно дочитывания» (burst settle) живым.
 *
 * Пока собеседник ещё ПЕЧАТАЕТ, Алиса ждёт; отвечает, когда он остановился, видя весь всплеск
 * сообщений целиком — как живой человек. Это уточняет фиксированную паузу BURST_SETTLE_MS:
 * вместо «подожди ровно 1.8с» — «подожди, ПОКА он печатает» (с фиксированной паузой как fallback,
 * когда сигнала typing нет вовсе).
 *
 * Telegram присылает typing-апдейты, действительные ~6с (если новых нет в течение 6с — считается,
 * что собеседник перестал печатать). mtcute разбирает все три TL-конструктора
 * (updateUserTyping / updateChatUserTyping / updateChannelUserTyping) в единый UserTypingUpdate
 * с уже маркированным chatId и статусом "typing" ТОЛЬКО для sendMessageTypingAction
 * (и sendMessageTextDraftAction) — upload/record/sticker и прочее сюда не попадают.
 *
 * Состояние ЭФЕМЕРНО: чистая память процесса, НЕ персистится, теряется при рестарте — это нормально
 * (typing — мимолётный сигнал; после рестарта поведение откатывается к фиксированной паузе, пока не
 * прилетит свежий typing). Никаких побочных эффектов на граф/БД.
 *
 * @see src/engine/react/orchestrator.ts §4b (typing-aware burst settle)
 */

/** Запись о последнем typing в конкретном чате. */
interface TypingEntry {
  /** Настенное время последнего typing-сигнала (мс). */
  lastMs: number;
  /** Кто печатал (stable contactId) — диагностика; для DM это собеседник. */
  userId?: string;
}

/**
 * stableChatId (telegram:channel:<markedId>) → последняя активность набора текста.
 * Эфемерно: только в памяти, не персистится.
 */
const typingByChat = new Map<string, TypingEntry>();

/**
 * Записывает событие набора текста для чата.
 *
 * @param chatId stable chat id (тот же, что targetChannelId в orchestrator: telegram:channel:<markedId>)
 * @param userId stable id печатающего (или null/undefined) — только для диагностики
 * @param nowMs настенное время события (мс)
 */
export function recordTyping(chatId: string, userId: string | null | undefined, nowMs: number): void {
  if (!chatId) return;
  typingByChat.set(chatId, { lastMs: nowMs, userId: userId ?? undefined });
}

/**
 * Время последнего typing в чате (мс) либо undefined, если сигналов не было.
 */
export function lastTypingMs(chatId: string): number | undefined {
  return typingByChat.get(chatId)?.lastMs;
}

/**
 * Печатает ли кто-то в чате прямо сейчас — был ли typing в пределах `withinMs` от `nowMs`.
 *
 * Чистая функция от состояния трекера: окно действия typing-сигнала задаётся вызывающим
 * (Telegram считает typing валидным ~6с). Если сигналов не было — false (тогда orchestrator
 * откатывается к фиксированному поведению burst settle, задержки нет).
 *
 * @param chatId stable chat id
 * @param nowMs текущее настенное время (мс)
 * @param withinMs окно «свежести» typing (мс), например 6000
 */
export function isTyping(chatId: string, nowMs: number, withinMs: number): boolean {
  const last = typingByChat.get(chatId)?.lastMs;
  if (last === undefined) return false;
  return nowMs - last < withinMs;
}

/**
 * Тестовая утилита: полностью очищает эфемерное состояние трекера.
 * Используется только в юнит-тестах для изоляции кейсов (в проде состояние живёт весь процесс).
 */
export function __resetTypingTracker(): void {
  typingByChat.clear();
}
