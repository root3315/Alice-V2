/**
 * D5: Social Cost Function — Brown-Levinson 礼貌理论的计算实现。
 *
 * 四个子组件量化"打扰别人的代价"：
 *   C_dist  — 社交距离（互惠失衡、tier 差异、时间间隔）
 *   C_power — 权力差异（群组角色、领地效应）
 *   C_imp   — 行动侵入性（上下文敏感度、行动类型排序）
 *   C_temp  — 时间序列惩罚（行动密度、行动重复度）
 *
 * @see paper/ Definition 8: Social Cost Function
 * @see docs/adr/62-d5-social-cost-paper-alignment.md
 */
import { z } from "zod";
import { chatIdToContactId, DUNBAR_TIER_THETA } from "../graph/constants.js";
import type { DunbarTier } from "../graph/entities.js";
import { findActiveConversation } from "../graph/queries.js";
import type { WorldModel } from "../graph/world-model.js";
import { ChatTarget } from "../prompt/types.js";
import { elapsedS, LEGACY_TICK_INTERVAL_MS, readNodeMs } from "./clock.js";
import { proactiveCooldownForTier } from "./goldilocks.js";
import { getDefaultParams, type HawkesState, queryIntensity } from "./hawkes.js";
import {
  effectiveActSilences,
  effectiveOutcomeQuality,
  effectiveOutgoing,
  effectiveRisk,
} from "./signal-decay.js";

// -- 行动侵入性排序表 -------------------------------------------------------

/**
 * 行动类型 → 侵入性评分 ∈ [0, 1]（私聊基准）。
 *
 * @see paper/ Definition 8, C_imp: intrusiveness(a)
 * @see docs/adr/113-online-social-recalibration.md
 */
export const INTRUSIVENESS: Record<string, number> = {
  proactive_message: 1.0, // 主动发消息（最高侵入性）
  send_message: 0.8, // 一般发消息
  sociability: 0.8, // 声部: 社交 → 会发消息
  reply: 0.6, // 回复
  diligence: 0.6, // 声部: 尽责 → 通常是回复
  react: 0.3, // 表情反应
  curiosity: 0.3, // 声部: 好奇 → 轻量互动
  mark_read: 0.1, // 已读
  caution: 0.1, // 声部: 谨慎 → 低侵入
};

/**
 * 群组/超级群组行动侵入性评分。
 * 群组是共享空间，大多数行动的侵入性低于私聊。
 *
 * @see docs/adr/113-online-social-recalibration.md §D1
 */
const INTRUSIVENESS_GROUP: Record<string, number> = {
  // ADR-113 修正：群聊参与门槛低，但公开发言有内容风险（N 人可见）。
  // 主动发言和 proactive 提高到 0.4（不是"几乎无成本"）。
  // reply 保持 0.2（回应已有话题确实门槛最低）。
  proactive_message: 0.4,
  send_message: 0.4,
  sociability: 0.4,
  reply: 0.2,
  diligence: 0.2,
  react: 0.1,
  curiosity: 0.2,
  mark_read: 0.1,
  caution: 0.1,
};

/**
 * 按 chat_type 查询行动侵入性。
 * 群组中参与门槛低于私聊，但公开发言有内容风险（说错话 N 人看到）。
 *
 * @see docs/adr/113-online-social-recalibration.md §D1
 */
export function getIntrusiveness(action: string, chatType?: string): number {
  if (ChatTarget.isGroupChat(chatType)) {
    return INTRUSIVENESS_GROUP[action] ?? INTRUSIVENESS[action] ?? 0.5;
  }
  return INTRUSIVENESS[action] ?? 0.5;
}

// -- 配置 Schema（Zod 校验） -------------------------------------------------

const w01 = z.number().min(0).max(1);
const pos = z.number().positive();

/**
 * SocialCostConfig Zod schema — 四子组件配置的单一真相源。
 *
 * 启动时 parse 一次，保证所有权重在合法区间内。
 * @see paper/ Definition 8: Social Cost Function
 */
