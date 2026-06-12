/**
 * app 类别动作 — 全部已迁移为 Skill CLI 脚本。
 *
 * 迁移清单：
 * - use_calendar_app → runtime/skills/calendar/
 * - use_countdown_app → runtime/skills/countdown/
 * - use_selfcheck_app → runtime/skills/selfcheck/
 * - google → runtime/skills/google/
 * - visit → runtime/skills/visit/
 * - repeat_message → runtime/skills/repeat-message/
 *
 * @see docs/adr/132-app-toolkit.md
 * @see docs/adr/202-engine-api.md
 */

import type { TelegramActionDef } from "../action-types.js";

export const appActions: TelegramActionDef[] = [];
