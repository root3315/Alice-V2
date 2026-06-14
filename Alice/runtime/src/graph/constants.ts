/**
 * Константы графа — перенесены дословно из Python graph.py.
 * @see docs/adr/155-branded-graph-id.md — Branded ID + формализация префиксов
 */
import type {
  ChannelNodeId,
  ContactNodeId,
  DunbarTier,
  EdgeCategory,
  TelegramId,
  ThreadWeight,
} from "./entities.js";

// Веса уровней Данбара: чем меньше круг, тем выше вес
export const DUNBAR_TIER_WEIGHT: Record<DunbarTier, number> = {
  5: 5.0, // близкий круг
  15: 3.0, // круг друзей
  50: 1.5, // круг приятелей
  150: 0.8, // круг знакомых
  500: 0.3, // круг «знаю в лицо»
};

// ADR-113 §D3: ожидаемая частота взаимодействий theta_c для уровней Данбара (в секундах).
// Калибровано для **онлайн мессенджеров** (не офлайн-общение).
// Потребность в мгновенном ответе покрывается P5; theta_c измеряет
// «через сколько времени без контакта отношения начинают остывать».
// @see docs/adr/113-online-social-recalibration/ §D3
export const DUNBAR_TIER_THETA: Record<DunbarTier, number> = {
  5: 7200, // близкий круг: 2 часа
  15: 14400, // круг друзей: 4 часа
  50: 43200, // круг приятелей: 12 часов
  150: 172800, // круг знакомых: 2 дня
  500: 604800, // круг «знаю в лицо»: 7 дней
};

// ADR-121: окно периферийного социального видения (сек) — чем ближе уровень Данбара, тем больше окно.
// @see docs/adr/121-social-peripheral-vision/README.md §3.2
export const PERIPHERAL_TIER_WINDOW_S: Record<DunbarTier, number> = {
  5: 86400, // близкий круг: 24h
  15: 43200, // круг друзей: 12h
  50: 21600, // круг приятелей: 6h
  150: 7200, // круг знакомых: 2h
  500: 0, // круг «знаю в лицо»: отключено
};

// ADR-111: параметры логарифмической временной шкалы P3 — основаны на законе Вебера–Фехнера.
// @see docs/adr/111-log-time-sigmoid/README.md

/**
 * Гранулярность временного восприятия по Веберу–Фехнеру (секунды).
 * Тишина менее τ₀ воспринимается приблизительно линейно; тишина более τ₀
 * логарифмически сжимается.
 * 600 с = 10 минут — минимально воспринимаемое различие (JND) изменений времени у человека.
 */
export const P3_TAU_0 = 600;

/**
 * Параметр крутизны сигмоиды P3 в логарифмическом домене.
 * Вывод: переходная зона от θ/α до α·θ (α=3),
 * β_r = 4.394 / median(W_log across tiers) ≈ 2.5.
 * Диапазон W_log по уровням [1.435, 2.074]; медиана соответствует tier-50.
 */
export const P3_BETA_R = 2.5;

// Отображение весов потоков
export const THREAD_WEIGHTS: Record<ThreadWeight, number> = {
  critical: 4.0,
  major: 2.0,
  minor: 1.0,
  subtle: 0.5,
  trivial: 0.25,
};

// Отображение меток рёбер → категорий рёбер
export const LABEL_CATEGORY: Record<string, EdgeCategory> = {
  monitors: "spatial",
  joined: "spatial",
  owner: "ownership",
  friend: "social",
  acquaintance: "social",
  stranger: "social",
  knows: "cognitive",
  suspects: "cognitive",
  tracks: "cognitive",
  caused: "causal",
  promised: "causal",
  discovered: "causal",
  involves: "ownership",
  from: "ownership",
  in: "ownership",
  happens_in: "spatial", // ADR-26: conversation → channel
  participates: "social", // ADR-26: contact → conversation
};

