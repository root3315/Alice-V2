/**
 * ADR-223: 闭环验证 — 行动→图状态→压力变化 的因果链。
 *
 * 三个场景：
 * 1. 行动后压力释放：reply → pending_directed-- → P5↓
 * 2. Habituation 目标轮换：多 tick 后 ρ_H 降低 → IAUS 切换目标
 * 3. 对话弧线：H 递增 → ρ_H 递减 → 有效压力递减
 *
 * @see docs/adr/223-simulation-closed-loop-verification.md
 * @see docs/adr/222-habituation-truth-model.md
 */
import { describe, expect, it } from "vitest";
import { scoreAllCandidates } from "../src/engine/iaus-scorer.js";
import { DEFAULT_KAPPA } from "../src/graph/constants.js";
import { buildTensionMap, routeContributions } from "../src/graph/tension.js";
import { WorldModel } from "../src/graph/world-model.js";
import { computeAllPressures } from "../src/pressure/aggregate.js";
import { computeHabituationFactor } from "../src/pressure/signal-decay.js";
import {
  DEFAULT_SATURATION_COST_CONFIG,
  DEFAULT_SOCIAL_COST_CONFIG,
} from "../src/pressure/social-cost.js";
import { PersonalityVector } from "../src/voices/personality.js";

// ── 辅助 ───────────────────────────────────────────────────────��──────

const TICK_MS = 60_000;
function tickMs(t: number): number {
  return t * TICK_MS;
}

const BALANCED_PERSONALITY = new PersonalityVector([0.3, 0.2, 0.3, 0.2]);

/** 构建三频道图：A（高压力私聊）+ B（中压力私聊）+ C（低压力私聊）*/
function buildThreeChannelGraph(tick: number): WorldModel {
  const G = new WorldModel();
  G.tick = tick;
  G.addAgent("self");

  G.addContact("contact:alice", { tier: 5, last_active_ms: tickMs(tick - 2) });
  G.addContact("contact:bob", { tier: 50, last_active_ms: tickMs(tick - 5) });
  G.addContact("contact:carol", { tier: 150, last_active_ms: tickMs(tick - 10) });

  G.addChannel("channel:alice", {
    unread: 3,
    tier_contact: 5,
    chat_type: "private",
    pending_directed: 3,
    last_directed_ms: tickMs(tick - 1),
    last_incoming_ms: tickMs(tick),
  });
  G.addChannel("channel:bob", {
    unread: 2,
    tier_contact: 50,
    chat_type: "private",
    pending_directed: 2,
    last_directed_ms: tickMs(tick - 2),
    last_incoming_ms: tickMs(tick - 1),
  });
  G.addChannel("channel:carol", {
    unread: 1,
    tier_contact: 150,
    chat_type: "private",
    pending_directed: 1,
    last_directed_ms: tickMs(tick - 5),
    last_incoming_ms: tickMs(tick - 3),
  });

  G.addEdge("contact:alice", "channel:alice", "in", "spatial");
  G.addEdge("contact:bob", "channel:bob", "in", "spatial");
  G.addEdge("contact:carol", "channel:carol", "in", "spatial");

  return G;
}

/** 计算压力并返回 P5 总量 */
function getP5(G: WorldModel, tick: number, nowMs: number): number {
  return computeAllPressures(G, tick, { nowMs }).P5;
}

/** 模拟一次"回复 directed 消息"的副作用 */
function simulateReply(G: WorldModel, channelId: string, nowMs: number): void {
  const ch = G.getChannel(channelId);
  const newDirected = Math.max(0, (ch.pending_directed ?? 0) - 1);
  G.updateChannel(channelId, {
    pending_directed: newDirected,
    consecutive_outgoing: (ch.consecutive_outgoing ?? 0) + 1,
    last_alice_action_ms: nowMs,
  });
  // ADR-222: Habituation 递增
  const prevH = ch.habituation ?? 0;
  const prevMs = ch.habituation_ms ?? 0;
  const ageS = Math.max(0, (nowMs - prevMs) / 1000);
  const decayedH = prevH * 2 ** (-ageS / 1800);
  G.updateChannel(channelId, {
    habituation: decayedH + 1.0,
    habituation_ms: nowMs,
  });
}

// ── 场景 1: 行动后压力释放 ─────────────────────────────────────────

describe("ADR-223 场景 1: 行动后压力释放", () => {
  it("reply → pending_directed-- → P5 逐 tick 递减", () => {
    const G = buildThreeChannelGraph(100);
    const p5Values: number[] = [];

    for (let i = 0; i < 3; i++) {
      const nowMs = tickMs(100 + i);
      const p5 = getP5(G, 100 + i, nowMs);
      p5Values.push(p5);
      simulateReply(G, "channel:alice", nowMs);
    }

    // P5 应逐轮递减（pending_directed 从 3→2→1）
    expect(p5Values[1]).toBeLessThan(p5Values[0]);
    expect(p5Values[2]).toBeLessThan(p5Values[1]);
  });
});

