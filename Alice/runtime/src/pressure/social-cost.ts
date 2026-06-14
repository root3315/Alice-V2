/**
 * D5: Social Cost Function — вычислительная реализация теории вежливости Brown-Levinson.
 *
 * Четыре подкомпонента количественно измеряют "стоимость беспокойства другого человека":
 *   C_dist  — социальная дистанция (дисбаланс взаимности, разница tier, временной интервал)
 *   C_power — разница власти (роль в группе, территориальный эффект)
 *   C_imp   — навязчивость действия (чувствительность к контексту, ранжирование типов действий)
 *   C_temp  — временной штраф (плотность действий, повторяемость действий)
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

// -- Таблица ранжирования навязчивости действий -------------------------------------------------------

/**
 * Тип действия → оценка навязчивости ∈ [0, 1] (базовая линия для приватного чата).
 *
 * @see paper/ Definition 8, C_imp: intrusiveness(a)
 * @see docs/adr/113-online-social-recalibration.md
 */
export const INTRUSIVENESS: Record<string, number> = {
  proactive_message: 1.0, // активное сообщение (максимальная навязчивость)
  send_message: 0.8, // обычное сообщение
  sociability: 0.8, // голос: общительность → отправит сообщение
  reply: 0.6, // ответ
  diligence: 0.6, // голос: усердие → обычно ответ
  react: 0.3, // реакция эмодзи
  curiosity: 0.3, // голос: любопытство → лёгкое взаимодействие
  mark_read: 0.1, // прочитано
  caution: 0.1, // голос: осторожность → низкая навязчивость
};

/**
 * Оценка навязчивости действий для группы/супергруппы.
 * Группа — общее пространство; большинство действий менее навязчивы, чем в приватном чате.
 *
 * @see docs/adr/113-online-social-recalibration.md §D1
 */
