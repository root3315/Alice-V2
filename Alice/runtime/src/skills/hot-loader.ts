/**
 * Skill 热加载器 — 运行时注册/注销 Skill 动作。
 *
 * 协调三个注册中心的一致性：
 * 1. TELEGRAM_ACTIONS / TELEGRAM_ACTION_MAP（动作注册表）
 * 2. CAPABILITY_FAMILIES（能力族注册表）
 * 3. TOOL_CATEGORIES（category 枚举）
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
 * 热加载编译后的 Skill：注册动作 + 能力族 + category。
 *
 * @param actions 编译器产出的 TelegramActionDef[]
 * @param manifest 原始 manifest（提取 family 元数据）
 */
export function loadSkill(actions: TelegramActionDef[], manifest: SkillManifest): void {
  // 1. 注册 categories（确保 man 能识别）
  const categories = new Set<string>();
  for (const action of actions) {
    const cat =
      action.affordance && "category" in action.affordance ? action.affordance.category : undefined;
    if (cat && !TOOL_CATEGORIES.includes(cat)) {
      registerToolCategory(cat);
    }
    if (cat) categories.add(cat);
  }

  // 2. 注册能力族
  if (manifest.family) {
    // familyCategory 允许多个 Skill 共享同一能力族（如 fun 族）
    const familyCat = manifest.familyCategory ?? manifest.name;
    if (!TOOL_CATEGORIES.includes(familyCat)) {
      registerToolCategory(familyCat);
    }
    registerCapabilityFamily(familyCat, manifest.family as CapabilityFamily);
  }

  // 3. 注册动作
  for (const action of actions) {
    registerAction(action);
  }
}

/**
 * 卸载 Skill：注销动作 + 能力族 + category。
 *
 * @param actionNames 要注销的动作名列表
 * @param categories 要注销的 category 列表
 */
export function unloadSkill(actionNames: string[], categories: string[]): void {
  // 1. 注销动作
  for (const name of actionNames) {
    unregisterAction(name);
  }

  // 2. 注销能力族和 category
  for (const cat of categories) {
    unregisterCapabilityFamily(cat);
    unregisterToolCategory(cat);
  }
}
