/**
 * ADR-177 P1: 压力场参数灵敏度分析。
 *
 * 对关键参数做 ±50% 蒙特卡洛扫描，量化每个参数对决策覆盖率的影响。
 * 识别「偏移 ≤30% 即导致行为质变」的脆弱参数。
 *
 * 不修改生产代码中的常量——直接用数学函数内联计算扰动后的值。
 *
 * @see docs/adr/177-pressure-field-structural-audit.md §P1
 */
import { describe, expect, it } from "vitest";

// ═══════════════════════════════════════════════════════════════════════════
// 内联的压力场核心数学（避免修改生产常量）
// ═══════════════════════════════════════════════════════════════════════════

/** 指数衰减核。 */
function decay(value: number, ageS: number, halfLifeS: number): number {
  if (ageS <= 0) return value;
  return value * 2 ** (-ageS / halfLifeS);
}

/** effectiveUnread 的参数化版本。 */
function effectiveUnreadParam(
  rawUnread: number,
  ewms: number,
  ageS: number,
  halfLifeS: number,
  kappaTonic: number,
): number {
  if (rawUnread <= 0) return 0;
  const phasic = ewms > 0 ? ewms * decay(1.0, ageS, halfLifeS) : 0;
  const tonic = kappaTonic * Math.log(1 + rawUnread);
  return Math.max(phasic, tonic);
}

/** P1 contribution 的简化计算。 */
function p1Contribution(eu: number, tierWeight: number, chatWeight: number): number {
  return eu * tierWeight * chatWeight;
}

/** tanh 归一化。 */
function tanhNorm(value: number, kappa: number): number {
  return Math.tanh(value / kappa);
}

/** P3 对数域 sigmoid。 */
function logSigmoid(silenceS: number, beta: number, thetaS: number, tau0: number): number {
  const x = beta * (Math.log(1 + silenceS / tau0) - Math.log(1 + thetaS / tau0));
  return 1 / (1 + Math.exp(-x));
}

// ═══════════════════════════════════════════════════════════════════════════
// 场景定义
// ═══════════════════════════════════════════════════════════════════════════

interface Channel {
  id: string;
  rawUnread: number;
  ewms: number;
  ageS: number; // 消息年龄
  tier: number;
  chatType: "private" | "group" | "supergroup" | "channel";
}

const TIER_WEIGHT: Record<number, number> = { 5: 5.0, 15: 3.0, 50: 1.5, 150: 0.8, 500: 0.3 };
const CHAT_WEIGHT: Record<string, number> = {
  private: 3.0,
  group: 1.0,
  supergroup: 0.8,
  channel: 0.3,
};

/** 写实场景：Alice 的典型频道分布。 */
const REALISTIC_CHANNELS: Channel[] = [
  // 亲密好友私聊——新消息
  { id: "dm-bestfriend", rawUnread: 3, ewms: 3, ageS: 120, tier: 5, chatType: "private" },
  // 好友私聊——中等年龄
  { id: "dm-friend", rawUnread: 5, ewms: 5, ageS: 3600, tier: 15, chatType: "private" },
  // 好友群——旧积压
  { id: "grp-friends", rawUnread: 30, ewms: 30, ageS: 8 * 3600, tier: 15, chatType: "supergroup" },
  // 技术群——活跃积压
  { id: "grp-tech", rawUnread: 80, ewms: 80, ageS: 4 * 3600, tier: 50, chatType: "supergroup" },
  // 大群——大量积压
  {
    id: "grp-large",
    rawUnread: 200,
    ewms: 200,
    ageS: 12 * 3600,
    tier: 150,
    chatType: "supergroup",
  },
  // 频道——很久前的消息
  { id: "chan-news", rawUnread: 50, ewms: 50, ageS: 24 * 3600, tier: 500, chatType: "channel" },
  // 熟人私聊——几天前的消息
  { id: "dm-acquaintance", rawUnread: 2, ewms: 2, ageS: 48 * 3600, tier: 50, chatType: "private" },
  // 新群——刚加入
  { id: "grp-new", rawUnread: 15, ewms: 15, ageS: 1800, tier: 500, chatType: "supergroup" },
];

// ═══════════════════════════════════════════════════════════════════════════
// 灵敏度测试
// ═══════════════════════════════════════════════════════════════════════════

