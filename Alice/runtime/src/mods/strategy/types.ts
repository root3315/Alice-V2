/**
 * Strategy Mod 共享类型、常量和纯函数。
 *
 * 所有子模块共享的基础设施，不含副作用。
 */

// -- 类型 --------------------------------------------------------------------

export interface ActionRecord {
  target: string | null;
  tick: number;
  /** ADR-110: 行动发生的墙钟时间（ms）。新数据必有，旧数据可能缺失。 */
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

// -- M2: 群聊动态状态 ---------------------------------------------------------

/**
 * 群聊结构化状态（M2 场景 4 增强）。
 *
 * 关键词窗口收集最近消息的高频词，供 LLM 在 contribute 中自行判断话题变化。
 * participationRatio 用简单比例追踪 Alice 在群中的参与度，
 * 避免 Alice 过度或过少参与（Dunbar 社交分配约束）。
 *
 * @see docs/adr/46-real-data-calibration.md §2 Wave 1
 */
export interface GroupChatState {
  /** 最近活跃发言者（环形缓冲，10 人）。 */
  recentSpeakers: string[];
  /** 话题关键词窗口（最近消息的关键词集合）。 */
  topicKeywords: string[];
  /** Alice 在该群的参与率 (alice_msgs / total_msgs，简单比例)。 */
  participationRatio: number;
  /** 总消息计数窗口。 */
  totalMessages: number;
  /** Alice 消息计数窗口。 */
  aliceMessages: number;
}

/** 频道消息频率追踪（用于危机/活跃度检测）。 */
export interface MessageFrequencyWindow {
  /** 最近 N tick 内的入站消息数（sliding window）。 */
  recentCount: number;
  /** 基线消息频率（长期均值 EMA）。 */
  baseline: number;
  /** EMA 方差（用于 Z-score 危机检测）。旧数据可能缺失，此时回退到频率比。 */
  variance?: number;
  /** 上次更新 tick。 */
  lastTick: number;
  /** ADR-110: 上次更新的墙钟时间（ms）。新数据必有，旧数据可能缺失。 */
  lastMs?: number;
}

/**
 * M4 人格漂移审计状态。
 *
 * 理论基础:
 * - drift = l2Distance(π_current, π_home): 累积偏离度
 * - velocity = l2Distance(π_current, π_previous) / interval: 瞬时变化率
 * - 分类: healthy (< 0.1) / warning (0.1~0.2) / alert (>= 0.2)
 *
 * 参考: Ashton & Lee (2007) HEXACO 人格稳定性研究 — 人格长期稳定但可漂移。
 */
export interface PersonalityDriftState {
  /** 上次审计 tick。 */
  lastAuditTick: number;
  /** ADR-110: 上次审计的墙钟时间（ms）。新数据必有，旧数据可能缺失。 */
  lastAuditMs?: number;
  /** 上次审计时的人格快照 (用于计算 velocity)。 */
  previousWeights: number[] | null;
  /** 当前漂移值。 */
  drift: number;
  /** 当前变化速度。 */
  velocity: number;
  /** 健康分类。 */
  health: "healthy" | "warning" | "alert";
}

export interface StrategyState {
  /** 最近行动日志（环形缓冲，20 条）。 */
  recentActions: ActionRecord[];
  // contactLastInteraction[Ms] 已移除——与 observer.mod 写到图属性 last_alice_action_ms 完全冗余。
  // hint-generators 现在直接从图读取（同时查 contact:xxx 和 channel:xxx 变体）。
  /** 当前活跃策略提示（每 tick 重新计算）。 */
  activeHints: StrategyHint[];
  /** 场景 6: 频道消息频率窗口（channelId → window）。 */
  messageFrequency: Record<string, MessageFrequencyWindow>;
  /** 场景 6: 当前处于危机模式的频道。 */
  crisisChannels: Record<string, number>; // channelId → detectedTick
  /** ADR-110: 危机检测的墙钟时间（channelId → ms）。 */
  crisisChannelsMs?: Record<string, number>;
  /** M2: 群聊动态状态（channelId → GroupChatState）。 */
  groupStates: Record<string, GroupChatState>;
  /** M4: 人格漂移审计。 */
  personalityDrift: PersonalityDriftState;
}

// -- 常量 --------------------------------------------------------------------

export const MAX_RECENT_ACTIONS = 20;
export const MAX_RECENT_SPEAKERS = 10;
export const MAX_TOPIC_KEYWORDS = 30;

// ADR-113 §D3: Tier → 沉默容忍阈值映射（秒）
// 与 P6 TIER_EXPECTED_SILENCE_S 对齐——策略层和压力层用相同的时间尺度。
// @see src/pressure/p6-curiosity.ts TIER_EXPECTED_SILENCE_S
export const SILENCE_THRESHOLD_S: Record<number, number> = {
  5: 14400, // intimate: 4 hours
  15: 86400, // close friend: 1 day
  50: 259200, // friend: 3 days
  150: 1209600, // acquaintance: 14 days
  500: 5184000, // known: 60 days
};

// M4: 人格漂移审计参数
/** 漂移审计间隔（ticks）。 */
export const DRIFT_AUDIT_INTERVAL = 100;
/** ADR-110: 漂移审计间隔（秒）。100 ticks × 60 = 6000 秒。 */
export const DRIFT_AUDIT_INTERVAL_S = 6000;
/** 漂移 warning 阈值。 */
export const DRIFT_WARNING_THRESHOLD = 0.1;
/**
 * 漂移 alert 阈值。
 * ADR-46 F7b: 0.2 → 0.15（ADR-45 发现 0.468 总漂移才触发，太晚）。
 * @see docs/adr/45-real-data-validation.md §3.6
 */
export const DRIFT_ALERT_THRESHOLD = 0.15;

/**
 * 危机检测：Z-score 阈值。unread 偏离 EMA 均值超过 2.5σ → 危机候选。
 * 替代旧频率比（CRISIS_FREQUENCY_RATIO=4.0），统计显著性更强。
 * @see evolve.ts spikeContribs — ADR-191: 相同的 Z-score 方法，通过 tauSpike → rCaution 直接结构路径
 */
export const CRISIS_Z_THRESHOLD = 2.5;
/**
 * 危机恢复：Z-score 回落到此值以下 → 危机消退。
 */
export const CRISIS_RECOVERY_Z = 1.0;
/**
 * @deprecated 旧频率比阈值，仅在 variance 数据缺失时作为回退。
 * @see CRISIS_Z_THRESHOLD — 新检测方式
 */
export const CRISIS_FREQUENCY_RATIO = 4.0;
/**
 * @deprecated 旧最低基线，仅在 variance 数据缺失时作为回退。
 */
export const CRISIS_MIN_BASELINE = 5;
/** @deprecated 旧恢复比率，Z-score 方式使用 CRISIS_RECOVERY_Z。 */
export const CRISIS_RECOVERY_RATIO = 1.5;

// -- 纯函数 ------------------------------------------------------------------

/** @deprecated ADR-110: 使用 getSilenceThresholdS 替代。 */
export function getSilenceThreshold(tier: number): number {
  return SILENCE_THRESHOLD_S[tier] ?? 30000;
}

/** ADR-110: 返回沉默容忍阈值（秒）。 */
export function getSilenceThresholdS(tier: number): number {
  return SILENCE_THRESHOLD_S[tier] ?? 30000;
}

/** 创建空白群聊状态。 */
export function emptyGroupState(): GroupChatState {
  return {
    recentSpeakers: [],
    topicKeywords: [],
    participationRatio: 0,
    totalMessages: 0,
    aliceMessages: 0,
  };
}

/** 解析图属性中的 JSON 权重数组。 */
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

// F24: 提升为模块级常量（一次初始化），避免每次 extractKeywords 调用重建 Set
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
 * 从文本提取关键词（简单 TF 方法）。
 * 去除停用词和短词，保留有信息量的 token。
 */
export function extractKeywords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 2 && !STOP_WORDS.has(w))
    .slice(0, 10); // 每条消息最多 10 个关键词
}
