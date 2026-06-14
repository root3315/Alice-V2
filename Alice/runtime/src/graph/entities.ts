/**
 * Определения типов сущностей графа — чистый рерайт WorldModel по ADR-154.
 *
 * Принципы проектирования:
 *   1. ZERO imports from telegram/ — исправление инверсии зависимостей
 *   2. Слоистость атрибутов: Core (без ?), Observable (?), Shadow (? ранее неявных, теперь явных)
 *   3. Не содержит эфемерных типов результата действий — они принадлежат слою CQRS
 *
 * Пояснение по слоям атрибутов:
 *   Core       — гарантированно присутствуют благодаря значениям по умолчанию addEntity (без `?`)
 *   Observable — записываются Mod/mapper, читаются pressure/engine/voices (с `?`)
 *   Shadow     — ранее неявно записывались через setNodeAttr, теперь объявлены явно (с `?`)
 *
 * @see paper-five-dim §3.1 Definition 3.1 (World Model)
 * @see docs/adr/154-world-model-rewrite.md
 */
import type { BeliefDict } from "../belief/store.js";

// -- Branded ID types (ADR-155) ----------------------------------------------
// На уровне компиляции разграничивают числовые Telegram ID и ID узлов графа, устраняя неявное смешение string ↔ nodeId.
// @see docs/adr/155-branded-graph-id.md

declare const __brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [__brand]: B };

/** Нативный числовой Telegram ID (пользователи — положительные, каналы/супергруппы — -100xxxx). */
export type TelegramId = Brand<number, "TelegramId">;

/** ID узла канала в графе, формат `channel:<platform>:<nativeId>`. */
export type ChannelNodeId = Brand<string, "ChannelNodeId">;

/** ID узла контакта в графе, формат `contact:<platform>:<nativeId>`. */
export type ContactNodeId = Brand<string, "ContactNodeId">;

/** ID узла сессии диалога в графе, формат `conversation:<channelId>_<tick>`. */
export type ConversationNodeId = Brand<string, "ConversationNodeId">;

/** Объединённый тип любого ID узла графа. */
export type GraphNodeId = ChannelNodeId | ContactNodeId | ConversationNodeId | "self";

// -- Перечисления -------------------------------------------------------------------

export const NodeType = {
  AGENT: "agent",
  CONTACT: "contact",
  THREAD: "thread",
  CHANNEL: "channel",
  /** ADR-154: info_item → fact переименование. */
  FACT: "fact",
  CONVERSATION: "conversation", // ADR-26 §3
} as const;
export type NodeType = (typeof NodeType)[keyof typeof NodeType];

export const EdgeCategory = {
  SPATIAL: "spatial",
  SOCIAL: "social",
  COGNITIVE: "cognitive",
  CAUSAL: "causal",
  OWNERSHIP: "ownership",
} as const;
export type EdgeCategory = (typeof EdgeCategory)[keyof typeof EdgeCategory];

export type DunbarTier = 5 | 15 | 50 | 150 | 500;

/**
 * ADR-43: тип отношений — измерение, ортогональное tier (близости).
 *
 * tier отвечает на вопрос «насколько близко», relationType — «какой тип отношений».
 * В комбинации образуют двумерное пространство отношений:
 *   tier=5  + romantic     → период влюблённости (игривость, тоска, беспокойство)
 *   tier=5  + close_friend → близкий друг (прямолинейность, глубокий разговор, без церемоний)
 *   tier=150 + colleague   → обычный коллега (вежливость, тематические разговоры)
 *
 * @see docs/adr/43-m1.5-feedback-loop-relation-type.md §P1
 * @see docs/adr/39-north-star-gap-analysis.md §Gap4
 */
export type RelationType =
  | "romantic"
  | "close_friend"
  | "friend"
  | "family"
  | "colleague"
  | "acquaintance"
  | "unknown";

export type ThreadWeight = "trivial" | "minor" | "major" | "critical" | "subtle";

export type ChatType = "private" | "group" | "supergroup" | "channel";

// -- Интерфейсы атрибутов узлов -----------------------------------------------------------

