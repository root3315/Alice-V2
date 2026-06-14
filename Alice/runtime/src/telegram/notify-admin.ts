/**
 * Уведомления администратора — инфраструктурные оповещения напрямую в Telegram Saved Messages.
 *
 * Минует LLM и ActionQueue, отправляет sendText прямо в избранное Alice.
 * Дебаунс: один и тот же тип события — не чаще одного раза в 5 минут.
 *
 * @see docs/adr/129-llm-voice-loss-awareness.md
 */
import type { TelegramClient } from "@mtcute/node";
import { createLogger } from "../utils/logger.js";
import { sendText } from "./actions.js";

const log = createLogger("notify-admin");

/** Период дебаунса (мс). Один и тот же тип события — не чаще одного раза в 5 минут. */
const DEBOUNCE_MS = 5 * 60 * 1000;

const _lastSent = new Map<string, number>();

export interface AdminNotifyContext {
  client: TelegramClient;
}

let _ctx: AdminNotifyContext | null = null;

/** Инициализация при запуске. */
export function initAdminNotify(ctx: AdminNotifyContext): void {
  _ctx = ctx;
  log.info("Admin notify initialized (target: Saved Messages)");
}

/**
 * Отправляет инфраструктурное оповещение в Saved Messages. Дебаунс: 5 минут на один eventKey.
 * Ошибки отправки игнорируются молча — оповещение не должно вызывать вторичные сбои.
 */
export async function notifyAdmin(eventKey: string, message: string): Promise<void> {
  if (!_ctx) return;

  const now = Date.now();
  const lastTime = _lastSent.get(eventKey) ?? 0;
  if (now - lastTime < DEBOUNCE_MS) {
    log.debug("Admin notify debounced", { eventKey });
    return;
  }

  _lastSent.set(eventKey, now);
  try {
    // "me" = Saved Messages (избранное самой Alice) — не беспокоим личный чат admin'а
    await sendText(_ctx.client, "me", `⚠ ${message}`);
    log.info("Admin notified (Saved Messages)", { eventKey });
  } catch (e) {
    log.warn("Admin notify failed (silent)", { eventKey, error: e });
  }
}

/** Сбрасывает состояние дебаунса и контекст (для тестов). */
export function resetAdminNotify(): void {
  _lastSent.clear();
  _ctx = null;
}
