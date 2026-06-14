/**
 * Drizzle ORM schema: graph_nodes, graph_edges, tick_log, action_log, mod_states и др.
 *
 * Единый реестр семантики данных на уровне таблиц — в `schema-classification.ts`.
 * При добавлении таблицы сначала дополнить `TABLE_CLASSIFICATIONS` и ADR-248 data-map, затем писать миграцию.
 * @see docs/adr/248-dcp-reference-implementation-plan/data-map.md
 */
import { index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

/** Снимок графа: WorldModel, сериализованный в JSON. */
export const graphSnapshots = sqliteTable(
  "graph_snapshots",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    tick: integer("tick").notNull(),
    graphJson: text("graph_json").notNull(),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [index("idx_graph_snapshots_tick").on(t.tick)],
);

/** Лог тиков: значения давления и выбранное действие за каждый тик. */
export const tickLog = sqliteTable(
  "tick_log",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    tick: integer("tick").notNull(),
    p1: real("p1").notNull(),
    p2: real("p2").notNull(),
    p3: real("p3").notNull(),
    p4: real("p4").notNull(),
    p5: real("p5").notNull(),
    p6: real("p6").notNull(),
    api: real("api").notNull(),
    /** ADR-195: Peak-based API (управляет интервалом тиков). */
    apiPeak: real("api_peak"),
    action: text("action"),
    target: text("target"),
    /** ADR-115: V(a,n) итоговая чистая социальная ценность. */
    netValue: real("net_value"),
    /** ADR-115: ΔP ожидаемое снижение давления. */
    deltaP: real("delta_p"),
    /** ADR-115: C_social социальная стоимость. */
    socialCost: real("social_cost"),
    /** ADR-115: вероятность выбора по softmax. */
    selectedProbability: real("selected_probability"),
    /** ADR-115: унифицированная метка результата решения (enqueue|system1:ACTION|silent:LEVEL|skip:REASON). */
    gateVerdict: text("gate_verdict"),
    /** ADR-115: Agent Mode (patrol|conversation|consolidation). */
    mode: text("mode"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [index("idx_tick_log_tick").on(t.tick)],
);

/** Лог действий: записи о выполнении действий, сгенерированных LLM. */
export const actionLog = sqliteTable(
  "action_log",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    tick: integer("tick").notNull(),
    voice: text("voice").notNull(),
    target: text("target"),
    actionType: text("action_type").notNull(),
    chatId: text("chat_id"),
    messageText: text("message_text"),
    confidence: real("confidence"),
    reasoning: text("reasoning"),
    success: integer("success", { mode: "boolean" }).notNull().default(false),
    /** ADR-43 P0 второй слой: отсутствует ли feel() после send_message (1=отсутствует, 0=норма, null=не send_message) */
    observationGap: integer("observation_gap"),
    /** D4 ClosureDepth: глубина пути обратной связи от действия до изменения структуры графа. */
    closureDepth: integer("closure_depth"),
    /** ADR-69: прокси-показатель эффективного продвижения агента. @see docs/adr/69-llm-cognitive-loop-gravity-well.md */
    eaProxy: real("ea_proxy"),
    /** ADR-108: число подциклов engagement-сессии. 1 = одиночное выполнение (без expect_reply/stay). */
    engagementSubcycles: integer("engagement_subcycles"),
    /** ADR-108: настенное время engagement-сессии (мс). */
    engagementDurationMs: integer("engagement_duration_ms"),
    /** ADR-108: причина завершения engagement-сессии: complete/timeout/preempted/limit. */
    engagementOutcome: text("engagement_outcome"),
    /** ADR-199: JSON-запись автоматической обратной записи состояния: {"feel":"positive","advance_topic":"conv:xxx"}. */
    autoWriteback: text("auto_writeback"),
    /** ADR-235: число вызовов инструментов в TC-цикле. */
    tcToolCallCount: integer("tc_tool_call_count"),
    /** ADR-235: достигнут ли бюджетный лимит TC_MAX_TOOL_CALLS. */
    tcBudgetExhausted: integer("tc_budget_exhausted", { mode: "boolean" }),
    /** ADR-235: значение afterward инструмента signal (done/waiting_reply/watching/resting/fed_up/cooling_down). */
    tcAfterward: text("tc_afterward"),
    /** ADR-235: агрегированные блоки $ cmd\noutput (обрезаны до 4 КБ). */
    tcCommandLog: text("tc_command_log"),
    /** ADR-247: JSON-последовательность причин, по которым host инициировал продолжение в рамках одного тика. */
    tcHostContinuationTrace: text("tc_host_continuation_trace"),
    /** Фактически выбранное имя LLM-провайдера на входе тика. */
    llmProvider: text("llm_provider"),
    /** Фактически выбранный ID модели на входе тика. */
    llmModel: text("llm_model"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    index("idx_action_log_tick").on(t.tick),
    index("idx_action_log_chat_tick").on(t.chatId, t.tick),
  ],
);

/**
 * Лог молчания (ADR-64 II-2): записи о решениях, пропущенных через gate.
 *
 * Молчание происходит в потоке EVOLVE (точка выхода skip после выбора голоса и цели);
 * хранится отдельно от action_log (записи выполнения потока ACT), так как относится
 * к другому аудиторскому измерению.
 *
 * @see docs/adr/64 §II-2: Silence as Information Gathering
 */
export const silenceLog = sqliteTable(
  "silence_log",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    tick: integer("tick").notNull(),
    /** Выбранный голос */
    voice: text("voice").notNull(),
    /** Целевая сущность */
    target: text("target"),
    /** Причина молчания: rate_cap | active_cooling | svg_negative | api_floor | all_candidates_negative */
    reason: text("reason").notNull(),
    /** V(a, n) чистая социальная ценность */
    netValue: real("net_value"),
    /** ΔP(a, n) ожидаемое снижение давления */
    deltaP: real("delta_p"),
    /** C_social(a, n) социальная стоимость */
    socialCost: real("social_cost"),
    /** Текущее значение API */
    apiValue: real("api_value"),
    /** D5 уровень пятиступенчатой шкалы молчания: L1~L5. */
    silenceLevel: text("silence_level"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [index("idx_silence_log_tick").on(t.tick)],
);

/**
 * ADR-248 W1: аудиторские факты Decision Trace.
 *
 * Фиксирует, что EVOLVE/ACT наблюдали на конкретном тике, что выбрали и почему остановились или продолжили.
 * Это append-only audit fact; нельзя использовать как входные данные для gate/pressure/control.
 * @see docs/adr/248-dcp-reference-implementation-plan/README.md
 */
export const decisionTrace = sqliteTable(
  "decision_trace",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    tick: integer("tick").notNull(),
    /** evolve | act */
    phase: text("phase").notNull(),
    target: text("target"),
    /** Опциональная ссылка на action_log.id; может быть null до молчания/постановки в очередь в EVOLVE. */
    actionLogId: integer("action_log_id"),
    /** enqueue | silence | defer | execute | continue | stop | fail */
    finalDecision: text("final_decision").notNull(),
    reason: text("reason").notNull(),
    /** JSON: DecisionTracePayload, аудиторские детали — не контрактный контроль. */
    payloadJson: text("payload_json").notNull().default("{}"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    index("idx_decision_trace_tick").on(t.tick),
    index("idx_decision_trace_action_log").on(t.actionLogId),
    index("idx_decision_trace_phase_tick").on(t.phase, t.tick),
  ],
);

/**
 * ADR-258 Wave 1: typed observation spine — tick boundary.
 *
 * Append-only diagnostic authority for what IAUS saw at a tick boundary.
 * @see docs/adr/258-iaus-health-curve-validation/README.md
 */
export const tickTrace = sqliteTable(
  "tick_trace",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    tick: integer("tick").notNull(),
    occurredAtMs: integer("occurred_at_ms").notNull(),
    pressureVectorJson: text("pressure_vector_json").notNull(),
    schedulerPhase: text("scheduler_phase").notNull(),
    selectedCandidateId: text("selected_candidate_id"),
    silenceMarker: text("silence_marker"),
    sampleStatus: text("sample_status").notNull(),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    uniqueIndex("idx_tick_trace_tick").on(t.tick),
    index("idx_tick_trace_candidate").on(t.selectedCandidateId),
    index("idx_tick_trace_silence").on(t.silenceMarker),
  ],
);

/** ADR-258 Wave 1: typed observation spine — candidate/silence authority. */
export const candidateTrace = sqliteTable(
  "candidate_trace",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    candidateId: text("candidate_id").notNull(),
    tick: integer("tick").notNull(),
    targetNamespace: text("target_namespace").notNull(),
    targetId: text("target_id"),
    actionType: text("action_type").notNull(),
    normalizedConsiderationsJson: text("normalized_considerations_json").notNull().default("{}"),
    deltaP: real("delta_p"),
    socialCost: real("social_cost"),
    netValue: real("net_value"),
    bottleneck: text("bottleneck"),
    gatePlane: text("gate_plane").notNull(),
    selected: integer("selected", { mode: "boolean" }).notNull().default(false),
    candidateRank: integer("candidate_rank"),
    silenceReason: text("silence_reason").notNull(),
    retainedImpulseJson: text("retained_impulse_json"),
    sampleStatus: text("sample_status").notNull(),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    uniqueIndex("idx_candidate_trace_candidate").on(t.candidateId),
    index("idx_candidate_trace_tick").on(t.tick),
    index("idx_candidate_trace_silence").on(t.silenceReason),
  ],
);

/** ADR-258 Wave 1: typed observation spine — queue fate authority. */
export const queueTrace = sqliteTable(
  "queue_trace",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    queueTraceId: text("queue_trace_id").notNull(),
    tick: integer("tick").notNull(),
    candidateId: text("candidate_id").notNull(),
    enqueueId: text("enqueue_id").notNull(),
    enqueueOutcome: text("enqueue_outcome").notNull(),
    fate: text("fate").notNull(),
    queueDepth: integer("queue_depth"),
    activeCount: integer("active_count"),
    saturation: real("saturation"),
    supersededByEnqueueId: text("superseded_by_enqueue_id"),
    reasonCode: text("reason_code").notNull(),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    uniqueIndex("idx_queue_trace_event").on(t.queueTraceId),
    index("idx_queue_trace_enqueue").on(t.enqueueId),
    index("idx_queue_trace_candidate").on(t.candidateId),
    index("idx_queue_trace_fate").on(t.fate),
  ],
);