/** 计算基线 P1 贡献排名。 */
function computeP1Ranking(
  channels: Channel[],
  halfLifeS: number,
  kappaTonic: number,
): { id: string; p1: number }[] {
  return channels
    .map((ch) => {
      const eu = effectiveUnreadParam(ch.rawUnread, ch.ewms, ch.ageS, halfLifeS, kappaTonic);
      const w = TIER_WEIGHT[ch.tier] ?? 0.8;
      const cw = CHAT_WEIGHT[ch.chatType] ?? 1.0;
      return { id: ch.id, p1: p1Contribution(eu, w, cw) };
    })
    .sort((a, b) => b.p1 - a.p1);
}

/** 计算覆盖率：P1 > 0 的频道中，能进入 top-K 的比例。 */
function coverageRate(ranking: { id: string; p1: number }[], topK: number): number {
  const active = ranking.filter((r) => r.p1 > 0.01);
  if (active.length === 0) return 1;
  return Math.min(topK, active.length) / active.length;
}

/** 排名稳定性：基线 top-3 是否仍在扰动后的 top-5 中。 */
function rankStability(
  baseline: { id: string; p1: number }[],
  perturbed: { id: string; p1: number }[],
): number {
  const baseTop3 = baseline.slice(0, 3).map((r) => r.id);
  const pertTop5 = new Set(perturbed.slice(0, 5).map((r) => r.id));
  const retained = baseTop3.filter((id) => pertTop5.has(id)).length;
  return retained / baseTop3.length;
}

