/**
 * ADR-132: App Toolkit 单元测试。
 *
 * Wave 1: clock / calendar / dice / countdown / browser
 * Wave 2: weather / trending
 * Wave 3: calendar 文化增强 / music
 *
 * @see docs/adr/132-app-toolkit.md
 */

import { describe, expect, it, vi } from "vitest";
import { TELEGRAM_ACTION_MAP } from "../src/telegram/actions/index.js";
import { _DATA_SIZE, getCalendarData } from "../src/telegram/apps/calendar.js";
import { getCountdownData } from "../src/telegram/apps/countdown.js";

// Mock telegram/actions.js — 模块加载需要
vi.mock("../src/telegram/actions.js", () => ({
  sendText: vi.fn(),
  markRead: vi.fn(),
  sendReaction: vi.fn(),
  editMessage: vi.fn(),
  forwardMessage: vi.fn(),
  sendSticker: vi.fn(),
  pinMessage: vi.fn(),
  sendMedia: vi.fn(),
  deleteMessages: vi.fn(),
  joinChat: vi.fn(),
  leaveChat: vi.fn(),
  unpinMessage: vi.fn(),
  getCallbackAnswer: vi.fn(),
  getInlineBotResults: vi.fn(),
  sendInlineBotResult: vi.fn(),
  getInstalledStickers: vi.fn(),
  getStickerSet: vi.fn(),
  searchMessages: vi.fn(),
  searchGlobal: vi.fn(),
  searchPublicChats: vi.fn(),
  getChatPreview: vi.fn(),
  getSimilarChannels: vi.fn(),
  getBotCommands: vi.fn(),
  readSavedMessages: vi.fn(),
  exaFetch: vi.fn(),
  sendVoice: vi.fn(),
  updateProfile: vi.fn(),
  sendPoll: vi.fn(),
  createInviteLink: vi.fn(),
}));

// ═══════════════════════════════════════════════════════════════════════════
// use_calendar_app（纯函数测试 — 已迁移为 Skill CLI 脚本）
// @see runtime/skills/calendar/
// ═══════════════════════════════════════════════════════════════════════════

describe("use_calendar_app (pure function)", () => {
  it("默认返回今天的日历", () => {
    const data = getCalendarData("", 8);
    expect(data.gregorian).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(data.weekday).toMatch(/^星期/);
    expect(data.lunar).toBeTruthy();
    expect(Array.isArray(data.holidays)).toBe(true);
  });

  it("可选 date 参数返回指定日期", () => {
    const data = getCalendarData("2026-01-01", 8);
    expect(data.gregorian).toBe("2026-01-01");
    expect(data.weekday).toBe("星期四");
  });

  it("春节检测正确（2026-02-17 = 农历正月初一）", () => {
    const data = getCalendarData("2026-02-17", 8);
    expect(data.lunar).toContain("初一");
    expect(data.holidays.some((h: string) => h.includes("春节"))).toBe(true);
  });

  it("节气检测正确（2026-02-18 = 雨水）", () => {
    const data = getCalendarData("2026-02-18", 8);
    expect(data.solarTerm).toBe("雨水");
  });

  it("无节气时 solarTerm 为 null", () => {
    const data = getCalendarData("2026-03-01", 8);
    expect(data.solarTerm).toBeNull();
  });

  it("黄历宜忌非空", () => {
    const data = getCalendarData("2026-02-19", 8);
    expect(data.recommends.length).toBeGreaterThan(0);
    expect(data.avoids.length).toBeGreaterThan(0);
  });

  it("节气日返回 solarTermPoem", () => {
    const data = getCalendarData("2026-02-18", 8);
    expect(data.solarTerm).toBe("雨水");
    expect(data.solarTermPoem).not.toBeNull();
    expect(data.solarTermPoem).toContain("杜甫");
  });

  it("非节气日 solarTermPoem 为 null", () => {
    const data = getCalendarData("2026-03-01", 8);
    expect(data.solarTermPoem).toBeNull();
  });

  it("历史上的今天命中", () => {
    const data = getCalendarData("2026-02-19", 8);
    expect(data.todayInHistory).not.toBeNull();
    expect(data.todayInHistory).toContain("哥白尼");
  });

  it("历史上的今天未命中", () => {
    const data = getCalendarData("2026-01-02", 8);
    expect(data.todayInHistory).toBeNull();
  });

  it("includes time fields from clock absorption", () => {
    const data = getCalendarData("", 8);
    expect(data).toHaveProperty("datetime");
    expect(data).toHaveProperty("timezone");
    expect(data).toHaveProperty("period");
    expect(typeof data.datetime).toBe("string");
    expect(typeof data.timezone).toBe("string");
    expect(["凌晨", "上午", "下午", "晚上"]).toContain(data.period);
  });

  it("精选数据集覆盖 ≥ 200 条目", () => {
    expect(_DATA_SIZE.todayInHistory).toBeGreaterThanOrEqual(200);
    expect(_DATA_SIZE.solarTermPoems).toBe(24);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// use_countdown_app（纯函数测试 — 已迁移为 Skill CLI 脚本）
// @see runtime/skills/countdown/
// ═══════════════════════════════════════════════════════════════════════════

describe("use_countdown_app (pure function)", () => {
  it("未来日期返回正天数", () => {
    const futureDate = new Date();
    futureDate.setFullYear(futureDate.getFullYear() + 1);
    const dateStr = futureDate.toISOString().slice(0, 10);
    const data = getCountdownData(dateStr, 8);
    expect(data).not.toBeNull();
    // biome-ignore lint/style/noNonNullAssertion: guarded by preceding toBeNull check
    expect(data!.days).toBeGreaterThan(0);
  });

  it("过去日期返回负天数", () => {
    const data = getCountdownData("2020-01-01", 8);
    expect(data).not.toBeNull();
    // biome-ignore lint/style/noNonNullAssertion: guarded by preceding toBeNull check
    expect(data!.days).toBeLessThan(0);
  });

  it("包含目标日期的星期几", () => {
    const data = getCountdownData("2026-02-19", 8);
    expect(data).not.toBeNull();
    // biome-ignore lint/style/noNonNullAssertion: guarded by test assertion
    expect(data!.weekday).toBe("星期四");
  });

  it("无效日期返回 null", () => {
    const data = getCountdownData("invalid", 8);
    expect(data).toBeNull();
  });

  it("缺失 date 参数返回 null", () => {
    const data = getCountdownData("", 8);
    expect(data).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// google + visit — 已迁移为 Skill CLI 脚本
// @see runtime/skills/google/, runtime/skills/visit/
// ═══════════════════════════════════════════════════════════════════════════

describe("google + visit (migrated to Skill CLI)", () => {
  it("TELEGRAM_ACTION_MAP 不再包含 google（已迁移为 Skill CLI）", () => {
    expect(TELEGRAM_ACTION_MAP.has("google")).toBe(false);
  });

  it("TELEGRAM_ACTION_MAP 不再包含 visit（已迁移为 Skill CLI）", () => {
    expect(TELEGRAM_ACTION_MAP.has("visit")).toBe(false);
  });

  it("TELEGRAM_ACTION_MAP 不再包含 use_browser_app", () => {
    expect(TELEGRAM_ACTION_MAP.has("use_browser_app")).toBe(false);
  });
});
