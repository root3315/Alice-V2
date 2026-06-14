/**
 * P1 долг внимания (Attention Debt) — управляется каналами.
 * Соответствует Python pressure.py P1_attention_debt().
 *
 * P1(n) = Σ_{h ∈ H_active} unread(h, n) · w_tier(h) · w_chat(h)
 *
 * Модуляция chat_type (#2.1 драматургия Гоффмана):
 * Личный чат — «задний план», групповой — «передний план»; давление непрочитанного в личном чате значительно выше.
 */

import { CHAT_TYPE_WEIGHTS, chatIdToContactId, DUNBAR_TIER_WEIGHT } from "../graph/constants.js";
import type { WorldModel } from "../graph/world-model.js";
import { effectiveUnread } from "./signal-decay.js";

/**
 * ADR-206 C1: жёсткий потолок вклада канала в P1.
 * Предотвращает заполнение социального P1 непрочитанным из каналов: 10 каналов по 500 непрочитанных ≠ тревога Alice.
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
    // ADR-23 Wave 5.2: модуляция activity_relevance (записывается observe_activity)
    // по умолчанию 1.0 → деградация v4
    const relevance = attrs.activity_relevance ?? 1.0;
    // ADR-91 Layer 2: снижение веса внимания на бот-каналы ×0.1
    const cid = chatIdToContactId(hid);
    const isBot = cid != null && G.has(cid) && G.getContact(cid).is_bot === true;
    let contribution = unread * w * chatW * relevance * (isBot ? 0.1 : 1.0);
    // ADR-206 C1: жёсткий потолок P1 для канала — непрочитанное в канале не должно доминировать над давлением внимания
    if (chatType === "channel") {
      contribution = Math.min(contribution, CHANNEL_P1_CAP);
    }
    contributions[hid] = contribution;
  }

  const total = Object.values(contributions).reduce((a, b) => a + b, 0);
  return { total, contributions };
}