/** ADR-258 Wave 1: typed observation spine — executor result authority. */
export const actionResult = sqliteTable(
  "action_result",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    actionId: text("action_id").notNull(),
    tick: integer("tick").notNull(),
    enqueueId: text("enqueue_id"),
    candidateId: text("candidate_id"),
    actionLogId: integer("action_log_id"),
    targetNamespace: text("target_namespace").notNull(),
    targetId: text("target_id"),
    actionType: text("action_type").notNull(),
    result: text("result").notNull(),
    failureCode: text("failure_code").notNull(),
    externalMessageId: text("external_message_id"),
    completedActionRefsJson: text("completed_action_refs_json").notNull().default("[]"),
    /** ADR-266 Wave 4: типизированные факты выполнения из ScriptExecutionResult.observations. */
    executionObservationsJson: text("execution_observations_json").notNull().default("[]"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    uniqueIndex("idx_action_result_action").on(t.actionId),
    index("idx_action_result_enqueue").on(t.enqueueId),
    index("idx_action_result_action_log").on(t.actionLogId),
    index("idx_action_result_result").on(t.result),
  ],
);

/**
 * ADR-259 Wave 1: shadow focus transition evidence.
 *
 * Append-only diagnostic fact. It records structured execution-boundary evidence
 * only; it must not authorize sends or feed IAUS control. Evidence can come from
 * rejected cross-chat sends, remote observations, or forwarded share edges.
 * @see docs/adr/259-focus-trajectory-closed-loop/README.md §Wave 1
 */