export const SocialCostConfigSchema = z.object({
  // 总权重（四组件加权求和）
  wDist: w01.default(0.3),
  wPower: w01.default(0.1),
  wImp: w01.default(0.3),
  wTemp: w01.default(0.3),

  // C_dist 子权重
  alpha1: w01.default(0.5),
  alpha2: w01.default(0.3),
  alpha3: w01.default(0.2),
  tauDist: pos.default(3600),

  // C_power 子权重
  beta1: w01.default(0.7),
  beta2: w01.default(0.3),

  // C_imp 子权重
  gamma1: w01.default(0.5),
  gamma2: w01.default(0.5),

  // C_temp 子权重
  delta1: w01.default(0.7),
  delta2: w01.default(0.3),
  // ADR-189: bypass 泄漏修正后重新校准（旧值 3.0 在 bypass 频繁绕过时校准，
  // 现在 bypass 仅限有义务 target，exp(-n/λ) 全量生效，需加宽允许带宽）
  lambdaC: pos.default(6.0),

  // Net Social Value
  lambda: z.number().min(1).default(1.5),

  // Window
  window: z.number().int().positive().default(1800),
});

export type SocialCostConfig = z.infer<typeof SocialCostConfigSchema>;

/** 默认 Social Cost 配置（保守：宁可沉默也不打扰）。 */
export const DEFAULT_SOCIAL_COST_CONFIG: SocialCostConfig = SocialCostConfigSchema.parse({});

// -- tier 相关常量 -----------------------------------------------------------

/** tier 最大值（用于归一化）。 */
const TIER_MAX = 500;

/** 群组角色 → rank 映射。 */
const ROLE_RANK: Record<string, number> = {
  owner: 4,
  admin: 3,
  member: 2,
  restricted: 1,
};
const RANK_MAX = 4;

// -- 子组件计算 -------------------------------------------------------------

/**
 * C_dist(n): 社交距离。
 *
 * 三个子项加权求和：
 *   α₁ · |sent - recv| / window    — 互惠失衡
 *   α₂ · (1 - tier / tier_max)     — tier 距离
 *   α₃ · σ(t_gap / τ_d)           — 最近交互时间 sigmoid
 *
 * @see paper/ Definition 8, C_dist
 */
function cDist(
  aliceSentWindow: number,
  contactRecvWindow: number,
  tier: number,
  tGap: number,
  cfg: SocialCostConfig,
  isGroup = false,
): number {
  const w = Math.max(cfg.window, 1);

  // 互惠失衡：Alice 发太多 vs 对方发太少
  // P1-1 fix: clamp 到 [0, 1]，防止长期累计 sent/recv 导致溢出
  // ADR-113: 群组中互惠失衡信号弱化（× 0.3）——群组对话不要求一对一平衡
  const reciprocityRaw = Math.min(1, Math.abs(aliceSentWindow - contactRecvWindow) / w);
  const reciprocity = reciprocityRaw * (isGroup ? 0.3 : 1.0);

  // tier 距离：tier 越远 → 社交距离越大
  // ADR-116: 群组中弱化——共享空间发言门槛低于私聊主动联系
  // @see docs/adr/116-group-silence-trap.md §修复 3
  const tierDist = (1 - tier / TIER_MAX) * (isGroup ? 0.4 : 1.0);

  // 时间间隔 sigmoid：很久没互动 → 距离感变大
  // P3-2 fix: 偏移 sigmoid，让 tGap=0 时接近 0 而非 0.5
  // σ(tGap; τ) = 1 / (1 + exp(-(tGap - 2τ) / τ))
  //   tGap=0   → ~0.12（刚互动过，距离感低）
  //   tGap=2τ  → 0.5
  //   tGap>>τ  → ~1.0（很久没互动，距离感高）
  //
  // ADR-151: tauDist per-tier 化 — τ_d = θ_c/2，使 sigmoid 中性点对齐各 tier 的冷却阈值。
  // 效果：tier 5 保持 3600s（与原值一致），tier 50 升至 21600s，tier 150 升至 86400s。
  // fallback 到 cfg.tauDist（3600s）用于无标准 tier 的情况。
  // @see docs/adr/151-algorithm-audit/research-online-calibration.md §5.3
  const thetaForTier = DUNBAR_TIER_THETA[tier as DunbarTier];
  const effectiveTauDist = thetaForTier != null ? thetaForTier / 2 : cfg.tauDist;
  const sigmoid =
    1 / (1 + Math.exp(-(tGap - 2 * effectiveTauDist) / Math.max(effectiveTauDist, 1)));

  return cfg.alpha1 * reciprocity + cfg.alpha2 * tierDist + cfg.alpha3 * sigmoid;
}

/**
 * C_power(n): 权力差异。
 *
 * @see paper/ Definition 8, C_power
 */
