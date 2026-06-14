/**
 * Точка агрегации действий Telegram — единственный источник истины.
 *
 * Разбито по category на отдельные файлы; здесь агрегируется в массив TELEGRAM_ACTIONS и MAP.
 * Порядок следования = порядок отображения в справочнике LLM.
 *
 * @see docs/adr/149-define-action-builder.md
 */

import type { TelegramActionDef } from "../action-types.js";
import { accountActions } from "./account.js";
import { appActions } from "./app.js";
import { botActions } from "./bot.js";
import { groupActions } from "./group.js";
import { mediaActions } from "./media.js";
import { messagingActions } from "./messaging.js";
import { moderationActions } from "./moderation.js";
import { reactionActions } from "./reaction.js";
import { searchActions } from "./search.js";
import { _setActions } from "./shared.js";
import { stickerActions } from "./sticker.js";
import { systemChatActions } from "./system-chat.js";

/** Полный массив действий (порядок = порядок отображения в справочнике LLM). */
export const TELEGRAM_ACTIONS: TelegramActionDef[] = [
  // ── Базовые действия ──
  ...messagingActions,
  ...reactionActions,
  ...systemChatActions,

  // ── M2: расширение пространства действий ──
  ...stickerActions,
  ...moderationActions,

  // ── M5: полное расширение пространства действий ──
  ...mediaActions,
  ...groupActions,
  ...botActions,
  ...searchActions,

  // ── Управление аккаунтом + избранное ──
  ...accountActions,

  // ── ADR-132: App Toolkit ──
  ...appActions,
];

// Передаём actions в hint-хелперы shared.ts (во избежание циклических импортов)
_setActions(TELEGRAM_ACTIONS);

/** Таблица поиска по имени за O(1) (используется action-executor). */
export const TELEGRAM_ACTION_MAP = new Map<string, TelegramActionDef>(
  TELEGRAM_ACTIONS.map((def) => [def.name, def]),
);

// ═══════════════════════════════════════════════════════════════════════════
// API горячей перезагрузки — вызывается менеджером пакетов Skill
// @see src/skills/hot-loader.ts
// @see docs/adr/201-os-for-llm.md
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Регистрация действия в рантайме (горячая загрузка).
 * Вызывается после того, как компилятор Skill выдаёт TelegramActionDef.
 */
export function registerAction(def: TelegramActionDef): void {
  // Идемпотентно: если уже существует — сначала удаляем
  unregisterAction(def.name);
  TELEGRAM_ACTIONS.push(def);
  TELEGRAM_ACTION_MAP.set(def.name, def);
  // Повторно передаём в shared.ts (hint-хелперам нужен актуальный список actions)
  _setActions(TELEGRAM_ACTIONS);
}

/**
 * Отмена регистрации действия в рантайме.
 */
export function unregisterAction(name: string): void {
  const idx = TELEGRAM_ACTIONS.findIndex((a) => a.name === name);
  if (idx >= 0) {
    TELEGRAM_ACTIONS.splice(idx, 1);
    _setActions(TELEGRAM_ACTIONS);
  }
  TELEGRAM_ACTION_MAP.delete(name);
}

// re-export shared (чтобы пути импорта у потребителей оставались короткими)
export {
  ALLOWED_REACTIONS,
  getExplorationGuard,
  getUsageHintsByCategory,
  initExplorationGuard,
  renderAllUsageHints,
  renderCategoryHints,
  setExplorationGuard,
  TelegramReactionSchema,
} from "./shared.js";
