/**
 * Admin 通知 — 基础设施级告警直发 Telegram Saved Messages。
 *
 * 不走 LLM，不走 ActionQueue，直接 sendText 到 Alice 自己的收藏夹。
 * 防抖：同一事件类型冷却 5 分钟。
 *
 * @see docs/adr/129-llm-voice-loss-awareness.md
 */
import type { TelegramClient } from "@mtcute/node";
import { createLogger } from "../utils/logger.js";
import { sendText } from "./actions.js";

const log = createLogger("notify-admin");

/** 防抖冷却（ms）。同一事件类型 5 分钟内只发一次。 */
const DEBOUNCE_MS = 5 * 60 * 1000;

const _lastSent = new Map<string, number>();

export interface AdminNotifyContext {
  client: TelegramClient;
}

let _ctx: AdminNotifyContext | null = null;

/** 启动时初始化。 */
export function initAdminNotify(ctx: AdminNotifyContext): void {
  _ctx = ctx;
  log.info("Admin notify initialized (target: Saved Messages)");
}

/**
 * 发送基础设施告警到 Saved Messages。防抖：同 eventKey 冷却 5 分钟。
 * 发送失败静默忽略——告警不应引起二次故障。
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
    // "me" = Saved Messages（Alice 自己的收藏夹），不打扰 admin 私聊
    await sendText(_ctx.client, "me", `⚠ ${message}`);
    log.info("Admin notified (Saved Messages)", { eventKey });
  } catch (e) {
    log.warn("Admin notify failed (silent)", { eventKey, error: e });
  }
}

/** 重置防抖状态和上下文（用于测试）。 */
export function resetAdminNotify(): void {
  _lastSent.clear();
  _ctx = null;
}
