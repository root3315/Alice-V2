/**
 * Learning Mod — ADR-123 §D3/D4 кристаллизация культурных знаний + поведенческого самопознания.
 *
 * Два домена убеждений разделяют единый конвейер кристаллизации (observe → EMA → crystallize → decay):
 *   jargon:    групповой сленг/мемы/специальные термины → культурная адаптация (GOAL сценарий 4)
 *   expression: поведенческая самооценка → эффективные паттерны выражения (GOAL сценарий 5)
 *
 * Инструкции: note_jargon
 * Слушает: rate_outcome (источник наблюдений домена expression)
 *
 * @see docs/adr/123-crystallization-substrate-generalization.md §D3, §D4
 * @see docs/adr/89-impression-formation-system.md — кристаллизация впечатлений (первая реализация домена, данный Mod изоморфен)
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

// -- Типы --------------------------------------------------------------------

/** Кристаллизованная запись группового сленга. Семантическое содержимое (meaning) хранится в состоянии Mod, не в BeliefStore. */
export interface JargonEntry {
  /** Выведенное значение (естественный язык, сгенерированный LLM). */
  meaning: string;
  /** Tick кристаллизации. */
  crystallizedAt: number;
  /** Tick последнего подкрепления (база для затухания). */
  lastReinforced: number;
  /** Настенные часы последнего подкрепления (мс). */
  lastReinforcedMs: number;
}

/** Кристаллизованная запись поведенческого самопознания, накопленная из rate_outcome. */
export interface LearnedExample {
  /** Описание ситуации. */
  situation: string;
  /** Эффективный паттерн выражения. */
  expression: string;
  /** Качество μ (накоплено из rate_outcome). */
  quality: number;
  /** Метка источника. */
  source: "learned";
  /** Tick кристаллизации. */
  crystallizedAt: number;
  /** Tick последнего подкрепления. */
  lastReinforced: number;
  /** Настенные часы последнего подкрепления (мс). */
  lastReinforcedMs: number;
}

// -- Состояние Mod ------------------------------------------------------------

export interface LearningState {
  /** База сленга группы: groupId → Map<term, JargonEntry>. */
  jargon: Record<string, Record<string, JargonEntry>>;
  /** Порог σ² для кристаллизации сленга. */
  jargonCrystallizeSigma2: number;
  /** Минимальное число наблюдений для кристаллизации сленга. */
  jargonMinObs: number;
  /** Усвоенные паттерны выражения: situationHash → LearnedExample. */
  expressions: Record<string, LearnedExample>;
  /** Порог σ² для кристаллизации выражения. */
  expressionCrystallizeSigma2: number;
  /** Минимальное число положительных наблюдений для кристаллизации выражения. */
  expressionMinPositive: number;
  /** Счётчики наблюдений сленга (key = "group::jargon:term", для условий кристаллизации). */
  jargonObsCounts: Record<string, number>;
  /** Счётчики наблюдений выражений (key = "self::expression:situationKey"). */
  expressionObsCounts: Record<string, number>;
  /** Кэш reason из rate_outcome (situationKey → {target, reason, tick, ms}). */
  expressionReasonCache: Record<
    string,
    { target: string; reason: string; tick: number; ms?: number }
  >;
}

// -- Константы ----------------------------------------------------------------

// @see docs/adr/123-crystallization-substrate-generalization.md §D3
/** Семантическая доступность для LLM: метка confidence → числовое отображение (выполняется на стороне кода). */
export const CONFIDENCE_MAP = {
  guess: 0.3,
  likely: 0.6,
  certain: 0.9,
} as const satisfies Record<string, number>;

/**
 * Порог устаревания кристаллизованных записей (в секундах): 3 периода полураспада ≈ 21 день без подкрепления — удаляем.
 * Аналогично CrystallizedTrait — нет числового значения для затухания (семантическое содержимое JargonEntry — строка),
 * поэтому вместо экспоненциального затухания применяется жёсткое отсечение «N секунд после последнего подкрепления».
 * @see docs/adr/89-impression-formation-system.md §Wave 3B — ссылка на затухание CrystallizedTrait
 */
const CRYSTALLIZED_EXPIRY_S = 604800 * 3; // 7д × 3 ≈ 21 день

// ADR-131: QUALITY_MAP единообразно импортируется из beat-feedback.ts (единственный источник истины).
// Ранее локальная копия good=0.6 расходилась с глобальным good=0.5 — это была семантическая трещина.

// -- Вспомогательные ---------------------------------------------------------

/** Простой хэш ключа ситуации: target + 10-минутный временной бакет. */
function hashSituation(target: string, nowMs: number): string {
  // С гранулярностью 10 минут объединяем несколько наблюдений одной ситуации (≈ старое 10-tick окно)
  const bucket = Math.floor(nowMs / 600_000);
  return `${target}_${bucket}`;
}

