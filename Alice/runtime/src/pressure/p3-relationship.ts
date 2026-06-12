/**
 * P3 关系冷却 (Relationship Cooling) — Contact 驱动。
 * 对应 Python pressure.py P3_relationship_cooling()。
 *
 * ADR-111: P3(n) = Σ_c w_tier(c) · logSigmoid(silence_c, β_r, θ_c, τ₀)
 * 对数时间域 sigmoid — Weber-Fechner 定律驱动。
 *
 * v4: 纯测量。不读取 API，不做 φ/ψ 调制。
 *
 * Wave 6: Tier Overestimate Bias Correction — σ² 高时向基线 150 回归。
 * @see docs/adr/111-log-time-sigmoid/README.md
 * @see paper/ §Social POMDP "Tier Overestimate Bias Correction"
 */

import {
  DUNBAR_TIER_THETA,
  DUNBAR_TIER_WEIGHT,
  ensureChannelId,
  GROUP_PRESENCE_THETA,
  K_ABSENCE_ROUNDS,
  P3_BETA_R,
  P3_TAU_0,
  TRAJECTORY_THETA_MAX_S,
  TRAJECTORY_THETA_MIN_S,
  tierBiasCorrection,
} from "../graph/constants.js";
import type { WorldModel } from "../graph/world-model.js";
import { logSigmoid } from "../utils/math.js";
import { elapsedS, readNodeMs } from "./clock.js";
import type { PressureResult } from "./p1-attention.js";

/**
 * @param channelRateEma ADR-161 §3.4: per-channel 消息速率 EMA（单位: msgs/tick）。
 * @param tickDt 当前 tick 的墙钟持续时间（秒），用于将 EMA 转换为 msgs/s。
 *   近似：用当前 dt 归一化历史 EMA。EMA 半衰期 ~10 tick，patrol 模式下
 *   tick 间隔变化不剧烈，近似误差可接受。夹紧范围进一步限制极端值。
 */
