/**
 * Learning Mod — ADR-123 §D3/D4 文化知识结晶 + 行为自知结晶。
 *
 * 两个信念域共享统一结晶管线（observe → EMA → crystallize → decay）：
 *   jargon:    群组黑话/梗/专有名词 → 文化适应（GOAL 场景 4）
 *   expression: 行为自评 → 有效表达模式（GOAL 场景 5）
 *
 * 指令：note_jargon
 * 监听：rate_outcome（expression 域观察来源）
 *
 * @see docs/adr/123-crystallization-substrate-generalization.md §D3, §D4
 * @see docs/adr/89-impression-formation-system.md — 印象结晶（首个域实现，本 Mod 同构）
 */
import { z } from "zod";
import { createMod } from "../core/mod-builder.js";
import { PromptBuilder } from "../core/prompt-style.js";
import type { ContributionItem } from "../core/types.js";
import { section } from "../core/types.js";
import { getDb } from "../db/connection.js";
import { reinforce as reinforceConsciousness } from "../engine/consciousness.js";
import { estimateEventMs } from "../pressure/clock.js";
import { QUALITY_MAP } from "../voices/beat-feedback.js";

// -- 类型 --------------------------------------------------------------------

/** 群组黑话结晶条目。语义内容（meaning）存在 Mod state，不在 BeliefStore。 */
export interface JargonEntry {
  /** 推断的含义（LLM 生成的自然语言）。 */
  meaning: string;
  /** 结晶 tick。 */
  crystallizedAt: number;
  /** 上次强化 tick（衰减基准）。 */
  lastReinforced: number;
  /** 上次强化墙钟 ms。 */
  lastReinforcedMs: number;
}

/** 从 rate_outcome 积累的行为自知结晶条目。 */
export interface LearnedExample {
  /** 场景描述。 */
  situation: string;
  /** 有效的表达模式。 */
  expression: string;
  /** 质量 μ（从 rate_outcome 累积）。 */
  quality: number;
  /** 来源标记。 */
  source: "learned";
  /** 结晶 tick。 */
  crystallizedAt: number;
  /** 上次强化 tick。 */
  lastReinforced: number;
  /** 上次强化墙钟 ms。 */
  lastReinforcedMs: number;
}

// -- Mod 状态 -----------------------------------------------------------------

export interface LearningState {
  /** 群组黑话库: groupId → Map<term, JargonEntry>。 */
  jargon: Record<string, Record<string, JargonEntry>>;
  /** 黑话结晶 σ² 阈值。 */
  jargonCrystallizeSigma2: number;
  /** 黑话结晶最少观察次数。 */
  jargonMinObs: number;
  /** 学到的表达模式: situationHash → LearnedExample。 */
  expressions: Record<string, LearnedExample>;
  /** 表达结晶 σ² 阈值。 */
  expressionCrystallizeSigma2: number;
  /** 表达结晶最少正向观察次数。 */
  expressionMinPositive: number;
  /** jargon 观察计数（key = "group::jargon:term"，用于结晶条件）。 */
  jargonObsCounts: Record<string, number>;
  /** expression 观察计数（key = "self::expression:situationKey"）。 */
  expressionObsCounts: Record<string, number>;
  /** rate_outcome reason 缓存（situationKey → {target, reason, tick, ms}）。 */
  expressionReasonCache: Record<
    string,
    { target: string; reason: string; tick: number; ms?: number }
  >;
}

// -- 常量 --------------------------------------------------------------------

// @see docs/adr/123-crystallization-substrate-generalization.md §D3
/** LLM 语义无障碍: confidence 标签 → 数值映射（代码侧完成）。 */
export const CONFIDENCE_MAP = {
  guess: 0.3,
  likely: 0.6,
  certain: 0.9,
} as const satisfies Record<string, number>;

/**
 * 已结晶条目过期阈值（秒）：3 倍半衰期 ≈ 21 天无强化则移除。
 * 与 CrystallizedTrait 同理——无数值可衰减（JargonEntry 的语义内容是字符串），
 * 故采用 "最近一次强化后 N 秒" 的硬截断替代指数衰减。
 * @see docs/adr/89-impression-formation-system.md §Wave 3B — CrystallizedTrait 衰减参考
 */
const CRYSTALLIZED_EXPIRY_S = 604800 * 3; // 7d × 3 ≈ 21 天

// ADR-131: QUALITY_MAP 统一从 beat-feedback.ts 导入（单一真相源）。
// 此前本地副本 good=0.6 与全局 good=0.5 不一致，属于语义裂缝。

// -- 辅助 --------------------------------------------------------------------

/** 简单 situation key 哈希：target + 10 分钟时间桶。 */
function hashSituation(target: string, nowMs: number): string {
  // 以 10 分钟为粒度合并同一场景的多次观察（≈ 旧 10-tick 窗口）
  const bucket = Math.floor(nowMs / 600_000);
  return `${target}_${bucket}`;
}

// -- Mod 定义 -----------------------------------------------------------------

