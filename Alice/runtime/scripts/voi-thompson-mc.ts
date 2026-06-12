/**
 * 蒙特卡洛模拟：VoI × Thompson 探索平衡分析。
 *
 * 验证 VoI 确定性探索奖励和 Thompson Sampling 随机扰动同时启用时，
 * 是否导致对高 σ² 目标的过度探索。
 *
 * 用法：npx tsx runtime/scripts/voi-thompson-mc.ts
 *
 * @see docs/adr/151-algorithm-audit/
 */

// ── 参数 ─────────────────────────────────────────────────────────
const SIGMA2_OBS = 0.1; // 与 iaus-scorer.ts 一致
const N_TRIALS = 10_000; // 每种配置模拟次数

// 5 个候选：σ² 从低到高，base NSV 从高到低（高 σ² 目标略低 NSV）
const candidates = [
  { label: "A (σ²=0.1)", sigma2: 0.1, baseNSV: 0.5 },
  { label: "B (σ²=0.3)", sigma2: 0.3, baseNSV: 0.4 },
  { label: "C (σ²=0.5)", sigma2: 0.5, baseNSV: 0.35 },
  { label: "D (σ²=0.7)", sigma2: 0.7, baseNSV: 0.3 },
  { label: "E (σ²=1.0)", sigma2: 1.0, baseNSV: 0.25 },
];

// 4 种配置
const configs = [
  { name: "Neither (γ=0, η=0)", gamma: 0, eta: 0 },
  { name: "VoI-only (γ=0.15, η=0)", gamma: 0.15, eta: 0 },
  { name: "Thompson-only (γ=0, η=0.1)", gamma: 0, eta: 0.1 },
  { name: "Both (γ=0.15, η=0.1)", gamma: 0.15, eta: 0.1 },
];

// ── 工具函数 ─────────────────────────────────────────────────────
function computeVoI(sigma2: number): number {
  return sigma2 / (sigma2 + SIGMA2_OBS);
}

function gaussianRandom(): number {
  const u1 = Math.random();
  const u2 = Math.random();
  return Math.sqrt(-2 * Math.log(u1 || 1e-10)) * Math.cos(2 * Math.PI * u2);
}

function std(arr: number[]): number {
  const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
  const variance = arr.reduce((sum, v) => sum + (v - mean) ** 2, 0) / arr.length;
  return Math.sqrt(variance);
}

// ── 单次 softmax 选择 ────────────────────────────────────────────
function softmaxSelect(values: number[], sigma2s: number[], gamma: number, eta: number): number {
  // Phase 1: 加入 VoI 确定性奖励
  const nsvWithVoI = values.map((v, i) => v + gamma * computeVoI(sigma2s[i]));

  // Phase 2: Thompson 噪声叠加
  const softmaxValues =
    eta > 0
      ? nsvWithVoI.map((v, i) => {
          const s2 = sigma2s[i];
          return s2 > 0 ? v + eta * Math.sqrt(s2) * gaussianRandom() : v;
        })
      : [...nsvWithVoI];

  // Axiom 4: V > 0 过滤
  const validIndices = softmaxValues.map((v, i) => ({ v, i })).filter((x) => x.v > 0);
  if (validIndices.length === 0) return -1;

  // 自适应温度 softmax
  const vVals = validIndices.map((x) => x.v);
  const spread = std(vVals);
  const tau = 0.05 + 0.2 / (1 + spread * 5);

  const maxV = Math.max(...vVals);
  const exps = vVals.map((v) => Math.exp((v - maxV) / tau));
  const sumExp = exps.reduce((a, b) => a + b, 0);
  const probs = exps.map((e) => e / sumExp);

  const r = Math.random();
  let cum = 0;
  for (let i = 0; i < probs.length; i++) {
    cum += probs[i];
    if (r < cum) return validIndices[i].i;
  }
  return validIndices[validIndices.length - 1].i;
}

// ── 主模拟 ───────────────────────────────────────────────────────
console.log("=".repeat(72));
console.log("VoI × Thompson 探索平衡 — 蒙特卡洛模拟");
console.log(`候选数: ${candidates.length}, 每配置试验数: ${N_TRIALS}`);
console.log("=".repeat(72));

// 打印候选信息
console.log("\n候选信息:");
console.log("  候选  |  σ²   | base NSV | VoI(σ²) | γ·VoI(0.15) | η·√σ²·1.96 (0.1)");
console.log("  ------|-------|----------|---------|-------------|------------------");
for (const c of candidates) {
  const voi = computeVoI(c.sigma2);
  const gammaVoI = 0.15 * voi;
  const thompson95 = 0.1 * Math.sqrt(c.sigma2) * 1.96;
  console.log(
    `  ${c.label.padEnd(13)} | ${c.sigma2.toFixed(1)}   | ${c.baseNSV.toFixed(2)}     | ${voi.toFixed(3)}   | ${gammaVoI.toFixed(4)}       | ±${thompson95.toFixed(4)}`,
  );
}

