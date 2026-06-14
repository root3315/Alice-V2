/**
 * P5 Response Obligation — реализация выравнивания §3.5 статьи + инженерные улучшения.
 *
 * Формула из статьи:
 *   P₅(n) = Σ_{h ∈ H_active} directed(h, n) × w_tier(h) × w_chat(h) × decay(h, n)
 *
 * Инженерные правки (ADR-157, ADR-153, ADR-215):
 * - Экспоненциальное ядро вместо гиперболы (физически корректнее, меньше остаточного сигнала)
 * - Модуляция Hawkes λ(t) (обязательство сохраняется, пока собеседник активен)
 * - Логарифмическое масштабирование directed (предотвращает насыщение при накоплении необработанных сообщений в крупных графах)
 * - Ограничение обязательства per-channel (защита от шторма сообщений в одном канале)
 *
 * @see paper/ §3.5 Response Obligation
 * @see docs/adr/157-signal-decay-integrity.md
 * @see docs/adr/215-p5-directed-saturation-fix.md
 */

import {
  CHAT_TYPE_WEIGHTS,
  chatIdToContactId,
  DUNBAR_TIER_WEIGHT,
  tierBiasCorrection,
} from "../graph/constants.js";
import { readSocialReception } from "../graph/dynamic-props.js";
import { findActiveConversation } from "../graph/queries.js";
import type { WorldModel } from "../graph/world-model.js";
import { elapsedS, readNodeMs } from "./clock.js";
import { getDefaultParams, type HawkesState, queryIntensity } from "./hawkes.js";
import type { PressureResult } from "./p1-attention.js";
import {
  decaySignal,
  OBLIGATION_HALFLIFE_GROUP,
  OBLIGATION_HALFLIFE_PRIVATE,
} from "./signal-decay.js";

// ADR-222 удалён

/** Дополнительный бонус обязательства ответа во время alice_turn (30%). */
const TURN_OBLIGATION_BOOST = 1.3;

/**
 * ADR-215: ограничение directed per-channel.
 * Защита от шторма сообщений в одном канале: даже при 100 необработанных directed-сообщениях
 * эффективное обязательство ограничено значением ln(1+5) ≈ 1.8 (вместо 100).
 */
const DIRECTED_CAP_PER_CHANNEL = 5.0;

/**
 * Логарифмическое масштабирование directed: преобразует линейно растущее число
 * необработанных сообщений в ограниченную интенсивность обязательства. Предотвращает
 * насыщение P5 в крупных графах.
 *
 * effectiveDirected = ln(1 + min(directed, DIRECTED_CAP_PER_CHANNEL))
 *
 * @see docs/adr/215-p5-directed-saturation-fix.md
 */
function effectiveDirected(directed: number): number {
  const capped = Math.min(Math.max(0, directed), DIRECTED_CAP_PER_CHANNEL);
  return Math.log1p(capped); // ln(1 + capped), capped=5 → ~1.79
}

