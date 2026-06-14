/**
 * Действия категории app — все перенесены в скрипты Skill CLI.
 *
 * Список миграций:
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
