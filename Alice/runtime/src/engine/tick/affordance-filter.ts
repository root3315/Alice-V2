/**
 * Сбор инструментов SAA — собирает видимые LLM инструменты из реестра Mod + Telegram actions.
 *
 * @see docs/adr/142-action-space-architecture/README.md
 */
import type { ModDefinition } from "../../core/types.js";
import type { TelegramActionDef } from "../../telegram/action-types.js";
import type { UnifiedTool } from "./types.js";
import { hasAffordance } from "./types.js";

// ── Сбор ─────────────────────────────────────────────────────────────────

/**
 * Собирает все инструменты с affordance из реестра Mod + Telegram actions в унифицированное представление.
 * Собираются только инструменты, объявившие affordance (внутренние инструкции исключаются автоматически).
 */
export function collectAllTools(
  mods: readonly ModDefinition[],
  telegramActions: readonly TelegramActionDef[],
): UnifiedTool[] {
  const tools: UnifiedTool[] = [];

  // Telegram actions
  for (const def of telegramActions) {
    if (hasAffordance(def)) {
      tools.push({
        name: def.name,
        affordance: def.affordance,
      });
    }
  }

  // Инструкции Mod
  for (const mod of mods) {
    for (const [name, def] of Object.entries(mod.instructions ?? {})) {
      if (hasAffordance(def)) {
        tools.push({
          name,
          affordance: def.affordance,
        });
      }
    }
    // Запросы Mod
    for (const [name, def] of Object.entries(mod.queries ?? {})) {
      if (hasAffordance(def)) {
        tools.push({
          name,
          affordance: def.affordance,
        });
      }
    }
  }

  return tools;
}
