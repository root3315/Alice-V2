/**
 * ADR-112 D5: 自然性验证指标测试。
 *
 * @see runtime/src/pressure/naturalness.ts
 */
import { describe, expect, it } from "vitest";
import { WorldModel } from "../src/graph/world-model.js";
import {
  computeIDI,
  computeIntervals,
  computeNaturalness,
  computeRAI,
  computeVDE,
  estimatePowerLawAlpha,
  estimateWeibullParams,
  ksStatistic,
  pearsonCorrelation,
  weibullCDF,
} from "../src/pressure/naturalness.js";

// ═══════════════════════════════════════════════════════════════════════════
// IDI: Interval Distribution Index
// ═══════════════════════════════════════════════════════════════════════════

describe("computeIntervals", () => {
  it("从时间戳序列计算正间隔", () => {
    const intervals = computeIntervals([100, 200, 350, 500]);
    expect(intervals).toEqual([100, 150, 150]);
  });

  it("乱序时间戳正确排序", () => {
    const intervals = computeIntervals([500, 100, 350, 200]);
    expect(intervals).toEqual([100, 150, 150]);
  });

  it("单个时间戳返回空数组", () => {
    expect(computeIntervals([100])).toEqual([]);
  });

  it("空数组返回空数组", () => {
    expect(computeIntervals([])).toEqual([]);
  });

  it("相同时间戳产生零间隔被过滤", () => {
    const intervals = computeIntervals([100, 100, 200]);
    // 0 间隔被过滤，只保留 100
    expect(intervals).toEqual([100]);
  });
});

describe("estimatePowerLawAlpha", () => {
  it("空数组返回 1", () => {
    expect(estimatePowerLawAlpha([])).toBe(1);
  });

  it("等间隔序列 α→∞（退化为指数）", () => {
    // 所有间隔相同 → log(x/xMin)=0 → α=1 (边界保护)
    const intervals = [100, 100, 100, 100, 100];
    expect(estimatePowerLawAlpha(intervals)).toBe(1);
  });

  it("幂律分布样本产生合理 α（1 < α < 4）", () => {
    // 模拟幂律分布的样本：大量短间隔 + 少量长间隔
    const intervals = [1, 1, 2, 2, 3, 5, 8, 13, 21, 34, 55, 89];
    const alpha = estimatePowerLawAlpha(intervals);
    expect(alpha).toBeGreaterThan(1);
    expect(alpha).toBeLessThan(4);
  });
});

