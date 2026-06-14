/**
 * Strategy Mod — общие типы, константы и чистые функции.
 *
 * Инфраструктура, разделяемая всеми подмодулями; без побочных эффектов.
 */

// -- Типы --------------------------------------------------------------------

export interface ActionRecord {
  target: string | null;
  tick: number;
  /** ADR-110: wall-clock время действия (ms). Присутствует в новых данных, может отсутствовать в старых. */
  ms?: number;
  intent: string;
}

export interface StrategyHint {
  type:
    | "relationship_cooling"
    | "attention_imbalance"
    | "opportunity"
    | "thread_stale"
    | "conversation_pending"
    | "crisis_detected"
    | "group_atmosphere"
    | "behavior_pattern"
    | "overnight_briefing"
    | "commitment_due"
    | "contextual_commitment"
    | "personality_drift";
  message: string;
}

// -- M2: динамическое состояние группового чата ---------------------------------------------------------

/**
 * Структурированное состояние группового чата (усиление M2 сценарий 4).
 *
 * Окно ключевых слов собирает часто встречаемые слова из последних сообщений,
 * чтобы LLM в contribute мог самостоятельно оценить смену темы.
 * participationRatio отслеживает долю участия Alice в группе простым соотношением,
 * не допуская чрезмерного или недостаточного участия (ограничение социального распределения Данбара).
 *
 * @see docs/adr/46-real-data-calibration.md §2 Wave 1
 */
export interface GroupChatState {
  /** Последние активные говорящие (кольцевой буфер, 10 человек). */
  recentSpeakers: string[];
  /** Окно ключевых слов темы (набор ключевых слов из последних сообщений). */
  topicKeywords: string[];
  /** Доля участия Alice в группе (alice_msgs / total_msgs, простое соотношение). */
  participationRatio: number;
  /** Окно общего счётчика сообщений. */
  totalMessages: number;
  /** Окно счётчика сообщений Alice. */
  aliceMessages: number;
}

/** Отслеживание частоты сообщений в канале (для детекции кризиса/активности). */
export interface MessageFrequencyWindow {
  /** Число входящих сообщений за последние N тиков (скользящее окно). */
  recentCount: number;
  /** Базовая частота сообщений (долгосрочное среднее EMA). */
  baseline: number;
  /** Дисперсия EMA (для Z-score детекции кризиса). Может отсутствовать в старых данных — тогда fallback на отношение частот. */
  variance?: number;
  /** Тик последнего обновления. */
  lastTick: number;
  /** ADR-110: wall-clock время последнего обновления (ms). Присутствует в новых данных, может отсутствовать в старых. */
  lastMs?: number;
}

/**
 * M4 Состояние аудита дрейфа личности.
 *
 * Теоретическая основа:
 * - drift = l2Distance(π_current, π_home): накопленное отклонение
 * - velocity = l2Distance(π_current, π_previous) / interval: мгновенная скорость изменения
 * - Классификация: healthy (< 0.1) / warning (0.1~0.2) / alert (>= 0.2)
 *
 * Ссылка: Ashton & Lee (2007) исследование стабильности личности HEXACO — личность долгосрочно стабильна, но может дрейфовать.
 */
export interface PersonalityDriftState {
  /** Тик последнего аудита. */
  lastAuditTick: number;
  /** ADR-110: wall-clock время последнего аудита (ms). Присутствует в новых данных, может отсутствовать в старых. */
  lastAuditMs?: number;
  /** Снимок личности на момент последнего аудита (для вычисления velocity). */
  previousWeights: number[] | null;
  /** Текущее значение дрейфа. */
  drift: number;
  /** Текущая скорость изменения. */
  velocity: number;
  /** Классификация здоровья. */
  health: "healthy" | "warning" | "alert";
}

