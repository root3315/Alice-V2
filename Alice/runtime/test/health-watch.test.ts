import { describe, it, expect } from "vitest";
import { ALERT_COOLDOWN_MS, shouldAlert } from "../src/mods/health-watch.mod.js";

const err = (type: string) =>
  ({ level: "error", type, message: `${type} problem`, tick: 1 }) as any;
const warn = (type: string) => ({ level: "warn", type, message: `${type}`, tick: 1 }) as any;
const NOW = 1_700_000_000_000;

describe("health-watch: shouldAlert (анти-спам)", () => {
  it("warn-уровень → НЕ алёртим (только реальные error)", () => {
    expect(shouldAlert(warn("pressure_dead"), {}, [], NOW)).toBe(false);
    expect(shouldAlert(warn("api_stagnant"), {}, [], NOW)).toBe(false);
  });

  it("новая error-аномалия → алёртим", () => {
    expect(shouldAlert(err("api_overflow"), {}, [], NOW)).toBe(true);
  });

  it("тот же тип в пределах кулдауна → НЕ алёртим", () => {
    const alerted = { api_overflow: NOW - 60_000 }; // минуту назад
    expect(shouldAlert(err("api_overflow"), alerted, [], NOW)).toBe(false);
  });

  it("тот же тип ПОСЛЕ кулдауна → снова алёртим", () => {
    const alerted = { api_overflow: NOW - ALERT_COOLDOWN_MS - 1 };
    expect(shouldAlert(err("api_overflow"), alerted, [], NOW)).toBe(true);
  });

  it("тип уже в pending → НЕ дублируем", () => {
    const pending = [{ type: "api_overflow", message: "x", ts: NOW, directed: false }];
    expect(shouldAlert(err("api_overflow"), {}, pending, NOW)).toBe(false);
  });

  it("разные типы независимы (кулдаун одного не глушит другой)", () => {
    const alerted = { api_overflow: NOW };
    expect(shouldAlert(err("action_failure_rate"), alerted, [], NOW)).toBe(true);
  });
});