function cPower(
  aliceRank: number,
  targetRank: number,
  isTargetTerritory: boolean,
  cfg: SocialCostConfig,
): number {
  // 对方 rank 高于 Alice → 更大压力
  const rankDiff = Math.max(0, targetRank - aliceRank) / RANK_MAX;
  const territory = isTargetTerritory ? 1 : 0;

  return cfg.beta1 * rankDiff + cfg.beta2 * territory;
}

/**
 * C_imp(a, n): 行动侵入性。
 *
 * @see paper/ Definition 8, C_imp
 */
function cImp(
  actionType: string,
  contextSignal: number,
  cfg: SocialCostConfig,
  chatType?: string,
): number {
  const intrusivenessScore = getIntrusiveness(actionType, chatType);
  return cfg.gamma1 * contextSignal + cfg.gamma2 * intrusivenessScore;
}

/**
 * C_temp(a, n): 时间序列惩罚。
 *
 * @see paper/ Definition 8, C_temp
 */
function cTemp(
  actionDensity: number,
  maxSimilarity: number,
  cfg: SocialCostConfig,
  opponentLambda?: number,
  windowS: number = 1800,
): number {
  // 密度惩罚：最近行动越密集 → 惩罚越大
  const densityPenalty = 1 - Math.exp(-actionDensity / Math.max(cfg.lambdaC, 0.01));

  // ADR-153 Phase 2: 对方消息率调制 — 不对称检测
  // asymmetry > 0: Alice 发太多 → 抬高 C_temp（抑制过度回复）
  // asymmetry < 0: Alice 回复不够 → 降低 C_temp（鼓励回复）
  // @see simulation/experiments/exp_hawkes_phase2_validation.py 验证 2
  let adjustedDensity = densityPenalty;
  if (opponentLambda != null) {
    const aliceRate = actionDensity / windowS;
    const maxRate = Math.max(aliceRate, opponentLambda, 1e-12);
    const asymmetry = (aliceRate - opponentLambda) / maxRate;
    adjustedDensity = densityPenalty * (1 + 0.3 * Math.max(-1, Math.min(1, asymmetry)));
  }

  return cfg.delta1 * adjustedDensity + cfg.delta2 * maxSimilarity;
}

// -- 辅助函数 ---------------------------------------------------------------

/**
 * 从图中提取上下文信号 C_ctx ∈ [0, 1]。
 *
 * 派生自 D2 factual panel：grief / unanswered / endpoint 等场景
 * 让 Alice 意识到"现在可能不适合打扰"。
 */
function extractContextSignal(
  G: WorldModel,
  targetId: string,
  isGroup = false,
  nowMs = Date.now(),
): number {
  if (!G.has(targetId)) return 0.5;

  // 多个信号加权：risk、连续消息、最近清除
  // ADR-126: 所有信号通过衰减层读取，消除陈旧数据的永久影响
  let signal = 0;
  let count = 0;

  // 风险等级（衰减后的连续值）
  const riskValue = effectiveRisk(G, targetId, nowMs);
  if (riskValue > 0) {
    signal += riskValue;
    count++;
  }

  // 连续发消息（衰减后——24h 后社交语境重置）
  const outgoing = effectiveOutgoing(G, targetId, nowMs);
  if (outgoing > 0) {
    signal += Math.min(1, outgoing / 5);
    count++;
  }

  // 最近 outcome quality（向中性 0.5 衰减——陈旧差评不永久抬高成本）
  const quality = effectiveOutcomeQuality(G, targetId, nowMs);
  signal += 1 - quality;
  count++;

  // 对话结束信号 — 无活跃对话或对话即将结束时增加社交成本
  const activeConv = findActiveConversation(G, targetId);
  if (!activeConv) {
    // 检查是否有 closing 状态的对话（即将结束但尚未冷却）
    let hasClosing = false;
    for (const convId of G.getEntitiesByType("conversation")) {
      const convAttrs = G.getConversation(convId);
      if (convAttrs.channel === targetId && convAttrs.state === "closing") {
        hasClosing = true;
        break;
      }
    }
    if (hasClosing) {
      // 对话即将结束 → 不宜打扰
      signal += 0.7;
      count++;
    } else {
      // 完全没有活跃对话 → 冷启动，主动发起门槛更高
      // ADR-116: 群组中没有活跃对话是常态（90-9-1 法则），成本远低于私聊冷启动
      // @see docs/adr/116-group-silence-trap.md §修复 2
      signal += isGroup ? 0.2 : 0.6;
      count++;
    }
  }

  // grief / 敏感状态检测
  // 1) 从关联 contact 的 mood_valence 检测负面情绪
  // @see ADR-50: 语义归 LLM，结构归代码——用数值判断而非正则
  const contactId = chatIdToContactId(targetId);
  if (contactId && contactId !== targetId && G.has(contactId)) {
    const contactAttrs = G.getContact(contactId);
    const moodValence = Number(contactAttrs.mood_valence ?? 0);
    // 负面情绪（valence < -0.3）增加社交成本
    if (moodValence < -0.3) {
      signal += Math.min(0.9, 0.5 + Math.abs(moodValence));
      count++;
    }
  }
  // 2) risk_reason 作为 risk 信号的补充
  // effectiveRisk 已在上方处理。如果有 risk_reason 但 effectiveRisk 为零（risk_level 未标记或已衰减），
  // 提升信号值（等价于隐含的 "low" 风险）。
  if (riskValue === 0) {
    const targetAttrs = G.getChannel(targetId);
    if (targetAttrs.risk_reason) {
      // 补充信号，不增加 count——risk_reason 是辅助信号而非独立维度，
      // 增加 count 会稀释平均值（0.1 低于其他信号均值，反而拉低总成本）。
      signal += 0.1;
    }
  }

  return count > 0 ? signal / count : 0.5;
}

