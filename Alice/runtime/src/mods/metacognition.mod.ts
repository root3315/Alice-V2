/**
 * Metacognition Mod — слой РЕФЛЕКСИИ (Wave 4, «как живой человек»).
 *
 * consciousness.mod пассивно ВСПЛЫВАЕТ недавние следы (Awareness). Этот мод добавляет активный
 * шаг: на по-настоящему значимое СВЕЖЕЕ событие (высокая salience) Алиса на миг ОСМЫСЛЯЕТ —
 * «что это для меня значит?» — её же голосом, как внутренняя мысль. Не каждый тик (троттл 20 мин —
 * это особый момент), не повторно (дедуп по id события). Личность НЕ трогаем: это лишь контекст
 * в её pipeline; она сама решает, что с этим делать (подумать / записать в дневник / промолчать).
 *
 * ДО: значимое событие просто всплывало в Awareness, она реагировала по ходу.
 * ПОСЛЕ: иногда (на по-настоящему важном) появляется внутренний шаг осмысления → более
 * человеческая, рефлексивная реакция (например, осмысленная запись в дневник вместо простой).
 */
import { createMod } from "../core/mod-builder.js";
import { PromptBuilder } from "../core/prompt-style.js";
import type { ContributionItem } from "../core/types.js";
import { section } from "../core/types.js";
import { getDb } from "../db/connection.js";
import { type CPointer, surface } from "../engine/consciousness.js";

/** Порог значимости события для рефлексии (salience 0..1). */
export const SALIENCE_THRESHOLD = 0.7;
/** Рефлексируем только над СВЕЖИМ событием (мс) — осмысляем то, что только что было. */
export const REFLECT_RECENCY_MS = 12 * 60_000;
/** Мин. пауза между рефлексиями (мс) — это особый момент, не каждый тик. */
export const REFLECT_THROTTLE_MS = 20 * 60_000;
/** Сколько тиков держим рефлексию «на виду» (переживает один тихий/упавший тик). */
const REFLECT_MAX_SHOWS = 2;
/** Кап памяти об уже отрефлексированных событиях (дедуп). */
const REFLECTED_CAP = 50;

interface MetacognitionState {
  /** id событий, над которыми уже рефлексировали (дедуп). */
  reflectedIds: number[];
  /** Когда последний раз рефлексировали (троттл). */
  lastReflectMs: number;
  /** Текущая рефлексия, которую показываем в contribute (null = нет). */
  pending: { summary: string; shown: number } | null;
}

/**
 * ЧИСТАЯ функция выбора события для рефлексии (тестируемая): самое значимое СВЕЖЕЕ НОВОЕ событие
 * выше порога, если троттл прошёл. Иначе null.
 */
export function pickReflection(
  pointers: CPointer[],
  reflectedIds: number[],
  lastReflectMs: number,
  now: number,
): CPointer | null {
  if (now - lastReflectMs < REFLECT_THROTTLE_MS) return null;
  const seen = new Set(reflectedIds);
  const candidates = pointers
    .filter(
      (p) => p.salience >= SALIENCE_THRESHOLD && p.ageMs <= REFLECT_RECENCY_MS && !seen.has(p.id),
    )
    .sort((a, b) => b.salience - a.salience);
  return candidates[0] ?? null;
}

/** Заменить сырые graph-id в summary на display-имена (как consciousness.mod). */
function humanizeSummary(summary: string, graphHas: (id: string) => boolean, name: (id: string) => string): string {
  return summary.replace(/\b(channel|contact):[-\d]+/g, (m) => (graphHas(m) ? name(m) : "(somewhere)"));
}

export const metacognitionMod = createMod<MetacognitionState>("metacognition", {
  category: "mechanic",
  description: "Рефлексия: на значимое недавнее событие — внутренний шаг осмысления (её голосом)",
  topics: ["awareness"],
  initialState: { reflectedIds: [], lastReflectMs: 0, pending: null },
})
  // contribute — ЧИСТЫЙ: только читает pending и отдаёт шаг осмысления.
  .contribute((ctx): ContributionItem[] => {
    const p = ctx.state.pending;
    if (!p) return [];
    const pb = new PromptBuilder();
    pb.line(`Только что было что-то значимое для тебя: «${p.summary}».`);
    pb.line(
      "Притормози на миг — что это для тебя значит? что ты на самом деле по этому поводу " +
        "чувствуешь, к чему это, может, ведёт? Это внутренняя мысль — можешь обдумать или " +
        "записать в дневник; вслух говорить не обязательно.",
    );
    // order=7 → сразу после awareness(6), перед strategy-hints(12)
    return [section("reflection", pb.build(), "Осмысление (внутреннее)", 7, 80)];
  })
  // Жизненный цикл (мутации) — выбор события для рефлексии, троттл, дедуп, TTL показа.
  .onTickEnd((ctx) => {
    const now = ctx.nowMs;

    // Текущую рефлексию показали в contribute этого тика — считаем показы, дропаем после нескольких.
    if (ctx.state.pending) {
      ctx.state.pending.shown += 1;
      if (ctx.state.pending.shown >= REFLECT_MAX_SHOWS) ctx.state.pending = null;
    }
    if (ctx.state.pending) return; // ещё показываем текущую — новую пока не берём

    let pointers: CPointer[];
    try {
      pointers = surface(getDb(), now, [], 10, ctx.graph);
    } catch {
      return;
    }
    const chosen = pickReflection(pointers, ctx.state.reflectedIds, ctx.state.lastReflectMs, now);
    if (!chosen) return;

    const summary = humanizeSummary(
      chosen.summary,
      (id) => ctx.graph.has(id),
      (id) =>
        String(
          ctx.graph.getDynamic(id, "display_name") ?? ctx.graph.getDynamic(id, "title") ?? "(somewhere)",
        ),
    );
    ctx.state.pending = { summary, shown: 0 };
    ctx.state.lastReflectMs = now;
    ctx.state.reflectedIds.push(chosen.id);
    if (ctx.state.reflectedIds.length > REFLECTED_CAP) {
      ctx.state.reflectedIds = ctx.state.reflectedIds.slice(-REFLECTED_CAP);
    }
  })
  .build();
