/**
 * ADR-241: 线程相关性衰减 + 压力阈值过滤测试。
 *
 * 验证:
 * - threadRelevance 半衰期衰减行为
 * - open_topics format() 的 dormant/urgency 标签
 *
 * @see docs/adr/241-thread-weight-decay.md
 */
import { describe, expect, it } from "vitest";
import { threadRelevance, threadsMod } from "../src/mods/threads.mod.js";

// -- 常量 --
const RELEVANCE_THRESHOLD = 0.15;
const DAY_MS = 24 * 3600_000;

function getOpenTopicsFormat(): (result: unknown) => string[] {
  const query = threadsMod.queries?.open_topics;
  if (!query) {
    throw new Error("threadsMod open_topics query is missing");
  }
  if (!query.format) {
    throw new Error("threadsMod open_topics format() is missing");
  }
  return query.format;
}

describe("ADR-241: threadRelevance 半衰期衰减", () => {
  const now = Date.now();

  it("刚创建的线程 relevance = 基础权重", () => {
    expect(threadRelevance(now, null, "minor", now)).toBeCloseTo(0.5, 2);
    expect(threadRelevance(now, null, "major", now)).toBeCloseTo(2.0, 2);
    expect(threadRelevance(now, null, "critical", now)).toBeCloseTo(4.0, 2);
  });

  it("minor 线程 7 天后 relevance ≈ 0.25（半衰期）", () => {
    const created = now - 7 * DAY_MS;
    const rel = threadRelevance(created, null, "minor", now);
    expect(rel).toBeCloseTo(0.25, 1);
  });

  it("minor 线程 14 天后 relevance ≈ 0.125（两个半衰期），低于阈值", () => {
    const created = now - 14 * DAY_MS;
    const rel = threadRelevance(created, null, "minor", now);
    expect(rel).toBeCloseTo(0.125, 1);
    expect(rel).toBeLessThan(RELEVANCE_THRESHOLD);
  });

  it("major 线程 14 天后 relevance ≈ 0.5（两个半衰期），仍高于阈值", () => {
    const created = now - 14 * DAY_MS;
    const rel = threadRelevance(created, null, "major", now);
    // major w=2.0, 14天=2个半衰期: 2.0 × 2^(-2) = 0.5
    expect(rel).toBeCloseTo(0.5, 1);
    expect(rel).toBeGreaterThan(RELEVANCE_THRESHOLD);
  });

  it("有 beat 活动的线程从 lastBeatMs 开始衰减", () => {
    const created = now - 30 * DAY_MS;
    const lastBeat = now - 1 * DAY_MS; // 1 天前有活动
    const rel = threadRelevance(created, lastBeat, "minor", now);
    // 应该接近基础权重（只衰减了 1 天）
    expect(rel).toBeGreaterThan(0.45);
  });

  it("trivial 线程衰减最快", () => {
    const created = now - 3 * DAY_MS;
    const rel = threadRelevance(created, null, "trivial", now);
    // trivial w=0.2，3 天后 ≈ 0.2 * 2^(-3/7) ≈ 0.148
    expect(rel).toBeLessThan(RELEVANCE_THRESHOLD);
  });
});

describe("ADR-241: open_topics format() urgency 标签", () => {
  const fmt = getOpenTopicsFormat();

  it("dormant: relevance < RELEVANCE_THRESHOLD", () => {
    const rows = [
      { id: 1, title: "旧线程", status: "open", weight: "minor", pressure: 5.0, relevance: 0.1 },
    ];
    const result = fmt(rows);
    expect(result[0]).toContain("dormant");
  });

  it("low: relevance >= threshold, pressure <= 0.5", () => {
    const rows = [
      { id: 1, title: "正常线程", status: "open", weight: "minor", pressure: 0.3, relevance: 0.5 },
    ];
    const result = fmt(rows);
    expect(result[0]).toContain("low");
    expect(result[0]).not.toContain("dormant");
  });

  it("moderate: pressure > 0.5", () => {
    const rows = [
      { id: 1, title: "中等", status: "open", weight: "minor", pressure: 0.8, relevance: 0.5 },
    ];
    const result = fmt(rows);
    expect(result[0]).toContain("moderate");
  });

  it("high urgency: pressure > 1.0", () => {
    const rows = [
      { id: 1, title: "紧急", status: "open", weight: "major", pressure: 2.0, relevance: 2.0 },
    ];
    const result = fmt(rows);
    expect(result[0]).toContain("high urgency");
  });

  it("空数组返回 '(no open topics)'", () => {
    expect(fmt([])).toEqual(["(no open topics)"]);
  });

  it("边界: relevance 正好等于 RELEVANCE_THRESHOLD 不是 dormant", () => {
    const rows = [
      { id: 1, title: "边界", status: "open", weight: "minor", pressure: 0.3, relevance: 0.15 },
    ];
    const result = fmt(rows);
    expect(result[0]).toContain("low");
    expect(result[0]).not.toContain("dormant");
  });

  it("旧格式兼容: 无 relevance 字段时回退到 pressure", () => {
    const rows = [{ id: 1, title: "旧数据", status: "open", weight: "minor", pressure: 0.05 }];
    const result = fmt(rows);
    expect(result[0]).toContain("dormant");
  });

  it("pressure 为 null 时不崩溃", () => {
    const rows = [
      { id: 1, title: "无数据", status: "open", weight: "minor", pressure: null, relevance: null },
    ];
    const result = fmt(rows);
    expect(result).toBeDefined();
    expect(result.length).toBe(1);
  });
});
