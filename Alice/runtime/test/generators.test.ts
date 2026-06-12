/**
 * 内源性线程生成器 + ADR-191 spike 信号流单元测试。
 *
 * 覆盖：
 * - createThreadInGraph：DB + 图节点创建
 * - Clock ρ：digestHour / reflectionDay+Hour 触发，幂等性
 * - Deferred δ：deferred_eval_ms 到期创建评估线程
 * - updateChannelRateEma：EMA 更新逻辑
 * - ADR-191: buildTensionMap tauSpike + rCaution 融合 + ZERO_TENSION
 *
 * @see src/engine/generators.ts
 * @see src/graph/tension.ts
 * @see src/voices/focus.ts
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Config, loadConfig } from "../src/config.js";
import { closeDb, getDb, initDb } from "../src/db/connection.js";
import { narrativeThreads } from "../src/db/schema.js";
import {
  createThreadInGraph,
  type GeneratorContext,
  runGenerators,
  updateChannelRateEma,
} from "../src/engine/generators.js";
import { buildTensionMap, ZERO_TENSION } from "../src/graph/tension.js";
import { WorldModel } from "../src/graph/world-model.js";
import { rCaution } from "../src/voices/focus.js";

// -- 测试辅助 -----------------------------------------------------------------

/** 用 loadConfig() 的完整 Config + generators 字段覆盖。 */
function makeConfig(overrides: Partial<Config["generators"]> = {}): Config {
  const config = loadConfig();
  config.generators = { ...config.generators, ...overrides };
  return config;
}

/** 创建 GeneratorContext。 */
function makeCtx(overrides: Partial<GeneratorContext> = {}): GeneratorContext {
  return {
    G: overrides.G ?? new WorldModel(),
    db: overrides.db ?? getDb(),
    tick: overrides.tick ?? 100,
    nowMs: overrides.nowMs ?? Date.now(),
    config: overrides.config ?? makeConfig(),
    channelCounts: overrides.channelCounts ?? new Map(),
    channelRateEma: overrides.channelRateEma ?? new Map(),
  };
}

// =============================================================================
// createThreadInGraph
// =============================================================================

describe("createThreadInGraph", () => {
  beforeEach(() => initDb(":memory:"));
  afterEach(() => closeDb());

  it("创建 DB 行 + 图节点", () => {
    const G = new WorldModel();
    G.tick = 100;
    const db = getDb();
    const id = createThreadInGraph(db, G, 100, 1_000_000, {
      title: "test_thread",
      weight: "major",
      source: "system",
      frame: "Test frame",
    });

    expect(id).toBeGreaterThan(0);

    // DB 行
    const rows = db.select().from(narrativeThreads).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe("test_thread");
    expect(rows[0].weight).toBe("major");
    expect(rows[0].status).toBe("open");

    // 图节点
    const nodeId = `thread_${id}`;
    expect(G.has(nodeId)).toBe(true);
    const attrs = G.getThread(nodeId);
    expect(attrs.source).toBe("system");
    expect(attrs.weight).toBe("major");
    expect(attrs.created_ms).toBe(1_000_000);
  });

  it("关联 involves 实体", () => {
    const G = new WorldModel();
    G.tick = 100;
    G.addChannel("channel:123", {
      unread: 0,
      tier_contact: 5,
      chat_type: "group",
      pending_directed: 0,
      last_directed_ms: 0,
    });
    const db = getDb();
    const id = createThreadInGraph(db, G, 100, 1_000_000, {
      title: "involved_thread",
      weight: "minor",
      source: "system",
      involves: [{ nodeId: "channel:123", role: "test" }],
    });

    const nodeId = `thread_${id}`;
    // 图中应有 involves 边
    expect(G.has(nodeId)).toBe(true);
  });

  it("设置 deadline_ms 当提供 deadlineMs", () => {
    const G = new WorldModel();
    G.tick = 100;
    const db = getDb();
    const deadlineMs = 1_000_000 + 4 * 3600_000;
    const id = createThreadInGraph(db, G, 100, 1_000_000, {
      title: "deadline_thread",
      weight: "critical",
      source: "system",
      deadlineMs,
    });

    const attrs = G.getThread(`thread_${id}`);
    expect(attrs.deadline_ms).toBe(deadlineMs);
  });
});

// =============================================================================
// Clock Generator (ρ)
// =============================================================================