export const focusTransitionShadow = sqliteTable(
  "focus_transition_shadow",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    transitionShadowId: text("transition_shadow_id").notNull(),
    tick: integer("tick").notNull(),
    actionId: text("action_id").notNull(),
    actionLogId: integer("action_log_id"),
    candidateId: text("candidate_id"),
    sourceTarget: text("source_target"),
    currentChatId: text("current_chat_id").notNull(),
    requestedChatId: text("requested_chat_id").notNull(),
    sourceCommand: text("source_command").notNull(),
    transitionClass: text("transition_class").notNull(),
    evidenceStatus: text("evidence_status").notNull(),
    payloadJson: text("payload_json").notNull().default("{}"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    uniqueIndex("idx_focus_transition_shadow_id").on(t.transitionShadowId),
    index("idx_focus_transition_shadow_action").on(t.actionId),
    index("idx_focus_transition_shadow_requested").on(t.requestedChatId),
    index("idx_focus_transition_shadow_tick").on(t.tick),
  ],
);

/**
 * ADR-259 Wave 3: explicit / blocked read-only focus transition request.
 *
 * Append-only request fact. It records that Alice asked to observe/switch to
 * another chat, or tried an active cross-chat send that was blocked. It must
 * not authorize sends, switch the active chat, or feed IAUS / retarget gates in
 * Wave 3.
 * @see docs/adr/259-focus-trajectory-closed-loop/wave-3-readonly-intent-audit.md
 */
export const focusTransitionIntent = sqliteTable(
  "focus_transition_intent",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    intentId: text("intent_id").notNull(),
    tick: integer("tick").notNull(),
    sourceChatId: text("source_chat_id").notNull(),
    requestedChatId: text("requested_chat_id").notNull(),
    intentKind: text("intent_kind").notNull(),
    reason: text("reason").notNull(),
    sourceCommand: text("source_command").notNull().default("self.attention-pull"),
    payloadJson: text("payload_json").notNull().default("{}"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    uniqueIndex("idx_focus_transition_intent_id").on(t.intentId),
    index("idx_focus_transition_intent_requested").on(t.requestedChatId),
    index("idx_focus_transition_intent_tick").on(t.tick),
  ],
);

/** ADR-258 Wave 1: typed observation spine — fact writeback authority. */
export const factMutation = sqliteTable(
  "fact_mutation",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    mutationId: text("mutation_id").notNull(),
    actionId: text("action_id"),
    sourceTick: integer("source_tick"),
    factNamespace: text("fact_namespace").notNull(),
    entityNamespace: text("entity_namespace").notNull(),
    entityId: text("entity_id"),
    mutationKind: text("mutation_kind").notNull(),
    beforeSummary: text("before_summary"),
    afterSummary: text("after_summary"),
    deltaJson: text("delta_json"),
    authorityTable: text("authority_table").notNull(),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    uniqueIndex("idx_fact_mutation_id").on(t.mutationId),
    index("idx_fact_mutation_action").on(t.actionId),
    index("idx_fact_mutation_tick").on(t.sourceTick),
    index("idx_fact_mutation_kind").on(t.mutationKind),
  ],
);

/** ADR-258 Wave 1: typed observation spine — pressure release authority. */
export const pressureDelta = sqliteTable(
  "pressure_delta",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    pressureDeltaId: text("pressure_delta_id").notNull(),
    sourceTick: integer("source_tick").notNull(),
    relatedCandidateId: text("related_candidate_id"),
    relatedActionId: text("related_action_id"),
    windowStartTick: integer("window_start_tick").notNull(),
    windowEndTick: integer("window_end_tick").notNull(),
    windowSizeTicks: integer("window_size_ticks").notNull(),
    pressureBefore: real("pressure_before").notNull(),
    pressureAfter: real("pressure_after").notNull(),
    dimension: text("dimension").notNull(),
    releaseClassification: text("release_classification").notNull(),
    classificationReason: text("classification_reason").notNull(),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    uniqueIndex("idx_pressure_delta_id").on(t.pressureDeltaId),
    index("idx_pressure_delta_source").on(t.sourceTick),
    index("idx_pressure_delta_action").on(t.relatedActionId),
    index("idx_pressure_delta_dimension").on(t.dimension),
  ],
);

/** Снимок вектора личности. */
export const personalitySnapshots = sqliteTable("personality_snapshots", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  tick: integer("tick").notNull(),
  weights: text("weights").notNull(), // JSON: number[]
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

/**
 * ADR-248 W3: Canonical event fact stream.
 *
 * Стабильная форма фактов после разбора платформенных событий. Append-only;
 * пока записывается тестами/хелперами, впоследствии подключается Telegram ingress.
 * Projection/rendering воспроизводится из этого потока фактов.
 * @see docs/adr/248-dcp-reference-implementation-plan/README.md
 */
export const canonicalEvents = sqliteTable(
  "canonical_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    kind: text("kind").notNull(),
    tick: integer("tick").notNull(),
    occurredAtMs: integer("occurred_at_ms"),
    channelId: text("channel_id"),
    contactId: text("contact_id"),
    directed: integer("directed", { mode: "boolean" }).notNull().default(false),
    novelty: real("novelty"),
    /** Источник факта: message_log / telegram / runtime / action_result. */
    source: text("source"),
    /** Стабильный ID внутри источника. Telegram ingress использует идентичность платформенного события. */
    sourceId: text("source_id"),
    payloadJson: text("payload_json").notNull(),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    index("idx_canonical_events_tick").on(t.tick),
    index("idx_canonical_events_kind_tick").on(t.kind, t.tick),
    index("idx_canonical_events_channel_tick").on(t.channelId, t.tick),
    uniqueIndex("idx_canonical_events_source").on(t.source, t.sourceId),
  ],
);

