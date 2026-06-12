/**
 * App Toolkit — 统一导出。
 *
 * 每个 App 是纯业务逻辑模块（零框架依赖），
 * action-defs.ts 消费这些函数组装 TelegramActionDef。
 *
 * @see docs/adr/132-app-toolkit.md
 */

export { type CalendarResult, getCalendarData } from "./calendar.js";
export { type CountdownResult, getCountdownData } from "./countdown.js";
export { getPaletteLabels, hasPaletteEntries, resolveLabel } from "./sticker-palette.js";
