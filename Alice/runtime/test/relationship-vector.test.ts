/**
 * ADR-178: 关系向量工具库测试。
 *
 * 覆盖：向量演化（增长/衰减）、导出函数、IAUS U_attraction、冷启动。
 */
import { describe, expect, it } from "vitest";
import { evalCurve, type ResponseCurve } from "../src/engine/iaus-scorer.js";

const EPSILON = 0.01;

import {
  CHEMISTRY_STIMULUS,
  DIMENSION_DECAY,
  decayDimension,
  deriveRelationType,
  deriveRomanticPhase,
  deriveTier,
  FAMILIARITY_INTERACTION_DELTA,
  growDimension,
  INITIAL_RV,
  interactionNudge,
  type RelationshipVector,
  type RVDimension,
  readRV,
  readVelocity,
  renderRelationshipFacts,
  updateVelocity,
} from "../src/graph/relationship-vector.js";
import type { TensionVector } from "../src/graph/tension.js";
import { tensionNorm } from "../src/graph/tension.js";

describe("ADR-178: Relationship Vector", () => {
  // ── 增长 ──────────────────────────────────────────────────────────────

  describe("growDimension", () => {
    it("正刺激时增长，有天花板阻尼", () => {
      const low = growDimension(0.1, 0.1, 0.5);
      const high = growDimension(0.9, 0.1, 0.5);
      // 低值增长更快
      expect(low - 0.1).toBeGreaterThan(high - 0.9);
      // 两者都在 [0, 1] 范围内
      expect(low).toBeGreaterThan(0.1);
      expect(high).toBeLessThanOrEqual(1);
    });

    it("负刺激时收缩，有地板阻尼", () => {
      const result = growDimension(0.5, 0.1, -0.5);
      expect(result).toBeLessThan(0.5);
      expect(result).toBeGreaterThanOrEqual(0);
    });

    it("值为 0 时负刺激不变", () => {
      expect(growDimension(0, 0.1, -0.5)).toBe(0);
    });

    it("值为 1 时正刺激不变", () => {
      expect(growDimension(1, 0.1, 0.5)).toBe(1);
    });
  });

  // ── 衰减 ──────────────────────────────────────────────────────────────

  describe("decayDimension", () => {
    it("半衰期后值减半", () => {
      const halfLifeS = 86400; // 1 天
      const elapsedMs = halfLifeS * 1000; // 正好 1 个半衰期
      const result = decayDimension(1.0, halfLifeS, elapsedMs);
      expect(result).toBeCloseTo(0.5, 2);
    });

    it("零或负经过时间不衰减", () => {
      expect(decayDimension(0.8, 86400, 0)).toBe(0.8);
      expect(decayDimension(0.8, 86400, -1000)).toBe(0.8);
    });

    it("各维度有独立半衰期", () => {
      const elapsedMs = 7 * 86400 * 1000; // 7 天
      const decayedAttraction = decayDimension(1.0, DIMENSION_DECAY.attraction, elapsedMs);
      const decayedTrust = decayDimension(1.0, DIMENSION_DECAY.trust, elapsedMs);
      // attraction 半衰期 7 天 → 7 天后 ≈ 0.5
      expect(decayedAttraction).toBeCloseTo(0.5, 1);
      // trust 半衰期 60 天 → 7 天后 ≈ 0.92
      expect(decayedTrust).toBeGreaterThan(0.9);
    });
  });

  // ── Velocity ──────────────────────────────────────────────────────────

  describe("updateVelocity", () => {
    it("EMA 平滑", () => {
      const vel = updateVelocity(0, 0.1, 0.05);
      expect(vel).toBeCloseTo(0.005, 4);
    });

    it("连续更新趋向 delta", () => {
      let vel = 0;
      for (let i = 0; i < 100; i++) {
        vel = updateVelocity(vel, 0.1, 0.05);
      }
      expect(vel).toBeCloseTo(0.1, 1);
    });
  });

  // ── 导出函数 ──────────────────────────────────────────────────────────

  describe("deriveTier", () => {
    it("familiarity 到 tier 的映射", () => {
      expect(deriveTier(0.9)).toBe(5);
      expect(deriveTier(0.7)).toBe(15);
      expect(deriveTier(0.5)).toBe(50);
      expect(deriveTier(0.3)).toBe(150);
      expect(deriveTier(0.1)).toBe(500);
    });
  });

  describe("deriveRelationType", () => {
    it("高 attraction + affection → romantic", () => {
      const v: RelationshipVector = {
        familiarity: 0.9,
        trust: 0.8,
        affection: 0.9,
        attraction: 0.8,
        respect: 0.7,
      };
      expect(deriveRelationType(v)).toBe("romantic");
    });

    it("高 familiarity + trust, 低 attraction → close_friend", () => {
      const v: RelationshipVector = {
        familiarity: 0.9,
        trust: 0.9,
        affection: 0.7,
        attraction: 0.1,
        respect: 0.8,
      };
      expect(deriveRelationType(v)).toBe("close_friend");
    });

    it("全零 → acquaintance 或 unknown（距离初始原型最近）", () => {
      const v: RelationshipVector = {
        familiarity: 0,
        trust: 0,
        affection: 0,
        attraction: 0,
        respect: 0,
      };
      const result = deriveRelationType(v);
      expect(["acquaintance", "unknown"]).toContain(result);
    });
  });

  describe("deriveRomanticPhase", () => {
    const zeroVel: Record<RVDimension, number> = {
      familiarity: 0,
      trust: 0,
      affection: 0,
      attraction: 0,
      respect: 0,
    };

    it("低 attraction → none", () => {
      const v: RelationshipVector = { ...INITIAL_RV, attraction: 0.05 };
      expect(deriveRomanticPhase(v, zeroVel)).toBe("none");
    });

    it("中 attraction, 低 affection → tension", () => {
      const v: RelationshipVector = { ...INITIAL_RV, attraction: 0.2, affection: 0.1 };
      expect(deriveRomanticPhase(v, zeroVel)).toBe("tension");
    });

    it("高 attraction + affection + 正增长 → passion", () => {
      const v: RelationshipVector = { ...INITIAL_RV, attraction: 0.6, affection: 0.7 };
      // vel.attraction > 0 表示激情仍在增长（passion 而非 bonding）
      const vel = { ...zeroVel, attraction: 0.01 };
      expect(deriveRomanticPhase(v, vel)).toBe("passion");
    });

    it("稳定高 affection + 非增 attraction → bonding", () => {
      const v: RelationshipVector = { ...INITIAL_RV, attraction: 0.5, affection: 0.8 };
      const vel = { ...zeroVel, attraction: -0.001 }; // ≤ 0 但不是 < -0.01
      expect(deriveRomanticPhase(v, vel)).toBe("bonding");
    });

    it("attraction 下降中 → cooling", () => {
      const v: RelationshipVector = { ...INITIAL_RV, attraction: 0.4, affection: 0.5 };
      const vel = { ...zeroVel, attraction: -0.02 };
      expect(deriveRomanticPhase(v, vel)).toBe("cooling");
    });

    it("attraction + affection 都下降 → estranged", () => {
      const v: RelationshipVector = { ...INITIAL_RV, attraction: 0.3, affection: 0.4 };
      const vel = { ...zeroVel, attraction: -0.02, affection: -0.01 };
      expect(deriveRomanticPhase(v, vel)).toBe("estranged");
    });
  });

  // ── 读取 ──────────────────────────────────────────────────────────────

  describe("readRV / readVelocity", () => {
    it("缺失值用 INITIAL_RV 填充", () => {
      const v = readRV({});
      expect(v.familiarity).toBe(INITIAL_RV.familiarity);
      expect(v.trust).toBe(INITIAL_RV.trust);
    });

    it("有值时使用属性值", () => {
      const v = readRV({ rv_familiarity: 0.8, rv_trust: 0.9 } as any);
      expect(v.familiarity).toBe(0.8);
      expect(v.trust).toBe(0.9);
    });

    it("velocity 缺失值为 0", () => {
      const vel = readVelocity({});
      expect(vel.familiarity).toBe(0);
      expect(vel.attraction).toBe(0);
    });
  });

  // ── Prompt 渲染 ────────────────────────────────────────────────────────

  describe("renderRelationshipFacts", () => {
    const zeroVel: Record<RVDimension, number> = {
      familiarity: 0,
      trust: 0,
      affection: 0,
      attraction: 0,
      respect: 0,
    };

    it("默认值不渲染", () => {
      const result = renderRelationshipFacts(INITIAL_RV, zeroVel, "Alice");
      expect(result).toBeNull();
    });

    it("偏离初始值的维度渲染为语义标签", () => {
      const v: RelationshipVector = {
        ...INITIAL_RV,
        familiarity: 0.8,
        attraction: 0.5,
      };
      const result = renderRelationshipFacts(v, zeroVel, "Bob");
      expect(result).not.toBeNull();
      expect(result).toContain("familiarity: very high");
      expect(result).toContain("attraction: moderate");
    });

    it("有 velocity 时显示趋势", () => {
      const v: RelationshipVector = { ...INITIAL_RV, familiarity: 0.7 };
      const vel = { ...zeroVel, familiarity: 0.03 };
      const result = renderRelationshipFacts(v, vel, "Charlie");
      expect(result).toContain("rising");
    });

    it("浪漫阶段非 none 时渲染", () => {
      const v: RelationshipVector = {
        ...INITIAL_RV,
        attraction: 0.6,
        affection: 0.7,
      };
      const vel = { ...zeroVel, attraction: 0.01 };
      const result = renderRelationshipFacts(v, vel, "Dave");
      expect(result).toContain("romantic phase: passion");
    });
  });

  // ── tauAttraction 不参与 tensionNorm ───────────────────────────────────

  describe("tauAttraction exclusion", () => {
    it("tauAttraction 不影响 tensionNorm", () => {
      const base: TensionVector = {
        tau1: 1,
        tau2: 0,
        tau3: 0,
        tau4: 0,
        tau5: 0,
        tau6: 0,
        tauP: 0,
        tauRisk: 0,
        tauAttraction: 0,
        tauSpike: 0,
      };
      const withAttraction: TensionVector = { ...base, tauAttraction: 5.0 };
      expect(tensionNorm(base)).toBeCloseTo(tensionNorm(withAttraction));
    });
  });

  // ── IAUS U_attraction ──────────────────────────────────────────────────

  describe("U_attraction in IAUS", () => {
    const attractionCurve: ResponseCurve = {
      type: "sigmoid",
      midpoint: 0.15,
      slope: 6,
      min: 0.01,
      max: 1,
    };

    it("tauAttraction=0 → 低值（sigmoid 左侧）", () => {
      const result = evalCurve(attractionCurve, 0);
      // sigmoid(0, midpoint=0.15, slope=6): 1/(1+exp(-6*(0-0.15))) ≈ 0.29
      expect(result).toBeLessThan(0.35);
      expect(result).toBeGreaterThan(EPSILON);
    });

    it("tauAttraction=0.5 → 高值", () => {
      const result = evalCurve(attractionCurve, 0.5);
      expect(result).toBeGreaterThan(0.8);
    });

    it("tauAttraction=1.0 → 接近 1.0", () => {
      const result = evalCurve(attractionCurve, 1.0);
      expect(result).toBeGreaterThan(0.95);
    });
  });

  // ── interactionNudge (organic growth) ──────────────────────────────────

  describe("interactionNudge", () => {
    it("familiarity 每次交互都增长（频率/计数信号）", () => {
      const next = interactionNudge(INITIAL_RV, { reciprocated: true });
      // familiarity 从 0 起，growDimension(0, 0.02, 1) = 0.02
      expect(next.familiarity).toBeCloseTo(FAMILIARITY_INTERACTION_DELTA, 4);
      expect(next.familiarity).toBeGreaterThan(INITIAL_RV.familiarity);
    });

    it("familiarity 随交互次数累积增长（多次交互越来越熟）", () => {
      let v: RelationshipVector = { ...INITIAL_RV };
      const before = v.familiarity;
      for (let i = 0; i < 30; i++) {
        v = interactionNudge(v, { reciprocated: true });
      }
      expect(v.familiarity).toBeGreaterThan(before + 0.3);
      // 但仍受天花板阻尼，不会爆到 1.0
      expect(v.familiarity).toBeLessThan(1);
    });

    it("正向 outcomeQuality → trust 增长；负向 → trust 下降", () => {
      const up = interactionNudge(INITIAL_RV, { outcomeQuality: 0.8 });
      const down = interactionNudge(INITIAL_RV, { outcomeQuality: -0.8 });
      expect(up.trust).toBeGreaterThan(INITIAL_RV.trust);
      expect(down.trust).toBeLessThan(INITIAL_RV.trust);
    });

    it("信任脆弱：从对称 trust=0.5 出发，同幅负向冲击大于正向", () => {
      // 在 trust=0.5 处天花板/地板阻尼对称（1-v == v），凸显负向系数更高
      const mid: RelationshipVector = { ...INITIAL_RV, trust: 0.5 };
      const up = interactionNudge(mid, { outcomeQuality: 0.8 });
      const down = interactionNudge(mid, { outcomeQuality: -0.8 });
      const upDelta = up.trust - 0.5;
      const downDelta = 0.5 - down.trust;
      expect(downDelta).toBeGreaterThan(upDelta);
    });

    it("中性信号下信任几乎不动（需要显式正向结果才长信任）", () => {
      const next = interactionNudge(INITIAL_RV, { reciprocated: true });
      expect(next.trust).toBeCloseTo(INITIAL_RV.trust, 6);
    });

    it("互动（reciprocated）即使中性也让 affection 略增（共处的温度）", () => {
      const next = interactionNudge(INITIAL_RV, { reciprocated: true });
      expect(next.affection).toBeGreaterThan(INITIAL_RV.affection);
    });

    it("负面情绪 → affection 下降", () => {
      const warm: RelationshipVector = { ...INITIAL_RV, affection: 0.5 };
      const next = interactionNudge(warm, { moodValence: -0.6, reciprocated: false });
      expect(next.affection).toBeLessThan(0.5);
    });

    it("reciprocated 让 respect 缓慢增长", () => {
      const next = interactionNudge(INITIAL_RV, { reciprocated: true });
      expect(next.respect).toBeGreaterThan(INITIAL_RV.respect);
    });

    it("不修改 attraction（仍归 sense_chemistry 管）", () => {
      const next = interactionNudge(
        { ...INITIAL_RV, attraction: 0.3 },
        { outcomeQuality: 0.9, moodValence: 0.8, reciprocated: true },
      );
      expect(next.attraction).toBe(0.3);
    });

    it("所有维度都钳制在 [0,1]，新接触不会跳到 1.0", () => {
      const next = interactionNudge(INITIAL_RV, {
        outcomeQuality: 1,
        moodValence: 1,
        reciprocated: true,
      });
      for (const dim of ["familiarity", "trust", "affection", "respect"] as RVDimension[]) {
        expect(next[dim]).toBeGreaterThanOrEqual(0);
        expect(next[dim]).toBeLessThanOrEqual(1);
      }
      // 单次交互即便满信号也是渐进的（远未到 1.0）
      expect(next.trust).toBeLessThan(0.5);
      expect(next.affection).toBeLessThan(0.3);
    });

    it("是纯函数：不改动入参向量", () => {
      const input: RelationshipVector = { ...INITIAL_RV };
      const snapshot = { ...input };
      interactionNudge(input, { outcomeQuality: 0.9, reciprocated: true });
      expect(input).toEqual(snapshot);
    });
  });

  // ── CHEMISTRY_STIMULUS ─────────────────────────────────────────────────

  describe("CHEMISTRY_STIMULUS", () => {
    it("正值枚举产生正向 stimulus", () => {
      expect(CHEMISTRY_STIMULUS.magnetic).toBeGreaterThan(0);
      expect(CHEMISTRY_STIMULUS.electric).toBeGreaterThan(0);
      expect(CHEMISTRY_STIMULUS.warm).toBeGreaterThan(0);
      expect(CHEMISTRY_STIMULUS.comfortable).toBeGreaterThan(0);
    });

    it("负值枚举产生负向 stimulus", () => {
      expect(CHEMISTRY_STIMULUS.awkward).toBeLessThan(0);
      expect(CHEMISTRY_STIMULUS.cold).toBeLessThan(0);
    });

    it("magnetic > electric > warm > comfortable", () => {
      expect(CHEMISTRY_STIMULUS.magnetic).toBeGreaterThan(CHEMISTRY_STIMULUS.electric);
      expect(CHEMISTRY_STIMULUS.electric).toBeGreaterThan(CHEMISTRY_STIMULUS.warm);
      expect(CHEMISTRY_STIMULUS.warm).toBeGreaterThan(CHEMISTRY_STIMULUS.comfortable);
    });
  });
});
