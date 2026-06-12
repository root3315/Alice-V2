/**
 * 行动选择（softmax with adaptive τ）。
 * 对应 Python voices.py select_action()。
 */
import { std } from "../utils/math.js";
import { VOICE_BY_INDEX, type VoiceAction } from "./personality.js";

/**
 * Adaptive-temperature softmax。
 *
 * 温度自适应：
 * - 声部分化度高（std 大）→ 低温 → 近似确定性
 * - 声部分化度低（std 小）→ 高温 → 增加探索
 *
 * τ = 0.1 + 0.3 / (1 + std(L) · 10)
 *
 * @see paper-five-dim/ Def 3.6
 */
function voiceSoftmax(loudness: number[]): { probs: number[]; tau: number } {
  const spread = std(loudness);
  const tau = 0.1 + 0.3 / (1.0 + spread * 10.0);
  const maxL = Math.max(...loudness);
  const shifted = loudness.map((l) => l - maxL);
  const logProbs = shifted.map((s) => Math.max(-50.0, Math.min(0.0, s / tau)));
  const exps = logProbs.map(Math.exp);
  const probSum = exps.reduce((a, b) => a + b, 0);
  const probs =
    probSum > 0 ? exps.map((e) => e / probSum) : loudness.map(() => 1.0 / loudness.length);
  return { probs, tau };
}

/**
 * 概率化行动选择。
 *
 * @returns [获胜声部索引, 行动类型名称]
 */
export function selectAction(
  loudness: number[],
  /** 传入 [0,1) 的随机数用于测试；null 则用 Math.random() */
  randomOverride: number | null = null,
): [number, VoiceAction] {
  // 空数组防护（不应发生，但防止 Math.max(...[]) = -Infinity）
  if (loudness.length === 0) return [0, VOICE_BY_INDEX[0]];

  const { probs } = voiceSoftmax(loudness);

  // 加权随机选择
  const r = randomOverride ?? Math.random();
  let cumulative = 0;
  let winner = probs.length - 1; // 浮点尾巴归最后一个声部
  for (let i = 0; i < probs.length; i++) {
    cumulative += probs[i];
    if (r < cumulative) {
      winner = i;
      break;
    }
  }

  return [winner, VOICE_BY_INDEX[winner]];
}