/**
 * 计算 max_sim：当前行动与最近行动的最大相似度。
 * 简化实现：相同行动类型 = 1，不同 = 0。
 *
 * @see paper/ Definition 8, C_temp: max_sim(a, a')
 */
function maxSimilarity(actionType: string, recentActionTypes: string[]): number {
  for (const recent of recentActionTypes) {
    if (recent === actionType) return 1;
  }
  return 0;
}

// -- 主函数 -----------------------------------------------------------------

/**
 * 计算对目标实体执行指定行动的社交成本。
 *
 * 纯函数：只读 G + 传入参数，无副作用。
 *
 * @param G - 伴侣图（只读）
 * @param targetId - 目标实体 ID（channel 或 contact）
 * @param actionType - 行动类型（声部名 or 具体行动）
 * @param tick - 当前 tick
 * @param recentActions - 最近行动记录
 * @param config - Social Cost 配置
 * @param chatType - 目标频道类型（默认 "private"，群组中社交成本更低）
 * @returns 社交成本 ∈ [0, ~1]（理论上无硬上限，但各子项 ∈ [0,1]）
 *
 * @see paper/ Definition 8: Social Cost Function
 * @see docs/adr/113-online-social-recalibration.md
 */
export function computeSocialCost(
  G: WorldModel,
  targetId: string,
  actionType: string,
  _tick: number,
  nowMs: number,
  recentActions: Array<{ tick: number; ms?: number; action: string }>,
  config: SocialCostConfig,
  chatType?: string,
): number {
  // ADR-206: 频道无社交义务（纯信息流），社交成本为 0
  if (chatType === "channel") return 0;

  // --- C_dist: 社交距离 ---

  // 获取 sent/recv 窗口计数
  let aliceSentWindow = 0;
  let contactRecvWindow = 0;
  let tier = 150; // 默认 Dunbar 150

  // 从 channel 或 contact 获取追踪数据
  if (G.has(targetId)) {
    const attrs = G.getChannel(targetId);
    aliceSentWindow = Number(attrs.alice_sent_window ?? 0);
    contactRecvWindow = Number(attrs.contact_recv_window ?? 0);
    // tier 从 channel.tier_contact 获取
    tier = Number(attrs.tier_contact ?? 150);
  }

  // 也尝试从关联 contact 获取 tier
  const contactId = chatIdToContactId(targetId);
  if (contactId && contactId !== targetId && G.has(contactId)) {
    const contactAttrs = G.getContact(contactId);
    tier = contactAttrs.tier;
  }

  // 时间间隔：自上次互动的墙钟秒数
  let lastInteractionMs = 0;
  if (G.has(targetId)) {
    const aliceMs = readNodeMs(G, targetId, "last_alice_action_ms");
    const directedMs = readNodeMs(G, targetId, "last_directed_ms");
    lastInteractionMs = Math.max(aliceMs, directedMs);
  }
  const tGap = elapsedS(nowMs, lastInteractionMs);

  const isGroup = ChatTarget.isGroupChat(chatType);
  const dist = cDist(aliceSentWindow, contactRecvWindow, tier, tGap, config, isGroup);

  // --- C_power: 权力差异 ---
  // P2-1 fix: 从 channel 的 alice_role 属性读取（perceive 阶段写入）
  const aliceRole = G.has(targetId)
    ? String(G.getChannel(targetId).alice_role ?? "member")
    : "member";
  const aliceRank = ROLE_RANK[aliceRole] ?? ROLE_RANK.member;
  let targetRank = ROLE_RANK.member;
  let isTargetTerritory = false;

  if (G.has(targetId)) {
    // ADR-113: 群组是共享空间，不再一律视为"对方领地"
    // 仅新成员（加入 < 7 天）视为"闯入者"——刚进群就主动发消息的社交成本更高
    if (isGroup) {
      const joinMs = Number(G.getChannel(targetId).join_ms ?? 0);
      isTargetTerritory = joinMs > 0 && nowMs - joinMs < 7 * 86_400_000;
      targetRank = ROLE_RANK.member;
    }
  }

  const power = cPower(aliceRank, targetRank, isTargetTerritory, config);

  // --- C_imp: 侵入性 ---
  const contextSignal = extractContextSignal(G, targetId, isGroup, nowMs);
  const imp = cImp(actionType, contextSignal, config, chatType);

  // --- C_temp: 时间序列惩罚（window 现为秒） ---
  const windowStartMs = nowMs - config.window * 1000;
  const actionsInWindow = recentActions.filter(
    (a) => (a.ms ?? a.tick * LEGACY_TICK_INTERVAL_MS) > windowStartMs,
  );
  const actionDensity = actionsInWindow.length;
  const typesInWindow = actionsInWindow.map((a) => a.action);
  const maxSim = maxSimilarity(actionType, typesInWindow);

  // ADR-153 Phase 2: 从 contact 读取 Hawkes λ(t) → 传入 C_temp 不对称检测
  let opponentLambda: number | undefined;
  if (contactId && G.has(contactId)) {
    const contactForHawkes = G.getContact(contactId);
    if (contactForHawkes.hawkes_last_event_ms && contactForHawkes.hawkes_last_event_ms > 0) {
      const hp = getDefaultParams(contactForHawkes.tier as DunbarTier, isGroup);
      const hs: HawkesState = {
        lambdaCarry: contactForHawkes.hawkes_carry ?? 0,
        lastEventMs: contactForHawkes.hawkes_last_event_ms,
      };
      opponentLambda = queryIntensity(hp, hs, nowMs).lambda;
    }
  }
  const temp = cTemp(actionDensity, maxSim, config, opponentLambda, config.window);

  // --- 总和: 加权求和 ---
  return config.wDist * dist + config.wPower * power + config.wImp * imp + config.wTemp * temp;
}

