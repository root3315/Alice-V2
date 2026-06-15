/**
 * KB Mod — долговечная база знаний Алисы («запомни про проект: …»).
 *
 * Назначение: дать Алисе инструкцию `note_kb`, чтобы зафиксировать устойчивое,
 * НЕ затухающее знание — то, что должно остаться надолго (договорённости по проекту,
 * стабильные факты, решения), в отличие от обычных заметок-наблюдений, которые
 * со временем угасают по кривой забывания и могут быть свёрнуты консолидацией.
 *
 * Хранение: знание сохраняется как обычный узел fact в графе, привязанный к узлу
 * self рёбром "knows" (общее хранилище фактов). За счёт этого:
 *  1. recall и существующие пути чтения находят kb-знания наравне с прочими фактами
 *     (общий retrieval — никакого отдельного дублирующего хранилища);
 *  2. высокая stability + пометка fact_type "kb" → извлекаемость R остаётся высокой,
 *     поэтому fading/consolidation не считают такой факт «угасающим» и не сворачивают его.
 *
 * Принцип честности: мод только фиксирует знание по явной просьбе. Он не меняет
 * голос Алисы и ничего не формулирует за неё — surfacing и ответ остаются за её
 * собственной когницией (через recall / обычную инжекцию self-notes).
 *
 * @see relationships.mod.ts — note() и хранилище узлов fact (рёбра knows)
 * @see recall.mod.ts — общий retrieval поднимает kb-факты вместе с остальными
 * @see consolidation.mod.ts — fading по retrievability; высокая stability защищает kb
 */
import { z } from "zod";

import { createMod } from "../core/mod-builder.js";
import { ALICE_SELF, ensureChannelId } from "../graph/constants.js";
import type { FactAttrs } from "../graph/entities.js";
import { warmEmbeddingOnIngest } from "../llm/embedding-store.js";
import { getEmbeddingConfig } from "../llm/semantic-recall-config.js";
import { getContactFacts, normalizeFactContent } from "./relationships.mod.js";

/**
 * fact_type-метка долговечного знания. Отличает kb-факты от обычных заметок
 * (interest/preference/observation/…) для отображения и защиты от свёртки.
 */
const KB_FACT_TYPE = "kb";

/**
 * Stability долговечного знания. Очень высокая (≫ preference S₀=20): период
 * полураспада исчисляется годами, поэтому retrievability остаётся у потолка и
 * fading/consolidation никогда не помечают kb-факт как «угасающий».
 */
const KB_STABILITY = 100_000;

/** Максимальная длина одной записи знания. */
const MAX_KB_LENGTH = 500;

/** Ёмкость базы знаний (узел self уже держит до 50 обычных фактов; kb добавляет свою квоту). */
const KB_CAPACITY = 60;

/** Module-level счётчик для уникальных ID узлов kb. */
let _kbIdCounter = 0;

function nextKbId(): string {
  return `kb_${_kbIdCounter++}_${Date.now()}`;
}

/** Все kb-факты (привязанные к self), для дедупликации и контроля ёмкости. */
function getKbFacts(
  facts: Array<{ id: string; attrs: FactAttrs }>,
): Array<{ id: string; attrs: FactAttrs }> {
  return facts.filter((f) => f.attrs.fact_type === KB_FACT_TYPE);
}