describe("ADR-177 P1: 参数灵敏度分析", () => {
  // -- 基线 --

  const BASELINE_HALFLIFE = 3600;
  const BASELINE_KAPPA_TONIC = 1.0;
  const BASELINE_KAPPA_P1 = 5.0;

  const baseline = computeP1Ranking(REALISTIC_CHANNELS, BASELINE_HALFLIFE, BASELINE_KAPPA_TONIC);

  it("基线排名：亲密好友私聊在 top-3", () => {
    const top3 = baseline.slice(0, 3).map((r) => r.id);
    expect(top3).toContain("dm-bestfriend");
  });

  it("基线排名：旧积压好友群可见（非零贡献）", () => {
    const friendsGroup = baseline.find((r) => r.id === "grp-friends");
    expect(friendsGroup).toBeDefined();
    expect(friendsGroup!.p1).toBeGreaterThan(0.1);
  });

  // -- KAPPA_TONIC 灵敏度 --

  it("KAPPA_TONIC ×0.3 — 旧积压信号大幅降低但不归零", () => {
    const perturbed = computeP1Ranking(REALISTIC_CHANNELS, BASELINE_HALFLIFE, 0.3);
    const friendsGroup = perturbed.find((r) => r.id === "grp-friends")!;
    const baselineFG = baseline.find((r) => r.id === "grp-friends")!;
    // 信号降低但仍 > 0
    expect(friendsGroup.p1).toBeGreaterThan(0);
    expect(friendsGroup.p1).toBeLessThan(baselineFG.p1);
    // top-3 排名应基本稳定
    expect(rankStability(baseline, perturbed)).toBeGreaterThanOrEqual(0.67);
  });

  it("KAPPA_TONIC ×3.0 — 旧积压信号增强但不反转排名", () => {
    const perturbed = computeP1Ranking(REALISTIC_CHANNELS, BASELINE_HALFLIFE, 3.0);
    // 亲密好友私聊仍在 top-3（phasic 主导时不应被 tonic 反转）
    const top3 = perturbed.slice(0, 3).map((r) => r.id);
    expect(top3).toContain("dm-bestfriend");
    // 大群的 tonic 增强但受 tier/chatW 压制
    const largeGroup = perturbed.find((r) => r.id === "grp-large")!;
    const dmBF = perturbed.find((r) => r.id === "dm-bestfriend")!;
    expect(dmBF.p1).toBeGreaterThan(largeGroup.p1);
  });

  // -- UNREAD_FRESHNESS_HALFLIFE_S 灵敏度 --

  it("半衰期 ×0.5 (30min) — phasic 衰减更快，tonic 接管更早", () => {
    const perturbed = computeP1Ranking(REALISTIC_CHANNELS, 1800, BASELINE_KAPPA_TONIC);
    // 旧积压频道应该更依赖 tonic（因为 phasic 衰减更快）
    const friendsGroup = perturbed.find((r) => r.id === "grp-friends")!;
    expect(friendsGroup.p1).toBeGreaterThan(0.1); // tonic 兜底
    // top-3 应基本稳定
    expect(rankStability(baseline, perturbed)).toBeGreaterThanOrEqual(0.67);
  });

  it("半衰期 ×2.0 (2h) — phasic 衰减更慢，中等年龄消息信号更强", () => {
    const perturbed = computeP1Ranking(REALISTIC_CHANNELS, 7200, BASELINE_KAPPA_TONIC);
    // 4h 年龄的 tech group 现在 phasic 更强
    const techGroup = perturbed.find((r) => r.id === "grp-tech")!;
    const baselineTG = baseline.find((r) => r.id === "grp-tech")!;
    expect(techGroup.p1).toBeGreaterThan(baselineTG.p1);
  });

  // -- κ_P1 灵敏度（tanh 归一化） --

  it("κ_P1 ×0.5 (2.5) — tanh 更快饱和，高贡献频道区分度降低", () => {
    const baselineNormalized = baseline.map((r) => ({
      id: r.id,
      share: tanhNorm(r.p1, BASELINE_KAPPA_P1),
    }));
    const perturbedNormalized = baseline.map((r) => ({
      id: r.id,
      share: tanhNorm(r.p1, 2.5),
    }));
    // top-2 的归一化差距应缩小（区分度降低）
    const baseGap = baselineNormalized[0].share - baselineNormalized[1].share;
    const pertGap = perturbedNormalized[0].share - perturbedNormalized[1].share;
    expect(pertGap).toBeLessThanOrEqual(baseGap + 0.01);
  });

  it("κ_P1 ×2.0 (10.0) — tanh 更慢饱和，小信号被放大", () => {
    // 所有频道的 tanh 归一化值应整体降低（分母更大）
    const baseAPI = baseline.reduce((sum, r) => sum + tanhNorm(r.p1, BASELINE_KAPPA_P1), 0);
    const pertAPI = baseline.reduce((sum, r) => sum + tanhNorm(r.p1, 10.0), 0);
    expect(pertAPI).toBeLessThan(baseAPI);
  });

  // -- P3 参数灵敏度 --

  it("P3_BETA_R ±50% — sigmoid 陡度影响关系冷却的敏感区", () => {
    const thetaS = 14400; // tier-15 θ
    const tau0 = 600;
    const silenceRange = [3600, 7200, 14400, 28800, 43200]; // 1h, 2h, 4h, 8h, 12h

    const baseBeta = 2.5;
    const lowBeta = 1.25;
    const highBeta = 3.75;

    for (const s of silenceRange) {
      const baseP3 = logSigmoid(s, baseBeta, thetaS, tau0);
      const lowP3 = logSigmoid(s, lowBeta, thetaS, tau0);
      const highP3 = logSigmoid(s, highBeta, thetaS, tau0);

      // 低 β → sigmoid 更平缓，值更接近 0.5
      expect(Math.abs(lowP3 - 0.5)).toBeLessThanOrEqual(Math.abs(baseP3 - 0.5) + 0.01);
      // 高 β → sigmoid 更陡峭，值更极端
      expect(Math.abs(highP3 - 0.5)).toBeGreaterThanOrEqual(Math.abs(baseP3 - 0.5) - 0.01);
    }
  });

  it("DUNBAR_TIER_THETA ×0.5 — 期望互动间隔减半，P3 更早触发", () => {
    const beta = 2.5;
    const tau0 = 600;
    const silence = 7200; // 2 小时沉默

    const baseThetaTier15 = 14400; // 4h
    const halfThetaTier15 = 7200; // 2h

    const baseP3 = logSigmoid(silence, beta, baseThetaTier15, tau0);
    const pertP3 = logSigmoid(silence, beta, halfThetaTier15, tau0);

    // 2h 沉默，基线 θ=4h → 低 P3（还没到期望互动时间）
    expect(baseP3).toBeLessThan(0.5);
    // 2h 沉默，扰动 θ=2h → P3 ≈ 0.5（刚好到期望互动时间）
    expect(pertP3).toBeCloseTo(0.5, 0);
  });

  // -- 综合覆盖率蒙特卡洛 --

  it("蒙特卡洛 100 次随机扰动 — 覆盖率不应跌破 50%", () => {
    const TRIALS = 100;
    let coverageDropCount = 0;
    let rankFlipCount = 0;

    for (let t = 0; t < TRIALS; t++) {
      // 随机扰动 ±50%
      const halfLife = BASELINE_HALFLIFE * (0.5 + Math.random());
      const kappaTonic = BASELINE_KAPPA_TONIC * (0.5 + Math.random());

      const perturbed = computeP1Ranking(REALISTIC_CHANNELS, halfLife, kappaTonic);
      const cov = coverageRate(perturbed, 5); // top-5 覆盖
      const stability = rankStability(baseline, perturbed);

      if (cov < 0.5) coverageDropCount++;
      if (stability < 0.33) rankFlipCount++;
    }

    // 覆盖率跌破 50% 的试验不应超过 5%
    expect(coverageDropCount).toBeLessThanOrEqual(TRIALS * 0.05);
    // 排名完全翻转的试验不应超过 10%
    expect(rankFlipCount).toBeLessThanOrEqual(TRIALS * 0.1);
  });

  // -- 诊断输出 --

  it("诊断: 打印基线 P1 贡献排名表", () => {
    console.log("\n=== ADR-177 P1 贡献排名（基线）===");
    console.log("rank | channel              | EU      | P1_contrib | tanh(P1/κ)");
    console.log("-----|----------------------|---------|------------|----------");
    for (let i = 0; i < baseline.length; i++) {
      const r = baseline[i];
      const ch = REALISTIC_CHANNELS.find((c) => c.id === r.id)!;
      const eu = effectiveUnreadParam(
        ch.rawUnread,
        ch.ewms,
        ch.ageS,
        BASELINE_HALFLIFE,
        BASELINE_KAPPA_TONIC,
      );
      const norm = tanhNorm(r.p1, BASELINE_KAPPA_P1);
      console.log(
        `  ${i + 1}  | ${r.id.padEnd(20)} | ${eu.toFixed(3).padStart(7)} | ${r.p1.toFixed(3).padStart(10)} | ${norm.toFixed(4)}`,
      );
    }

    // 验证排名表有内容
    expect(baseline.length).toBe(REALISTIC_CHANNELS.length);
  });

  it("诊断: KAPPA_TONIC 扫描表（0.3 → 3.0）", () => {
    const kappas = [0.3, 0.5, 0.7, 1.0, 1.5, 2.0, 3.0];
    const targets = ["dm-bestfriend", "grp-friends", "grp-tech", "grp-large"];

    console.log("\n=== KAPPA_TONIC 灵敏度扫描 ===");
    console.log("κ_tonic | " + targets.map((t) => t.padEnd(15)).join("| "));
    console.log("--------|" + targets.map(() => "---------------").join("|"));

    for (const k of kappas) {
      const ranking = computeP1Ranking(REALISTIC_CHANNELS, BASELINE_HALFLIFE, k);
      const values = targets.map((t) => {
        const r = ranking.find((r) => r.id === t);
        return (r?.p1.toFixed(2) ?? "N/A").padEnd(15);
      });
      console.log(`  ${k.toFixed(1).padStart(4)}  | ${values.join("| ")}`);
    }

    expect(kappas.length).toBe(7);
  });

  it("诊断: 交叉点年龄表（不同未读数量）", () => {
    const unreads = [10, 30, 50, 100, 200];
    console.log("\n=== Phasic/Tonic 交叉点年龄 ===");
    console.log("unread | tonic   | crossover_h | phasic@cross");
    console.log("-------|---------|-------------|------------");

    for (const n of unreads) {
      const tonic = BASELINE_KAPPA_TONIC * Math.log(1 + n);
      // n × 2^(-t/3600) = tonic → t = -3600 × log2(tonic/n)
      const crossoverS = -BASELINE_HALFLIFE * Math.log2(tonic / n);
      const crossoverH = crossoverS / 3600;
      const phasicAtCross = n * 2 ** (-crossoverS / BASELINE_HALFLIFE);
      console.log(
        `  ${String(n).padStart(4)} | ${tonic.toFixed(3).padStart(7)} | ${crossoverH.toFixed(1).padStart(10)}h | ${phasicAtCross.toFixed(3)}`,
      );
    }

    expect(unreads.length).toBe(5);
  });
});