// ═══════════════════════════════════════════════════════════════════════════
// ADR-136: Saturation Cost C_sat
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Saturation Cost 配置。
 *
 * 4 个子组件的权重和参数。权重需要在 σ=1.0 时产生足够大的 C_sat
 * 使 NSV ≤ 0（等效于"阻断"），但在 σ 较低时对 NSV 影响可忽略。
 *
 * @see docs/adr/136-constrained-vmax/README.md §2.4
 */
export const SaturationCostConfigSchema = z.object({
  /** σ_rate 权重——per-target 频率饱和。 */
  wRate: z.number().min(0).default(2.0),
  /** σ_cool 权重——proactive 冷却。 */
  wCool: z.number().min(0).default(1.5),
  /** σ_out 权重——consecutive outgoing。 */
  wOut: z.number().min(0).default(2.0),
  /** σ_fail 权重——ACT 执行失败。 */
  wFail: z.number().min(0).default(1.5),

  /** σ_rate 凸性指数 α > 1（越接近上限惩罚越陡）。 */
  alphaRate: z.number().min(1).default(2.0),
  /** σ_out 凸性指数 β > 1。 */
  betaOut: z.number().min(1).default(2.0),
  /** σ_fail 指数斜率 γ。 */
  gammaFail: z.number().positive().default(0.5),

  /** Per-target 频率上限（标准）。
   * ADR-189 蟑螂审计 Recal 2: 3→4（50 分钟窗口每 12.5 分钟 1 次，更适合活跃私聊）。 */
  perTargetCap: z.number().int().positive().default(4),
  /** Per-target 频率上限（obligation bypass 时）。 */
  perTargetCapBypass: z.number().int().positive().default(5),

  /** Consecutive outgoing 上限——私聊。
   * ADR-189 蟑螂审计 Recal 1: 3→4（给主动对话留一条缓冲）。 */
  outgoingCapPrivate: z.number().int().positive().default(4),
  /** Consecutive outgoing 上限——群组。 */
  outgoingCapGroup: z.number().int().positive().default(4),
});