// Веса категорий рёбер для лапласового распространения (v4)
export const PROPAGATION_WEIGHT: Record<EdgeCategory, number> = {
  spatial: 0.5,
  social: 1.0,
  cognitive: 0.3,
  causal: 0.8,
  ownership: 0.6,
};

/** Отображает метку ребра в категорию; неизвестные метки по умолчанию дают ownership. */
export function labelToCategory(label: string): EdgeCategory {
  return LABEL_CATEGORY[label] ?? "ownership";
}

/** Последовательность уровней Данбара (по возрастанию). */
export const TIER_SEQUENCE: DunbarTier[] = [5, 15, 50, 150, 500];

/** Уровень Данбара → текстовая метка. Используется в нескольких местах (self-observation, strategy hints, relationships contribute). */
const TIER_LABELS: Record<number, string> = {
  5: "intimate",
  15: "close friend",
  50: "friend",
  150: "acquaintance",
  500: "known",
};

/** Преобразует номер уровня в текстовую метку; неизвестный уровень возвращает "acquaintance". */
export function tierLabel(tier: number): string {
  return TIER_LABELS[tier] ?? "acquaintance";
}

/**
 * Находит ближайший DunbarTier к непрерывному значению.
 * Используется после tier bias correction для отображения непрерывного
 * значения обратно в дискретный уровень.
 */
export function nearestTier(value: number): DunbarTier {
  let best: DunbarTier = 150;
  let bestDist = Infinity;
  for (const t of TIER_SEQUENCE) {
    const dist = Math.abs(value - t);
    if (dist < bestDist) {
      bestDist = dist;
      best = t;
    }
  }
  return best;
}

/** Базовое значение для коррекции смещения уровня. */
const TIER_BASELINE = 150;

/**
 * Коррекция смещения завышения уровня — Social POMDP.
 *
 * Если дисперсия σ² убеждения по уровню в BeliefStore высока,
 * это означает неопределённость в оценке близости контакта.
 * Стратегия коррекции: регрессия уровня к базовому значению 150 (знакомые).
 *
 * effectiveTier = tier + (150 - tier) × min(σ², 0.8)
 *
 * σ² низкая (<0.3) → без коррекции, доверяем текущему уровню
 * σ² высокая (>0.3) → регрессия к 150, чем больше неопределённость, тем консервативнее
 *
 * @param tier исходный DunbarTier (5/15/50/150/500)
 * @param sigma2 дисперсия убеждения, от 0 до 1. undefined — нет данных убеждения.
 * @returns скорректированный ближайший DunbarTier
 *
 * @see paper/ §Social POMDP "Tier Overestimate Bias Correction"
 */
export function tierBiasCorrection(tier: DunbarTier, sigma2: number | undefined): DunbarTier {
  if (sigma2 === undefined || sigma2 <= 0.3) return tier;
  const regression = Math.min(sigma2, 0.8);
  const effectiveTier = tier + (TIER_BASELINE - tier) * regression;
  return nearestTier(effectiveTier);
}

/** Константа ID узла самой Alice. m2: устраняет жёстко закодированную строку "self". */
export const ALICE_SELF = "self";

// -- Единая спецификация измерений давления ---------------------------------------------------------

/**
 * Спецификация измерений давления — унифицированная система двух констант.
 *
 * - kappa: кривизна tanh-нормализации (для агрегации API, точка полунасыщения)
 * - typicalScale: типичная верхняя граница величины (для взвешивания staleness)
 *
 * Устраняет дублирование DEFAULT_KAPPA из aggregate.ts и PRESSURE_SCALES из act.ts.
 * @see paper/ §3.3 "API Normalization"
 */
export interface PressureDimensionSpec {
  /** ADR-112 D4: минимальное κ (исходно жёстко заданное kappa, теперь нижняя граница адаптивного κ). */
  kappaMin: number;
  typicalScale: number;
}

