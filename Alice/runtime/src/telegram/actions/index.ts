/**
 * Telegram 动作聚合入口 — 单一真相来源。
 *
 * 按 category 拆分为独立文件，此处聚合为 TELEGRAM_ACTIONS 数组和 MAP。
 * 排列顺序 = LLM 手册中的展示顺序。
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

/** 全量动作数组（顺序 = LLM 手册展示顺序）。 */
export const TELEGRAM_ACTIONS: TelegramActionDef[] = [
  // ── 基础动作 ──
  ...messagingActions,
  ...reactionActions,
  ...systemChatActions,

  // ── M2: 行动空间扩展 ──
  ...stickerActions,
  ...moderationActions,

  // ── M5: 行动空间全量扩展 ──
  ...mediaActions,
  ...groupActions,
  ...botActions,
  ...searchActions,

  // ── 账户管理 + 收藏夹 ──
  ...accountActions,

  // ── ADR-132: App Toolkit ──
  ...appActions,
];

// 注入 actions 给 shared.ts 的 hint helpers（避免循环导入）
_setActions(TELEGRAM_ACTIONS);

/** O(1) 名称查找表（由 action-executor 使用）。 */
export const TELEGRAM_ACTION_MAP = new Map<string, TelegramActionDef>(
  TELEGRAM_ACTIONS.map((def) => [def.name, def]),
);

// ═══════════════════════════════════════════════════════════════════════════
// 热加载 API — Skill 包管理器调用
// @see src/skills/hot-loader.ts
// @see docs/adr/201-os-for-llm.md
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 运行时注册动作（热加载）。
 * Skill 编译器产出 TelegramActionDef 后通过此函数注入。
 */
export function registerAction(def: TelegramActionDef): void {
  // 幂等：已存在则先移除
  unregisterAction(def.name);
  TELEGRAM_ACTIONS.push(def);
  TELEGRAM_ACTION_MAP.set(def.name, def);
  // 重新注入 shared.ts（hint helpers 需要更新的 actions 列表）
  _setActions(TELEGRAM_ACTIONS);
}

/**
 * 运行时注销动作。
 */
export function unregisterAction(name: string): void {
  const idx = TELEGRAM_ACTIONS.findIndex((a) => a.name === name);
  if (idx >= 0) {
    TELEGRAM_ACTIONS.splice(idx, 1);
    _setActions(TELEGRAM_ACTIONS);
  }
  TELEGRAM_ACTION_MAP.delete(name);
}

// re-export shared（保持消费者的导入路径简洁）
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
