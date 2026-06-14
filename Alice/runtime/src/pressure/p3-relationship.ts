/**
 * P3 охлаждение отношений (Relationship Cooling) — управляется контактами.
 * Соответствует Python pressure.py P3_relationship_cooling().
 *
 * ADR-111: P3(n) = Σ_c w_tier(c) · logSigmoid(silence_c, β_r, θ_c, τ₀)
 * Sigmoid в логарифмическом временном домене — закон Вебера-Фехнера.
 *
 * v4: чистое измерение. Не читает API, без φ/ψ-модуляции.
 *
 * Wave 6: коррекция смещения при переоценке tier — при высоком σ² регрессия к базовому уровню 150.
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
 * @param channelRateEma ADR-161 §3.4: EMA скорости сообщений per-channel (единица: msgs/tick).
 * @param tickDt длительность текущего тика по настенным часам (секунды), используется для перевода EMA в msgs/s.
 *   Приближение: нормализация исторического EMA текущим dt. Полупериод EMA ~10 тиков; в режиме patrol
 *   интервал тика меняется незначительно, погрешность приближения приемлема. Зажим диапазона дополнительно ограничивает экстремальные значения.
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
    // ADR-91 Layer 2: боты не генерируют давление охлаждения отношений
    if (attrs.is_bot === true) continue;

    // ADR-206: фантомные контакты, возникающие когда канал отправляет сообщения от своего имени — не участвуют в социальном давлении.
    // Канал — информационный поток, а не социальный партнёр.
    const chId = ensureChannelId(cid);
    if (chId && G.has(chId) && G.getChannel(chId).chat_type === "channel") continue;

    // Wave 6: коррекция смещения tier — при высоком σ² регрессия к базовому уровню, чтобы избежать переоценки близости.
    // @see paper/ §Social POMDP "Tier Overestimate Bias Correction"
    const b = beliefs.get(cid, "tier");
    const effectiveTier = tierBiasCorrection(attrs.tier, b?.sigma2);

    const w = DUNBAR_TIER_WEIGHT[effectiveTier] ?? 0.8;
    // ADR-110: DUNBAR_TIER_THETA уже задан непосредственно в секундах
    const thetaS = DUNBAR_TIER_THETA[effectiveTier] ?? 4800;
    const lastActiveMs = readNodeMs(G, cid, "last_active_ms");
    // Никогда не взаимодействовали (last_active_ms=0) ≠ охлаждение отношений. Нельзя охладить то, чего нет.
    if (lastActiveMs <= 0) continue;

    // ADR-56 S3 + ADR-70 P0.5: объединённый поиск канала
    const channelId = ensureChannelId(cid);
    if (channelId && G.has(channelId)) {
      // ADR-56 S3: Alice написала, собеседник не ответил → пропустить (живое общение: я написала тебе → жду ответа)
      // @see docs/adr/56-behavioral-reciprocity-action-loop.md §S3
      const aliceLastMs = readNodeMs(G, channelId, "last_alice_action_ms");
      if (aliceLastMs > lastActiveMs && aliceLastMs > 0) {
        continue;
      }
      // ADR-70 P0.5: Alice думает → засчитывается как ответ
      if (G.getChannel(channelId).alice_thinking_since != null) {
        continue;
      }
    }

    // ADR-178 §6.1: модуляция θ через attraction — привлекательный собеседник ожидается более частым
    const rvAttraction = attrs.rv_attraction ?? 0;
    const MU_ATTRACTION_THETA = 0.3; // при attraction=1 θ сокращается на 30%
    const thetaEffective = thetaS * (1 - MU_ATTRACTION_THETA * rvAttraction);

    const silenceS = elapsedS(nowMs, lastActiveMs);
    // ADR-111: sigmoid в логарифмическом домене — восприятие времени по закону Вебера-Фехнера
    const cooling = logSigmoid(silenceS, P3_BETA_R, thetaEffective, P3_TAU_0);

    // P1-1: демпфирование дисбаланса взаимности — при чрезмерной инициативе Alice подавляем P3, избегая односторонней навязчивости.
    // ratio = alice_initiated / max(1, contact_initiated)
    // ratio ≤ 2: без демпфирования (асимметрия до 2:1 нормальна в companion-сценарии — §6 принцип 6.3)
    // ratio > 2: damping = 1 / (1 + ratio - 2), плавное затухание
    //
    // Исправление по результатам аудита: старое условие `aliceInit > 0 && contactInit > 0`
    // не срабатывало при contactInit=0 — именно тогда демпфирование нужно больше всего
    // (собеседник никогда не инициировал, а Alice постоянно пишет первой).
    // Изменено на `aliceInit > 0`, при contactInit=0 используем max(1, contactInit) для защиты от деления на ноль.
    const aliceInit = Number(attrs.alice_initiated_count ?? 0);
    const contactInit = Number(attrs.contact_initiated_count ?? 0);
    let reciprocityDamping = 1.0;
    if (aliceInit > 0) {
      const ratio = aliceInit / Math.max(1, contactInit);
      if (ratio > 2) {
        reciprocityDamping = 1 / (1 + ratio - 2);
      }
    }

    // ADR-178: модуляция вклада через attraction — привлекательный собеседник даёт больший P3
    const KAPPA_ATTRACTION_P3 = 0.5;
    contributions[cid] =
      w * cooling * reciprocityDamping * (1 + KAPPA_ATTRACTION_P3 * rvAttraction);
  }

  // ADR-98 W1.1 + ADR-113 §D3: обрезка Top-K — оставляем только K контактов с наибольшим вкладом.
  // K=8: верхняя граница Miller's 7±2, совместима с распределением социального внимания при одновременном мониторинге нескольких каналов.
  // @see docs/adr/98-personality-hyperactivity-diagnosis.md §3 W1.1
  // @see docs/adr/113-online-social-recalibration/ §D3
  const P3_TOP_K = 8;
  const sorted = Object.entries(contributions).sort(([, a], [, b]) => b - a);
  const topK = sorted.slice(0, P3_TOP_K);
  const clampedContributions: Record<string, number> = Object.fromEntries(topK);

  // -- Суб-измерение группового присутствия (ADR-104 + ADR-160 Fix B + ADR-161 §3.4) --
  // Групповые каналы создают независимое давление отсутствия, не входящее в contact Top-K.
  // ADR-161: theta выводится из собственной активности группы (channelRateEma), заменяет статическое отображение tier.
  // Холодный старт: fallback на GROUP_PRESENCE_THETA[tier].
  // @see docs/adr/161-action-space-audit-group-cadence.md §3.4

  for (const hid of G.getEntitiesByType("channel")) {
    const attrs = G.getChannel(hid);
    // ADR-206: обрабатываем только group/supergroup — канал является информационным потоком и не создаёт социального давления отсутствия
    if (attrs.chat_type !== "group" && attrs.chat_type !== "supergroup") continue;

    // Стражник присутствия: Alice никогда не писала в этой группе → давления отсутствия нет
    const lastAliceActionMs = readNodeMs(G, hid, "last_alice_action_ms");
    if (lastAliceActionMs <= 0) continue;

    // подавление в состоянии thinking (аналогично contact P3)
    if (attrs.alice_thinking_since != null) continue;

    // Дуаль S3: последнее действие Alice > последняя активность группы → пропустить
    const lastGroupActivityMs = readNodeMs(G, hid, "last_activity_ms");
    if (lastAliceActionMs > lastGroupActivityMs && lastAliceActionMs > 0) continue;

    const tier = attrs.tier_contact;
    const w = DUNBAR_TIER_WEIGHT[tier] ?? 0.8;

    // ADR-161 §3.4: theta на основе траектории — выводится из темпа активности группы, заменяет статическое отображение tier.
    //
    // Теоретическое обоснование:
    // - tier — атрибут двусторонних отношений (близость), а не активности группы (темп).
    //   Группы с одинаковым tier могут иметь совершенно разную частоту сообщений (500/день vs 10/неделю).
    // - Терпимость к отсутствию в онлайн-IM-группе зависит от темпа самой группы, а не от близости с её участниками.
    //   (ADR-113: онлайн-общение ≠ офлайн-общение)
    // - Литература по Temporal Point Process: EMA интервалов между сообщениями — правильный признак для предсказания следующего события,
    //   не статическая классификация. @see "Why Do People Gather?" (Yan et al., 2024) γ=0.172
    //
    // Формула:
    //   msgsPerS = ema / tickDt    (EMA в единицах msgs/tick ÷ секунды тика = msgs/s)
    //   avgIntervalS = 1 / msgsPerS (средний интервал между сообщениями в секундах)
    //   theta = K × avgIntervalS    (через K раундов активности группы sigmoid P3 достигает 50%)
    //
    // K_ABSENCE_ROUNDS=10: группа написала 10 раундов, Alice молчит → давление отсутствия 50%.
    // В онлайн-IM 10 раундов диалога — явный порог «ты почему молчишь».
    //
    // tier сохраняется как весовой множитель (DUNBAR_TIER_WEIGHT): в близкой группе давление отсутствия сильнее, но порог определяется темпом.
    // @see docs/adr/161-action-space-audit-group-cadence.md §3.4
    const stats = channelRateEma?.get(hid);
    const effectiveDt = tickDt && tickDt > 0 ? tickDt : 60; // fallback 60s (типичное значение для patrol)
    let adjustedThetaS: number;
    if (stats && stats.ema >= 0.001) {
      // msgs/s → средний интервал между сообщениями → theta
      const msgsPerS = stats.ema / effectiveDt;
      const avgIntervalS = 1 / msgsPerS;
      adjustedThetaS = Math.max(
        TRAJECTORY_THETA_MIN_S,
        Math.min(K_ABSENCE_ROUNDS * avgIntervalS, TRAJECTORY_THETA_MAX_S),
      );
    } else {
      // §3.5 холодный старт: нет данных траектории, используем консервативное значение GROUP_PRESENCE_THETA по умолчанию
      adjustedThetaS = GROUP_PRESENCE_THETA[tier] ?? 14400;
    }

    const silenceGroupS = elapsedS(nowMs, lastAliceActionMs);
    // ADR-111: sigmoid в логарифмическом домене — отсутствие в группе тоже использует логарифмическую временную шкалу
    const cooling = logSigmoid(silenceGroupS, P3_BETA_R, adjustedThetaS, P3_TAU_0);

    // ключ — ID канала (непосредственно действуемый), не входит в Top-K
    clampedContributions[hid] = w * cooling;
  }

  // пересчёт total (включая вклад групп)
  const total = Object.values(clampedContributions).reduce((sum, v) => sum + v, 0);
  return { total, contributions: clampedContributions };
}
