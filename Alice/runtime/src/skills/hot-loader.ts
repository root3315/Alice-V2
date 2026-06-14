/**
 * Горячий загрузчик Skill — регистрация/отмена регистрации действий Skill во время выполнения.
 *
 * Обеспечивает согласованность трёх реестров:
 * 1. TELEGRAM_ACTIONS / TELEGRAM_ACTION_MAP (реестр действий)
 * 2. CAPABILITY_FAMILIES (реестр семейств возможностей)
 * 3. TOOL_CATEGORIES (перечисление категорий)
 *
 * @see docs/adr/201-os-for-llm.md
 */

import {
  type CapabilityFamily,
  registerCapabilityFamily,
  unregisterCapabilityFamily,
} from "../core/capability-families.js";
import {
  registerToolCategory,
  TOOL_CATEGORIES,
  unregisterToolCategory,
} from "../engine/tick/types.js";
import type { TelegramActionDef } from "../telegram/action-types.js";
import { registerAction, unregisterAction } from "../telegram/actions/index.js";
import type { SkillManifest } from "./manifest.js";

/**
 * Горячая загрузка скомпилированного Skill: регистрация действий + семейств возможностей + category.
 *
 * @param actions TelegramActionDef[], полученные от компилятора
 * @param manifest исходный manifest (для извлечения метаданных family)
 */
export function loadSkill(actions: TelegramActionDef[], manifest: SkillManifest): void {
  // 1. Регистрируем categories (чтобы man мог их распознать)
  const categories = new Set<string>();
  for (const action of actions) {
    const cat =
      action.affordance && "category" in action.affordance ? action.affordance.category : undefined;
    if (cat && !TOOL_CATEGORIES.includes(cat)) {
      registerToolCategory(cat);
    }
    if (cat) categories.add(cat);
  }

  // 2. Регистрируем семейство возможностей
  if (manifest.family) {
    // familyCategory позволяет нескольким Skill разделять одно семейство (например, семейство fun)
    const familyCat = manifest.familyCategory ?? manifest.name;
    if (!TOOL_CATEGORIES.includes(familyCat)) {
      registerToolCategory(familyCat);
    }
    registerCapabilityFamily(familyCat, manifest.family as CapabilityFamily);
  }

  // 3. Регистрируем действия
  for (const action of actions) {
    registerAction(action);
  }
}

/**
 * Выгружает Skill: отменяет регистрацию действий + семейств возможностей + category.
 *
 * @param actionNames список имён действий для отмены регистрации
 * @param categories список category для отмены регистрации
 */
export function unloadSkill(actionNames: string[], categories: string[]): void {
  // 1. Отменяем регистрацию действий
  for (const name of actionNames) {
    unregisterAction(name);
  }

  // 2. Отменяем регистрацию семейств возможностей и category
  for (const cat of categories) {
    unregisterCapabilityFamily(cat);
    unregisterToolCategory(cat);
  }
}