describe("clockGenerator (ρ)", () => {
  beforeEach(() => initDb(":memory:"));
  afterEach(() => closeDb());

  it("在 digestHour 创建 morning_digest 线程", () => {
    // 构造一个 nowMs 使得 getHours() === 8
    const date = new Date();
    date.setHours(8, 30, 0, 0);
    const ctx = makeCtx({
      nowMs: date.getTime(),
      config: makeConfig({ digestHour: 8 }),
    });

    runGenerators(ctx);

    // 检查图中有 morning_digest 线程
    const threads = ctx.G.getEntitiesByType("thread");
    expect(threads.some((tid) => ctx.G.getThread(tid).title === "morning_digest")).toBe(true);
  });

  it("幂等——不重复创建同名 open 线程", () => {
    const date = new Date();
    date.setHours(8, 30, 0, 0);
    const ctx = makeCtx({
      nowMs: date.getTime(),
      config: makeConfig({ digestHour: 8 }),
    });

    runGenerators(ctx);
    runGenerators(ctx);

    const threads = ctx.G.getEntitiesByType("thread").filter(
      (tid) => ctx.G.getThread(tid).title === "morning_digest",
    );
    expect(threads).toHaveLength(1);
  });

  it("非 digestHour 不创建 morning_digest", () => {
    const date = new Date();
    date.setHours(15, 0, 0, 0);
    const ctx = makeCtx({
      nowMs: date.getTime(),
      config: makeConfig({ digestHour: 8 }),
    });

    runGenerators(ctx);

    const threads = ctx.G.getEntitiesByType("thread").filter(
      (tid) => ctx.G.getThread(tid).title === "morning_digest",
    );
    expect(threads).toHaveLength(0);
  });

  it("在 reflectionDay + reflectionHour 创建 weekly_reflection", () => {
    // 找到下一个 Sunday
    const date = new Date();
    const daysUntilSunday = (7 - date.getDay()) % 7 || 7;
    date.setDate(date.getDate() + daysUntilSunday);
    date.setHours(20, 0, 0, 0);
    expect(date.getDay()).toBe(0); // Sunday

    const ctx = makeCtx({
      nowMs: date.getTime(),
      config: makeConfig({ reflectionDay: 0, reflectionHour: 20 }),
    });

    runGenerators(ctx);

    const threads = ctx.G.getEntitiesByType("thread").filter(
      (tid) => ctx.G.getThread(tid).title === "weekly_reflection",
    );
    expect(threads).toHaveLength(1);
  });
});

// =============================================================================
// ADR-191: Spike 信号流（替代 anomaly 线程）
// =============================================================================

describe("ADR-191: spike signal flow", () => {
  it("ZERO_TENSION.tauSpike === 0", () => {
    expect(ZERO_TENSION.tauSpike).toBe(0);
  });

  it("buildTensionMap 正确设置 tauSpike", () => {
    const contributions = { P1: { "channel:a": 1.0 } };
    const spikeContribs = { "channel:a": 2.5 };
    const tensionMap = buildTensionMap(
      contributions,
      undefined,
      undefined,
      undefined,
      spikeContribs,
    );
    const t = tensionMap.get("channel:a")!;
    expect(t.tauSpike).toBe(2.5);
    expect(t.tau1).toBe(1.0);
  });

  it("buildTensionMap 对无 spike 的实体设置 tauSpike=0", () => {
    const contributions = { P1: { "channel:a": 1.0 } };
    const tensionMap = buildTensionMap(contributions);
    const t = tensionMap.get("channel:a")!;
    expect(t.tauSpike).toBe(0);
  });

  it("buildTensionMap spike-only 实体也出现在 tensionMap 中", () => {
    const contributions = { P1: { "channel:a": 1.0 } };
    const spikeContribs = { "channel:b": 3.0 };
    const tensionMap = buildTensionMap(
      contributions,
      undefined,
      undefined,
      undefined,
      spikeContribs,
    );
    expect(tensionMap.has("channel:b")).toBe(true);
    expect(tensionMap.get("channel:b")!.tauSpike).toBe(3.0);
    expect(tensionMap.get("channel:b")!.tau1).toBe(0);
  });

  it("rCaution 在 tauSpike > 0 时输出增大", () => {
    const base = { ...ZERO_TENSION, tau1: 1, tau3: 1 };
    const withSpike = { ...base, tauSpike: 2.0 };
    const uncertainty = 0.5;
    const rBase = rCaution(base, uncertainty);
    const rSpike = rCaution(withSpike, uncertainty);
    expect(rSpike).toBeGreaterThan(rBase);
    // α_spike=0.5, tauSpike=2.0 → spike 增量 = 1.0
    // 乘法 uncertainty: diff = 1.0 * (1+0.5) = 1.5
    expect(rSpike - rBase).toBeCloseTo(1.5, 5);
  });

  it("rCaution 在 tauSpike=0 时行为不变", () => {
    const t = { ...ZERO_TENSION, tauRisk: 0.5 };
    const r = rCaution(t, 0.3);
    // signal = ALPHA_RISK * tauRisk = 0.8*0.5 = 0.4
    // result = signal × (1+0.3) = 0.52
    // H=0（全零向量除 tauRisk），α_c·H·normMag = 0
    expect(r).toBeCloseTo(0.8 * 0.5 * 1.3, 5);
  });
});

// =============================================================================
// Deferred Generator (δ)
// =============================================================================