/**
 * Атрибуты узла Agent (self). Статья V_A.
 */
export interface AgentAttrs {
  entity_type: typeof NodeType.AGENT;
  // -- Core --
  mood_valence: number;
  /** Настенное время установки mood (мс). */
  mood_set_ms: number;
  /** Настенное время создания узла (мс). */
  created_ms?: number;
  // -- Observable (поддерживается engine/observer) --
  /** Эффективное настроение после затухания (вычисляется selfMoodDecay каждый tick). */
  mood_effective?: number;
  mood_arousal?: number;
  /** Настенное время сдвига mood (мс). */
  mood_shift_ms?: number;
  mood_shift?: string;
  // -- Состояние личности (поддерживается index.ts / personality-drift) --
  personality_weights?: string;
  pi_home?: string;
  /** @internal Внутренние значения движка, не раскрываются LLM. Записываются в граф с префиксом _. */
  _personality_drift?: number;
  /** @internal Внутренние значения движка, не раскрываются LLM. Записываются в граф с префиксом _. */
  _personality_velocity?: number;
  personality_health?: string;
  /** Настенное время последнего подтверждения работы runtime (мс). Используется для определения реальной длительности офлайна при запуске. */
  runtime_last_seen_ms?: number;
  /** Настенное время, записанное при штатном завершении runtime (мс). Используется для принятия решения о восстановлении при запуске. */
  runtime_shutdown_ms?: number;
  // -- Профиль --
  display_name?: string;
  bio?: string;
  /** Текущая цель размышления (записывается действием thinking). */
  thinking_target?: string | null;
  /** Настенное время, до которого Alice намеренно выбрала отдых/сон (мс). */
  resting_until_ms?: number;
  /** Настенное время последнего перехода в режим отдыха (мс). */
  resting_since_ms?: number;
  /** Причина отдыха, используется для диагностики и проекции в prompt. */
  resting_reason?: string;
  /**
   * ADR-268: append-only self emotion episode ledger, JSON encoded.
   * Internal graph-backed transition storage; normal prompt must read the projection.
   */
  emotion_episodes?: string;
  /** ADR-268: derived current emotion state, JSON encoded. */
  emotion_state?: string;
  /** ADR-268: derived bounded control patch, JSON encoded. */
  emotion_control?: string;
  /**
   * ADR-268: transient repair fact cache for isolated tests/probes without DB.
   * Production authority is the append-only emotion_repairs table.
   */
  emotion_repairs?: string;
}

/**
 * Атрибуты узла контакта. Статья V_C.
 */