export const PRESSURE_SPECS: Record<string, PressureDimensionSpec> = {
  // ADR-215: повышаем κ₁ под реальный масштаб (968 контактов, исходная калибровка ~15)
  // Типичный вклад: unread × w ≈ 5 × 20 = 100; при κ=15 tanh(100/15)≈0.999 всё ещё высоко
  // но совместно с ln(1+unread) в effectiveUnread P1 должен оставаться в разумных пределах
  P1: { kappaMin: 15.0, typicalScale: 200 },

  // ADR-215: повышаем κ₂ под реальный масштаб (192 факта)
  // Типичный вклад: 192 × 0.5 × 0.5 ≈ 48 (средний importance=0.5, наполовину забыто)
  P2: { kappaMin: 20.0, typicalScale: 50 },

  // P3 имеет Top-K усечение, отвязанное от общего масштаба; κ сохраняется умеренным
  P3: { kappaMin: 10.0, typicalScale: 8 },

  // P4 растёт логарифмически, субlinейно по масштабу; κ сохраняется консервативным
  P4: { kappaMin: 5.0, typicalScale: 10 },

  // ADR-215: значительно повышаем κ₅ для согласования с логарифмическим масштабированием directed
  // effectiveDirected = ln(1+min(raw, 5)) ≈ 1.8
  // Типичный вклад: 72 канала × 1.8 × avg(w≈50) × chatW(1) ≈ 150
  // При κ=50 tanh(150/50)=0.76 — динамический диапазон сохраняется
  P5: { kappaMin: 50.0, typicalScale: 50 },

  // P6 ограничен по статье [0, η]; κ мал, но η=0.6 гарантирует ограниченность
  P6: { kappaMin: 0.5, typicalScale: 0.6 },
};

/** Шестёрка kappaMin, производная от PRESSURE_SPECS (нижняя граница kappa по умолчанию). */
export const DEFAULT_KAPPA: [number, number, number, number, number, number] = [
  PRESSURE_SPECS.P1.kappaMin,
  PRESSURE_SPECS.P2.kappaMin,
  PRESSURE_SPECS.P3.kappaMin,
  PRESSURE_SPECS.P4.kappaMin,
  PRESSURE_SPECS.P5.kappaMin,
  PRESSURE_SPECS.P6.kappaMin,
];

/** Шестёрка typicalScale, производная от PRESSURE_SPECS (для взвешивания staleness). */
export const PRESSURE_TYPICAL_SCALES: [number, number, number, number, number, number] = [
  PRESSURE_SPECS.P1.typicalScale,
  PRESSURE_SPECS.P2.typicalScale,
  PRESSURE_SPECS.P3.typicalScale,
  PRESSURE_SPECS.P4.typicalScale,
  PRESSURE_SPECS.P5.typicalScale,
  PRESSURE_SPECS.P6.typicalScale,
];

// -- Единые веса chat_type -------------------------------------------------------

/**
 * Единые веса chat_type (устраняет разрозненные константы в p1 и p5).
 * @see paper/ §3.1 "Goffman's Dramaturgical Theory"
 */
export const CHAT_TYPE_WEIGHTS: Record<string, { attention: number; response: number }> = {
  private: { attention: 3.0, response: 2.0 },
  group: { attention: 1.0, response: 1.0 },
  supergroup: { attention: 0.8, response: 0.8 },
  channel: { attention: 0.3, response: 0.3 },
};

// -- Непрерывный спектр стабильности (Continuous Stability Spectrum) ---------------------------
// Заменяет бинарную классификацию semantic/episodic. Все факты используют
// единую кривую забывания SM-2; разница только в начальной стабильности S₀:
// preference/skill затухают медленно (~1.5 года полужизни),
// observation — очень быстро (~27 дней), остальные — посередине.
//
// SM-2: R(t) = (1 + t/(9·S))^d, d=-0.5
// Период полужизни t_half = 27·S дней
//
// Онлайн-социальная калибровка: в IM информация обновляется значительно
// чаще, чем в офлайн-отношениях. Предпочтение, не закреплённое год, уже
// заслуживает повторной проверки. S₀ контролирует только «естественное
// затухание без закрепления» — активные факты накапливают рост через
// remember() × STABILITY_REINFORCE_FACTOR и этим не ограничены.
// Опровергающие свидетельства исправляются мгновенно через
// update_fact/delete_fact, без ожидания затухания.
//
// @see docs/adr/151-algorithm-audit/research-online-calibration.md
// Отображение выводится кодом из fact_type — следует ADR-50 "семантика за LLM, структура за кодом".

