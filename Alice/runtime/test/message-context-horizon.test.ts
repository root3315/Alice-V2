import { describe, expect, it } from "vitest";
import { resolveContextHorizonMs } from "../src/engine/act/messages.js";

describe("message context horizon", () => {
  it("channel 不受 group 48h 地平线约束", () => {
    expect(resolveContextHorizonMs(-1001374920454, "channel")).toBeNull();
  });

  it("group 和 supergroup 保持 48h", () => {
    expect(resolveContextHorizonMs(-1001, "group")).toBe(48 * 3600_000);
    expect(resolveContextHorizonMs(-1002, "supergroup")).toBe(48 * 3600_000);
  });

  it("private 保持 7d", () => {
    expect(resolveContextHorizonMs(123456, "private")).toBe(7 * 24 * 3600_000);
  });

  it("未知 chatType 时回退到原有 chatId 符号启发式", () => {
    expect(resolveContextHorizonMs(42, undefined)).toBe(7 * 24 * 3600_000);
    expect(resolveContextHorizonMs(-42, undefined)).toBe(48 * 3600_000);
  });
});