/** Лог сообщений: входящие и исходящие сообщения. */
export const messageLog = sqliteTable(
  "message_log",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    tick: integer("tick").notNull(),
    /** Источник с поддержкой нескольких платформ. Первые платформы: telegram / qq. */
    platform: text("platform").notNull().default("telegram"),
    chatId: text("chat_id").notNull(),
    /** UI-local numeric ref used by current chat tools. Null when unavailable or non-numeric. */
    msgId: integer("msg_id"),
    /** Нативный ID чата на платформе. Для Telegram — chat id, для QQ — номер группы/QQ-номер. */
    nativeChatId: text("native_chat_id"),
    /** Нативный ID сообщения на платформе. Может быть числом или строкой; не участвует в Telegram reply API. */
    nativeMsgId: text("native_msg_id"),
    /** Кроссплатформенный стабильный ID сообщения: message:<platform>:<nativeChatId>:<nativeMsgId>. */
    stableMessageId: text("stable_message_id"),
    /** Числовая ссылка на сообщение-цель в текущем чате. Используется для контекста диффузии цепочки ответов (ADR-97). */
    replyToMsgId: integer("reply_to_msg_id"),
    senderId: text("sender_id"),
    senderName: text("sender_name"),
    text: text("text"),
    /** ADR-119: Тип медиа (sticker/photo/voice/video/document). Для текстовых сообщений — null. */
    mediaType: text("media_type"),
    isOutgoing: integer("is_outgoing", { mode: "boolean" }).notNull().default(false),
    isDirected: integer("is_directed", { mode: "boolean" }).notNull().default(false),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    index("idx_message_log_tick").on(t.tick),
    index("idx_message_log_chat").on(t.chatId),
    index("idx_message_log_chat_tick").on(t.chatId, t.tick),
    index("idx_message_log_chat_msg").on(t.chatId, t.msgId),
    index("idx_message_log_platform_native").on(t.platform, t.nativeChatId, t.nativeMsgId),
    index("idx_message_log_stable_message").on(t.stableMessageId),
    index("idx_message_log_sender").on(t.senderId),
  ],
);

/**
 * ADR-260: Проекция активов группового фотоальбома.
 * source_chat_id/source_msg_id — авторитетный источник отправки; file_unique_id отвечает только за дедупликацию и семантическое слияние.
 * @see docs/adr/260-group-photo-album-affordance/README.md
 */
export const albumPhotos = sqliteTable(
  "album_photos",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    assetId: text("asset_id").notNull().unique(),
    fileUniqueId: text("file_unique_id").notNull().unique(),
    sourceChatId: integer("source_chat_id").notNull(),
    sourceMsgId: integer("source_msg_id").notNull(),
    mediaType: text("media_type").notNull().default("photo"),
    captionText: text("caption_text"),
    description: text("description"),
    wdTagsJson: text("wd_tags_json"),
    ocrText: text("ocr_text"),
    visibilityScope: text("visibility_scope").notNull().default("group"),
    sourceStatus: text("source_status").notNull().default("available"),
    lastFailureCode: text("last_failure_code"),
    observedAtMs: integer("observed_at_ms").notNull(),
    lastIndexedAtMs: integer("last_indexed_at_ms").notNull(),
    sourceMissingAtMs: integer("source_missing_at_ms"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    uniqueIndex("idx_album_photos_asset").on(t.assetId),
    uniqueIndex("idx_album_photos_file_unique").on(t.fileUniqueId),
    index("idx_album_photos_source").on(t.sourceChatId, t.sourceMsgId),
    index("idx_album_photos_status").on(t.sourceStatus),
    index("idx_album_photos_observed").on(t.observedAtMs),
  ],
);

/** ADR-260: Факты результата отправки из альбома, append-only. */
export const albumUsage = sqliteTable(
  "album_usage",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    assetId: text("asset_id").notNull(),
    targetChatId: integer("target_chat_id").notNull(),
    actionLogId: integer("action_log_id"),
    sentMsgId: integer("sent_msg_id"),
    sendMode: text("send_mode").notNull(),
    failureCode: text("failure_code"),
    usedAtMs: integer("used_at_ms").notNull(),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    index("idx_album_usage_asset").on(t.assetId),
    index("idx_album_usage_target").on(t.targetChatId),
    index("idx_album_usage_used").on(t.usedAtMs),
  ],
);

/**
 * ADR-261: Восстанавливаемая проекция ритмического профиля.
 * Восстанавливается из источников фактов типа message_log / canonical_events;
 * не является авторитетом истории активности.
 * @see docs/adr/261-rhythm-profile-projection.md
 */