// -- Определение Mod ----------------------------------------------------------

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
   * Записывает групповой сленг/мемы/специальные термины.
   * Вызывается LLM на этапе act при естественном обнаружении специфичных для группы слов.
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

      // ADR-50: семантическая метка → числовое отображение (выполняется на стороне кода, LLM не видит числа)
      const observation =
        confidenceLabel in CONFIDENCE_MAP
          ? CONFIDENCE_MAP[confidenceLabel as keyof typeof CONFIDENCE_MAP]
          : 0.3;

      // Переиспользуем EMA-слияние BeliefStore
      const belief = ctx.graph.beliefs.update(
        group,
        `jargon:${term}`,
        observation,
        "semantic",
        ctx.nowMs,
      );

      // Счётчик наблюдений (для условий кристаллизации)
      const countKey = `${group}::jargon:${term}`;
      ctx.state.jargonObsCounts[countKey] = (ctx.state.jargonObsCounts[countKey] ?? 0) + 1;
      const obsCount = ctx.state.jargonObsCounts[countKey];

      // Семантическое содержимое хранится в состоянии Mod (не в BeliefStore)
      if (!ctx.state.jargon[group]) ctx.state.jargon[group] = {};
      const groupJargon = ctx.state.jargon[group];

      const existing = groupJargon[term];
      if (existing) {
        // Кристаллизованный term получил новое наблюдение → обновляем meaning + обновляем lastReinforced
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

      // Проверка кристаллизации: σ² < 0.08 && obs >= 2
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
   * Слушает rate_outcome — источник наблюдений домена expression.
   * Учится только из outcome с quality="good"|"excellent".
   * @see docs/adr/123-crystallization-substrate-generalization.md §D4
   */
  .listen("rate_outcome", (ctx, args, _result) => {
    const qualityLabel = String(args.quality ?? "");
    if (!["good", "excellent"].includes(qualityLabel)) return;

    const target = String(args.target ?? "");
    const reason = String(args.reason ?? "");
    if (!target) return;

    // ADR-204: усиление потока сознания — положительный outcome укрепляет связанные события
    try {
      reinforceConsciousness(getDb(), [target], 0.15);
    } catch {
      /* non-critical */
    }

    // ключ ситуации: target + 10-минутный временной бакет
    const situationKey = hashSituation(target, ctx.nowMs);

    // EMA-слияние убеждений
    const qualityValue = QUALITY_MAP[qualityLabel] ?? 0;
    const belief = ctx.graph.beliefs.update(
      "self",
      `expression:${situationKey}`,
      qualityValue,
      "semantic",
      ctx.nowMs,
    );

    // Счётчик наблюдений
    const countKey = `self::expression:${situationKey}`;
    ctx.state.expressionObsCounts[countKey] = (ctx.state.expressionObsCounts[countKey] ?? 0) + 1;

    // Кэшируем reason как кандидата expression
    if (reason) {
      ctx.state.expressionReasonCache[situationKey] = {
        target,
        reason,
        tick: ctx.tick,
        ms: ctx.nowMs,
      };
    }

    // Проверка кристаллизации: σ² < 0.1 && μ > 0.5 && obs >= 2
    const obsCount = ctx.state.expressionObsCounts[countKey];
    if (
      belief.sigma2 < ctx.state.expressionCrystallizeSigma2 &&
      belief.mu > 0.5 &&
      obsCount >= ctx.state.expressionMinPositive
    ) {
      // Получаем описание ситуации из кэша reason
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

    // -- домен jargon: рендерим кристаллизованный сленг текущего целевого канала --
    // Читаем ID целевого канала (из состояния mod memory)
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

    // -- домен expression: топ-3 кристаллизованных LearnedExample --
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
   * Затухание кристаллизованных JargonEntry / LearnedExample.
   * Аналогично CrystallizedTrait: период полураспада 7 дней, по истечении — удаление.
   * @see docs/adr/89-impression-formation-system.md §Wave 3B
   */
  .onTickEnd((ctx) => {
    // -- затухание jargon --
    for (const [groupId, groupJargon] of Object.entries(ctx.state.jargon)) {
      for (const [term, entry] of Object.entries(groupJargon)) {
        const elapsedS = (ctx.nowMs - entry.lastReinforcedMs) / 1000;
        if (elapsedS > CRYSTALLIZED_EXPIRY_S) {
          delete groupJargon[term];
          // Синхронно очищаем obsCounts (предотвращаем неограниченный рост tracking-ключей)
          delete ctx.state.jargonObsCounts[`${groupId}::jargon:${term}`];
        }
      }
      // Удаляем пустые группы
      if (Object.keys(groupJargon).length === 0) {
        delete ctx.state.jargon[groupId];
      }
    }

    // -- затухание expression --
    for (const [key, entry] of Object.entries(ctx.state.expressions)) {
      const elapsedS = (ctx.nowMs - entry.lastReinforcedMs) / 1000;
      if (elapsedS > CRYSTALLIZED_EXPIRY_S) {
        delete ctx.state.expressions[key];
        // Синхронно очищаем tracking-ключи (предотвращаем неограниченный рост)
        delete ctx.state.expressionObsCounts[`self::expression:${key}`];
        delete ctx.state.expressionReasonCache[key];
      }
    }

    // -- очистка expression tracking: устаревшие некристаллизованные записи --
    // expressionReasonCache создаётся по 10-минутным бакетам;
    // после 20 минут новые наблюдения не поступят → никогда не кристаллизуется → удаляем.
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
