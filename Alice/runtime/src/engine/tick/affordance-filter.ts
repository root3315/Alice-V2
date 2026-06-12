/**
 * SAA 工具收集 — 从 Mod 注册表 + Telegram actions 收集 LLM 可见工具。
 *
 * @see docs/adr/142-action-space-architecture/README.md
 */
import type { ModDefinition } from "../../core/types.js";
import type { TelegramActionDef } from "../../telegram/action-types.js";
import type { UnifiedTool } from "./types.js";
import { hasAffordance } from "./types.js";

// ── 收集 ─────────────────────────────────────────────────────────────────

/**
 * 从 Mod 注册表 + Telegram actions 收集所有带 affordance 的工具到统一视图。
 * 只有声明了 affordance 的工具才会被收集（内部指令自然被排除）。
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

  // Mod instructions
  for (const mod of mods) {
    for (const [name, def] of Object.entries(mod.instructions ?? {})) {
      if (hasAffordance(def)) {
        tools.push({
          name,
          affordance: def.affordance,
        });
      }
    }
    // Mod queries
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