export const rhythmProfiles = sqliteTable(
  "rhythm_profiles",
  {
    entityId: text("entity_id").primaryKey(),
    entityType: text("entity_type").notNull(),
    sourceWindowStartMs: integer("source_window_start_ms").notNull(),
    sourceWindowEndMs: integer("source_window_end_ms").notNull(),
    sampleCount: integer("sample_count").notNull(),
    bucketCount: integer("bucket_count").notNull(),
    activeBucketCount: integer("active_bucket_count").notNull().default(0),
    observedSpanHours: real("observed_span_hours").notNull().default(0),
    observedDays: integer("observed_days").notNull().default(0),
    timezoneOffsetHours: real("timezone_offset_hours").notNull().default(0),
    enabledPeriodsJson: text("enabled_periods_json").notNull().default("[]"),
    activeNowScore: real("active_now_score").notNull(),
    quietNowScore: real("quiet_now_score").notNull(),
    unusualActivityScore: real("unusual_activity_score").notNull(),
    peakWindowsJson: text("peak_windows_json").notNull().default("[]"),
    quietWindowsJson: text("quiet_windows_json").notNull().default("[]"),
    confidence: text("confidence").notNull(),
    stale: integer("stale", { mode: "boolean" }).notNull().default(false),
    diagnosticsJson: text("diagnostics_json").notNull().default("{}"),
    updatedAtMs: integer("updated_at_ms").notNull(),
  },
  (t) => [
    index("idx_rhythm_profiles_type").on(t.entityType),
    index("idx_rhythm_profiles_confidence").on(t.confidence),
    index("idx_rhythm_profiles_updated").on(t.updatedAtMs),
  ],
);

/**
 * ADR-255: Свидетельства результата группового вмешательства.
 * Одно исходящее сообщение Alice оценивается не более одного раза; graph social_reception — лишь проекция последующего состояния.
 * @see docs/adr/255-intervention-outcome-truth-model/README.md
 */
export const interventionOutcomeEvidence = sqliteTable(
  "intervention_outcome_evidence",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    tick: integer("tick"),
    channelId: text("channel_id").notNull(),
    aliceMessageLogId: integer("alice_message_log_id").notNull(),
    aliceMsgId: integer("alice_msg_id"),
    aliceMessageAtMs: integer("alice_message_at_ms").notNull(),
    evaluatedAtMs: integer("evaluated_at_ms").notNull(),
    outcome: text("outcome").notNull(),
    signal: real("signal"),
    afterMessageCount: integer("after_message_count").notNull(),
    replyToAliceCount: integer("reply_to_alice_count").notNull(),
    hostileMatchCount: integer("hostile_match_count").notNull(),
    sourceMessageLogIdsJson: text("source_message_log_ids_json").notNull().default("[]"),
    semanticReception: text("semantic_reception"),
    semanticConfidence: real("semantic_confidence"),
    semanticRationale: text("semantic_rationale"),
    semanticSourceMessageLogIdsJson: text("semantic_source_message_log_ids_json")
      .notNull()
      .default("[]"),
    semanticAuthority: text("semantic_authority").notNull().default("deterministic"),
    semanticModel: text("semantic_model"),
    previousReception: real("previous_reception"),
    nextReception: real("next_reception"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    uniqueIndex("idx_intervention_outcome_evidence_alice_message_log").on(t.aliceMessageLogId),
    index("idx_intervention_outcome_evidence_channel_time").on(t.channelId, t.aliceMessageAtMs),
    index("idx_intervention_outcome_evidence_outcome").on(t.outcome),
  ],
);

/**
 * ADR-268: Alice self emotion episode fact ledger.
 *
 * Append-only authority for self affect episodes. Graph `emotion_state` is only
 * a rebuildable current projection/cache derived from this fact stream.
 * @see docs/adr/268-emotion-episode-state/README.md
 */
export const emotionEvents = sqliteTable(
  "emotion_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    eventId: text("event_id").notNull(),
    kind: text("kind").notNull(),
    valence: real("valence").notNull(),
    arousal: real("arousal").notNull(),
    intensity: real("intensity").notNull(),
    targetId: text("target_id"),
    causeType: text("cause_type").notNull(),
    causeJson: text("cause_json").notNull(),
    createdAtMs: integer("created_at_ms").notNull(),
    halfLifeMs: integer("half_life_ms").notNull(),
    confidence: real("confidence").notNull(),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    uniqueIndex("idx_emotion_events_event").on(t.eventId),
    index("idx_emotion_events_created").on(t.createdAtMs),
    index("idx_emotion_events_kind_created").on(t.kind, t.createdAtMs),
    index("idx_emotion_events_target_created").on(t.targetId, t.createdAtMs),
  ],
);

/**
 * ADR-268: Alice self emotion repair fact ledger.
 *
 * Append-only repair accelerators. These rows reduce derived effective
 * intensity for matching active episodes; they never mutate the episode facts.
 * @see docs/adr/268-emotion-episode-state/README.md
 */
export const emotionRepairs = sqliteTable(
  "emotion_repairs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    repairId: text("repair_id").notNull(),
    repairKind: text("repair_kind").notNull(),
    emotionKind: text("emotion_kind"),
    targetId: text("target_id"),
    strength: real("strength").notNull(),
    causeType: text("cause_type").notNull(),
    causeJson: text("cause_json").notNull(),
    createdAtMs: integer("created_at_ms").notNull(),
    confidence: real("confidence").notNull(),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    uniqueIndex("idx_emotion_repairs_repair").on(t.repairId),
    index("idx_emotion_repairs_created").on(t.createdAtMs),
    index("idx_emotion_repairs_kind_created").on(t.repairKind, t.createdAtMs),
    index("idx_emotion_repairs_target_created").on(t.targetId, t.createdAtMs),
  ],
);

/**
 * ADR-262: Alice-centered social event facts.
 *
 * Append-only authority for interpersonal case facts. Current social case state
 * (`repairState`, venue debt, boundary status) is a projection and must be
 * rebuilt from this table rather than stored here.
 * @see docs/adr/262-social-case-management/README.md
 */
