/**
 * Consolidation Mod — M4 сжатие памяти.
 *
 * При активации голоса Reflection проверяет, есть ли угасающие факты (R < 0.2) для сжатия.
 * Если у контакта >= 3 фактов с R < 0.2 → помечаются как сжимаемые.
 * LLM вызывает consolidate_facts для генерации сводки, затем атомарная замена.
 *
 * Инструкция: consolidate_facts
 * contribute: секция memory-housekeeping (подсказывает LLM выполнить сжатие)
 */
import { z } from "zod";
import { createMod } from "../core/mod-builder.js";
import { PromptBuilder } from "../core/prompt-style.js";
import type { ContributionItem } from "../core/types.js";
import { readModState, section } from "../core/types.js";
import { safeDisplayName } from "../graph/display.js";
import type { FactAttrs } from "../graph/entities.js";
import { hasObligation, OBLIGATION_THRESHOLDS } from "../pressure/signal-decay.js";
import {
  factRetrievabilityFromNode,
  getContactFacts,
  normalizeFactContent,
} from "./relationships.mod.js";

// -- Константы ---------------------------------------------------------------

/** Минимальное количество угасающих фактов для одного сжатия. */
const MIN_FADING_FACTS = 3;
/** Stability сводного факта, создаваемого после сжатия. */
const CONSOLIDATED_STABILITY = 2.0;
/** Порог угасания (согласован с relationships.mod). */
const FORGET_THRESHOLD = 0.2;

// -- Состояние Mod -----------------------------------------------------------

interface ConsolidationState {
  /** Тик последней проверки сжатия. */
  lastCheckTick: number;
  /** Количество выполненных сжатий. */
  consolidationCount: number;
}

// -- Вспомогательное ---------------------------------------------------------

/** Fading fact entry with node ID and attributes. */
interface FadingFact {
  id: string;
  attrs: FactAttrs;
}

/**
 * Собирает из графа факты, пригодные для сжатия (узлы fact с R < FORGET_THRESHOLD).
 * Обходит всех knows-соседей контактов, возвращает маппинг { contactId → fadingFacts[] }.
 */
function collectFadingFactsFromGraph(
  graph: Parameters<typeof getContactFacts>[0],
  nowMs: number,
): Record<string, FadingFact[]> {
  const result: Record<string, FadingFact[]> = {};
  // обходим источники входящих рёбер узлов fact (то есть knows-рёбра contact/agent → fact)
  for (const iid of graph.getEntitiesByType("fact")) {
    const attrs = graph.getFact(iid);
    // непрерывный спектр стабильности: все факты идут по SM-2, высокостабильные факты (preference S=40)
    // естественно будут угасать очень долго (~3 года полураспада), особых исключений не нужно.
    if (factRetrievabilityFromNode(attrs, nowMs) < FORGET_THRESHOLD) {
      // находим исходный узел knows-ребра (contact/agent)
      const sources = graph.getPredecessors(iid, "knows");
      for (const src of sources) {
        if (!result[src]) result[src] = [];
        result[src].push({ id: iid, attrs });
      }
    }
  }
  // фильтрация: помечать только если не менее MIN_FADING_FACTS
  for (const key of Object.keys(result)) {
    if (result[key].length < MIN_FADING_FACTS) {
      delete result[key];
    }
  }
  return result;
}

// -- Определение Mod ---------------------------------------------------------