export interface ContactAttrs {
  entity_type: typeof NodeType.CONTACT;
  // -- Core --
  tier: DunbarTier;
  /** Настенное время последней активности контакта (мс). */
  last_active_ms: number;
  /** Используется в тестовых фикстурах. */
  auth_level: number;
  interaction_count: number;
  display_name?: string;
  /** Языковые предпочтения контакта (обновляются инструкцией LANGUAGE в Reflection). */
  language_preference?: string;
  /** ADR-43: тип отношений (ортогонален tier). По умолчанию "unknown". */
  relation_type?: RelationType;
  /** ADR-43: настенное время последнего обновления типа отношений (мс). */
  relation_type_set_ms?: number;
  // -- Observable (поддерживается mapper/observer) --
  is_bot?: boolean;
  /** Настенное время метки returning (мс). */
  returning_ms?: number;
  /** Настенное время последней реакции (мс). */
  last_reaction_ms?: number;
  last_reaction_emoji?: string;
  /** Настенное время инжекции социального напряжения реакцией (мс). */
  reaction_boost_ms?: number;
  /** Настенное время изменения tier (мс). */
  tier_changed_ms?: number;
  tier_direction?: "upgrade" | "downgrade";
  // -- Observable (feel / flag_risk / observe_activity / DECLARE_ACTION / rate_outcome) --
  mood_valence?: number;
  mood_arousal?: number;
  /** Настенное время изменения mood (мс). */
  mood_shift_ms?: number;
  mood_shift?: string;
  /** Настенное время последнего действия Alice (мс). */
  last_alice_action_ms?: number;
  last_outcome_quality?: number;
  /** Настенное время оценки outcome (мс). */
  last_outcome_ms?: number;
  social_debt_direction?: string;
  risk_level?: "none" | "low" | "medium" | "high";
  /** Настенное время обновления risk (мс). */
  risk_updated_ms?: number;
  risk_reason?: string;
  activity_type?: string;
  activity_intensity?: number;
  activity_relevance?: number;
  // -- P1-1: отслеживание взаимности (счётчик направления инициации per-contact) --
  /** Количество взаимодействий, инициированных Alice (без ответов). Поддерживается perceive+observer. */
  alice_initiated_count?: number;
  /** Количество взаимодействий, инициированных контактом (без ответов). Поддерживается mapper. */
  contact_initiated_count?: number;
  // -- Адаптивное состояние Goldilocks Window (ADR-154) --
  /** EMA интервала взаимодействия (секунды). Используется адаптивным окном Goldilocks. @see docs/adr/154-goldilocks-window/ */
  ema_contact_interval_s?: number;
  // -- Состояние самовозбуждающегося процесса Hawkes (ADR-153) --
  /** Накопленная интенсивность Hawkes λ_carry. @see docs/adr/153-per-contact-hawkes/ */
  hawkes_carry?: number;
  /** Настенное время последнего события Hawkes (мс). */
  hawkes_last_event_ms?: number;
  /** Счётчик событий для онлайн-калибровки весов. */
  hawkes_event_count?: number;
  /** Настенное время первого события (мс). Вместе с event_count используется для вычисления накопленного наблюдения μ_obs. */
  hawkes_first_event_ms?: number;
  // -- Вектор отношений (ADR-178) --
  /** @see docs/adr/178-relationship-vector-field.md */
  rv_familiarity?: number;
  rv_trust?: number;
  rv_affection?: number;
  rv_attraction?: number;
  rv_respect?: number;
  /** Первая производная каждого измерения (velocity, сглаженная EMA). */
  rv_vel_familiarity?: number;
  rv_vel_trust?: number;
  rv_vel_affection?: number;
  rv_vel_attraction?: number;
  rv_vel_respect?: number;
  /** Настенное время последнего обновления каждого измерения (мс). */
  rv_familiarity_ms?: number;
  rv_trust_ms?: number;
  rv_affection_ms?: number;
  rv_attraction_ms?: number;
  rv_respect_ms?: number;
  /** Производная величина: фаза отношений (пересчитывается каждый tick из вектора + velocity). */
  romantic_phase?: string;
  // -- GC (mark-sweep обслуживания) --
  reachability_score?: number;
  failure_type?: string | null;
  /** Настенное время метки кандидата на GC (мс). */
  gc_candidate_ms?: number | null;
}

/**
 * Атрибуты узла потока. Статья V_T.
 */
export interface ThreadAttrs {
  entity_type: typeof NodeType.THREAD;
  /** @see docs/adr/134-temporal-coherence.md §D3 — "expired" = автоматическое истечение после 7 дней без активности. */
  status: "open" | "resolved" | "expired";
  weight: ThreadWeight;
  /** Числовое отображение THREAD_WEIGHTS[weight]. */
  w: number;
  /** Время создания (настенные мс). ADR-154: изменено с tick на wall-clock ms. */
  created_ms: number;
  deadline: number; // Infinity означает отсутствие дедлайна
  title?: string;
  horizon?: number;
  /** ADR-64 VI-2: нарративный конспект потока. */
  summary?: string;
  /** ADR-104: исходный канал, породивший поток (выводится из targetNodeId на этапе act). */
  source_channel?: string;
  /** ADR-115: источник потока — создан диалогом, системой эндогенно или автоматической кластеризацией. */
  source?: "conversation" | "system" | "auto";
  /** ADR-134 D3: настенное время последней активности (мс). Обновляется advance/thread_review. */
  last_activity_ms?: number;
  /** Настенное время дедлайна (мс). ADR-154: изменено с tick на wall-clock ms. */
  deadline_ms?: number;
}

