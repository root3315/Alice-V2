/**
 * ExplorationGuard 单元测试 — 探索保护全量验证。
 *
 * 覆盖：
 * - 滑动窗口 budget（join/search）
 * - Cooldown（join/search/post-join-search）
 * - 观察窗口（silent → apprentice → normal）
 * - 学徒期消息限制
 * - Circuit breaker 三态流转（closed → open → half-open → closed/open）
 *
 * @see src/telegram/exploration-guard.ts
 * @see docs/adr/53-audit-gap-closure.md §ExplorationGuard
 */

import { describe, expect, it } from "vitest";
import { type ExplorationConfig, ExplorationGuard } from "../src/telegram/exploration-guard.js";

/** 创建可控时间的 guard */
function makeGuard(overrides?: Partial<ExplorationConfig>, startTime = 0) {
  let now = startTime;
  const guard = new ExplorationGuard(overrides, () => now);
  const advance = (ms: number) => {
    now += ms;
  };
  const setTime = (t: number) => {
    now = t;
  };
  return { guard, advance, setTime, getTime: () => now };
}

// ═══════════════════════════════════════════════════════════════════════════
// Budget 滑动窗口
// ═══════════════════════════════════════════════════════════════════════════

describe("ExplorationGuard — Budget 滑动窗口", () => {
  it("5 次 join 后第 6 次被拒", () => {
    const { guard, advance } = makeGuard({ maxJoinsPerDay: 5, joinCooldownMs: 0 });

    for (let i = 0; i < 5; i++) {
      expect(guard.canJoin().allowed).toBe(true);
      guard.recordJoin();
      advance(1); // 每次 join 间隔 1ms（cooldown=0）
    }

    // 第 6 次
    expect(guard.canJoin().allowed).toBe(false);
    expect(guard.canJoin().reason).toContain("budget exhausted");
  });

  it("24h 后 budget 恢复", () => {
    const { guard, advance } = makeGuard({ maxJoinsPerDay: 2, joinCooldownMs: 0 });

    guard.recordJoin();
    advance(1);
    guard.recordJoin();
    advance(1);
    expect(guard.canJoin().allowed).toBe(false);

    // 24h 后恢复
    advance(24 * 60 * 60 * 1000);
    expect(guard.canJoin().allowed).toBe(true);
  });

  it("10 次 search 后被拒", () => {
    const { guard, advance } = makeGuard({
      maxSearchPerHour: 10,
      searchCooldownMs: 0,
      postJoinSearchCooldownMs: 0,
    });

    for (let i = 0; i < 10; i++) {
      expect(guard.canSearch("public").allowed).toBe(true);
      guard.recordSearch();
      advance(1);
    }

    expect(guard.canSearch("public").allowed).toBe(false);
    expect(guard.canSearch("public").reason).toContain("budget exhausted");
  });

  it("1h 后 search budget 恢复", () => {
    const { guard, advance } = makeGuard({
      maxSearchPerHour: 2,
      searchCooldownMs: 0,
      postJoinSearchCooldownMs: 0,
    });

    guard.recordSearch();
    advance(1);
    guard.recordSearch();
    advance(1);
    expect(guard.canSearch("global").allowed).toBe(false);

    advance(60 * 60 * 1000);
    expect(guard.canSearch("global").allowed).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Cooldown
// ═══════════════════════════════════════════════════════════════════════════

describe("ExplorationGuard — Cooldown", () => {
  it("join 后立即再 join 被拒，等 1h 后允许", () => {
    const { guard, advance } = makeGuard({ joinCooldownMs: 3_600_000 });

    expect(guard.canJoin().allowed).toBe(true);
    guard.recordJoin();

    // 立即
    advance(1000);
    const r = guard.canJoin();
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain("cooldown");

    // 1h 后
    advance(3_600_000);
    expect(guard.canJoin().allowed).toBe(true);
  });

  it("search cooldown 正常生效", () => {
    const { guard, advance } = makeGuard({
      searchCooldownMs: 300_000,
      postJoinSearchCooldownMs: 0,
    });

    guard.recordSearch();
    advance(1000);
    expect(guard.canSearch("public").allowed).toBe(false);

    advance(300_000);
    expect(guard.canSearch("public").allowed).toBe(true);
  });

  it("join 后 30min 内 search 被拒（post-join cooldown）", () => {
    const { guard, advance } = makeGuard({
      joinCooldownMs: 0,
      searchCooldownMs: 0,
      postJoinSearchCooldownMs: 1_800_000,
    });

    guard.recordJoin();
    advance(60_000); // 1 分钟
    const r = guard.canSearch("public");
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain("post-join");

    advance(1_800_000);
    expect(guard.canSearch("public").allowed).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 观察窗口
// ═══════════════════════════════════════════════════════════════════════════

describe("ExplorationGuard — 观察窗口", () => {
  it("silent → apprentice → normal 阶段推进", () => {
    // ADR-110: silentDurationS=600 (10分钟), apprenticeDurationS=1800 (30分钟)
    const { guard } = makeGuard({ silentDurationS: 600, apprenticeDurationS: 1800 });

    const baseMs = 1_000_000;
    // getObservationPhase(joinMs, nowMs) — 参数是毫秒时间戳
    expect(guard.getObservationPhase(baseMs, baseMs)).toBe("silent"); // 0s elapsed
    expect(guard.getObservationPhase(baseMs, baseMs + 300_000)).toBe("silent"); // 300s < 600
    expect(guard.getObservationPhase(baseMs, baseMs + 599_000)).toBe("silent"); // 599s < 600
    expect(guard.getObservationPhase(baseMs, baseMs + 600_000)).toBe("apprentice"); // 600s = silentDurationS
    expect(guard.getObservationPhase(baseMs, baseMs + 1_200_000)).toBe("apprentice"); // 1200s < 1800
    expect(guard.getObservationPhase(baseMs, baseMs + 1_799_000)).toBe("apprentice"); // 1799s < 1800
    expect(guard.getObservationPhase(baseMs, baseMs + 1_800_000)).toBe("normal"); // 1800s = apprenticeDurationS
    expect(guard.getObservationPhase(baseMs, baseMs + 5_000_000)).toBe("normal"); // 5000s >> 1800
  });

  it("silentDurationS=0 跳过静默期", () => {
    const { guard } = makeGuard({ silentDurationS: 0, apprenticeDurationS: 300 });
    const baseMs = 1_000_000;
    expect(guard.getObservationPhase(baseMs, baseMs)).toBe("apprentice"); // 0s, silent=0 → 直接 apprentice
    expect(guard.getObservationPhase(baseMs, baseMs + 300_000)).toBe("normal"); // 300s = apprenticeDurationS
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 学徒期消息限制
// ═══════════════════════════════════════════════════════════════════════════

describe("ExplorationGuard — 学徒期限制", () => {
  it("config.apprenticeMaxMessages 限制在学徒期内", () => {
    const { guard } = makeGuard({ apprenticeMaxMessages: 3 });
    expect(guard.config.apprenticeMaxMessages).toBe(3);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Circuit Breaker
// ═══════════════════════════════════════════════════════════════════════════

describe("ExplorationGuard — Circuit Breaker", () => {
  it("3 次失败 → open", () => {
    const { guard } = makeGuard({ circuitBreakerThreshold: 3 });

    guard.recordFailure("join");
    expect(guard.getBreakerState("join")).toBe("closed");
    guard.recordFailure("join");
    expect(guard.getBreakerState("join")).toBe("closed");
    guard.recordFailure("join");
    expect(guard.getBreakerState("join")).toBe("open");
  });

  it("open 时 canJoin 被拒", () => {
    const { guard, advance } = makeGuard({
      circuitBreakerThreshold: 1,
      joinCooldownMs: 0,
    });

    guard.recordFailure("join");
    expect(guard.getBreakerState("join")).toBe("open");

    const r = guard.canJoin();
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain("circuit breaker");

    // 不影响 search
    advance(1);
    expect(guard.canSearch("public").allowed).toBe(true);
  });

  it("超时 → half-open，成功 → closed", () => {
    const { guard, advance } = makeGuard({
      circuitBreakerThreshold: 1,
      circuitBreakerOpenMs: 3_600_000,
      joinCooldownMs: 0,
    });

    guard.recordFailure("join");
    expect(guard.getBreakerState("join")).toBe("open");
    expect(guard.canJoin().allowed).toBe(false);

    // 超时 → half-open（在 canJoin 内转换）
    advance(3_600_001);
    expect(guard.canJoin().allowed).toBe(true);
    expect(guard.getBreakerState("join")).toBe("half-open");

    // 成功 → closed
    guard.recordSuccess("join");
    expect(guard.getBreakerState("join")).toBe("closed");
  });

  it("half-open 试探失败 → 回到 open", () => {
    const { guard, advance } = makeGuard({
      circuitBreakerThreshold: 1,
      circuitBreakerOpenMs: 1000,
      joinCooldownMs: 0,
    });

    guard.recordFailure("join");
    expect(guard.getBreakerState("join")).toBe("open");

    advance(1001);
    guard.canJoin(); // 触发 half-open 转换
    expect(guard.getBreakerState("join")).toBe("half-open");

    // 试探失败
    guard.recordFailure("join");
    expect(guard.getBreakerState("join")).toBe("open");
  });

  it("per-action 独立：join open 不影响 search", () => {
    const { guard } = makeGuard({
      circuitBreakerThreshold: 1,
      searchCooldownMs: 0,
      postJoinSearchCooldownMs: 0,
    });

    guard.recordFailure("join");
    expect(guard.getBreakerState("join")).toBe("open");
    expect(guard.getBreakerState("search_public")).toBe("closed");
    expect(guard.canSearch("public").allowed).toBe(true);
  });

  it("search circuit breaker 独立生效", () => {
    const { guard } = makeGuard({
      circuitBreakerThreshold: 2,
      searchCooldownMs: 0,
      postJoinSearchCooldownMs: 0,
    });

    guard.recordFailure("search_public");
    guard.recordFailure("search_public");
    expect(guard.getBreakerState("search_public")).toBe("open");
    expect(guard.canSearch("public").allowed).toBe(false);

    // global 不受影响
    expect(guard.canSearch("global").allowed).toBe(true);
  });

  it("recordSuccess 重置连续失败计数", () => {
    const { guard } = makeGuard({ circuitBreakerThreshold: 3 });

    guard.recordFailure("join");
    guard.recordFailure("join");
    guard.recordSuccess("join"); // 重置
    guard.recordFailure("join");
    guard.recordFailure("join");
    // 只有 2 次连续失败，不应 open
    expect(guard.getBreakerState("join")).toBe("closed");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 默认配置
// ═══════════════════════════════════════════════════════════════════════════

describe("ExplorationGuard — 默认配置", () => {
  it("无参构造使用默认值", () => {
    const guard = new ExplorationGuard();
    expect(guard.config.maxJoinsPerDay).toBe(5);
    expect(guard.config.silentDurationS).toBe(600);
    expect(guard.config.apprenticeDurationS).toBe(1800);
    expect(guard.config.circuitBreakerThreshold).toBe(3);
  });

  it("部分覆盖合并正确", () => {
    const guard = new ExplorationGuard({ maxJoinsPerDay: 10, silentDurationS: 300 });
    expect(guard.config.maxJoinsPerDay).toBe(10);
    expect(guard.config.silentDurationS).toBe(300);
    expect(guard.config.apprenticeDurationS).toBe(1800); // 未覆盖
  });
});