// 运行 4 种配置
for (const cfg of configs) {
  const counts = new Array(candidates.length).fill(0);
  const sigma2s = candidates.map((c) => c.sigma2);
  const baseNSVs = candidates.map((c) => c.baseNSV);

  for (let t = 0; t < N_TRIALS; t++) {
    const winner = softmaxSelect(baseNSVs, sigma2s, cfg.gamma, cfg.eta);
    if (winner >= 0) counts[winner]++;
  }

  const total = counts.reduce((a: number, b: number) => a + b, 0);
  console.log(`\n── ${cfg.name} ──`);
  for (let i = 0; i < candidates.length; i++) {
    const freq = total > 0 ? counts[i] / total : 0;
    const bar = "█".repeat(Math.round(freq * 50));
    console.log(`  ${candidates[i].label.padEnd(13)} : ${(freq * 100).toFixed(1)}% ${bar}`);
  }
}

// ── 附加分析：扫描 gamma × eta 参数空间 ────────────────────────────
console.log("\n" + "=".repeat(72));
console.log("参数空间扫描：高 σ² 目标（E, σ²=1.0）的选中频率");
console.log("=".repeat(72));

const gammaRange = [0, 0.05, 0.1, 0.15, 0.2, 0.3, 0.5];
const etaRange = [0, 0.05, 0.1, 0.15, 0.2, 0.3];
const sigma2s = candidates.map((c) => c.sigma2);
const baseNSVs = candidates.map((c) => c.baseNSV);

// 表头
process.stdout.write("γ\\η".padStart(6) + " |");
for (const eta of etaRange) {
  process.stdout.write(` ${eta.toFixed(2).padStart(6)} |`);
}
console.log("");
console.log("-".repeat(6 + (etaRange.length * 9 + 1)));

for (const gamma of gammaRange) {
  process.stdout.write(`${gamma.toFixed(2).padStart(6)} |`);
  for (const eta of etaRange) {
    const counts = new Array(candidates.length).fill(0);
    const trials = 5000;
    for (let t = 0; t < trials; t++) {
      const winner = softmaxSelect(baseNSVs, sigma2s, gamma, eta);
      if (winner >= 0) counts[winner]++;
    }
    const total = counts.reduce((a: number, b: number) => a + b, 0);
    const freqE = total > 0 ? (counts[4] / total) * 100 : 0;
    process.stdout.write(` ${freqE.toFixed(1).padStart(5)}% |`);
  }
  console.log("");
}

// ── 附加分析 2：NSV 差距翻转阈值 ─────────────────────────────────
console.log("\n" + "=".repeat(72));
console.log("翻转阈值：高 σ² 目标需要多大 base NSV 劣势才能被抑制？");
console.log("(配置: γ=0.15, η=0.1, 判定阈值: 选中频率 < 20%)");
console.log("=".repeat(72));

// 固定候选 A (σ²=0.1, NSV=0.5) 和候选 E (σ²=1.0, NSV=variable)
// 扫描 E 的 base NSV 从 0.5 到 0.0
const nsvSweep = [0.5, 0.45, 0.4, 0.35, 0.3, 0.25, 0.2, 0.15, 0.1, 0.05];
console.log("\n2 候选场景：A (σ²=0.1, NSV=0.50) vs E (σ²=1.0, NSV=变化)");
console.log("  E的baseNSV | NSV差距 | Neither | VoI-only | Thompson | Both");
console.log("  -----------|---------|---------|----------|----------|------");

for (const eNsv of nsvSweep) {
  const twoSigma2s = [0.1, 1.0];
  const gap = 0.5 - eNsv;
  const results: string[] = [];

  for (const cfgInner of configs) {
    const counts = [0, 0];
    const trials = 5000;
    for (let t = 0; t < trials; t++) {
      const winner = softmaxSelect([0.5, eNsv], twoSigma2s, cfgInner.gamma, cfgInner.eta);
      if (winner >= 0) counts[winner]++;
    }
    const total = counts[0] + counts[1];
    const freqE = total > 0 ? (counts[1] / total) * 100 : 0;
    results.push(`${freqE.toFixed(1).padStart(5)}%`);
  }

  console.log(
    `  ${eNsv.toFixed(2).padStart(10)} | ${gap.toFixed(2).padStart(7)} | ${results.join("  |  ")}`,
  );
}

console.log("\n模拟完成。");