export const learningMod = createMod<LearningState>("learning", {
  category: "mechanic",
  description: "ADR-123 кристаллизация культурных знаний (jargon) + поведенческого самопознания (expression)",
  depends: ["observer", "memory"],
  topics: ["social", "memory"],
  initialState: {
    jargon: {},
    jargonCrystallizeSigma2: 0.08,
    jargonMinObs: 2,
    expressions: {},
    expressionCrystallizeSigma2: 0.1,
    expressionMinPositive: 2,
    jargonObsCounts: {},
    expressionObsCounts: {},
    expressionReasonCache: {},
  },
})
  /**
   * 记录群组黑话/梗/专有名词。
   * LLM 在 act 阶段自然观察到群组特有用语时调用。
   * @see docs/adr/123-crystallization-substrate-generalization.md §D3
   */
  .instruction("note_jargon", {
    params: z.object({
      chatId: z.string().min(1).describe("ID группы/канала"),
      term: z.string().min(1).max(30).describe("сленг/мем/особое словечко (до 30 символов)"),
      meaning: z.string().min(1).max(100).describe("значение, которое ты вывела из контекста"),
      confidence: z.enum(["guess", "likely", "certain"]).describe("насколько ты уверена в этой догадке?"),
    }),
    deriveParams: { chatId: (cv: Record<string, unknown>) => cv.TARGET_CHAT },
    description: "записать специфичное для группы словечко (сленг, мем, внутренняя шутка)",
    examples: [
      'note_jargon({ term: "профит", meaning: "something good happened", confidence: "likely" })',
    ],
    affordance: {
      whenToUse: "Record group-specific slang, memes, or inside jokes you notice",
      whenNotToUse: "For common words or well-known terms",
      priority: "capability",
      category: "social",
    },
    impl(ctx, args) {
      const group = String(args.chatId);
      const term = String(args.term);
      const meaning = String(args.meaning);
      const confidenceLabel = String(args.confidence);

      // ADR-50: 语义标签 → 数值映射（代码侧完成，LLM 不接触数值）
      const observation =
        confidenceLabel in CONFIDENCE_MAP
          ? CONFIDENCE_MAP[confidenceLabel as keyof typeof CONFIDENCE_MAP]
          : 0.3;

      // 复用 BeliefStore EMA 融合
      const belief = ctx.graph.beliefs.update(
        group,
        `jargon:${term}`,
        observation,
        "semantic",
        ctx.nowMs,
      );

      // 观察计数（用于结晶条件）
      const countKey = `${group}::jargon:${term}`;
      ctx.state.jargonObsCounts[countKey] = (ctx.state.jargonObsCounts[countKey] ?? 0) + 1;
      const obsCount = ctx.state.jargonObsCounts[countKey];

      // 语义内容存储在 Mod state（不在 BeliefStore）
      if (!ctx.state.jargon[group]) ctx.state.jargon[group] = {};
      const groupJargon = ctx.state.jargon[group];

      const existing = groupJargon[term];
      if (existing) {
        // 已结晶的 term 收到新观察 → 更新 meaning + 刷新 lastReinforced
        existing.meaning = meaning;
        existing.lastReinforced = ctx.tick;
        existing.lastReinforcedMs = ctx.nowMs;
        return {
          success: true,
          crystallized: true,
          reinforced: true,
          mu: belief.mu,
          sigma2: belief.sigma2,
          observations: obsCount,
        };
      }

      // 结晶检查: σ² < 0.08 && obs >= 2
      if (belief.sigma2 < ctx.state.jargonCrystallizeSigma2 && obsCount >= ctx.state.jargonMinObs) {
        groupJargon[term] = {
          meaning,
          crystallizedAt: ctx.tick,
          lastReinforced: ctx.tick,
          lastReinforcedMs: ctx.nowMs,
        };
        return {
          success: true,
          crystallized: true,
          reinforced: false,
          mu: belief.mu,
          sigma2: belief.sigma2,
          observations: obsCount,
        };
      }

      return {
        success: true,
        crystallized: false,
        mu: belief.mu,
        sigma2: belief.sigma2,
        observations: obsCount,
      };
    },
  })
  /**
   * 监听 rate_outcome — expression 域的观察来源。
   * 只从 quality="good"|"excellent" 的 outcome 中学习。
   * @see docs/adr/123-crystallization-substrate-generalization.md §D4
   */
  .listen("rate_outcome", (ctx, args, _result) => {
    const qualityLabel = String(args.quality ?? "");
    if (!["good", "excellent"].includes(qualityLabel)) return;

    const target = String(args.target ?? "");
    const reason = String(args.reason ?? "");
    if (!target) return;

    // ADR-204: 意识流 reinforce — 正向 outcome 强化关联事件
    try {
      reinforceConsciousness(getDb(), [target], 0.15);
    } catch {
      /* non-critical */
    }

    // situation key: target + 10 分钟时间桶
    const situationKey = hashSituation(target, ctx.nowMs);

    // 信念 EMA 融合
    const qualityValue = QUALITY_MAP[qualityLabel] ?? 0;
    const belief = ctx.graph.beliefs.update(
      "self",
      `expression:${situationKey}`,
      qualityValue,
      "semantic",
      ctx.nowMs,
    );

    // 观察计数
    const countKey = `self::expression:${situationKey}`;
    ctx.state.expressionObsCounts[countKey] = (ctx.state.expressionObsCounts[countKey] ?? 0) + 1;

    // 缓存 reason 作为 expression 候选
    if (reason) {
      ctx.state.expressionReasonCache[situationKey] = {
        target,
        reason,
        tick: ctx.tick,
        ms: ctx.nowMs,
      };
    }

    // 结晶检查: σ² < 0.1 && μ > 0.5 && obs >= 2
    const obsCount = ctx.state.expressionObsCounts[countKey];
    if (
      belief.sigma2 < ctx.state.expressionCrystallizeSigma2 &&
      belief.mu > 0.5 &&
      obsCount >= ctx.state.expressionMinPositive
    ) {
      // 从 reason cache 中获取场景描述
      const cached = ctx.state.expressionReasonCache[situationKey];
      if (cached && !ctx.state.expressions[situationKey]) {
        ctx.state.expressions[situationKey] = {
          situation: `Talking to ${cached.target}`,
          expression: cached.reason,
          quality: belief.mu,
          source: "learned",
          crystallizedAt: ctx.tick,
          lastReinforced: ctx.tick,
          lastReinforcedMs: ctx.nowMs,
        };
      }
    }
  })
  .contribute((ctx): ContributionItem[] => {
    const items: ContributionItem[] = [];

    // -- jargon 域: 渲染当前目标频道的已结晶黑话 --
    // 读取目标频道 ID（从 memory mod state）
    const memState = ctx.getModState<{ targetChatId: string | null }>("memory");
    const targetChatId = memState?.targetChatId ?? null;

    if (targetChatId) {
      const groupJargon = ctx.state.jargon[targetChatId];
      if (groupJargon && Object.keys(groupJargon).length > 0) {
        const entries = Object.entries(groupJargon).slice(0, 8);
        const lines = entries.map(([term, e]) => PromptBuilder.of(`"${term}" → ${e.meaning}`));
        items.push(section("group-jargon", lines, "Local slang in this group", 60, 30));
      }
    }

    // -- expression 域: top-3 已结晶的 LearnedExample --
    const allExpressions = Object.values(ctx.state.expressions);
    if (allExpressions.length > 0) {
      const top3 = allExpressions.sort((a, b) => b.quality - a.quality).slice(0, 3);
      const lines = top3.map((ex) =>
        PromptBuilder.of(`When ${ex.situation}, try: ${ex.expression}`),
      );
      items.push(section("learned-expressions", lines, "What you've learned works", 80, 25));
    }

    return items;
  })
  /**
   * 已结晶的 JargonEntry / LearnedExample 衰减。
   * 与 CrystallizedTrait 同理：半衰期 7 天，过期移除。
   * @see docs/adr/89-impression-formation-system.md §Wave 3B
   */
  .onTickEnd((ctx) => {
    // -- jargon 衰减 --
    for (const [groupId, groupJargon] of Object.entries(ctx.state.jargon)) {
      for (const [term, entry] of Object.entries(groupJargon)) {
        const elapsedS = (ctx.nowMs - entry.lastReinforcedMs) / 1000;
        if (elapsedS > CRYSTALLIZED_EXPIRY_S) {
          delete groupJargon[term];
          // 同步清理 obsCounts（防止 tracking key 无界增长）
          delete ctx.state.jargonObsCounts[`${groupId}::jargon:${term}`];
        }
      }
      // 清理空组
      if (Object.keys(groupJargon).length === 0) {
        delete ctx.state.jargon[groupId];
      }
    }

    // -- expression 衰减 --
    for (const [key, entry] of Object.entries(ctx.state.expressions)) {
      const elapsedS = (ctx.nowMs - entry.lastReinforcedMs) / 1000;
      if (elapsedS > CRYSTALLIZED_EXPIRY_S) {
        delete ctx.state.expressions[key];
        // 同步清理 tracking key（防止无界增长）
        delete ctx.state.expressionObsCounts[`self::expression:${key}`];
        delete ctx.state.expressionReasonCache[key];
      }
    }

    // -- expression tracking 清理：未结晶的 stale 条目 --
    // expressionReasonCache 按 10 分钟桶创建，
    // 超过 20 分钟后不会再收到新观察 → 永远不会结晶 → 清理。
    const EXPRESSION_STALE_MS = 20 * 60_000;
    for (const [key, cached] of Object.entries(ctx.state.expressionReasonCache)) {
      const age = ctx.nowMs - estimateEventMs(cached, ctx.nowMs, ctx.tick);
      if (age > EXPRESSION_STALE_MS && !ctx.state.expressions[key]) {
        delete ctx.state.expressionReasonCache[key];
        delete ctx.state.expressionObsCounts[`self::expression:${key}`];
      }
    }
  })
  .build();