/**
 * Отображение fact_type → начальная стабильность S₀ (онлайн-социальная калибровка).
 *
 * | fact_type   | S₀ | период полужизни | когнитивное обоснование                          |
 * |-------------|-----|-----------------|--------------------------------------------------|
 * | preference  | 20  | ~1.5 года       | предпочтение без закрепления 1.5 года → пора перепроверить |
 * | skill       | 20  | ~1.5 года       | навык, упомянутый в чате — срок хранения разумен |
 * | general     | 14  | ~1 год          | работа/город/статус — люди меняются              |
 * | interest    | 7   | ~6 месяцев      | онлайн-интересы очень подвижны                   |
 * | growth      | 3   | ~2.7 месяца     | текущий статус — за несколько месяцев ясно, завершено или брошено |
 * | observation | 1   | ~27 дней        | мимолётное наблюдение, затухает быстрее всего    |
 */
export const FACT_TYPE_INITIAL_STABILITY: Record<string, number> = {
  preference: 20,
  skill: 20,
  general: 14,
  interest: 7,
  growth: 3,
  observation: 1,
};

/** Стабильность по умолчанию (неизвестный fact_type обрабатывается как observation — консервативно, быстрое затухание). */
const DEFAULT_STABILITY = 1;

/** Выводит начальную стабильность S₀ из fact_type. LLM не нужно передавать это явно. */
export function factTypeInitialStability(factType: string | undefined): number {
  return FACT_TYPE_INITIAL_STABILITY[factType ?? "general"] ?? DEFAULT_STABILITY;
}

/** Коэффициент усиления стабильности при повторном упоминании факта в remember(). S_new = S_old × REINFORCE_FACTOR. */
export const STABILITY_REINFORCE_FACTOR = 1.2;

// -- Общие константы кривой забывания --------------------------------------------------------

/**
 * ADR-110: временной масштаб забывания фактов (секунды).
 * 1 день = 86400 секунд. Константа разделяется P2 и factRetrievability.
 * @see paper/ §3.2 "Information Pressure"
 */
export const FACT_TIME_SCALE = 86400;

/** Параметр кривой забывания d. */
export const FACT_DECAY_D = -0.5;

/** Порог забывания: факты с R ниже этого значения не вставляются в контекст. */
export const FACT_FORGET_THRESHOLD = 0.2;

/** Коэффициент консолидации SM-2. */
export const FACT_CONSOLIDATION_FACTOR = 1.5;

// -- Константы префиксов (ADR-155) ------------------------------------------------------

/** Префикс ID узла-канала в графе. */
export const CHANNEL_PREFIX = "channel:";
/** Префикс ID узла-контакта в графе. */
export const CONTACT_PREFIX = "contact:";
/** Префикс ID узла-разговора в графе. */
export const CONVERSATION_PREFIX = "conversation:";
export const TELEGRAM_PLATFORM = "telegram";

const PLATFORM_ENTITY_ID_RE = /^(channel|contact):([a-z][a-z0-9_-]*):(.+)$/u;
const TELEGRAM_NUMBER_RE = /^-?\d+$/u;

// -- Утилиты преобразования ID -------------------------------------------------------------

/**
 * Преобразует chatId (channel:xxx) в contactId (contact:xxx).
 * m6: централизует соглашение об именовании, заменяя жёстко закодированную обработку префиксов в разных местах.
 * @see docs/adr/155-branded-graph-id.md
 */
