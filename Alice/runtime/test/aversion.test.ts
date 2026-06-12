/**
 * ADR-217: effectiveAversion 指数衰减测试。
 */
import { describe, expect, it } from "vitest";
import type { ChatType } from "../src/graph/entities.js";
import { WorldModel } from "../src/graph/world-model.js";
import { effectiveAversion } from "../src/pressure/signal-decay.js";

function makeGraph(chatType: ChatType, aversion: number, aversionAgoMs: number): WorldModel {
  const G = new WorldModel();
  G.addChannel("channel:100", {
    chat_type: chatType,
    aversion,
    aversion_ms: Date.now() - aversionAgoMs,
  });
  return G;
}

describe("effectiveAversion", () => {
  it("无 aversion → 0", () => {
    const G = new WorldModel();
    G.addChannel("channel:100", { chat_type: "group" });
    expect(effectiveAversion(G, "channel:100", Date.now())).toBe(0);
  });

  it("刚设置的 aversion 几乎不衰减", () => {
    const G = makeGraph("group", 0.8, 0);
    const eff = effectiveAversion(G, "channel:100", Date.now());
    expect(eff).toBeGreaterThan(0.79);
    expect(eff).toBeLessThanOrEqual(0.8);
  });

  it("群聊 2 小时后衰减到 ~37%（τ=2h，e^-1 ≈ 0.368）", () => {
    const twoHoursMs = 2 * 3600 * 1000;
    const G = makeGraph("group", 1.0, twoHoursMs);
    const eff = effectiveAversion(G, "channel:100", Date.now());
    expect(eff).toBeCloseTo(0.368, 2);
  });

  it("私聊 8 小时后衰减到 ~37%（τ=8h）", () => {
    const eightHoursMs = 8 * 3600 * 1000;
    const G = makeGraph("private", 1.0, eightHoursMs);
    const eff = effectiveAversion(G, "channel:100", Date.now());
    expect(eff).toBeCloseTo(0.368, 2);
  });

  it("群聊衰减比私聊快", () => {
    const fourHoursMs = 4 * 3600 * 1000;
    const groupG = makeGraph("group", 1.0, fourHoursMs);
    const privateG = makeGraph("private", 1.0, fourHoursMs);
    const groupEff = effectiveAversion(groupG, "channel:100", Date.now());
    const privateEff = effectiveAversion(privateG, "channel:100", Date.now());
    expect(groupEff).toBeLessThan(privateEff);
  });

  it("cooling_down (1.0) 群聊 4 小时后 < 0.15（2τ 衰减）", () => {
    const fourHoursMs = 4 * 3600 * 1000;
    const G = makeGraph("group", 1.0, fourHoursMs);
    const eff = effectiveAversion(G, "channel:100", Date.now());
    // e^(-2) ≈ 0.135
    expect(eff).toBeLessThan(0.15);
  });

  it("fed_up (0.8) 群聊 2 小时后 < 0.3", () => {
    const twoHoursMs = 2 * 3600 * 1000;
    const G = makeGraph("group", 0.8, twoHoursMs);
    const eff = effectiveAversion(G, "channel:100", Date.now());
    // 0.8 × e^(-1) ≈ 0.294
    expect(eff).toBeLessThan(0.3);
  });

  it("不存在的节点 → 0", () => {
    const G = new WorldModel();
    expect(effectiveAversion(G, "channel:999", Date.now())).toBe(0);
  });
});