/**
 * Атрибуты узла канала. Статья V_H.
 */
export interface ChannelAttrs {
  entity_type: typeof NodeType.CHANNEL;
  // -- Core --
  unread: number;
  tier_contact: DunbarTier;
  chat_type: ChatType;
  pending_directed: number;
  /** Настенное время последнего directed-сообщения (мс). */
  last_directed_ms: number;
  display_name?: string;
  /** Forum: id текущего/последнего активного топика (ответы уходят в него, не в General). */
  current_topic_id?: number;
  // -- Observable (поддерживается observer/mapper, читается pressure/engine) --
  /** Настенное время последнего действия Alice (мс). */
  last_alice_action_ms?: number;
  last_outgoing_text?: string;
  consecutive_outgoing?: number;
  risk_level?: "none" | "low" | "medium" | "high";
  /** Настенное время обновления risk (мс). */
  risk_updated_ms?: number;
  risk_reason?: string;
  activity_type?: string;
  activity_intensity?: number;
  activity_relevance?: number;
  /** Настенное время последней очистки (мс). */
  recently_cleared_ms?: number;
  mentions_alice?: boolean;
  last_sender_is_bot?: boolean;
  last_content_type?: string;
  /** Настенное время последней реакции в канале (мс). */
  last_reaction_ms?: number;
  // -- D5: отслеживание Social Cost --
  /** Роль Alice в данном канале (owner/admin/member/restricted), записывается на этапе perceive. */
  alice_role?: string;
  /** Количество сообщений, отправленных Alice в текущем окне (обновляется D4 writeback). */
  alice_sent_window?: number;
  /** Количество сообщений, полученных от собеседника в текущем окне (обновляется perceive). */
  contact_recv_window?: number;
  // -- Observable (поддерживается act/reachability) --
  reachability_score?: number;
  consecutive_act_failures?: number;
  failure_type?: string | null;
  failure_subtype?: string | null;
  /** Настенное время метки кандидата на GC (мс). */
  gc_candidate_ms?: number | null;
  mood_valence?: number;
  /** Настенное время изменения mood (мс). */
  mood_shift_ms?: number;
  mood_shift?: string;
  consecutive_act_silences?: number;
  /** Настенное время последнего инкремента тишины ACT (мс). Используется для временного затухания σ_fail. @see docs/adr/136-constrained-vmax/README.md §2.3 */
  last_act_silence_ms?: number;
  /** Настенное время последнего проактивного обращения (мс). */
  last_proactive_outreach_ms?: number;
  alice_thinking_since?: number | null;
  /** Настенное время последней активности канала (мс). Используется для защиты группы P3 S3. */
  last_activity_ms?: number;
  /** Настенное время последнего входящего сообщения (мс). Используется для затухания свежести P1 effectiveUnread. @see docs/adr/134-temporal-coherence.md §D2 */
  last_incoming_ms?: number;
  /** Аккумулятор EWMS — точная экспоненциально взвешенная сумма непрочитанных. @see docs/adr/150-ewms-exact-unread-decay.md §D1 */
  unread_ewms?: number;
  /** Настенное время последнего обновления EWMS (мс). @see docs/adr/150-ewms-exact-unread-decay.md §D1 */
  unread_ewms_ms?: number;
  topic?: string;
  // -- Поддерживается Mapper/action --
  /** Настенное время вступления в канал (мс). */
  join_ms?: number;
  apprentice_msg_count?: number;
  participation_ratio?: number;
  social_debt_direction?: "alice_owes" | "contact_owes" | null;
  last_outcome_quality?: number;
  /** Настенное время оценки outcome (мс). */
  last_outcome_ms?: number;
  // -- Shadow attrs (ранее неявно записывались через setNodeAttr, теперь объявлены явно) --
  /** Настенное время истечения отложенной оценки (мс). @see runtime/src/engine/generators.ts, runtime/src/telegram/actions/group.ts */
  deferred_eval_ms?: number | null;
  /** Настенное время упоминания имени (мс). @see runtime/src/telegram/mapper.ts */
  mentions_alice_ms?: number;
  /** Метка безопасности (уровень безопасности сообщения). @see runtime/src/telegram/mapper.ts */
  safety_flag?: string;
  /** Настенное время установки safety_flag (мс). @see runtime/src/mods/observer.mod.ts */
  safety_flag_ms?: number;
  /** ID последнего отправленного сообщения. @see runtime/src/engine/react/orchestrator.ts */
  last_sent_msg_id?: number;
  /** Настенное время последнего исходящего сообщения (мс). @see runtime/src/mods/observer.mod.ts */
  last_outgoing_ms?: number;
  /** Текст последнего directed-сообщения (ссылка на смежную пару CA). @see runtime/src/pressure/situation-lines.ts */
  last_directed_text?: string;
  // -- Состояние активности группы Hawkes (ADR-153) --
  /** Групповой directed Hawkes λ_carry (учитываются только directed/mentions события). @see docs/adr/153-per-contact-hawkes/ */
  hawkes_carry?: number;
  /** Настенное время последнего релевантного события Hawkes в группе (мс). */
  hawkes_last_event_ms?: number;
  // -- ADR-206: атрибуты информационного потока канала --
  /** Метка предметной области контента канала (выводится из описания/истории канала). @see docs/adr/206-channel-information-flow/ §3 */
  content_domain?: string;
  /** Настенное время последнего чтения канала Alice (мс). Используется для расчёта информационного голода. @see docs/adr/206-channel-information-flow/ §3 */
  last_read_ms?: number;
  /** Здоровье подписки ∈ [0,1]. Долгое нечтение → затухание → рассмотрение отписки. @see docs/adr/206-channel-information-flow/ §5 */
  subscription_health?: number;
  /** Настенное время последнего репоста контента из этого канала (мс). Ограничение частоты ADR-206 C3. */
  last_shared_ms?: number;
  /** Настенное время последней публикации в этот канал (мс). Шлюз публикации ADR-206 C4. Только для admin/owner. */
  last_publish_ms?: number;
  /**
   * ADR-217: интенсивность социального избегания ∈ [0, 1]. 0 = нет избегания, 1 = полное избегание.
   * Собственная сила отталкивания поля давлений — мультипликативно модулирует ценность цели в слое IAUS: V_eff = V × (1 - aversion).
   * Не сбрасывается directed-сообщениями (отделена от act_silences).
   * @see docs/adr/217-pressure-field-aversion-gap.md
   */
  aversion?: number;
  /** Настенное время события избегания (мс). Используется для экспоненциального затухания. */
  aversion_ms?: number;
  /**
   * ADR-222: накопленное значение адаптивного затухания H(v) ≥ 0.
   * После каждого действия Alice в этом канале H += 1.0, затем экспоненциально затухает до 0.
   * ρ_H = 1/(1 + α·H_eff) модулирует напряжение давлений, кроме P5.
   * @see docs/adr/222-habituation-truth-model.md
   */
  habituation?: number;
  /** Настенное время последнего обновления H(v) (мс). Базовое время для экспоненциального затухания. */
  habituation_ms?: number;
}

