/**
 * P1 注意力债务 (Attention Debt) — Channel 驱动。
 * 对应 Python pressure.py P1_attention_debt()。
 *
 * P1(n) = Σ_{h ∈ H_active} unread(h, n) · w_tier(h) · w_chat(h)
 *
 * chat_type 调制（#2.1 Goffman 拟剧论）：
 * 私聊是"后台"，群聊是"前台"——私聊未读的注意力压力应显著更高。
 */

import { CHAT_TYPE_WEIGHTS, chatIdToContactId, DUNBAR_TIER_WEIGHT } from "../graph/constants.js";
import type { WorldModel } from "../graph/world-model.js";
import { effectiveUnread } from "./signal-decay.js";

/**
 * ADR-206 C1: 频道 P1 贡献硬上限。
 * 防止频道未读淹没社交 P1：10 个频道各 500 条未读 ≠ Alice 焦虑。
 * @see docs/adr/206-channel-information-flow/206-channel-information-flow.md §8.1
 */
const CHANNEL_P1_CAP = 5.0;

export interface PressureResult {
  total: number;
  contributions: Record<string, number>;
}

/**
 * @see docs/adr/134-temporal-coherence.md §D2
 */
export function p1AttentionDebt(G: WorldModel, nowMs: number): PressureResult {
  const contributions: Record<string, number> = {};

  for (const hid of G.getEntitiesByType("channel")) {
    const unread = effectiveUnread(G, hid, nowMs);
    if (unread <= 0) continue;
    const attrs = G.getChannel(hid);
    const tier = attrs.tier_contact;
    const w = DUNBAR_TIER_WEIGHT[tier] ?? 0.8;
    const chatType = attrs.chat_type;
    const chatW = CHAT_TYPE_WEIGHTS[chatType]?.attention ?? 1.0;
    // ADR-23 Wave 5.2: activity_relevance 调制（observe_activity 写入）
    // 缺省 1.0 → v4 退化
    const relevance = attrs.activity_relevance ?? 1.0;
    // ADR-91 Layer 2: Bot 频道注意力降权 ×0.1
    const cid = chatIdToContactId(hid);
    const isBot = cid != null && G.has(cid) && G.getContact(cid).is_bot === true;
    let contribution = unread * w * chatW * relevance * (isBot ? 0.1 : 1.0);
    // ADR-206 C1: 频道 P1 硬上限——频道未读不应主导注意力压力
    if (chatType === "channel") {
      contribution = Math.min(contribution, CHANNEL_P1_CAP);
    }
    contributions[hid] = contribution;
  }

  const total = Object.values(contributions).reduce((a, b) => a + b, 0);
  return { total, contributions };
}