export function chatIdToContactId(chatId: string): ContactNodeId | null {
  const parsed = parsePlatformEntityId(chatId);
  if (parsed) {
    if (parsed.kind === "contact") return chatId as ContactNodeId;
    return platformContactId(parsed.platform, parsed.nativeId);
  }
  return null;
}

// -- Универсальные преобразования ID -----------------------------------------------------------

export function platformChannelId(platform: string, nativeId: string | number): ChannelNodeId {
  return `${CHANNEL_PREFIX}${platform}:${nativeId}` as ChannelNodeId;
}

export function platformContactId(platform: string, nativeId: string | number): ContactNodeId {
  return `${CONTACT_PREFIX}${platform}:${nativeId}` as ContactNodeId;
}

export function telegramChannelId(nativeId: string | number): ChannelNodeId {
  return platformChannelId(TELEGRAM_PLATFORM, nativeId);
}

export function telegramContactId(nativeId: string | number): ContactNodeId {
  return platformContactId(TELEGRAM_PLATFORM, nativeId);
}

function parsePlatformEntityId(
  id: string,
): { kind: "channel" | "contact"; platform: string; nativeId: string } | null {
  const match = PLATFORM_ENTITY_ID_RE.exec(id);
  if (!match) return null;
  return {
    kind: match[1] as "channel" | "contact",
    platform: match[2],
    nativeId: match[3],
  };
}

/** Извлекает числовой ID из ID сущности Telegram или нативного числового маркера Telegram. */
export function extractNumericId(id: string): TelegramId | null {
  let raw: string;
  const parsed = parsePlatformEntityId(id);
  if (parsed) {
    if (parsed.platform !== TELEGRAM_PLATFORM) return null;
    raw = parsed.nativeId;
  }
  // Префикс @senderId (соглашение об аннотации в промпте) + ~senderId (сокращение для LLM)
  else if (id.startsWith("@") || id.startsWith("~")) raw = id.slice(1);
  else raw = id;
  if (!TELEGRAM_NUMBER_RE.test(raw)) return null;
  const n = Number(raw);
  return Number.isNaN(n) || raw === "" ? null : (n as TelegramId);
}

/**
 * Гарантирует, что ID имеет формат channel.
 * Принимает только явно квалифицированные channel/contact ID; нативные числа Telegram
 * должны явно преобразовываться через telegramChannelId() в точке вызова.
 * @see docs/adr/155-branded-graph-id.md
 */
export function ensureChannelId(id: string): ChannelNodeId | null {
  const parsed = parsePlatformEntityId(id);
  if (parsed?.kind === "channel") return id as ChannelNodeId;
  if (parsed?.kind === "contact") return platformChannelId(parsed.platform, parsed.nativeId);
  return null;
}

// -- Константы Perceive Facts (ADR-160) ------------------------------------------
// @see docs/adr/158-outbound-feedback-gap.md

/** ADR-160 Fix A: верхний предел отдельного пула ёмкости для perceive-sourced facts. Не входит в квоту 20 для контакта. */
export const PERCEIVE_FACTS_LIMIT = 30;

/** ADR-160 Fix A: интервал дебаунса perceive fact для одного канала (мс). 30 минут. */
export const PERCEIVE_FACT_DEBOUNCE_MS = 30 * 60_000;

/** ADR-160 Fix A: порог накопленных сообщений в канале — perceive fact создаётся только при ≥ этого числа сообщений с момента последнего действия Alice. */
export const PERCEIVE_FACT_MSG_THRESHOLD = 3;

// -- Отдельные параметры присутствия в группе (ADR-160) -------------------------------------------
// @see docs/adr/158-outbound-feedback-gap.md