export const consolidationMod = createMod<ConsolidationState>("consolidation", {
  category: "mechanic",
  description: "M4 сжатие памяти — угасающие факты сливаются в обобщённую сводку",
  depends: ["relationships"],
  topics: ["memory"],
  initialState: { lastCheckTick: 0, consolidationCount: 0 },
})
  /**
   * Вызывается после генерации сводки LLM, атомарно заменяет угасающие факты.
   *
   * Процесс:
   * 1. Удаляет указанные узлы fact из графа
   * 2. Создаёт новый узел сводного факта (stability = CONSOLIDATED_STABILITY)
   */
  .instruction("consolidate_facts", {
    params: z.object({
      contactId: z.string().min(1).describe("ID контакта"),
      summary: z.string().trim().min(1).max(2000).describe("Текст сводки, сгенерированной LLM"),
      original_facts: z
        .array(z.string().min(1))
        .min(1)
        .describe("Список исходных фактов, которые сжимаются (string[])"),
    }),
    description: "Заменяет несколько угасающих фактов одной обобщённой сводкой (атомарная операция)",
    affordance: {
      whenToUse: "Merge fading memories about a contact into a summary",
      whenNotToUse: "When memories are still vivid or fewer than 3 are fading",
      priority: "on-demand",
      category: "memory",
    },
    impl(ctx, args) {
      const contactId = String(args.contactId);
      // Zod z.string().trim().min(1).max(2000) гарантирует непустую trimmed строку
      const summary = String(args.summary);
      // Zod z.array(z.string().min(1)).min(1) гарантирует непустой string[]
      const originalFacts = z.array(z.string()).parse(args.original_facts);

      // получаем факты контакта из графа
      const facts = getContactFacts(ctx.graph, contactId);
      if (facts.length === 0) return { success: false, error: "no facts for contact" };

      // H2: сначала СОБИРАЕМ цели удаления (без мутации графа) — удалим в самом конце, после того
      // как саммари надёжно создано. Иначе сбой addFact/addRelation оставит факты удалёнными
      // без саммари (потеря данных). Конечное состояние идентично, порядок безопаснее.
      const removedContents: string[] = [];
      const toRemove: string[] = [];
      for (const content of originalFacts) {
        const normalized = normalizeFactContent(content);
        const target = facts.find(
          (f) => normalizeFactContent(f.attrs.content ?? "") === normalized,
        );
        if (target) {
          toRemove.push(target.id);
          removedContents.push(content);
        }
      }

      if (removedContents.length === 0) {
        return { success: false, error: "none of the specified facts found" };
      }

      // ADR-104: наследуем source_channel от исходных фактов, участвующих в слиянии
      const inheritedSourceChannel = facts
        .filter((f) =>
          originalFacts.some(
            (c) => normalizeFactContent(c) === normalizeFactContent(f.attrs.content ?? ""),
          ),
        )
        .map((f) => f.attrs.source_channel)
        .find((ch) => ch != null);

      // создаём узел сводного факта
      const iid = `info_${contactId}_consolidated_${ctx.nowMs}`;
      ctx.graph.addFact(iid, {
        content: summary,
        fact_type: "observation",
        importance: 0.5,
        stability: CONSOLIDATED_STABILITY,
        last_access_ms: ctx.nowMs,
        volatility: 0,
        tracked: false,
        created_ms: ctx.nowMs,
        novelty: 1.0,
        reinforcement_count: 1,
        source_contact: contactId,
        source_channel: inheritedSourceChannel,
        source: "consolidation",
      });
      ctx.graph.addRelation(contactId, "knows", iid);
      // H2: саммари создано и связано — теперь безопасно удаляем исходные факты (атомарность отката).
      for (const id of toRemove) ctx.graph.removeEntity(id);
      ctx.state.consolidationCount++;

      return {
        success: true,
        contactId,
        removedCount: removedContents.length,
        summaryStability: CONSOLIDATED_STABILITY,
        totalConsolidations: ctx.state.consolidationCount,
      };
    },
  })
  .contribute((ctx): ContributionItem[] => {
    // ADR-81: gate по давлению — не инжектировать housekeeping-подсказки при срочных directed-сообщениях
    // ADR-124: используем hasObligation вместо pending_directed > 0
    // @see docs/adr/126-obligation-field-decay.md §D6
    const hasUrgentDirected = ctx.graph
      .getEntitiesByType("channel")
      .some((chId) => hasObligation(ctx.graph, chId, ctx.nowMs, OBLIGATION_THRESHOLDS.signal));
    if (hasUrgentDirected) return [];

    const items: ContributionItem[] = [];

    // 1. направление к сжатию угасающих фактов
    // ADR-110: используем nowMs вместо tick
    const fadingByContact = collectFadingFactsFromGraph(ctx.graph, ctx.nowMs);
    if (Object.keys(fadingByContact).length > 0) {
      // ADR-66: убрать раскрытие значений R, заменить естественным языком. Не дублировать имена функций (уже в справочнике).
      const m = new PromptBuilder();
      m.line("Some older memories are getting fuzzy:");
      for (const [contactId, facts] of Object.entries(fadingByContact)) {
        const displayName = safeDisplayName(ctx.graph, contactId);
        m.line(`${displayName}: ${facts.length} fading memories`);
        m.list(facts.slice(0, 5).map((f) => `"${f.attrs.content}"`));
        if (facts.length > 5) {
          m.line(`... and ${facts.length - 5} more`);
        }
      }
      m.line("Merging these into a summary would keep the important parts.");
      items.push(section("memory-housekeeping", m.build(), "Memory maintenance", 35, 50));
    }

    // 2. ADR-94: стратегическая рефлексия — извлечение повторно используемых стратегий из недавних rate_outcome
    // Показываем outcomeHistory наблюдателя, направляем LLM записывать эффективные стратегии через self note.
    // Независимо от угасающих фактов — можно рефлексировать при низком давлении даже без угасающих фактов.
    // @see docs/adr/94-skill-packaging-convergence.md §план-реализации
    const observerState = readModState(ctx, "observer");
    if (observerState?.outcomeHistory && observerState.outcomeHistory.length >= 3) {
      const recent = observerState.outcomeHistory.slice(-5);
      const strategyBuilder = new PromptBuilder();
      strategyBuilder.line("Looking back at recent interactions:");
      for (const r of recent) {
        const ql = r.quality > 0.3 ? "went well" : r.quality < -0.3 ? "didn't land" : "was okay";
        strategyBuilder.line(`${r.target}: ${ql}${r.reason ? ` — ${r.reason}` : ""}`);
      }
      strategyBuilder.line(
        "Notice a pattern? Remember what works (and what doesn't) with each person.",
      );
      items.push(section("strategy-reflection", strategyBuilder.build(), "Reflection", 36, 45));
    }

    return items;
  })
  .build();