/**
 * Атрибуты узла факта. Статья V_I.
 *
 * ADR-154: переименование info_item → fact.
 *
 * Перенос из MemorizedFact (плоский массив Mod state) в узлы графа:
 * каждый факт — это узел fact, соединённый рёбрами "knows" с contact/agent.
 * Это позволяет кривой забывания P2 обходить реальные данные.
 *
 * @see paper/ §3.2 "Information Pressure"
 */
export interface FactAttrs {
  entity_type: typeof NodeType.FACT;
  // -- Core (кривая забывания P2) --
  importance: number; // [0,1] важность факта
  stability: number; // параметр стабильности SM-2
  /** Настенное время последнего обращения (мс). ADR-154: изменено с tick на wall-clock ms. */
  last_access_ms: number;
  volatility: number; // изменчивость информации
  tracked: boolean; // отслеживать ли устаревание
  /** Время создания (настенные мс). ADR-154: изменено с tick на wall-clock ms. */
  created_ms: number;
  novelty: number; // новизна
  // -- Перенесено из MemorizedFact --
  content?: string; // содержимое факта
  fact_type?: string; // interest/preference/skill/...
  reinforcement_count?: number; // счётчик усиления при дедупликации
  // -- Отслеживание источника --
  source_contact?: string; // ID контакта-источника
  source_channel?: string; // ID канала-источника
  /** ADR-69: различать активную запись LLM, автоматическое извлечение perceive и сжатое слияние. */
  source?: "llm" | "perceive" | "consolidation";
  // -- Эмоциональная реактивность (ADR-156) --
  /** Эмоциональная реактивность [0,1]. 1=сильный эмоциональный триггер, 0=чисто информационный. Экспоненциальное затухание. @see docs/adr/156-emotional-reactivity-damping.md */
  reactivity?: number;
  /** Настенное время установки/обновления reactivity (мс). */
  reactivity_ms?: number;
}