// biome-ignore lint/complexity/noBannedTypes: Mod без состояния (узлы хранятся в графе)
export const kbMod = createMod<{}>("kb", {
  category: "mechanic",
  description: "Долговечная база знаний — устойчивые, не затухающие факты (kb)",
  depends: ["relationships"],
  topics: ["memory"],
  initialState: {},
})
  .instruction("note_kb", {
    params: z.object({
      text: z
        .string()
        .trim()
        .min(1)
        .max(MAX_KB_LENGTH)
        .describe(
          "Знание, которое нужно сохранить надолго (например 'по проекту X решили делать Y')",
        ),
      topic: z
        .string()
        .trim()
        .max(60)
        .optional()
        .describe("Краткая тема/ярлык (необязательно, например 'проект X')"),
    }),
    perTurnCap: 3,
    description:
      "Запомнить устойчивое знание надолго (не затухает со временем) — для договорённостей, решений, стабильных фактов.",
    examples: ['note_kb({ text: "по проекту Орбита решили релиз 1 сентября", topic: "Орбита" })'],
    affordance: {
      priority: "capability",
      category: "memory",
      whenToUse:
        "When asked to remember durable project knowledge or a decision that must persist ('запомни про проект…')",
      whenNotToUse: "For fleeting observations or facts about a single contact (use note instead)",
    },
    impl(ctx, args) {
      // Zod .trim().min(1).max(MAX_KB_LENGTH) гарантирует непустую обрезанную строку.
      const body = String(args.text);
      const topic = args.topic ? String(args.topic).trim() : "";
      // Тема (если есть) встраивается в содержимое как префикс — это улучшает
      // совпадение в recall и читаемость при инжекции self-notes.
      const content = topic ? `[${topic}] ${body}` : body;

      // ADR-104: канал-источник выводим из текущей цели — для scope-аудита,
      // но kb-знание считается общим (recall показывает его везде).
      const relState = ctx.getModState<{ targetNodeId: string | null }>("relationships");
      const targetNode = relState?.targetNodeId ?? null;
      const sourceChannel = targetNode ? (ensureChannelId(targetNode) ?? targetNode) : undefined;

      // Дедупликация (нестрогая: lowercase + collapse whitespace) среди kb-фактов self.
      const selfFacts = ctx.graph.has(ALICE_SELF) ? getContactFacts(ctx.graph, ALICE_SELF) : [];
      const normalized = normalizeFactContent(content);
      const kbFacts = getKbFacts(selfFacts);
      const existing = kbFacts.find(
        (f) => normalizeFactContent(f.attrs.content ?? "") === normalized,
      );
      if (existing) {
        // Повторная фиксация → освежаем доступ (last_access), stability и так у потолка.
        ctx.graph.updateFact(existing.id, {
          last_access_ms: ctx.nowMs,
          stability: KB_STABILITY,
          reinforcement_count: (existing.attrs.reinforcement_count ?? 1) + 1,
        });
        return {
          success: true,
          isDuplicate: true,
          reinforced: true,
          kbCount: kbFacts.length,
        };
      }

      // self-узел обязателен (kb привязывается к нему). Если его нет — мягкая ошибка.
      if (!ctx.graph.has(ALICE_SELF)) {
        return { success: false, error: "self node missing — cannot store knowledge" };
      }

      const id = nextKbId();
      ctx.graph.addFact(id, {
        content,
        fact_type: KB_FACT_TYPE,
        importance: 0.9, // знание базы — высоко значимо
        stability: KB_STABILITY,
        last_access_ms: ctx.nowMs,
        volatility: 0,
        tracked: false,
        created_ms: ctx.nowMs,
        novelty: 1.0,
        reinforcement_count: 1,
        source_contact: ALICE_SELF,
        source_channel: sourceChannel,
        source: "llm",
        // нейтральное знание — без эмоциональной реактивности.
      });
      ctx.graph.addRelation(ALICE_SELF, "knows", id);

      // Семантическая память (ADDITIVE): фоновый прогрев эмбеддинга нового знания.
      // No-op при отключённых эмбеддингах; никогда не блокирует/не бросает.
      warmEmbeddingOnIngest(content, getEmbeddingConfig(), ctx.nowMs);

      // Контроль ёмкости: при превышении вытесняем самый старый kb-факт.
      // (R у всех kb одинаково высок, поэтому критерий — возраст по last_access.)
      const after = getKbFacts(getContactFacts(ctx.graph, ALICE_SELF));
      if (after.length > KB_CAPACITY) {
        let oldestIdx = 0;
        let oldestAccess = Number.MAX_VALUE;
        for (let i = 0; i < after.length; i++) {
          const acc = after[i].attrs.last_access_ms ?? 0;
          if (acc < oldestAccess) {
            oldestAccess = acc;
            oldestIdx = i;
          }
        }
        ctx.graph.removeEntity(after[oldestIdx].id);
      }

      return {
        success: true,
        isDuplicate: false,
        kbCount: Math.min(after.length, KB_CAPACITY),
      };
    },
  })
  .build();