export function p3RelationshipCooling(
  G: WorldModel,
  _n: number,
  nowMs: number,
  channelRateEma?: Map<string, { ema: number; variance: number }>,
  tickDt?: number,
): PressureResult {
  const contributions: Record<string, number> = {};
  const beliefs = G.beliefs;

  for (const cid of G.getEntitiesByType("contact")) {
    const attrs = G.getContact(cid);
    // ADR-91 Layer 2: Bot 不产生关系冷却压力
    if (attrs.is_bot === true) continue;

    // ADR-206: 频道以自身身份发消息产生的幽灵联系人 — 不参与社交压力。
    // 频道是信息流实体，不是社交对等体。
    const chId = ensureChannelId(cid);
    if (chId && G.has(chId) && G.getChannel(chId).chat_type === "channel") continue;

    // Wave 6: Tier bias correction — σ² 高时向基线回归，避免高估亲密度。
    // @see paper/ §Social POMDP "Tier Overestimate Bias Correction"
    const b = beliefs.get(cid, "tier");
    const effectiveTier = tierBiasCorrection(attrs.tier, b?.sigma2);

    const w = DUNBAR_TIER_WEIGHT[effectiveTier] ?? 0.8;
    // ADR-110: DUNBAR_TIER_THETA 已直接为秒值
    const thetaS = DUNBAR_TIER_THETA[effectiveTier] ?? 4800;
    const lastActiveMs = readNodeMs(G, cid, "last_active_ms");
    // 从未交互（last_active_ms=0）≠ 关系冷却。没有关系何来冷却。
    if (lastActiveMs <= 0) continue;

    // ADR-56 S3 + ADR-70 P0.5: 合并频道查找
    const channelId = ensureChannelId(cid);
    if (channelId && G.has(channelId)) {
      // ADR-56 S3: Alice 说了对方没回 → 跳过（真人社交：我联系了你 → 等你回）
      // @see docs/adr/56-behavioral-reciprocity-action-loop.md §S3
      const aliceLastMs = readNodeMs(G, channelId, "last_alice_action_ms");
      if (aliceLastMs > lastActiveMs && aliceLastMs > 0) {
        continue;
      }
      // ADR-70 P0.5: Alice 正在思考 → 视同已回复
      if (G.getChannel(channelId).alice_thinking_since != null) {
        continue;
      }
    }

    // ADR-178 §6.1: attraction 调制 θ — 被吸引的人，期望更频繁地互动
    const rvAttraction = attrs.rv_attraction ?? 0;
    const MU_ATTRACTION_THETA = 0.3; // attraction=1 时 θ 缩短 30%
    const thetaEffective = thetaS * (1 - MU_ATTRACTION_THETA * rvAttraction);

    const silenceS = elapsedS(nowMs, lastActiveMs);
    // ADR-111: 对数域 sigmoid — Weber-Fechner 时间感知
    const cooling = logSigmoid(silenceS, P3_BETA_R, thetaEffective, P3_TAU_0);

    // P1-1: 互惠失衡衰减 — Alice 发起过多时抑制 P3，避免单方面黏人。
    // ratio = alice_initiated / max(1, contact_initiated)
    // ratio ≤ 2 时不衰减（2:1 以内的不对称在 companion 场景中正常——§六 6.3 原则 3）
    // ratio > 2 时 damping = 1 / (1 + ratio - 2)，平滑衰减
    //
    // 审计修复: 旧条件 `aliceInit > 0 && contactInit > 0` 在 contactInit=0 时
    // 不触发衰减——恰好是最需要衰减的场景（对方从未主动联系 Alice，Alice 却反复发起）。
    // 改为 `aliceInit > 0`，contactInit=0 时用 max(1, contactInit) 防除零。
    const aliceInit = Number(attrs.alice_initiated_count ?? 0);
    const contactInit = Number(attrs.contact_initiated_count ?? 0);
    let reciprocityDamping = 1.0;
    if (aliceInit > 0) {
      const ratio = aliceInit / Math.max(1, contactInit);
      if (ratio > 2) {
        reciprocityDamping = 1 / (1 + ratio - 2);
      }
    }

    // ADR-178: attraction 调制 contribution — 被吸引的人贡献更大的 P3
    const KAPPA_ATTRACTION_P3 = 0.5;
    contributions[cid] =
      w * cooling * reciprocityDamping * (1 + KAPPA_ATTRACTION_P3 * rvAttraction);
  }

  // ADR-98 W1.1 + ADR-113 §D3: Top-K 截断 — 只保留贡献最大的 K 个联系人。
  // K=8: Miller's 7±2 上界，兼容线上多频道同步监控的社交注意力分配。
  // @see docs/adr/98-personality-hyperactivity-diagnosis.md §3 W1.1
  // @see docs/adr/113-online-social-recalibration/ §D3
  const P3_TOP_K = 8;
  const sorted = Object.entries(contributions).sort(([, a], [, b]) => b - a);
  const topK = sorted.slice(0, P3_TOP_K);
  const clampedContributions: Record<string, number> = Object.fromEntries(topK);

  // -- 社群存在子维度（ADR-104 + ADR-160 Fix B + ADR-161 §3.4）--
  // 群组频道产生独立的缺席压力，不计入 contact Top-K。
  // ADR-161: theta 从群组自身活动轨迹推导（channelRateEma），替代静态 tier 映射。
  // 冷启动 fallback 到 GROUP_PRESENCE_THETA[tier]。
  // @see docs/adr/161-action-space-audit-group-cadence.md §3.4

  for (const hid of G.getEntitiesByType("channel")) {
    const attrs = G.getChannel(hid);
    // ADR-206: 只处理 group/supergroup — 频道是信息流实体，不产生社交缺席压力
    if (attrs.chat_type !== "group" && attrs.chat_type !== "supergroup") continue;

    // 建立存在守卫：Alice 从未在此群发言 → 无缺席压力
    const lastAliceActionMs = readNodeMs(G, hid, "last_alice_action_ms");
    if (lastAliceActionMs <= 0) continue;

    // thinking 状态抑制（与 contact P3 一致）
    if (attrs.alice_thinking_since != null) continue;

    // S3 对偶：Alice 最后行动 > 群组最后活动 → 跳过
    const lastGroupActivityMs = readNodeMs(G, hid, "last_activity_ms");
    if (lastAliceActionMs > lastGroupActivityMs && lastAliceActionMs > 0) continue;

    const tier = attrs.tier_contact;
    const w = DUNBAR_TIER_WEIGHT[tier] ?? 0.8;

    // ADR-161 §3.4: 轨迹驱动 theta — 从群组自身活动节奏推导，替代静态 tier 映射。
    //
    // 理论依据：
    // - tier 是双边关系属性（亲密度），不是群组活动属性（节奏）。
    //   相同 tier 的群可以有截然不同的消息频率（日均 500 vs 周均 10）。
    // - 线上 IM 群组的缺席容忍度取决于该群的节奏，不是对群友的亲密度。
    //   （ADR-113: 线上社交 ≠ 线下社交）
    // - Temporal Point Process 文献：消息间隔 EMA 是预测下次事件的正确特征，
    //   而非静态分类。@see "Why Do People Gather?" (Yan et al., 2024) γ=0.172
    //
    // 公式：
    //   msgsPerS = ema / tickDt    （EMA 单位 msgs/tick ÷ tick 秒数 = msgs/s）
    //   avgIntervalS = 1 / msgsPerS （平均消息间隔秒数）
    //   theta = K × avgIntervalS    （K 轮群组活动后 P3 sigmoid 达 50%）
    //
    // K_ABSENCE_ROUNDS=10: 群组发了 10 轮消息而 Alice 沉默 → 缺席压力达 50%。
    // 线上 IM 中 10 轮对话是明显的「你怎么不说话」临界点。
    //
    // tier 保留为权重因子（DUNBAR_TIER_WEIGHT）：亲密群的缺席压力更大，但阈值由节奏决定。
    // @see docs/adr/161-action-space-audit-group-cadence.md §3.4
    const stats = channelRateEma?.get(hid);
    const effectiveDt = tickDt && tickDt > 0 ? tickDt : 60; // fallback 60s（patrol 典型值）
    let adjustedThetaS: number;
    if (stats && stats.ema >= 0.001) {
      // msgs/s → 平均消息间隔 → theta
      const msgsPerS = stats.ema / effectiveDt;
      const avgIntervalS = 1 / msgsPerS;
      adjustedThetaS = Math.max(
        TRAJECTORY_THETA_MIN_S,
        Math.min(K_ABSENCE_ROUNDS * avgIntervalS, TRAJECTORY_THETA_MAX_S),
      );
    } else {
      // §3.5 冷启动: 无轨迹数据，使用 GROUP_PRESENCE_THETA 保守默认值
      adjustedThetaS = GROUP_PRESENCE_THETA[tier] ?? 14400;
    }

    const silenceGroupS = elapsedS(nowMs, lastAliceActionMs);
    // ADR-111: 对数域 sigmoid — 群组缺席也使用对数时间尺度
    const cooling = logSigmoid(silenceGroupS, P3_BETA_R, adjustedThetaS, P3_TAU_0);

    // 以频道 ID 为键（直接可行动），不计入 Top-K
    clampedContributions[hid] = w * cooling;
  }

  // 重新计算 total（包含群组贡献）
  const total = Object.values(clampedContributions).reduce((sum, v) => sum + v, 0);
  return { total, contributions: clampedContributions };
}