const INTRUSIVENESS_GROUP: Record<string, number> = {
  // ADR-113 правка: порог участия в группе низкий, но публичная речь несёт риск содержания (N человек видят).
  // Активная речь и proactive подняты до 0.4 (не "почти бесплатно").
  // reply остаётся 0.2 (ответ на существующую тему действительно имеет самый низкий порог).
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
 * Получить навязчивость действия по chat_type.
 * В группе порог участия ниже, чем в приватном чате, но публичная речь несёт риск содержания (ошибку увидят N человек).
 *
 * @see docs/adr/113-online-social-recalibration.md §D1
 */
export function getIntrusiveness(action: string, chatType?: string): number {
  if (ChatTarget.isGroupChat(chatType)) {
    return INTRUSIVENESS_GROUP[action] ?? INTRUSIVENESS[action] ?? 0.5;
  }
  return INTRUSIVENESS[action] ?? 0.5;
}

// -- Schema конфигурации (Zod-валидация) -------------------------------------------------

const w01 = z.number().min(0).max(1);
const pos = z.number().positive();

/**
 * Zod schema SocialCostConfig — единый источник истины для конфигурации четырёх подкомпонентов.
 *
 * Парсится один раз при запуске, гарантируя, что все веса находятся в допустимом диапазоне.
 * @see paper/ Definition 8: Social Cost Function
 */
export const SocialCostConfigSchema = z.object({
  // Общие веса (взвешенная сумма четырёх компонентов)
  wDist: w01.default(0.3),
  wPower: w01.default(0.1),
  wImp: w01.default(0.3),
  wTemp: w01.default(0.3),

  // Подвеса C_dist
  alpha1: w01.default(0.5),
  alpha2: w01.default(0.3),
  alpha3: w01.default(0.2),
  tauDist: pos.default(3600),

  // Подвеса C_power
  beta1: w01.default(0.7),
  beta2: w01.default(0.3),

  // Подвеса C_imp
  gamma1: w01.default(0.5),
  gamma2: w01.default(0.5),

  // Подвеса C_temp
  delta1: w01.default(0.7),
  delta2: w01.default(0.3),
  // ADR-189: перекалибровка после исправления утечки bypass (старое значение 3.0 калибровалось при частых обходах bypass;
  // теперь bypass ограничен target с обязательством, exp(-n/λ) работает в полную силу, нужно расширить допустимую полосу)
  lambdaC: pos.default(6.0),

  // Net Social Value
  lambda: z.number().min(1).default(1.5),

  // Window
  window: z.number().int().positive().default(1800),
});

export type SocialCostConfig = z.infer<typeof SocialCostConfigSchema>;

/** Конфигурация Social Cost по умолчанию (консервативная: лучше промолчать, чем беспокоить). */
export const DEFAULT_SOCIAL_COST_CONFIG: SocialCostConfig = SocialCostConfigSchema.parse({});

// -- Константы, связанные с tier -----------------------------------------------------------

/** Максимальное значение tier (для нормализации). */
const TIER_MAX = 500;

/** Отображение роли в группе → ранг. */
const ROLE_RANK: Record<string, number> = {
  owner: 4,
  admin: 3,
  member: 2,
  restricted: 1,
};
const RANK_MAX = 4;

// -- Вычисление подкомпонентов -------------------------------------------------------------

/**
 * C_dist(n): социальная дистанция.
 *
 * Взвешенная сумма трёх подэлементов:
 *   α₁ · |sent - recv| / window    — дисбаланс взаимности
 *   α₂ · (1 - tier / tier_max)     — дистанция по tier
 *   α₃ · σ(t_gap / τ_d)           — sigmoid времени последнего взаимодействия
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

  // Дисбаланс взаимности: Алиса отправляет слишком много vs собеседник слишком мало
  // P1-1 fix: зажим в [0, 1], предотвращает переполнение от накопленных sent/recv
  // ADR-113: сигнал дисбаланса взаимности ослаблен в группе (× 0.3) — групповой диалог не требует баланса один к одному
  const reciprocityRaw = Math.min(1, Math.abs(aliceSentWindow - contactRecvWindow) / w);
  const reciprocity = reciprocityRaw * (isGroup ? 0.3 : 1.0);

  // Дистанция по tier: чем дальше tier → тем больше социальная дистанция
  // ADR-116: ослаблено в группе — порог высказывания в общем пространстве ниже, чем при личной инициативе
  // @see docs/adr/116-group-silence-trap.md §Правка 3
  const tierDist = (1 - tier / TIER_MAX) * (isGroup ? 0.4 : 1.0);

  // Sigmoid временного интервала: давно не взаимодействовали → чувство дистанции растёт
  // P3-2 fix: сдвигаем sigmoid, чтобы при tGap=0 значение было близко к 0, а не 0.5
  // σ(tGap; τ) = 1 / (1 + exp(-(tGap - 2τ) / τ))
  //   tGap=0   → ~0.12 (только что взаимодействовали, дистанция низкая)
  //   tGap=2τ  → 0.5
  //   tGap>>τ  → ~1.0 (давно не взаимодействовали, дистанция высокая)
  //
  // ADR-151: tauDist per-tier — τ_d = θ_c/2, выравнивает нейтральную точку sigmoid с порогом кулдауна каждого tier.
  // Эффект: tier 5 сохраняет 3600s (как раньше), tier 50 вырастает до 21600s, tier 150 до 86400s.
  // Fallback к cfg.tauDist (3600s) для нестандартных tier.
  // @see docs/adr/151-algorithm-audit/research-online-calibration.md §5.3
  const thetaForTier = DUNBAR_TIER_THETA[tier as DunbarTier];
  const effectiveTauDist = thetaForTier != null ? thetaForTier / 2 : cfg.tauDist;
  const sigmoid =
    1 / (1 + Math.exp(-(tGap - 2 * effectiveTauDist) / Math.max(effectiveTauDist, 1)));

  return cfg.alpha1 * reciprocity + cfg.alpha2 * tierDist + cfg.alpha3 * sigmoid;
}

/**
 * C_power(n): разница власти.
 *
 * @see paper/ Definition 8, C_power
 */
function cPower(
  aliceRank: number,
  targetRank: number,
  isTargetTerritory: boolean,
  cfg: SocialCostConfig,
): number {
  // Ранг собеседника выше, чем у Алисы → большее давление
  const rankDiff = Math.max(0, targetRank - aliceRank) / RANK_MAX;
  const territory = isTargetTerritory ? 1 : 0;

  return cfg.beta1 * rankDiff + cfg.beta2 * territory;
}

/**
 * C_imp(a, n): навязчивость действия.
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
 * C_temp(a, n): временной штраф.
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
  // Штраф за плотность: чем плотнее недавние действия → тем больше штраф
  const densityPenalty = 1 - Math.exp(-actionDensity / Math.max(cfg.lambdaC, 0.01));

  // ADR-153 Phase 2: модуляция скорости сообщений собеседника — обнаружение асимметрии
  // asymmetry > 0: Алиса отправляет слишком много → повышаем C_temp (сдерживаем избыточные ответы)
  // asymmetry < 0: Алиса отвечает недостаточно → снижаем C_temp (стимулируем ответ)
  // @see simulation/experiments/exp_hawkes_phase2_validation.py проверка 2
  let adjustedDensity = densityPenalty;
  if (opponentLambda != null) {
    const aliceRate = actionDensity / windowS;
    const maxRate = Math.max(aliceRate, opponentLambda, 1e-12);
    const asymmetry = (aliceRate - opponentLambda) / maxRate;
    adjustedDensity = densityPenalty * (1 + 0.3 * Math.max(-1, Math.min(1, asymmetry)));
  }

  return cfg.delta1 * adjustedDensity + cfg.delta2 * maxSimilarity;
}

// -- Вспомогательные функции ---------------------------------------------------------------

/**
 * Извлечь контекстный сигнал C_ctx ∈ [0, 1] из графа.
 *
 * Выводится из фактической панели D2: сценарии grief / unanswered / endpoint
 * помогают Алисе понять, что "сейчас, возможно, не лучшее время беспокоить".
 */
function extractContextSignal(
  G: WorldModel,
  targetId: string,
  isGroup = false,
  nowMs = Date.now(),
): number {
  if (!G.has(targetId)) return 0.5;

  // Взвешивание нескольких сигналов: risk, последовательные сообщения, недавняя очистка
  // ADR-126: все сигналы читаются через слой затухания, устраняя постоянное влияние устаревших данных
  let signal = 0;
  let count = 0;

  // Уровень риска (непрерывное значение после затухания)
  const riskValue = effectiveRisk(G, targetId, nowMs);
  if (riskValue > 0) {
    signal += riskValue;
    count++;
  }

  // Последовательные исходящие (после затухания — через 24ч социальный контекст сброшен)
  const outgoing = effectiveOutgoing(G, targetId, nowMs);
  if (outgoing > 0) {
    signal += Math.min(1, outgoing / 5);
    count++;
  }

  // Недавнее качество взаимодействия (затухает к нейтральному 0.5 — старые плохие оценки не поднимают стоимость навсегда)
  const quality = effectiveOutcomeQuality(G, targetId, nowMs);
  signal += 1 - quality;
  count++;

  // Сигнал завершения диалога — социальные издержки растут при отсутствии активного разговора или его скором окончании
  const activeConv = findActiveConversation(G, targetId);
  if (!activeConv) {
    // Проверяем, есть ли диалог в состоянии closing (скоро завершится, но ещё не остыл)
    let hasClosing = false;
    for (const convId of G.getEntitiesByType("conversation")) {
      const convAttrs = G.getConversation(convId);
      if (convAttrs.channel === targetId && convAttrs.state === "closing") {
        hasClosing = true;
        break;
      }
    }
    if (hasClosing) {
      // Диалог скоро закончится → не стоит беспокоить
      signal += 0.7;
      count++;
    } else {
      // Нет активного диалога вообще → холодный старт, порог инициативы выше
      // ADR-116: в группе отсутствие активного диалога является нормой (правило 90-9-1), издержки значительно ниже, чем при холодном старте в личке
      // @see docs/adr/116-group-silence-trap.md §Правка 2
      signal += isGroup ? 0.2 : 0.6;
      count++;
    }
  }

  // Обнаружение grief / чувствительных состояний
  // 1) Обнаружение негативных эмоций по mood_valence связанного contact
  // @see ADR-50: семантика принадлежит LLM, структура принадлежит коду — используем числовую оценку, а не regex
  const contactId = chatIdToContactId(targetId);
  if (contactId && contactId !== targetId && G.has(contactId)) {
    const contactAttrs = G.getContact(contactId);
    const moodValence = Number(contactAttrs.mood_valence ?? 0);
    // Негативные эмоции (valence < -0.3) увеличивают социальные издержки
    if (moodValence < -0.3) {
      signal += Math.min(0.9, 0.5 + Math.abs(moodValence));
      count++;
    }
  }
  // 2) risk_reason как дополнение к сигналу риска
  // effectiveRisk уже обработан выше. Если есть risk_reason, но effectiveRisk равен нулю (risk_level не помечен или затух),
  // поднимаем сигнал (эквивалентно неявному "low" риску).
  if (riskValue === 0) {
    const targetAttrs = G.getChannel(targetId);
    if (targetAttrs.risk_reason) {
      // Дополнительный сигнал, count не увеличиваем — risk_reason является вспомогательным сигналом, а не отдельным измерением;
      // увеличение count разбавит среднее (0.1 ниже среднего других сигналов, что снизит общую стоимость).
      signal += 0.1;
    }
  }

  return count > 0 ? signal / count : 0.5;
}

/**
 * Вычислить max_sim: максимальное сходство текущего действия с недавними.
 * Упрощённая реализация: одинаковый тип действия = 1, разный = 0.
 *
 * @see paper/ Definition 8, C_temp: max_sim(a, a')
 */
function maxSimilarity(actionType: string, recentActionTypes: string[]): number {
  for (const recent of recentActionTypes) {
    if (recent === actionType) return 1;
  }
  return 0;
}

// -- Главная функция -----------------------------------------------------------------

/**
 * Вычислить социальные издержки выполнения указанного действия над целевой сущностью.
 *
 * Чистая функция: только читает G + переданные параметры, побочных эффектов нет.
 *
 * @param G - граф-компаньон (только чтение)
 * @param targetId - ID целевой сущности (channel или contact)
 * @param actionType - тип действия (название голоса или конкретное действие)
 * @param tick - текущий тик
 * @param recentActions - запись недавних действий
 * @param config - конфигурация Social Cost
 * @param chatType - тип целевого канала (по умолчанию "private"; в группе социальные издержки ниже)
 * @returns социальные издержки ∈ [0, ~1] (теоретически без жёсткого верхнего предела, но каждый подэлемент ∈ [0,1])
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
  // ADR-206: у канала нет социальных обязательств (чистый информационный поток), социальные издержки равны 0
  if (chatType === "channel") return 0;

  // --- C_dist: социальная дистанция ---

  // Получить счётчики окна sent/recv
  let aliceSentWindow = 0;
  let contactRecvWindow = 0;
  let tier = 150; // Данбар 150 по умолчанию

  // Получить данные отслеживания из channel или contact
  if (G.has(targetId)) {
    const attrs = G.getChannel(targetId);
    aliceSentWindow = Number(attrs.alice_sent_window ?? 0);
    contactRecvWindow = Number(attrs.contact_recv_window ?? 0);
    // tier берётся из channel.tier_contact
    tier = Number(attrs.tier_contact ?? 150);
  }

  // Также пробуем получить tier из связанного contact
  const contactId = chatIdToContactId(targetId);
  if (contactId && contactId !== targetId && G.has(contactId)) {
    const contactAttrs = G.getContact(contactId);
    tier = contactAttrs.tier;
  }

  // Временной интервал: секунды стенного времени с момента последнего взаимодействия
  let lastInteractionMs = 0;
  if (G.has(targetId)) {
    const aliceMs = readNodeMs(G, targetId, "last_alice_action_ms");
    const directedMs = readNodeMs(G, targetId, "last_directed_ms");
    lastInteractionMs = Math.max(aliceMs, directedMs);
  }
  const tGap = elapsedS(nowMs, lastInteractionMs);

  const isGroup = ChatTarget.isGroupChat(chatType);
  const dist = cDist(aliceSentWindow, contactRecvWindow, tier, tGap, config, isGroup);

  // --- C_power: разница власти ---
  // P2-1 fix: читаем из атрибута alice_role канала (записывается на этапе perceive)
  const aliceRole = G.has(targetId)
    ? String(G.getChannel(targetId).alice_role ?? "member")
    : "member";
  const aliceRank = ROLE_RANK[aliceRole] ?? ROLE_RANK.member;
  let targetRank = ROLE_RANK.member;
  let isTargetTerritory = false;

  if (G.has(targetId)) {
    // ADR-113: группа — общее пространство, больше не считается "территорией собеседника"
    // Только новые участники (вступили < 7 дней назад) считаются "нарушителями" — социальные издержки выше при активной отправке сразу после вступления
    if (isGroup) {
      const joinMs = Number(G.getChannel(targetId).join_ms ?? 0);
      isTargetTerritory = joinMs > 0 && nowMs - joinMs < 7 * 86_400_000;
      targetRank = ROLE_RANK.member;
    }
  }

  const power = cPower(aliceRank, targetRank, isTargetTerritory, config);

  // --- C_imp: навязчивость ---
  const contextSignal = extractContextSignal(G, targetId, isGroup, nowMs);
  const imp = cImp(actionType, contextSignal, config, chatType);

  // --- C_temp: временной штраф (window теперь в секундах) ---
  const windowStartMs = nowMs - config.window * 1000;
  const actionsInWindow = recentActions.filter(
    (a) => (a.ms ?? a.tick * LEGACY_TICK_INTERVAL_MS) > windowStartMs,
  );
  const actionDensity = actionsInWindow.length;
  const typesInWindow = actionsInWindow.map((a) => a.action);
  const maxSim = maxSimilarity(actionType, typesInWindow);

  // ADR-153 Phase 2: читаем Hawkes λ(t) из contact → передаём в C_temp для обнаружения асимметрии
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

  // --- Итог: взвешенная сумма ---
  return config.wDist * dist + config.wPower * power + config.wImp * imp + config.wTemp * temp;
}

// ═══════════════════════════════════════════════════════════════════════════
// ADR-136: Saturation Cost C_sat
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Конфигурация Saturation Cost.
 *
 * Веса и параметры 4 подкомпонентов. Веса должны давать достаточно большой C_sat при σ=1.0,
 * чтобы NSV ≤ 0 (эквивалентно "блокировке"), но при малом σ влияние на NSV незначительно.
 *
 * @see docs/adr/136-constrained-vmax/README.md §2.4
 */
export const SaturationCostConfigSchema = z.object({
  /** Вес σ_rate — насыщение частоты per-target. */
  wRate: z.number().min(0).default(2.0),
  /** Вес σ_cool — кулдаун proactive. */
  wCool: z.number().min(0).default(1.5),
  /** Вес σ_out — насыщение consecutive outgoing. */
  wOut: z.number().min(0).default(2.0),
  /** Вес σ_fail — сбой выполнения ACT. */
  wFail: z.number().min(0).default(1.5),

  /** Показатель выпуклости σ_rate α > 1 (штраф становится круче по мере приближения к лимиту). */
  alphaRate: z.number().min(1).default(2.0),
  /** Показатель выпуклости σ_out β > 1. */
  betaOut: z.number().min(1).default(2.0),
  /** Наклон экспоненты σ_fail γ. */
  gammaFail: z.number().positive().default(0.5),

  /** Лимит частоты per-target (стандартный).
   * ADR-189 Cockroach Audit Recal 2: 3→4 (1 раз за 12.5 минут в окне 50 минут; лучше подходит для активных личных чатов). */
  perTargetCap: z.number().int().positive().default(4),
  /** Лимит частоты per-target (при obligation bypass). */
  perTargetCapBypass: z.number().int().positive().default(5),

  /** Лимит consecutive outgoing — приватный чат.
   * ADR-189 Cockroach Audit Recal 1: 3→4 (оставляем один буфер для проактивного диалога). */
  outgoingCapPrivate: z.number().int().positive().default(4),
  /** Лимит consecutive outgoing — группа. */
  outgoingCapGroup: z.number().int().positive().default(4),
});

export type SaturationCostConfig = z.infer<typeof SaturationCostConfigSchema>;

/** Конфигурация Saturation Cost по умолчанию. */
export const DEFAULT_SATURATION_COST_CONFIG: SaturationCostConfig =
  SaturationCostConfigSchema.parse({});

/**
 * ADR-154: извлечь действующий Dunbar tier из target (channel/contact).
 * Приоритет — tier связанного contact, fallback — tier_contact канала.
 */
function extractTierFromTarget(G: WorldModel, targetId: string, isGroup: boolean): DunbarTier {
  // Приватный чат: выводим channel → contact
  const contactId = chatIdToContactId(targetId);
  if (contactId && contactId !== targetId && G.has(contactId)) {
    return G.getContact(contactId).tier;
  }
  // Группа или нет связанного contact: используем tier_contact канала
  if (G.has(targetId)) {
    return G.getChannel(targetId).tier_contact;
  }
  // Fallback: группа по умолчанию 150, приватный чат 50
  return isGroup ? 150 : 50;
}

/**
 * ADR-136: Saturation Cost C_sat — кодирует ограничения выполнения как непрерывный штраф.
 *
 * 4 подкомпонента соответствуют 4 типам свёрнутых бинарных гейтов:
 *   σ_rate — насыщение частоты per-target
 *   σ_cool — кулдаун proactive
 *   σ_out  — насыщение consecutive outgoing
 *   σ_fail — штраф за сбой выполнения (временное затухание)
 *
 * Чистая функция: только читает G + переданные параметры, побочных эффектов нет.
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
  // ADR-206: у канала нет saturation cost (информационная сущность, а не социальный партнёр)
  if (ChatTarget.isChannelChat(chatType)) return 0;

  const isGroup = ChatTarget.isGroupChat(chatType);

  // ── σ_rate: насыщение частоты per-target ──
  const cap = bypassGates ? config.perTargetCapBypass : config.perTargetCap;
  const ratioRate = Math.min(1, recentTargetActionCount / Math.max(cap, 1));
  const sigmaRate = ratioRate ** config.alphaRate;

  // ── σ_cool: кулдаун proactive (ADR-154: per-tier τ_cool) ──
  let sigmaCool = 0;
  if (G.has(targetId)) {
    const lastProactiveMs = readNodeMs(G, targetId, "last_proactive_outreach_ms");
    if (lastProactiveMs > 0) {
      const elapsedCoolS = Math.max(0, (nowMs - lastProactiveMs) / 1000);
      // ADR-154: τ_cool per-tier — у близких друзей кулдаун короче, у дальних знакомых длиннее
      const tier = extractTierFromTarget(G, targetId, isGroup);
      const tauCool = isGroup
        ? proactiveCooldownForTier(tier) * 0.25 // кулдаун в группе = личный × 0.25
        : proactiveCooldownForTier(tier);
      sigmaCool = Math.exp(-elapsedCoolS / Math.max(tauCool, 1));
    }
  }

  // ── σ_out: насыщение consecutive outgoing ──
  let sigmaOut = 0;
  if (G.has(targetId)) {
    const outgoing = effectiveOutgoing(G, targetId, nowMs);
    const outCap = isGroup ? config.outgoingCapGroup : config.outgoingCapPrivate;
    const ratioOut = Math.min(1, outgoing / Math.max(outCap, 1));
    sigmaOut = ratioOut ** config.betaOut;
  }

  // ── σ_fail: сбой выполнения ACT (временное затухание) ──
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