/**
 * ADR-160 Fix B: отображение theta для групп (секунды).
 *
 * Социальная динамика группы отличается от двусторонних отношений:
 * молчать весь день в активном чате — ненормально,
 * а несколько дней без личного сообщения другу — нормально.
 * Групповое theta примерно в 12 раз быстрее DUNBAR_TIER_THETA.
 */
export const GROUP_PRESENCE_THETA: Record<DunbarTier, number> = {
  5: 1800, // intimate group:    30 min
  15: 3600, // close group:       1 hour
  50: 7200, // friend group:      2 hours
  150: 14400, // acquaintance group: 4 hours
  500: 43200, // stranger group:    12 hours
};

/**
 * ADR-161 §3.4: theta, управляемый траекторией — кратное естественного интервала сообщений
 * в группе → средняя точка сигмоиды P3.
 * K=10 означает: группа отправила 10 раундов сообщений, пока Alice молчит — давление отсутствия достигает 50%.
 * @see docs/adr/161-action-space-audit-group-cadence.md §3.4
 */
export const K_ABSENCE_ROUNDS = 10;

/** ADR-161 §3.4: нижняя граница зажима разумного диапазона theta, управляемого траекторией (сек). 30 минут. */
export const TRAJECTORY_THETA_MIN_S = 1800;

/** ADR-161 §3.4: верхняя граница зажима разумного диапазона theta, управляемого траекторией (сек). 7 дней. */
export const TRAJECTORY_THETA_MAX_S = 604800;

// -- Константы эмоциональной реактивности (ADR-156) ------------------------------------------------
// @see docs/adr/156-emotional-reactivity-damping.md

/** ADR-156: период полужизни эмоциональной реактивности (мс). По умолчанию 2 часа. */
export const EMOTIONAL_HALF_LIFE = 7_200_000;

/** ADR-156: коэффициент разряда. После ответа Alice: E *= это значение (один ответ снимает 70% эмоционального давления). */
export const EMOTIONAL_DISCHARGE_FACTOR = 0.3;

/** ADR-156: порог отображения эмоции. При E > этого значения используется метка (vivid). */
export const EMOTIONAL_VIVID_THRESHOLD = 0.5;

/** ADR-156: порог отображения эмоции. При E > этого значения используется метка (noted), иначе — без метки. */
export const EMOTIONAL_NOTED_THRESHOLD = 0.2;

/**
 * Гарантирует, что ID имеет формат contact (contact:xxx).
 * Принимает только явно квалифицированные channel/contact ID; нативные числа Telegram
 * должны явно преобразовываться через telegramContactId() в точке вызова.
 * @see docs/adr/155-branded-graph-id.md
 */
export function ensureContactId(id: string): ContactNodeId | null {
  const parsed = parsePlatformEntityId(id);
  if (parsed?.kind === "contact") return id as ContactNodeId;
  if (parsed?.kind === "channel") return platformContactId(parsed.platform, parsed.nativeId);
  return null;
}

/**
 * Определяет узлы contact + channel в графе по target.
 * Коллбэк has верифицирует существование узла (избегает циклического импорта WorldModel).
 * @see docs/adr/155-branded-graph-id.md
 */
export function resolveContactAndChannel(
  target: string,
  has: (id: string) => boolean,
): { contactId: ContactNodeId | null; channelId: ChannelNodeId | null } {
  const channelId = ensureChannelId(target);
  const contactId = ensureContactId(target);
  const parsed = parsePlatformEntityId(target);
  const mirroredContactId =
    parsed?.kind === "channel" ? platformContactId(parsed.platform, parsed.nativeId) : null;
  const mirroredChannelId =
    parsed?.kind === "contact" ? platformChannelId(parsed.platform, parsed.nativeId) : null;
  return {
    contactId:
      contactId && has(contactId)
        ? contactId
        : mirroredContactId && has(mirroredContactId)
          ? mirroredContactId
          : null,
    channelId:
      channelId && has(channelId)
        ? channelId
        : mirroredChannelId && has(mirroredChannelId)
          ? mirroredChannelId
          : null,
  };
}