export type SaturationCostConfig = z.infer<typeof SaturationCostConfigSchema>;

/** 默认 Saturation Cost 配置。 */
export const DEFAULT_SATURATION_COST_CONFIG: SaturationCostConfig =
  SaturationCostConfigSchema.parse({});

/**
 * ADR-154: 从 target（channel/contact）提取有效 Dunbar tier。
 * 优先使用关联 contact 的 tier，fallback 到 channel 的 tier_contact。
 */
function extractTierFromTarget(G: WorldModel, targetId: string, isGroup: boolean): DunbarTier {
  // 私聊：channel → contact 推导
  const contactId = chatIdToContactId(targetId);
  if (contactId && contactId !== targetId && G.has(contactId)) {
    return G.getContact(contactId).tier;
  }
  // 群组或无关联 contact：使用 channel 的 tier_contact
  if (G.has(targetId)) {
    return G.getChannel(targetId).tier_contact;
  }
  // fallback: 群组默认 150，私聊默认 50
  return isGroup ? 150 : 50;
}

/**
 * ADR-136: 饱和成本 C_sat — 将执行约束编码为连续惩罚。
 *
 * 4 个子组件对应 4 类被折叠的二值门控：
 *   σ_rate — per-target 频率饱和
 *   σ_cool — proactive 冷却衰减
 *   σ_out  — consecutive outgoing 饱和
 *   σ_fail — 执行失败惩罚（时间衰减）
 *
 * 纯函数：只读 G + 传入参数，无副作用。
 *
 * @see paper/ Eq.(csat): C_sat = Σ w_k · σ_k
 * @see docs/adr/136-constrained-vmax/README.md §2.3
 */
export function computeSaturationCost(
  G: WorldModel,
  targetId: string,
  nowMs: number,
  recentTargetActionCount: number,
  config: SaturationCostConfig,
  chatType: string,
  bypassGates: boolean,
): number {
  // ADR-206: 频道无饱和成本（信息流实体，不是社交对等体）
  if (ChatTarget.isChannelChat(chatType)) return 0;

  const isGroup = ChatTarget.isGroupChat(chatType);

  // ── σ_rate: per-target 频率饱和 ──
  const cap = bypassGates ? config.perTargetCapBypass : config.perTargetCap;
  const ratioRate = Math.min(1, recentTargetActionCount / Math.max(cap, 1));
  const sigmaRate = ratioRate ** config.alphaRate;

  // ── σ_cool: proactive 冷却（ADR-154: per-tier τ_cool）──
  let sigmaCool = 0;
  if (G.has(targetId)) {
    const lastProactiveMs = readNodeMs(G, targetId, "last_proactive_outreach_ms");
    if (lastProactiveMs > 0) {
      const elapsedCoolS = Math.max(0, (nowMs - lastProactiveMs) / 1000);
      // ADR-154: τ_cool per-tier 化——亲密朋友冷却短，疏远联系人冷却长
      const tier = extractTierFromTarget(G, targetId, isGroup);
      const tauCool = isGroup
        ? proactiveCooldownForTier(tier) * 0.25 // 群组冷却 = 私聊 × 0.25
        : proactiveCooldownForTier(tier);
      sigmaCool = Math.exp(-elapsedCoolS / Math.max(tauCool, 1));
    }
  }

  // ── σ_out: consecutive outgoing 饱和 ──
  let sigmaOut = 0;
  if (G.has(targetId)) {
    const outgoing = effectiveOutgoing(G, targetId, nowMs);
    const outCap = isGroup ? config.outgoingCapGroup : config.outgoingCapPrivate;
    const ratioOut = Math.min(1, outgoing / Math.max(outCap, 1));
    sigmaOut = ratioOut ** config.betaOut;
  }

  // ── σ_fail: ACT 执行失败（时间衰减） ──
  let sigmaFail = 0;
  if (G.has(targetId)) {
    const effectiveSil = effectiveActSilences(G, targetId, nowMs);
    if (effectiveSil > 0) {
      sigmaFail = 1 - Math.exp(-config.gammaFail * effectiveSil);
    }
  }

  return (
    config.wRate * sigmaRate +
    config.wCool * sigmaCool +
    config.wOut * sigmaOut +
    config.wFail * sigmaFail
  );
}