// -- ADR-26 §3: сущность сессии диалога ------------------------------------------------

export type ConversationState = "pending" | "opening" | "active" | "closing" | "cooldown";
export type TurnState = "alice_turn" | "other_turn" | "open" | "closed";

/**
 * Атрибуты узла сессии диалога. Расширение ADR-26.
 */
export interface ConversationAttrs {
  entity_type: typeof NodeType.CONVERSATION;
  channel: string;
  participants: string[];
  state: ConversationState;
  /** Настенное время начала диалога (мс). */
  start_ms: number;
  /** Настенное время последней активности (мс). */
  last_activity_ms: number;
  turn_state: TurnState;
  pace: number;
  message_count: number;
  alice_message_count: number;
  topic?: string;
  /** Настенное время входа в closing по leave / таймауту (мс). Используется для точного сравнения временных меток шлюза. */
  closing_since_ms?: number;
}

// -- Объединённые типы ---------------------------------------------------------------

export type NodeAttrs =
  | AgentAttrs
  | ContactAttrs
  | ThreadAttrs
  | ChannelAttrs
  | FactAttrs
  | ConversationAttrs;

// -- Дискриминированный союз (ADR-154) ----------------------------------------------------

/** Дискриминированный союз: различает типы узлов по полю type, удобен для switch/if narrowing. */
export type NodeEntry =
  | { type: "agent"; attrs: AgentAttrs }
  | { type: "contact"; attrs: ContactAttrs }
  | { type: "channel"; attrs: ChannelAttrs }
  | { type: "thread"; attrs: ThreadAttrs }
  | { type: "fact"; attrs: FactAttrs }
  | { type: "conversation"; attrs: ConversationAttrs };

// -- Вспомогательные типы ---------------------------------------------------------------

/** Интерфейс атрибутов сущности без entity_type, взятый как Partial; используется для patch-обновлений. */
export type Mutable<T extends { entity_type: string }> = Partial<Omit<T, "entity_type">>;

// -- Маппинг NodeType → Attrs ---------------------------------------------------

/** Маппинг литерала NodeType на соответствующий интерфейс атрибутов. */
export interface NodeAttrsMap {
  agent: AgentAttrs;
  contact: ContactAttrs;
  thread: ThreadAttrs;
  channel: ChannelAttrs;
  fact: FactAttrs;
  conversation: ConversationAttrs;
}

// -- Данные рёбер -----------------------------------------------------------------

export interface EdgeData {
  label: string;
  category: EdgeCategory;
  [key: string]: unknown;
}

// -- Формат сериализации -------------------------------------------------------------

export interface SerializedNode {
  id: string;
  entity_type: string;
  [key: string]: unknown;
}

export interface SerializedEdge {
  src: string;
  dst: string;
  label: string;
  category: string;
  [key: string]: unknown;
}

export interface SerializedGraph {
  tick: number;
  nodes: SerializedNode[];
  edges: SerializedEdge[];
  /** Social POMDP: снимок убеждений (структурированный формат ADR-123). */
  beliefs?: BeliefDict;
}