describe("deferredGenerator (δ)", () => {
  beforeEach(() => initDb(":memory:"));
  afterEach(() => closeDb());

  it("deferred_eval_ms 到期后创建评估线程", () => {
    const G = new WorldModel();
    G.tick = 100;
    G.addChannel("channel:new", {
      unread: 0,
      tier_contact: 150,
      chat_type: "supergroup",
      pending_directed: 0,
      last_directed_ms: 0,
    });
    G.setDynamic("channel:new", "deferred_eval_ms", Date.now() - 1000); // 已到期

    const ctx = makeCtx({ G, nowMs: Date.now() });

    runGenerators(ctx);

    // ADR-190: 标题改用 safeDisplayName，通过 involves 边判断
    const evalThreads = ctx.G.getEntitiesByType("thread").filter(
      (tid) =>
        ctx.G.getThread(tid).title?.startsWith("evaluate_") &&
        ctx.G.getNeighbors(tid, "involves").includes("channel:new"),
    );
    expect(evalThreads).toHaveLength(1);

    // deferred_eval_ms 应被清除
    expect(ctx.G.getChannel("channel:new").deferred_eval_ms).toBeNull();
  });

  it("未到期时不创建", () => {
    const G = new WorldModel();
    G.tick = 100;
    G.addChannel("channel:new", {
      unread: 0,
      tier_contact: 150,
      chat_type: "supergroup",
      pending_directed: 0,
      last_directed_ms: 0,
    });
    G.setDynamic("channel:new", "deferred_eval_ms", Date.now() + 86_400_000); // 明天到期

    const ctx = makeCtx({ G, nowMs: Date.now() });

    runGenerators(ctx);

    // ADR-190: 标题改用 safeDisplayName，通过 involves 边判断
    const evalThreads = ctx.G.getEntitiesByType("thread").filter(
      (tid) =>
        ctx.G.getThread(tid).title?.startsWith("evaluate_") &&
        ctx.G.getNeighbors(tid, "involves").includes("channel:new"),
    );
    expect(evalThreads).toHaveLength(0);
  });
});

// =============================================================================
// updateChannelRateEma
// =============================================================================

describe("updateChannelRateEma", () => {
  /** ADR-166: 标称 dt=60s（旧行为退化点） */
  const DT_NOMINAL = 60;

  it("初始化新频道的 EMA", () => {
    const ema = new Map<string, { ema: number; variance: number }>();
    updateChannelRateEma(ema, new Map([["channel:1", 5]]), DT_NOMINAL);

    expect(ema.get("channel:1")).toEqual({ ema: 5, variance: 0 });
  });

  it("更新已有频道的 EMA 和方差", () => {
    const ema = new Map<string, { ema: number; variance: number }>();
    ema.set("channel:1", { ema: 2, variance: 0 });

    updateChannelRateEma(ema, new Map([["channel:1", 10]]), DT_NOMINAL);

    const stats = ema.get("channel:1")!;
    expect(stats.ema).toBeGreaterThan(2);
    expect(stats.ema).toBeLessThan(10);
    expect(stats.variance).toBeGreaterThan(0);
  });

  it("未出现的频道 count=0 衰减", () => {
    const ema = new Map<string, { ema: number; variance: number }>();
    ema.set("channel:absent", { ema: 5, variance: 1 });

    updateChannelRateEma(ema, new Map(), DT_NOMINAL); // channel:absent 无消息

    const stats = ema.get("channel:absent")!;
    expect(stats.ema).toBeLessThan(5);
  });

  it("多次更新后方差收敛到合理值", () => {
    const ema = new Map<string, { ema: number; variance: number }>();

    // 模拟 30 个 tick 的恒定速率
    for (let i = 0; i < 30; i++) {
      updateChannelRateEma(ema, new Map([["channel:stable", 3]]), DT_NOMINAL);
    }

    const stats = ema.get("channel:stable")!;
    expect(stats.ema).toBeCloseTo(3, 1);
    expect(stats.variance).toBeLessThan(0.5); // 恒定速率 → 低方差
  });

  // ADR-166: 连续时间 EMA 验证 — 短 tick 间隔下 α 更小
  it("dt=3s（conversation 模式）α 更小，EMA 移动更少", () => {
    const emaSlow = new Map<string, { ema: number; variance: number }>();
    emaSlow.set("ch", { ema: 2, variance: 0 });
    updateChannelRateEma(emaSlow, new Map([["ch", 10]]), 3); // dt=3s

    const emaFast = new Map<string, { ema: number; variance: number }>();
    emaFast.set("ch", { ema: 2, variance: 0 });
    updateChannelRateEma(emaFast, new Map([["ch", 10]]), 60); // dt=60s

    // dt=3s → α≈0.005, dt=60s → α≈0.1 → 60s 模式 EMA 应移动更多
    expect(emaFast.get("ch")!.ema).toBeGreaterThan(emaSlow.get("ch")!.ema);
    // dt=3s 时 EMA 应几乎不动（从 2 → ~2.04）
    expect(emaSlow.get("ch")!.ema).toBeLessThan(2.1);
  });

  // ADR-166: dt=60s 退化到旧行为
  it("dt=60s 退化为旧 α=0.1 行为", () => {
    const ema = new Map<string, { ema: number; variance: number }>();
    ema.set("ch", { ema: 2, variance: 0 });
    updateChannelRateEma(ema, new Map([["ch", 10]]), 60);

    // α(60) ≈ 0.1 → newEma = 2 + 0.1 * (10-2) = 2.8
    expect(ema.get("ch")!.ema).toBeCloseTo(2.8, 1);
  });
});
