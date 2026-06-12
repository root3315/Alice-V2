/**
 * Strategy Mod — 人格漂移审计。
 *
 * M4 人格漂移检测：
 * - drift = l2Distance(π_current, π_home): 累积偏离度
 * - velocity = l2Distance(π_current, π_previous) / interval: 瞬时变化率
 * - 分类: healthy (< 0.1) / warning (0.1~0.2) / alert (>= 0.2)
 *
 * 参考: Ashton & Lee (2007) HEXACO — 人格长期稳定但环境可引发漂移。
 */
import { PromptBuilder } from "../../core/prompt-style.js";
import type { ContributionItem, ModContext } from "../../core/types.js";
import { section } from "../../core/types.js";
import { estimateAgeS } from "../../pressure/clock.js";
import { l2Distance } from "../../utils/math.js";
import { VOICE_COUNT } from "../../voices/personality.js";
import {
  DRIFT_ALERT_THRESHOLD,
  DRIFT_AUDIT_INTERVAL,
  DRIFT_WARNING_THRESHOLD,
  parseJsonWeights,
  type StrategyHint,
  type StrategyState,
} from "./types.js";

/**
 * 解析并自动修正人格权重维度。
 *
 * 图属性中可能残留旧维度的数据（如 ADR-81 前的 5 维向量）。
 * 此函数：
 * 1. 解析 JSON 权重
 * 2. 维度不匹配时自动修正（截断多余 / 补均匀值）并归一化到 sum=1
 * 3. 修正后写回图属性（自愈——脏数据只被修正一次，后续 tick 不再触发）
 *
 * @param raw       图属性原始值
 * @param attrName  属性名（用于写回）
 * @param graph     图引用（用于写回）
 * @returns 保证 VOICE_COUNT 维的权重数组
 */
function resolveWeights(
  raw: unknown,
  attrName: string,
  graph: ModContext<StrategyState>["graph"],
): number[] {
  const parsed = parseJsonWeights(raw);
  if (!parsed) {
    // 无数据 → 均匀分布
    return Array.from({ length: VOICE_COUNT }, () => 1 / VOICE_COUNT);
  }
  if (parsed.length === VOICE_COUNT) return parsed;

  // 维度不匹配 → 自动修正
  let fixed: number[];
  if (parsed.length > VOICE_COUNT) {
    // 截断多余维度
    fixed = parsed.slice(0, VOICE_COUNT);
  } else {
    // 补均匀值
    fixed = [...parsed];
    const pad = 1 / VOICE_COUNT;
    while (fixed.length < VOICE_COUNT) fixed.push(pad);
  }
  // 归一化到 sum=1
  const sum = fixed.reduce((a, b) => a + b, 0);
  if (sum > 0) {
    for (let i = 0; i < fixed.length; i++) fixed[i] /= sum;
  }
  // 写回图属性——自愈，下次不再触发修正
  if (graph.has("self")) {
    graph.setDynamic("self", attrName, JSON.stringify(fixed));
  }
  return fixed;
}

/**
 * 人格漂移审计 — 每 DRIFT_AUDIT_INTERVAL ticks 评估偏离度。
 *
 * 在 onTickEnd 中调用。修改 ctx.state.personalityDrift 并写入图属性。
 *
 * @returns 漂移 hint（warning/alert 时）或 null
 */
export function auditPersonalityDrift(ctx: ModContext<StrategyState>): StrategyHint | null {
  if (ctx.tick <= 0 || ctx.tick % DRIFT_AUDIT_INTERVAL !== 0 || !ctx.graph.has("self")) {
    return null;
  }

  const selfAttrs = ctx.graph.getAgent("self");
  const currentWeights = resolveWeights(
    selfAttrs.personality_weights,
    "personality_weights",
    ctx.graph,
  );
  const piHome = resolveWeights(selfAttrs.pi_home, "pi_home", ctx.graph);

  const pd = ctx.state.personalityDrift;
  const drift = l2Distance(currentWeights, piHome);
  // previousWeights 维度不匹配时视为首次审计（velocity=0）
  const prevWeights = pd.previousWeights;
  const prevValid = prevWeights !== null && prevWeights.length === VOICE_COUNT;
  // ADR-110/166: velocity 使用 estimateAgeS 统一墙钟/tick 回退
  const elapsedS = Math.max(
    1,
    estimateAgeS({ ms: pd.lastAuditMs ?? 0, tick: pd.lastAuditTick }, ctx.nowMs, ctx.tick),
  );
  const velocity = prevValid ? l2Distance(currentWeights, prevWeights) / elapsedS : 0;

  let health: "healthy" | "warning" | "alert";
  if (drift >= DRIFT_ALERT_THRESHOLD) health = "alert";
  else if (drift >= DRIFT_WARNING_THRESHOLD) health = "warning";
  else health = "healthy";

  pd.drift = drift;
  pd.velocity = velocity;
  pd.health = health;
  pd.previousWeights = [...currentWeights];
  pd.lastAuditTick = ctx.tick;
  pd.lastAuditMs = ctx.nowMs;

  // 写入图属性（供 evolve.ts 自适应 γ 和外部诊断）
  // 注意：drift/velocity 是引擎内部数值，不应暴露给 LLM。
  // 前缀 _ 标记为内部属性；health 是语义标签，安全暴露。
  ctx.graph.setDynamic("self", "_personality_drift", drift);
  ctx.graph.setDynamic("self", "_personality_velocity", velocity);
  ctx.graph.setDynamic("self", "personality_health", health);

  if (health === "healthy") return null;

  return {
    type: "personality_drift",
    message:
      health === "alert"
        ? "Personality shifted significantly from baseline. Recent interactions may be pulling away from natural tendencies."
        : "Personality drifted slightly from baseline. Minor drift is normal.",
  };
}

/**
 * 构建人格漂移 contribute section。
 *
 * 始终注入（有审计数据时），内容因 health 不同而不同。
 *
 * @returns ContributionItem 或 null（无审计数据时）
 */
export function buildDriftSection(state: StrategyState): ContributionItem | null {
  if (state.personalityDrift.lastAuditTick <= 0) return null;

  const pd = state.personalityDrift;
  const driftLabel =
    pd.health === "alert"
      ? "significant drift from baseline"
      : pd.health === "warning"
        ? "noticeable drift from baseline"
        : "within normal range";
  const driftBuilder = new PromptBuilder();
  driftBuilder.line(`Personality: ${driftLabel}.`);
  if (pd.health === "alert") {
    driftBuilder.line(
      "Personality shifted significantly from baseline. Recent interactions may be pulling away from natural tendencies.",
    );
  }
  return section("personality-drift", driftBuilder.build(), "Personality audit", 35, 55);
}