export interface StrategyState {
  /** Журнал последних действий (кольцевой буфер, 20 записей). */
  recentActions: ActionRecord[];
  // contactLastInteraction[Ms] удалён — полностью избыточно по отношению к last_alice_action_ms в graph-атрибутах, записываемых observer.mod.
  // hint-generators теперь читают напрямую из графа (проверяют и contact:xxx и channel:xxx варианты).
  /** Текущие активные стратегические подсказки (пересчитываются каждый тик). */
  activeHints: StrategyHint[];
  /** Сценарий 6: окна частоты сообщений каналов (channelId → window). */
  messageFrequency: Record<string, MessageFrequencyWindow>;
  /** Сценарий 6: каналы, находящиеся в режиме кризиса. */
  crisisChannels: Record<string, number>; // channelId → detectedTick
  /** ADR-110: wall-clock время детекции кризиса (channelId → ms). */
  crisisChannelsMs?: Record<string, number>;
  /** M2: динамическое состояние групповых чатов (channelId → GroupChatState). */
  groupStates: Record<string, GroupChatState>;
  /** M4: аудит дрейфа личности. */
  personalityDrift: PersonalityDriftState;
}

// -- Константы --------------------------------------------------------------------

export const MAX_RECENT_ACTIONS = 20;
export const MAX_RECENT_SPEAKERS = 10;
export const MAX_TOPIC_KEYWORDS = 30;

// ADR-113 §D3: маппинг Tier → порог толерантного молчания (секунды)
// Согласовано с P6 TIER_EXPECTED_SILENCE_S — стратегический и слой давления используют одну шкалу времени.
// @see src/pressure/p6-curiosity.ts TIER_EXPECTED_SILENCE_S
export const SILENCE_THRESHOLD_S: Record<number, number> = {
  5: 14400, // intimate: 4 hours
  15: 86400, // close friend: 1 day
  50: 259200, // friend: 3 days
  150: 1209600, // acquaintance: 14 days
  500: 5184000, // known: 60 days
};

// M4: параметры аудита дрейфа личности
/** Интервал аудита дрейфа (тики). */
export const DRIFT_AUDIT_INTERVAL = 100;
/** ADR-110: интервал аудита дрейфа (секунды). 100 ticks × 60 = 6000 секунд. */
export const DRIFT_AUDIT_INTERVAL_S = 6000;
/** Порог warning для дрейфа. */
export const DRIFT_WARNING_THRESHOLD = 0.1;
/**
 * Порог alert для дрейфа.
 * ADR-46 F7b: 0.2 → 0.15 (ADR-45 обнаружил, что срабатывание при суммарном дрейфе 0.468 — слишком поздно).
 * @see docs/adr/45-real-data-validation.md §3.6
 */
export const DRIFT_ALERT_THRESHOLD = 0.15;

/**
 * Детекция кризиса: Z-score порог. unread отклоняется от EMA более чем на 2.5σ → кризис-кандидат.
 * Заменяет старое отношение частот (CRISIS_FREQUENCY_RATIO=4.0), статистически значимее.
 * @see evolve.ts spikeContribs — ADR-191: тот же Z-score метод, прямой структурный путь через tauSpike → rCaution
 */
export const CRISIS_Z_THRESHOLD = 2.5;
/**
 * Восстановление от кризиса: Z-score опускается ниже этого значения → кризис спал.
 */
export const CRISIS_RECOVERY_Z = 1.0;
/**
 * @deprecated Старый порог отношения частот, используется как fallback при отсутствии данных о дисперсии.
 * @see CRISIS_Z_THRESHOLD — новый метод детекции
 */
export const CRISIS_FREQUENCY_RATIO = 4.0;
/**
 * @deprecated Старый минимальный базис, используется как fallback при отсутствии данных о дисперсии.
 */
export const CRISIS_MIN_BASELINE = 5;
/** @deprecated Старый порог восстановления; Z-score метод использует CRISIS_RECOVERY_Z. */
export const CRISIS_RECOVERY_RATIO = 1.5;

// -- Чистые функции ------------------------------------------------------------------