describe("ksStatistic", () => {
  it("完美拟合返回小 KS 值", () => {
    // 用 α=2 生成理论分布的样本
    const xMin = 1;
    const alpha = 2;
    // 手动构造 CDF 反函数采样: x = xMin * (1-u)^(-1/(α-1)) = xMin / (1-u)
    const samples: number[] = [];
    for (let i = 0; i < 50; i++) {
      const u = (i + 0.5) / 50; // 均匀样本
      samples.push(xMin / (1 - u));
    }
    const ks = ksStatistic(samples, alpha);
    // 理论样本拟合应很好
    expect(ks).toBeLessThan(0.1);
  });

  it("均匀分布与幂律拟合差返回大 KS 值", () => {
    // 均匀间隔 → 不是幂律
    const intervals = Array.from({ length: 50 }, (_, i) => (i + 1) * 100);
    const alpha = estimatePowerLawAlpha(intervals);
    const ks = ksStatistic(intervals, alpha);
    // 均匀分布 vs 幂律拟合较差
    expect(ks).toBeGreaterThan(0.1);
  });

  it("空数组返回 0", () => {
    expect(ksStatistic([], 2)).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Weibull MLE + CDF
// ═══════════════════════════════════════════════════════════════════════════

describe("estimateWeibullParams", () => {
  it("已知参数生成数据 → MLE 恢复参数（c=2, b=100）", () => {
    // 逆 CDF 采样: X = b * (-ln(1-U))^(1/c)
    const trueC = 2;
    const trueB = 100;
    const n = 200;
    const samples: number[] = [];
    for (let i = 0; i < n; i++) {
      const u = (i + 0.5) / n; // 均匀分位点
      samples.push(trueB * (-Math.log(1 - u)) ** (1 / trueC));
    }
    const { c, b } = estimateWeibullParams(samples);
    // MLE 应恢复到接近真实值（允许 10% 误差）
    expect(c).toBeCloseTo(trueC, 0);
    expect(Math.abs(c - trueC) / trueC).toBeLessThan(0.1);
    expect(Math.abs(b - trueB) / trueB).toBeLessThan(0.1);
  });

  it("已知参数生成数据 → MLE 恢复参数（c=0.5, b=50 — 类幂律）", () => {
    const trueC = 0.5;
    const trueB = 50;
    const n = 200;
    const samples: number[] = [];
    for (let i = 0; i < n; i++) {
      const u = (i + 0.5) / n;
      samples.push(trueB * (-Math.log(1 - u)) ** (1 / trueC));
    }
    const { c, b } = estimateWeibullParams(samples);
    expect(Math.abs(c - trueC) / trueC).toBeLessThan(0.15);
    expect(Math.abs(b - trueB) / trueB).toBeLessThan(0.15);
  });

  it("不足 2 个样本返回默认值", () => {
    expect(estimateWeibullParams([])).toEqual({ c: 1, b: 1 });
    expect(estimateWeibullParams([42])).toEqual({ c: 1, b: 42 });
  });
});

describe("weibullCDF", () => {
  it("单调递增且 ∈ [0,1]", () => {
    const c = 1.5;
    const b = 10;
    let prev = 0;
    for (let x = 0.1; x <= 100; x += 0.5) {
      const f = weibullCDF(x, c, b);
      expect(f).toBeGreaterThanOrEqual(prev);
      expect(f).toBeGreaterThanOrEqual(0);
      expect(f).toBeLessThanOrEqual(1);
      prev = f;
    }
  });

  it("x=0 返回 0", () => {
    expect(weibullCDF(0, 2, 10)).toBe(0);
  });

  it("x<0 返回 0", () => {
    expect(weibullCDF(-5, 2, 10)).toBe(0);
  });

  it("c=1 退化为指数分布（b=1/λ）", () => {
    // 指数 CDF: F(x) = 1 - exp(-λx), Weibull c=1: F(x) = 1 - exp(-x/b)
    // 即 λ = 1/b
    const lambda = 0.05;
    const b = 1 / lambda;
    for (const x of [1, 5, 10, 20, 50]) {
      const weibullF = weibullCDF(x, 1, b);
      const expF = 1 - Math.exp(-lambda * x);
      expect(weibullF).toBeCloseTo(expF, 10);
    }
  });

  it("大 x → CDF 趋近 1", () => {
    expect(weibullCDF(1e6, 2, 10)).toBeCloseTo(1, 10);
  });
});

describe("computeIDI", () => {
  it("数据不足时返回 null", () => {
    // 少于 6 条行动 → 少于 5 个间隔 → null
    const actions = [{ ms: 100 }, { ms: 200 }, { ms: 300 }];
    expect(computeIDI(actions)).toBeNull();
  });

  it("幂律分布的行动间隔 IDI > 0.5", () => {
    // 模拟人类行为：大量短间隔穿插少量长间隔
    const actions = [
      { ms: 0 },
      { ms: 1000 },
      { ms: 1500 },
      { ms: 2000 },
      { ms: 2200 },
      { ms: 2300 },
      { ms: 5000 },
      { ms: 5100 },
      { ms: 5200 },
      { ms: 8000 },
      { ms: 15000 },
      { ms: 40000 },
    ];
    const idi = computeIDI(actions);
    expect(idi).not.toBeNull();
    expect(idi!).toBeGreaterThan(0.5);
    expect(idi!).toBeLessThanOrEqual(1);
  });

  it("均匀间隔返回高 IDI（Weibull c>1 好拟合窄尾分布）", () => {
    // 用 Weibull c=3 b=1000 生成样本（窄尾），验证 MLE 拟合好 → 高 IDI
    // 逆 CDF: X = b * (-ln(1-U))^(1/c)
    const c = 3;
    const b = 1000;
    const n = 50;
    const actions: { ms: number }[] = [{ ms: 0 }];
    for (let i = 0; i < n; i++) {
      const u = (i + 0.5) / n;
      const interval = b * (-Math.log(1 - u)) ** (1 / c);
      actions.push({ ms: actions[actions.length - 1].ms + interval });
    }
    const idi = computeIDI(actions);
    expect(idi).not.toBeNull();
    expect(idi!).toBeGreaterThan(0.7);
    expect(idi!).toBeLessThanOrEqual(1);
  });

  it("IDI ∈ [0, 1]", () => {
    const actions = [
      { ms: 0 },
      { ms: 100 },
      { ms: 500 },
      { ms: 800 },
      { ms: 900 },
      { ms: 2000 },
      { ms: 5000 },
    ];
    const idi = computeIDI(actions);
    expect(idi).not.toBeNull();
    expect(idi!).toBeGreaterThanOrEqual(0);
    expect(idi!).toBeLessThanOrEqual(1);
  });

  it("完全随机间隔返回合理 IDI", () => {
    // 伪随机间隔（LCG 确定性序列）
    let seed = 12345;
    const actions: { ms: number }[] = [{ ms: 0 }];
    for (let i = 0; i < 30; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      const interval = 100 + (seed % 10000); // 100~10099ms
      actions.push({ ms: actions[actions.length - 1].ms + interval });
    }
    const idi = computeIDI(actions);
    expect(idi).not.toBeNull();
    // 随机间隔应该能被 Weibull 合理拟合
    expect(idi!).toBeGreaterThan(0.3);
    expect(idi!).toBeLessThanOrEqual(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// VDE: Voice Diversity Entropy
// ═══════════════════════════════════════════════════════════════════════════

describe("computeVDE", () => {
  it("数据不足时返回 null", () => {
    expect(computeVDE([])).toBeNull();
    expect(computeVDE([{ action: "diligence" }])).toBeNull();
  });

  it("完全均匀分布 VDE = 1.0", () => {
    const actions = [
      { action: "diligence" },
      { action: "caution" },
      { action: "sociability" },
      { action: "exploration" },
    ];
    const vde = computeVDE(actions, 4);
    expect(vde).toBeCloseTo(1.0, 5);
  });

  it("单一声部 VDE = 0.0", () => {
    const actions = Array.from({ length: 10 }, () => ({ action: "diligence" }));
    const vde = computeVDE(actions, 4);
    expect(vde).toBeCloseTo(0.0, 5);
  });

  it("两声部均匀 VDE ≈ log(2)/log(4) ≈ 0.5", () => {
    const actions = [
      { action: "diligence" },
      { action: "diligence" },
      { action: "caution" },
      { action: "caution" },
    ];
    const vde = computeVDE(actions, 4);
    const expected = Math.log(2) / Math.log(4);
    expect(vde).toBeCloseTo(expected, 4);
  });

  it("VDE ∈ [0, 1]", () => {
    const actions = [
      { action: "diligence" },
      { action: "diligence" },
      { action: "caution" },
      { action: "exploration" },
    ];
    const vde = computeVDE(actions, 4);
    expect(vde).not.toBeNull();
    expect(vde!).toBeGreaterThanOrEqual(0);
    expect(vde!).toBeLessThanOrEqual(1);
  });

  it("多于声部数的分类不超过 1.0", () => {
    // 5 种不同的 action 但 voiceCount=4
    const actions = [
      { action: "diligence" },
      { action: "caution" },
      { action: "sociability" },
      { action: "exploration" },
      { action: "unknown" },
    ];
    const vde = computeVDE(actions, 4);
    expect(vde).not.toBeNull();
    // 实际熵可能 > log(4) 但被 clamp 到 1.0
    expect(vde!).toBeLessThanOrEqual(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// RAI: Reciprocal Adaptation Index
// ═══════════════════════════════════════════════════════════════════════════

describe("pearsonCorrelation", () => {
  it("完全正相关返回 1.0", () => {
    expect(pearsonCorrelation([1, 2, 3, 4, 5], [2, 4, 6, 8, 10])).toBeCloseTo(1.0, 5);
  });

  it("完全负相关返回 -1.0", () => {
    expect(pearsonCorrelation([1, 2, 3, 4, 5], [10, 8, 6, 4, 2])).toBeCloseTo(-1.0, 5);
  });

  it("无相关接近 0", () => {
    // sin 和 cos 在均匀采样点上接近无相关
    const x = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
    const y = x.map((v) => Math.sin(v * 2.7));
    const r = pearsonCorrelation(x, y);
    expect(Math.abs(r)).toBeLessThan(0.5);
  });

  it("数据不足返回 0", () => {
    expect(pearsonCorrelation([1], [2])).toBe(0);
    expect(pearsonCorrelation([], [])).toBe(0);
  });

  it("常数序列返回 0（方差为零）", () => {
    expect(pearsonCorrelation([5, 5, 5, 5], [1, 2, 3, 4])).toBe(0);
  });
});

describe("computeRAI", () => {
  it("空图数据不足返回 null", () => {
    const G = new WorldModel();
    G.addAgent("self");
    const result = computeRAI(G);
    expect(result).toBeNull();
  });

  it("频道不足返回 null", () => {
    const G = new WorldModel();
    G.addAgent("self");
    // 只有 1 个频道，不够计算相关性
    G.addChannel("ch1", {
      chat_type: "private",
      unread: 5,
      last_activity_ms: 1000,
      last_alice_action_ms: 2000,
      contact_recv_window: 10,
    });
    const result = computeRAI(G, 3000);
    expect(result).toBeNull();
  });

  it("有足够频道数据时返回 [-1, 1] 范围的值", () => {
    const G = new WorldModel();
    G.addAgent("self");
    const now = Date.now();
    // 构造 3 个频道，活跃度不同
    G.addChannel("ch1", {
      chat_type: "private",
      unread: 20,
      last_activity_ms: now - 1000,
      last_alice_action_ms: now - 500,
      contact_recv_window: 50,
    });
    G.addChannel("ch2", {
      chat_type: "private",
      unread: 5,
      last_activity_ms: now - 5000,
      last_alice_action_ms: now - 3000,
      contact_recv_window: 10,
    });
    G.addChannel("ch3", {
      chat_type: "private",
      unread: 1,
      last_activity_ms: now - 10000,
      last_alice_action_ms: now - 8000,
      contact_recv_window: 3,
    });

    const result = computeRAI(G, now);
    expect(result).not.toBeNull();
    expect(result!).toBeGreaterThanOrEqual(-1);
    expect(result!).toBeLessThanOrEqual(1);
  });

  it("Alice 对活跃频道回复更快时 RAI 为负（自然适应）", () => {
    const G = new WorldModel();
    G.addAgent("self");
    const now = 100_000;
    // 高活跃频道 → Alice 最近刚回复（短间隔）
    G.addChannel("channel:active", {
      chat_type: "private",
      unread: 30,
      last_activity_ms: now - 100,
      last_alice_action_ms: now - 50, // Alice 50ms 前回复
      contact_recv_window: 100,
    });
    // 中活跃频道
    G.addChannel("channel:medium", {
      chat_type: "private",
      unread: 10,
      last_activity_ms: now - 500,
      last_alice_action_ms: now - 1000, // Alice 1s 前回复
      contact_recv_window: 30,
    });
    // 低活跃频道 → Alice 很久没回复（长间隔）
    G.addChannel("channel:quiet", {
      chat_type: "private",
      unread: 1,
      last_activity_ms: now - 5000,
      last_alice_action_ms: now - 10000, // Alice 10s 前回复
      contact_recv_window: 5,
    });

    const rai = computeRAI(G, now);
    expect(rai).not.toBeNull();
    // 活跃度高 → responseInterval 短 → 负相关
    expect(rai!).toBeLessThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 聚合
// ═══════════════════════════════════════════════════════════════════════════

describe("computeNaturalness", () => {
  it("空数据返回全 null", () => {
    const G = new WorldModel();
    G.addAgent("self");
    const result = computeNaturalness(G, []);
    expect(result.idi).toBeNull();
    expect(result.vde).toBeNull();
    expect(result.rai).toBeNull();
  });

  it("有充分数据时所有指标非 null", () => {
    const G = new WorldModel();
    G.addAgent("self");
    const now = Date.now();
    // 3 个频道用于 RAI
    G.addChannel("ch1", {
      chat_type: "private",
      unread: 20,
      last_activity_ms: now - 1000,
      last_alice_action_ms: now - 500,
      contact_recv_window: 50,
    });
    G.addChannel("ch2", {
      chat_type: "private",
      unread: 5,
      last_activity_ms: now - 5000,
      last_alice_action_ms: now - 3000,
      contact_recv_window: 10,
    });
    G.addChannel("ch3", {
      chat_type: "private",
      unread: 1,
      last_activity_ms: now - 10000,
      last_alice_action_ms: now - 8000,
      contact_recv_window: 3,
    });

    // 12 条行动（6+ 间隔用于 IDI，3+ 声部用于 VDE）
    const actions = [
      { tick: 1, action: "diligence", ms: now - 50000 },
      { tick: 2, action: "caution", ms: now - 45000 },
      { tick: 3, action: "sociability", ms: now - 40000 },
      { tick: 4, action: "diligence", ms: now - 35000 },
      { tick: 5, action: "exploration", ms: now - 25000 },
      { tick: 6, action: "diligence", ms: now - 20000 },
      { tick: 7, action: "sociability", ms: now - 10000 },
      { tick: 8, action: "caution", ms: now - 5000 },
    ];

    const result = computeNaturalness(G, actions, now);
    expect(result.idi).not.toBeNull();
    expect(result.vde).not.toBeNull();
    expect(result.rai).not.toBeNull();

    // 范围检查
    expect(result.idi!).toBeGreaterThanOrEqual(0);
    expect(result.idi!).toBeLessThanOrEqual(1);
    expect(result.vde!).toBeGreaterThanOrEqual(0);
    expect(result.vde!).toBeLessThanOrEqual(1);
    expect(result.rai!).toBeGreaterThanOrEqual(-1);
    expect(result.rai!).toBeLessThanOrEqual(1);
  });
});