export const socialEvents = sqliteTable(
  "social_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    eventId: text("event_id").notNull(),
    // Stable case-file handle. Facts without this are legacy relation-scoped events.
    caseId: text("case_id"),
    kind: text("kind").notNull(),
    actorId: text("actor_id").notNull(),
    targetId: text("target_id"),
    affectedRelationA: text("affected_relation_a").notNull(),
    affectedRelationB: text("affected_relation_b").notNull(),
    affectedRelationKey: text("affected_relation_key").notNull(),
    venueId: text("venue_id").notNull(),
    visibility: text("visibility").notNull(),
    witnessesJson: text("witnesses_json").notNull().default("[]"),
    severity: real("severity").notNull(),
    confidence: real("confidence").notNull(),
    evidenceMsgIdsJson: text("evidence_msg_ids_json").notNull().default("[]"),
    causesJson: text("causes_json").notNull().default("[]"),
    occurredAtMs: integer("occurred_at_ms").notNull(),
    repairsEventId: text("repairs_event_id"),
    boundaryText: text("boundary_text"),
    contentText: text("content_text"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    uniqueIndex("idx_social_events_event").on(t.eventId),
    index("idx_social_events_case_time").on(t.caseId, t.occurredAtMs),
    index("idx_social_events_relation_time").on(t.affectedRelationKey, t.occurredAtMs),
    index("idx_social_events_kind").on(t.kind),
    index("idx_social_events_venue_time").on(t.venueId, t.occurredAtMs),
  ],
);

/**
 * Нарративные потоки (упрощённый Arc).
 * Отслеживают продолжающиеся темы, динамику отношений и причинно-следственные цепочки.
 */