/** @deprecated ADR-110: используйте getSilenceThresholdS вместо этого. */
export function getSilenceThreshold(tier: number): number {
  return SILENCE_THRESHOLD_S[tier] ?? 30000;
}

/** ADR-110: возвращает порог толерантного молчания (секунды). */
export function getSilenceThresholdS(tier: number): number {
  return SILENCE_THRESHOLD_S[tier] ?? 30000;
}

/** Создаёт пустое состояние группового чата. */
export function emptyGroupState(): GroupChatState {
  return {
    recentSpeakers: [],
    topicKeywords: [],
    participationRatio: 0,
    totalMessages: 0,
    aliceMessages: 0,
  };
}

/** Разбирает JSON-массив весов из graph-атрибута. */
export function parseJsonWeights(raw: unknown): number[] | null {
  if (Array.isArray(raw) && raw.every((v): v is number => typeof v === "number")) return raw;
  if (typeof raw === "string") {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.every((v): v is number => typeof v === "number"))
        return parsed;
    } catch {
      return null;
    }
  }
  return null;
}

// F24: поднято до уровня модульной константы (инициализируется один раз), чтобы не пересоздавать Set при каждом вызове extractKeywords
const STOP_WORDS = new Set([
  // Английские
  "the",
  "a",
  "an",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "have",
  "has",
  "had",
  "do",
  "does",
  "did",
  "will",
  "would",
  "shall",
  "should",
  "may",
  "might",
  "must",
  "can",
  "could",
  "i",
  "you",
  "he",
  "she",
  "it",
  "we",
  "they",
  "me",
  "him",
  "her",
  "us",
  "them",
  "my",
  "your",
  "his",
  "its",
  "our",
  "their",
  "this",
  "that",
  "these",
  "those",
  "and",
  "but",
  "or",
  "not",
  "no",
  "so",
  "if",
  "then",
  "than",
  "too",
  "very",
  "just",
  "about",
  "up",
  "out",
  "on",
  "off",
  "over",
  "under",
  "again",
  "once",
  "here",
  "there",
  "when",
  "where",
  "why",
  "how",
  "all",
  "each",
  "every",
  "both",
  "few",
  "more",
  "most",
  "other",
  "some",
  "such",
  "only",
  "own",
  "same",
  "into",
  "to",
  "from",
  "in",
  "of",
  "for",
  "with",
  "at",
  "by",
  "as",
  // Русские частые служебные слова (слова короче 2 символов отсекаются фильтром длины)
  "не",
  "на",
  "что",
  "это",
  "как",
  "так",
  "то",
  "он",
  "она",
  "оно",
  "они",
  "мы",
  "вы",
  "ты",
  "но",
  "да",
  "же",
  "ли",
  "бы",
  "по",
  "за",
  "из",
  "от",
  "до",
  "для",
  "про",
  "без",
  "или",
  "если",
  "чтобы",
  "когда",
  "где",
  "вот",
  "ведь",
  "уже",
  "ещё",
  "еще",
  "тоже",
  "только",
  "очень",
  "был",
  "была",
  "было",
  "были",
  "быть",
  "есть",
  "будет",
  "может",
  "надо",
  "нет",
  "ну",
  "мне",
  "меня",
  "тебе",
  "тебя",
  "себя",
  "себе",
  "нас",
  "вас",
  "их",
  "его",
  "её",
  "ее",
  "ему",
  "ей",
  "им",
  "тот",
  "эта",
  "этот",
  "эти",
  "там",
  "тут",
  "здесь",
  // междометия и филлеры чата
  "ах",
  "ох",
  "эх",
  "ой",
  "ага",
  "угу",
  "хм",
  "ха",
  "хах",
  "хаха",
  "блин",
]);

/**
 * Извлечение ключевых слов из текста (простой TF-метод).
 * Убирает стоп-слова и короткие слова, оставляет информативные токены.
 */
export function extractKeywords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 2 && !STOP_WORDS.has(w))
    .slice(0, 10); // Не более 10 ключевых слов на сообщение
}
