/**
 * App Toolkit — единая точка экспорта.
 *
 * Каждый App — чистый модуль бизнес-логики (без зависимостей от фреймворка);
 * action-defs.ts потребляет эти функции для сборки TelegramActionDef.
 *
 * @see docs/adr/132-app-toolkit.md
 */

export { type CalendarResult, getCalendarData } from "./calendar.js";
export { type CountdownResult, getCountdownData } from "./countdown.js";
export { getPaletteLabels, hasPaletteEntries, resolveLabel } from "./sticker-palette.js";