export function p5ResponseObligation(G: WorldModel, _n: number, nowMs: number): PressureResult {
  const contributions: Record<string, number> = {};
  const beliefs = G.beliefs;

  for (const hid of G.getEntitiesByType("channel")) {
    const attrs = G.getChannel(hid);
    // H1: числовая коэрция (как effectiveObligation/iaus-scorer) — иначе один канал с
    // undefined pending_directed даёт NaN, который отравляет ВСЁ поле давления (total→API→NaN).
    const directedRaw = Number(attrs.pending_directed ?? 0);
    if (!(directedRaw > 0)) continue;

    // ADR-215: логарифмическое масштабирование directed, предотвращает насыщение в крупных графах
    const directed = effectiveDirected(directedRaw);

    // Wave 6: Tier bias correction — выводим contactId из tier_contact канала,
    // читаем σ² убеждения tier из BeliefStore, при высоком σ² регрессируем к базовой линии.
    // @see paper/ §Social POMDP "Tier Overestimate Bias Correction"
    const contactId = chatIdToContactId(hid);
    // ADR-91 Layer 2: снижение веса directed-сообщений от ботов ×0.1
    const isBot = contactId != null && G.has(contactId) && G.getContact(contactId).is_bot === true;
    const botWeight = isBot ? 0.1 : 1.0;
    const b = contactId ? beliefs.get(contactId, "tier") : undefined;
    const effectiveTier = tierBiasCorrection(attrs.tier_contact, b?.sigma2);
    const w = DUNBAR_TIER_WEIGHT[effectiveTier] ?? 0.8;
    const chatType = attrs.chat_type;
    const chatW = CHAT_TYPE_WEIGHTS[chatType]?.response ?? 1.0;
    const lastDirectedMs = readNodeMs(G, hid, "last_directed_ms");
    const ageS = Math.max(elapsedS(nowMs, lastDirectedMs), 1.0);
    // ADR-157: единообразно используем экспоненциальное ядро и константы полураспада из signal-decay.ts.
    // Период полураспада: приватный чат 3600s, групповой 2400s (соответствует effectiveObligation).
    // Старая версия использовала гиперболу 1/(1+ageS/τ); экспоненциальное ядро 2^(-ageS/τ) физически точнее описывает затухание событийного сигнала.
    // @see docs/adr/157-signal-decay-integrity.md §Fix 1
    const isPrivate = chatType === "private";
    const decayHalfLife = isPrivate ? OBLIGATION_HALFLIFE_PRIVATE : OBLIGATION_HALFLIFE_GROUP;
    const rawDecay = decaySignal(1.0, ageS, decayHalfLife);
    // ADR-153 Phase 2: высокий λ(t) → замедление затухания (собеседник ещё активен, обязательство сохраняется)
    // k_p5 = 0.5, зажим [1, 2]. Подтверждено симуляцией: в активный период 2× базовой линии, после тишины сходится.
    // @see simulation/experiments/exp_hawkes_phase2_validation.py проверка 1
    let decay = rawDecay;
    const cId = chatIdToContactId(hid);
    if (cId && G.has(cId)) {
      const c = G.getContact(cId);
      if (c.hawkes_last_event_ms && c.hawkes_last_event_ms > 0) {
        const hp = getDefaultParams(c.tier, false);
        const hs: HawkesState = {
          lambdaCarry: c.hawkes_carry ?? 0,
          lastEventMs: c.hawkes_last_event_ms,
        };
        const hi = queryIntensity(hp, hs, nowMs);
        const modulation = Math.min(
          2,
          1 + 0.5 * Math.max(0, (hi.lambda - hp.mu) / Math.max(hp.mu, 1e-10)),
        );
        decay = rawDecay * modulation;
      }
    }

    // ADR-156: независимая модуляция social reception (ортогональна ADR-222 habituation).
    // reception — социальная обратная связь от других к Алисе; habituation — адаптивное затухание самой Алисы.
    // reception=0 (по умолчанию/не задан) → 1.0 (отсутствие данных не штрафуется).
    const reception = readSocialReception(G, hid);
    const receptionFactor =
      reception >= 0 ? 1.0 : reception > -0.3 ? 0.7 : reception > -0.6 ? 0.3 : 0.1;

    // ADR-70 P0.5: Алиса обдумывает ответ для этого канала → подавить накопление P5
    const thinkingSince = G.getChannel(hid).alice_thinking_since;
    if (thinkingSince != null) {
      contributions[hid] = directed * w * chatW * decay * receptionFactor * 0.1 * botWeight;
      continue;
    }

    // M4: conversation turn awareness — очередь Алисы отвечать → дополнительное обязательство
    let turnBoost = 1.0;
    const convId = findActiveConversation(G, hid);
    if (convId && G.has(convId)) {
      const convAttrs = G.getConversation(convId);
      if (convAttrs.turn_state === "alice_turn") {
        turnBoost = TURN_OBLIGATION_BOOST;
      }
    }

    const basePressure = directed * w * chatW * decay;
    contributions[hid] = basePressure * turnBoost * botWeight * receptionFactor;
  }

  const total = Object.values(contributions).reduce((a, b) => a + b, 0);
  return { total, contributions };
}
