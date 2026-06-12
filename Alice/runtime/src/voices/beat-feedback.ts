/**
 * ADR-23 Wave 2: Beat 类型驱动的多维人格反馈。
 *
 * 替代 v4 的二值 success ? 0.7 : -0.5 反馈机制。
 * 每种 Beat 类型对应一组声部权重调整方向，
 * 使人格向量的演化更精确地反映 Alice 的社交行为模式。
 *
 * 有 BEAT → 用 BEAT_FEEDBACK_MAP 多维反馈
 * 无 BEAT → 退化到 v4 降权反馈（success ? 0.2 : -0.5）
 *
 * ADR-214 Wave B: 参数从 ExecutableResult 改为 ScriptExecutionResult。
 * shell-native 下 BEAT/rate_outcome 通过 Engine API dispatch 执行，
 * 不在 completedActions 中追踪。extractBeatTypes/extractOutcomeFeedback
 * 在当前架构下始终返回空——人格反馈退化到 v4 路径（success ? 0.3 : -0.3）。
 * 保留接口以便后续 completedActions 扩展。
 *
 * ADR-131: QUALITY_MAP 为 rate_outcome 的单一语义映射源。
 * observer.mod 和 extractOutcomeFeedback 共用，消除语义裂缝。
 */
import type { ScriptExecutionResult } from "../core/script-execution.js";
import type { BeatType } from "../mods/threads.mod.js";

/** 单条声部反馈。 */
export interface VoiceFeedback {
  /** 声部索引: 0=Diligence, 1=Curiosity, 2=Sociability, 3=Caution。ADR-81: 4 维。 */
  voice: number;
  /** 反馈幅度（正=强化，负=抑制）。 */
  magnitude: number;
}

/**
 * Beat 类型 → 人格向量反馈映射。
 *
 * 设计原则：
 * - observation → 好奇心得到满足
 * - engagement → 社交能力得到锻炼
 * - assistance → 尽责性得到验证
 * - misstep → 谨慎性强化 + 社交性微抑制（从错误中学习）
 * - connection → 社交性强化（深度连接）
 * - insight → 洞察力验证（ADR-81: 映射到 Curiosity，反思是涌现属性）
 */
export const BEAT_FEEDBACK_MAP: Record<string, VoiceFeedback[]> = {
  observation: [{ voice: 1, magnitude: 0.3 }],
  engagement: [{ voice: 2, magnitude: 0.3 }],
  assistance: [{ voice: 0, magnitude: 0.3 }],
  misstep: [
    { voice: 3, magnitude: 0.4 },
    { voice: 2, magnitude: -0.2 },
  ],
  connection: [{ voice: 2, magnitude: 0.5 }],
  insight: [{ voice: 1, magnitude: 0.4 }], // ADR-81: voice 4 (Reflection) → voice 1 (Curiosity)
  // ADR-181: Caution 正向强化路径（RST BIS "relief" 信号）
  prudence: [
    { voice: 3, magnitude: 0.3 }, // 审慎评估成功 → Caution 正强化
    { voice: 1, magnitude: 0.15 }, // 审慎带来洞察 → 轻微 Curiosity 强化
  ],
  breakthrough: [
    { voice: 2, magnitude: 0.4 }, // 社交冒险成功 → Sociability 强化
    { voice: 3, magnitude: -0.2 }, // 成功趋近 → BAS 奖励抑制 BIS
  ],
  // kernel 和 ambient 使用默认反馈
};

/**
 * ADR-131: LLM 语义标签 → 数值的单一映射源。
 *
 * rate_outcome 的 quality 参数是语义标签（ADR-50 原则），
 * 代码侧统一在此完成映射。observer.mod 和 extractOutcomeFeedback 共用。
 * @see docs/adr/131-feedback-loop-integrity.md §D1
 */
export const QUALITY_MAP: Record<string, number> = {
  excellent: 0.9,
  good: 0.5,
  fair: 0.0,
  poor: -0.5,
  terrible: -0.9,
};

/**
 * 从 ScriptExecutionResult 提取 BEAT 调用的 beatType。
 *
 * ADR-214 Wave B: shell-native 下 BEAT 通过 Engine API dispatch 执行，
 * 不在 completedActions 中追踪。当前始终返回空数组。
 * 保留接口以便后续 completedActions 格式扩展。
 */
export function extractBeatTypes(_result: ScriptExecutionResult): BeatType[] {
  // shell-native: dispatch 动作不在 completedActions 中追踪
  // completedActions 格式: "sent:chatId=X:msgId=Y", "sticker:...", "forwarded:..." 等
  // BEAT dispatch 不输出 __ALICE_ACTION__ 控制行
  return [];
}

/**
 * 从 Beat 类型数组提取多维人格反馈。
 *
 * 返回 null 表示无 Beat（应退化到 v4 反馈）。
 * 多个 Beat 的反馈叠加。
 *
 * ADR-214 Wave B: shell-native 下始终返回 null（无 BEAT 数据）。
 */
export function extractBeatFeedback(result: ScriptExecutionResult): VoiceFeedback[] | null {
  const beatTypes = extractBeatTypes(result);
  if (beatTypes.length === 0) return null;

  const feedbacks: VoiceFeedback[] = [];
  for (const bt of beatTypes) {
    const mapped = BEAT_FEEDBACK_MAP[bt];
    if (mapped) {
      feedbacks.push(...mapped);
    }
  }

  return feedbacks.length > 0 ? feedbacks : null;
}

/**
 * ADR-31: 从 rate_outcome 指令提取实时人格反馈。
 *
 * ADR-214 Wave B: shell-native 下 rate_outcome 通过 dispatch 执行，
 * 不在 completedActions 中追踪。当前始终返回 null。
 */
export function extractOutcomeFeedback(_result: ScriptExecutionResult): VoiceFeedback[] | null {
  // shell-native: dispatch 动作不在 completedActions 中追踪
  return null;
}