export const narrativeThreads = sqliteTable(
  "narrative_threads",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    title: text("title").notNull(),
    tensionFrame: text("tension_frame"), // Описание рамки нарративной напряжённости
    tensionStake: text("tension_stake"), // Описание ставки/важности
    // Проекция читаемой модели нарратива: open|active|resolved|abandoned|expired_unresolved.
    // Состояние потока в графе может быть "expired", означающее, что проекция давления памяти покинула P4-open;
    // статус narrative сохраняет явные результаты жизненного цикла.
    status: text("status").notNull().default("open"),
    weight: text("weight").notNull().default("minor"), // trivial|minor|major|critical
    /** ADR-190: источник потока, различает системные и диалоговые потоки. */
    source: text("source").default("conversation"), // "conversation" | "system"
    involves: text("involves"), // JSON: Involvement[]
    createdTick: integer("created_tick").notNull(),
    lastBeatTick: integer("last_beat_tick"),
    resolvedTick: integer("resolved_tick"),
    /** Горизонт прогноза (в тиках), используется для вычисления P_prospect. */
    horizon: integer("horizon"),
    /** Абсолютный дедлайн-тик = createdTick + horizon. */
    deadlineTick: integer("deadline_tick"),
    /** ADR-64 VI-2: нарративный конспект потока (генерируется LLM через THREAD_REVIEW). */
    summary: text("summary"),
    /** ADR-64 VI-2: тик последнего обновления конспекта. */
    summaryTick: integer("summary_tick"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [index("idx_narrative_threads_status").on(t.status)],
);

/**
 * ADR-262 Wave 4D: факты жизненного цикла потока.
 *
 * Append-only authority: фиксирует, почему поток покинул или продлил open-жизненный цикл.
 * `narrative_threads.status` и атрибуты потока в графе — проекции этих событий.
 * Граф `expired` означает «больше не вносит вклад в P4-open»; narrative `expired_unresolved`
 * означает «нет resolving action, но open-жизненный цикл завершён».
 * @see docs/adr/262-social-case-management/README.md
 */
export const threadLifecycleEvent = sqliteTable(
  "thread_lifecycle_event",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    threadNodeId: text("thread_node_id").notNull(),
    threadId: integer("thread_id"),
    tick: integer("tick").notNull(),
    occurredAtMs: integer("occurred_at_ms").notNull(),
    previousStatus: text("previous_status").notNull(),
    outcome: text("outcome").notNull(),
    reason: text("reason").notNull(),
    deadlineMs: integer("deadline_ms"),
    snoozeUntilMs: integer("snooze_until_ms"),
    p4Before: real("p4_before"),
    metadataJson: text("metadata_json").notNull().default("{}"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    index("idx_thread_lifecycle_event_thread").on(t.threadNodeId),
    index("idx_thread_lifecycle_event_outcome").on(t.outcome),
    index("idx_thread_lifecycle_event_tick").on(t.tick),
  ],
);

/**
 * Персистентность состояния Mod (ADR-33 Phase 1).
 * State каждого Mod сериализуется в JSON, UPSERT по mod_name.
 */
export const modStates = sqliteTable("mod_states", {
  modName: text("mod_name").primaryKey(),
  stateJson: text("state_json").notNull(),
  updatedTick: integer("updated_tick").notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

/**
 * Узлы графа (ADR-33 Phase 2: Write-Back Cache).
 * Замена полной JSON-сериализации graph_snapshots.
 */
export const graphNodes = sqliteTable(
  "graph_nodes",
  {
    id: text("id").primaryKey(),
    entityType: text("entity_type").notNull(),
    attrs: text("attrs").notNull(), // JSON: атрибуты узла
    updatedTick: integer("updated_tick").notNull(),
  },
  (t) => [index("idx_graph_nodes_type").on(t.entityType)],
);

/**
 * Рёбра графа (ADR-33 Phase 2: Write-Back Cache).
 */
export const graphEdges = sqliteTable(
  "graph_edges",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    src: text("src").notNull(),
    dst: text("dst").notNull(),
    label: text("label").notNull(),
    category: text("category").notNull(),
    attrs: text("attrs"), // JSON: дополнительные атрибуты ребра (может быть null)
  },
  (t) => [
    index("idx_graph_edges_src").on(t.src),
    index("idx_graph_edges_dst").on(t.dst),
    index("idx_graph_edges_src_label").on(t.src, t.label),
  ],
);

/**
 * Запланированные задачи (Scheduler Mod).
 * Поддерживаются два типа: at (однократный) и every (периодический).
 */
export const scheduledTasks = sqliteTable(
  "scheduled_tasks",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    type: text("type").notNull(), // "at" | "every"
    targetMs: integer("target_ms"), // Абсолютное настенное время в мс (когда сработать)
    intervalMs: integer("interval_ms"), // Интервал настенного времени в мс (тип every)
    action: text("action").notNull(), // Описание действия при срабатывании (читаемо LLM)
    target: text("target"), // Целевой chatId (опционально)
    payload: text("payload"), // JSON-дополнительные данные
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
    active: integer("active", { mode: "boolean" }).notNull().default(true),
  },
  (t) => [index("idx_scheduled_tasks_active").on(t.active, t.targetMs)],
);

/**
 * Нарративные биты (упрощённый Beat).
 * Ключевые события в потоке, поддерживают причинно-следственные цепочки.
 */
export const narrativeBeats = sqliteTable(
  "narrative_beats",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    threadId: integer("thread_id").notNull(),
    tick: integer("tick").notNull(),
    content: text("content").notNull(),
    beatType: text("beat_type").notNull().default("ambient"), // kernel|ambient
    causedBy: text("caused_by"), // JSON: string[] (id потоков/битов)
    spawns: text("spawns"), // JSON: string[] (id новых потоков)
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [index("idx_narrative_beats_thread").on(t.threadId)],
);

/**
 * Лог атрибуции эволюции личности (ADR-53 #2).
 * Фиксирует источник каждого изменения вектора личности — для аудита «из-за чего дрейф».
 * @see docs/adr/53-audit-gap-closure.md
 */
export const personalityEvolutionLog = sqliteTable(
  "personality_evolution_log",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    tick: integer("tick").notNull(),
    /** Измерение личности: diligence|curiosity|sociability|caution */
    dimension: text("dimension").notNull(),
    /** Величина изменения веса (до нормализации) */
    delta: real("delta").notNull(),
    /** Источник изменения: beat|outcome|decay */
    source: text("source").notNull(),
    /** Тип бита (только когда source=beat) */
    beatType: text("beat_type"),
    /** ID связанной сущности (контакт/канал) */
    targetEntity: text("target_entity"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [index("idx_personality_evo_tick").on(t.tick)],
);

/**
 * ADR-82: Личный дневник Alice.
 * Хранит эмоциональную память, желания/намерения и саморефлексию.
 * LLM записывает через синтаксический сахар diary(), contribute() Mod-дневника читает и инжектирует в system prompt.
 * @see docs/adr/82-diary-inner-world.md
 */
export const diaryEntries = sqliteTable(
  "diary_entries",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    tick: integer("tick").notNull(),
    /** Содержимое записи дневника (произвольный текст, не более 200 символов) */
    content: text("content").notNull(),
    /** ID связанной сущности (контакт/канал, опционально) */
    about: text("about"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [index("idx_diary_tick").on(t.tick), index("idx_diary_about").on(t.about)],
);

/**
 * Таблица аудиторских событий (ADR-54).
 *
 * Критические исключения времени выполнения и системные события записываются сюда
 * для структурированного SQL-запроса. Назначение: постмортем-анализ (точнее grep по логам)
 * и отслеживание трендов аномалий.
 *
 * Примеры запросов:
 *   SELECT tick, level, source, message FROM audit_events WHERE level='fatal' ORDER BY tick DESC LIMIT 20;
 *   SELECT source, COUNT(*) FROM audit_events WHERE tick > 1000 GROUP BY source ORDER BY COUNT(*) DESC;
 *
 * @see docs/adr/54-pre-mortem-safety-net.md
 */
export const auditEvents = sqliteTable(
  "audit_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    tick: integer("tick").notNull(),
    /** fatal | error | warn */
    level: text("level").notNull(),
    /** Исходный модуль (logger tag: act, evolve, events, sandbox и др.) */
    source: text("source").notNull(),
    /** Описание события */
    message: text("message").notNull(),
    /** Дополнительные детали JSON (стек ошибки, снимок параметров и т.д.) */
    details: text("details"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    index("idx_audit_events_tick").on(t.tick),
    index("idx_audit_events_level").on(t.level),
    index("idx_audit_events_source").on(t.source),
  ],
);

/**
 * ADR-199: Аудиторский лог отложенной оценки.
 * Фиксирует результаты отложенной оценки внешней обратной связи после отправки сообщений Alice.
 * @see runtime/src/engine/deferred-outcome.ts
 */
export const deferredOutcomeLog = sqliteTable(
  "deferred_outcome_log",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    tick: integer("tick").notNull(),
    channelId: text("channel_id").notNull(),
    /** Настенное время отправки сообщения Alice (мс). */
    actionMs: integer("action_ms").notNull(),
    /** Настенное время выполнения отложенной оценки (мс). */
    evaluationMs: integer("evaluation_ms").notNull(),
    /** Задержка (мс) = evaluationMs - actionMs. */
    delayMs: integer("delay_ms").notNull(),
    /** Оценка внешней обратной связи [-1, 1]. */
    score: real("score").notNull(),
    /** Уверенность [0, 1]. */
    confidence: real("confidence").notNull(),
    /** JSON-сигналы: string[]. */
    signals: text("signals"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    index("idx_deferred_outcome_tick").on(t.tick),
    index("idx_deferred_outcome_channel").on(t.channelId),
  ],
);

/** Семантическая палитра стикеров: маппинг label → fileId. Phase 1 — ручное обслуживание, Phase 2 — авто-заполнение VLM. */
export const stickerPalette = sqliteTable(
  "sticker_palette",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** Семантическая метка = VLM summary (видна LLM) */
    label: text("label").notNull(),
    /** Telegram sticker file ID (для отправки, может обновляться). */
    fileId: text("file_id").notNull().unique(),
    /** Telegram file_unique_id — постоянный уникальный, ключ дедупликации. */
    fileUniqueId: text("file_unique_id").notNull().unique(),
    /** Вспомогательный emoji (опционально) */
    emoji: text("emoji"),
    /** Короткое имя набора стикеров (для отслеживания источника) */
    setName: text("set_name"),
    /** Измерение эмоции (заполняется VLM в Phase 2) */
    emotion: text("emotion"),
    /** Измерение действия (заполняется VLM в Phase 2) */
    action: text("action"),
    /** Измерение интенсивности (заполняется VLM в Phase 2) */
    intensity: text("intensity"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    index("idx_sticker_palette_label").on(t.label),
    index("idx_sticker_palette_emotion").on(t.emotion),
  ],
);

/** Отслеживание частоты использования стикеров: per sticker × per chat. */
export const stickerUsage = sqliteTable(
  "sticker_usage",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** sticker_palette.file_unique_id */
    fileUniqueId: text("file_unique_id").notNull(),
    /** ID чата, в котором использовался стикер */
    chatId: text("chat_id").notNull(),
    /** Тип чата (определяется по знаку chatId: положительный=private, отрицательный=group) */
    chatType: text("chat_type").notNull(),
    /** Счётчик использований (накапливается) */
    count: integer("count").notNull().default(1),
    /** Время последнего использования */
    lastUsedAt: integer("last_used_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    uniqueIndex("idx_sticker_usage_unique").on(t.fileUniqueId, t.chatId),
    index("idx_sticker_usage_chat").on(t.chatId),
    index("idx_sticker_usage_count").on(t.count),
  ],
);

/**
 * ADR-204: События потока сознания.
 * Хранит следы выполнения тик-цикла (эмоции, инструкции, наблюдения, вывод Skill),
 * в следующем тике всплывают в prompt через surface(), reinforce() замыкает петлю обратной связи.
 * @see docs/adr/204-consciousness-stream/
 */
export const consciousnessEvents = sqliteTable(
  "consciousness_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    tick: integer("tick").notNull(),
    timestampMs: integer("timestamp_ms").notNull(),
    /** Категория события: act:feel | act:diary | evolve:tier | evolve:enqueue и т.д. */
    kind: text("kind").notNull(),
    /** JSON-массив ID связанных сущностей (контакты/каналы). */
    entityIds: text("entity_ids").notNull().default("[]"),
    /** Человекочитаемый конспект события. */
    summary: text("summary").notNull(),
    /** Заметность [0,1], управляет сортировкой surface(). */
    salience: real("salience").notNull().default(0.5),
    /** Подсказка для раскрытия (опционально, для более богатого контекста при contribute). */
    expandHint: text("expand_hint"),
  },
  (t) => [index("idx_ce_tick").on(t.tick), index("idx_ce_salience").on(t.salience)],
);

/**
 * Кэш Bio: получаемые по запросу bio/description Telegram-сущностей.
 * Контакты → users.getFullUser.about, группы/каналы → channels.getFullChannel.about.
 * TTL 3 дня, при cache miss запрашивается асинхронно, вступает в силу со следующего тика.
 */
export const bioCache = sqliteTable("bio_cache", {
  /** ID сущности (например contact:telegram:123 или channel:telegram:-100xxx). */
  entityId: text("entity_id").primaryKey(),
  /** Текст bio/about (подпись Telegram-пользователя или описание группы). */
  bio: text("bio"),
  /** ID личного канала пользователя (только для contact, может использоваться для обнаружения). */
  personalChannelId: integer("personal_channel_id"),
  /** Время получения (мс). */
  fetchedAt: integer("fetched_at", { mode: "timestamp_ms" }).notNull(),
});

/**
 * ADR-215: Cognitive Episode Graph — когнитивный эпизод.
 * Episode = отрезок связной когнитивной активности (от начала engagement до естественного прерывания).
 * Разделяется автоматически, объявление LLM не требуется. Residue кодирует неразрешённое напряжение и участвует в конкуренции давлений.
 * @see docs/adr/215-cognitive-episode-graph.md
 */
export const episodes = sqliteTable(
  "episodes",
  {
    id: text("id").primaryKey(), // episode:${tick_start}
    tickStart: integer("tick_start").notNull(),
    tickEnd: integer("tick_end"),
    target: text("target"),
    voice: text("voice"),
    outcome: text("outcome"), // message_sent | silence | error | preempted
    pressureApi: real("pressure_api"),
    pressureDominant: text("pressure_dominant"),
    triggerEvent: text("trigger_event"),
    entityIds: text("entity_ids").notNull().default("[]"), // JSON string[]
    residue: text("residue"), // JSON EpisodeResidue | null
    causedBy: text("caused_by"), // JSON string[] ID эпизодов
    consults: text("consults"), // JSON string[] ID эпизодов
    resolves: text("resolves"), // JSON string[] ID эпизодов
    createdMs: integer("created_ms").notNull(),
  },
  (t) => [index("idx_episodes_tick").on(t.tickStart), index("idx_episodes_target").on(t.target)],
);