// ── 场景 2: Habituation 目标轮换 ──────────────────────────────────

describe("ADR-223 场景 2: Habituation 目标轮换", () => {
  it("多 tick 后 IAUS 不锁定单一目标", () => {
    const G = buildThreeChannelGraph(100);
    const targetCounts: Record<string, number> = {};
    const recentActions: Array<{
      tick: number;
      action: string;
      ms: number;
      target: string | null;
    }> = [];
    const voiceLastWon: Record<string, number> = {
      diligence: 0,
      curiosity: 0,
      sociability: 0,
      caution: 0,
    };

    for (let i = 0; i < 10; i++) {
      const tick = 100 + i;
      const nowMs = tickMs(tick);
      G.tick = tick;

      const allP = computeAllPressures(G, tick, { nowMs });
      const routed = routeContributions(allP.contributions, allP.prospectContributions, G);

      // ADR-222: 适应性衰减调制（P5 除外）
      for (const pk of ["P1", "P2", "P3", "P4", "P6"] as const) {
        const pkContribs = routed.contributions[pk];
        if (!pkContribs) continue;
        for (const eid of Object.keys(pkContribs)) {
          if (!G.has(eid)) continue;
          const ch = G.getChannel(eid);
          const factor = computeHabituationFactor(
            ch.habituation ?? 0,
            ch.habituation_ms ?? 0,
            nowMs,
          );
          pkContribs[eid] *= factor;
        }
      }

      const tensionMap = buildTensionMap(routed.contributions, routed.prospectContributions);

      const result = scoreAllCandidates(tensionMap, G, tick, recentActions, {
        candidateCtx: { G, nowMs },
        kappa: DEFAULT_KAPPA,
        contributions: routed.contributions,
        beliefs: G.beliefs,
        beliefGamma: 0.15,
        thompsonEta: 0, // 无随机噪声
        socialCost: DEFAULT_SOCIAL_COST_CONFIG,
        saturationCost: DEFAULT_SATURATION_COST_CONFIG,
        windowStartMs: tickMs(90),
        uncertainty: 0,
        personality: BALANCED_PERSONALITY,
        voiceLastWon,
        nowMs,
        deterministic: true,
        momentumBonus: 0.05,
      });

      if (result) {
        const t = result.candidate.target;
        if (t) {
          targetCounts[t] = (targetCounts[t] ?? 0) + 1;
          recentActions.push({ tick, action: result.candidate.action, ms: nowMs, target: t });
          voiceLastWon[result.candidate.action] = nowMs;
          simulateReply(G, t, nowMs);
        }
      }
    }

    // 验证：至少选了 2 个不同目标
    const distinctTargets = Object.keys(targetCounts).length;
    expect(distinctTargets).toBeGreaterThanOrEqual(2);

    // 最高频目标占比 < 80%
    const total = Object.values(targetCounts).reduce((a, b) => a + b, 0);
    if (total > 0) {
      const topRatio = Math.max(...Object.values(targetCounts)) / total;
      expect(topRatio).toBeLessThan(0.8);
    }
  });
});

// ── 场景 3: 对话弧线 ──────────────────────────────────────────────

describe("ADR-223 场景 3: 对话弧线", () => {
  it("连续行动 → H 递增 → ρ_H 递减", () => {
    const G = buildThreeChannelGraph(100);
    const hValues: number[] = [];
    const rhoValues: number[] = [];

    for (let i = 0; i < 5; i++) {
      const nowMs = tickMs(100) + i * 20_000; // 每 20 秒一次行动

      const ch = G.getChannel("channel:alice");
      const factor = computeHabituationFactor(ch.habituation ?? 0, ch.habituation_ms ?? 0, nowMs);
      hValues.push(ch.habituation ?? 0);
      rhoValues.push(factor);

      simulateReply(G, "channel:alice", nowMs);
    }

    // H 单调递增（每次 +1.0，衰减 20s/1800s 很小）
    for (let i = 1; i < hValues.length; i++) {
      expect(hValues[i]).toBeGreaterThan(hValues[i - 1]);
    }

    // ρ_H 单调递减（从第 2 步开始，因为第 1 步 H=0→ρ=1.0）
    for (let i = 2; i < rhoValues.length; i++) {
      expect(rhoValues[i]).toBeLessThan(rhoValues[i - 1]);
    }

    // 第 5 步 ρ_H 应显著低于初始值
    expect(rhoValues[rhoValues.length - 1]).toBeLessThan(0.6);
  });
});
