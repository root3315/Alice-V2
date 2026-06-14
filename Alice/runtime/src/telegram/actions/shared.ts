/**
 * Общие компоненты для определений action.
 *
 * - ALLOWED_REACTIONS + TelegramReactionSchema (потребляет reaction.ts)
 * - Глобальный экземпляр ExplorationGuard (потребляет group.ts)
 * - Вспомогательные функции usageHint (потребляют strategy.mod + тесты)
 */

import { z } from "zod";
import type { ActionCategory, TelegramActionDef } from "../action-types.js";
import { ExplorationGuard } from "../exploration-guard.js";

// ═══════════════════════════════════════════════════════════════════════════
// Белый список реакций Telegram
// ═══════════════════════════════════════════════════════════════════════════

// Белый список emoji-реакций, разрешённых в Telegram (версия 2024, включает часто используемое подмножество Telegram Premium).
// Emoji вне этого списка будут отклонены API ("The specified reaction is invalid.").
// @see https://core.telegram.org/api/reactions
export const ALLOWED_REACTIONS = new Set([
  "👍",
  "👎",
  "❤",
  "🔥",
  "🥰",
  "👏",
  "😁",
  "🤔",
  "🤯",
  "😱",
  "🤬",
  "😢",
  "🎉",
  "🤩",
  "🤮",
  "💩",
  "🙏",
  "👌",
  "🕊",
  "🤡",
  "🥱",
  "🥴",
  "😍",
  "🐳",
  "❤‍🔥",
  "🌚",
  "🌭",
  "💯",
  "🤣",
  "⚡",
  "🍌",
  "🏆",
  "💔",
  "🤨",
  "😐",
  "🍓",
  "🍾",
  "💋",
  "🖕",
  "😈",
  "😴",
  "😭",
  "🤓",
  "👻",
  "👨‍💻",
  "👀",
  "🎃",
  "🙈",
  "😇",
  "😨",
  "🤝",
  "✍",
  "🤗",
  "🫡",
  "🎅",
  "🎄",
  "☃",
  "💅",
  "🤪",
  "🗿",
  "🆒",
  "💘",
  "🙉",
  "🦄",
  "😘",
  "💊",
  "🙊",
  "😎",
  "👾",
  "🤷‍♂",
  "🤷",
  "🤷‍♀",
  "😡",
]);

/** Unicode-нормализация реакции Telegram перед сравнением. */
export function normalizeReactionEmoji(emoji: string): string {
  return emoji.trim().replace(/\uFE0F/g, "");
}

/** Zod schema: coerce + валидация по белому списку. Недопустимые emoji перехватываются на этапе записи в песочницу. */
export const TelegramReactionSchema = z.preprocess(
  (v) => (v == null ? "" : normalizeReactionEmoji(String(v))),
  z.string().refine((s) => ALLOWED_REACTIONS.has(s), {
    message: "Not a valid Telegram reaction emoji",
  }),
);

// ═══════════════════════════════════════════════════════════════════════════
// Глобальный экземпляр ExplorationGuard
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Глобальный охранник исследования. Инициализируется через initExplorationGuard().
 * По умолчанию создаётся экземпляр с настройками по умолчанию (пригоден для тестов и продакшена).
 */
let explorationGuard = new ExplorationGuard();

/**
 * Инициализирует глобальный ExplorationGuard внешней конфигурацией.
 * Вызывается из bootstrap / index.ts после загрузки config.
 */
export function initExplorationGuard(
  config?: Partial<import("../exploration-guard.js").ExplorationConfig>,
): void {
  explorationGuard = new ExplorationGuard(config);
}

/** Заменяет глобальный охранник полным экземпляром ExplorationGuard (только для тестов). */
export function setExplorationGuard(guard: ExplorationGuard): void {
  explorationGuard = guard;
}

/** Возвращает текущий глобальный экземпляр ExplorationGuard. */
export function getExplorationGuard(): ExplorationGuard {
  return explorationGuard;
}

// ═══════════════════════════════════════════════════════════════════════════
// Вспомогательные функции usageHint (для потребления strategy.mod)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Возвращает список usageHint по категории.
 * strategy.mod использует эту функцию для автоматической генерации capability hints
 * вместо жёстко закодированных строк с именами функций (первопричина галлюцинаций QUERY_*).
 *
 * Примечание: функция ссылается на TELEGRAM_ACTIONS, доступный из index.ts после загрузки модуля (безопасно для циклических зависимостей).
 *
 * @see docs/adr/51-m5-interaction-primitives-implementation.md — QUERY_* урок
 */
let _actions: TelegramActionDef[] = [];

/** Вызывается из index.ts, внедряет полный массив action (во избежание циклического импорта). */
export function _setActions(actions: TelegramActionDef[]): void {
  _actions = actions;
}

export function getUsageHintsByCategory(
  category: ActionCategory,
): Array<{ name: string; hint: string }> {
  return _actions
    .filter(
      (def): def is typeof def & { usageHint: string } =>
        def.category === category && typeof def.usageHint === "string",
    )
    .map((def) => ({ name: def.name, hint: def.usageHint }));
}

/**
 * Генерирует объединённый текст hint для указанной категории.
 * Формат: одна строка на action, `name — hint`.
 */
export function renderCategoryHints(category: ActionCategory): string {
  const hints = getUsageHintsByCategory(category);
  if (hints.length === 0) return "";
  return hints.map((h) => `${h.name}: ${h.hint}`).join("\n");
}

/**
 * Генерирует полные capability hints (сгруппированные по категориям).
 * Включает только действия, у которых есть usageHint.
 */
export function renderAllUsageHints(): string {
  const categories: ActionCategory[] = [
    "messaging",
    "reaction",
    "media",
    "sticker",
    "moderation",
    "group",
    "bot",
    "search",
    "account",
    "knowledge",
    "app",
  ];
  const lines: string[] = [];
  for (const cat of categories) {
    const hints = getUsageHintsByCategory(cat);
    if (hints.length === 0) continue;
    lines.push(`[${cat}]`);
    for (const h of hints) {
      lines.push(`  ${h.name}: ${h.hint}`);
    }
  }
  return lines.join("\n");
}
