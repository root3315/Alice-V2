/**
 * Self-Reflection Mod — периодическая АВТОБИОГРАФИЧЕСКАЯ дуга (тихий внутренний обзор).
 *
 * ЗАЧЕМ: metacognition.mod рефлексирует РЕАКТИВНО — на одно свежее значимое событие (троттл).
 * Сквозной линии «что я заметила за эту неделю — про людей и про себя» у неё нет. Этот мод даёт
 * тихий регулярный обзор, создающий НЕПРЕРЫВНОСТЬ-Я во времени: раз в сутки (на смене дня, в
 * простое/при низком давлении) и раз в ISO-неделю она КОНСОЛИДИРУЕТ недавние сигналы в НЕСКОЛЬКО
 * долговечных автобиографических заметок ЕЁ голосом («за эту неделю со Стёпой стало теплее…»,
 * «я чаще злюсь, когда меня перебивают»).
 *
 * ЭТО ВНУТРЕННЕЕ/ИНТРОСПЕКТИВНОЕ — питает её СОБСТВЕННУЮ память/контекст (как metacognition), а НЕ
 * отчёт владельцу. digest.mod — owner-facing дневная сводка в личку; здесь НИЧЕГО не отправляется,
 * нет новых «уст»/send. Заметки складываются в ТУ ЖЕ долговечную KB (fact_type "kb" на self, как
 * kb.mod / exploration.mod) → её обычные пути recall/self-notes поднимают их сами. Голос/личность
 * не трогаем: мод лишь ФИКСИРУЕТ наблюдения в память, surfacing и реакция — её собственная когниция.
 *
 * АРХИТЕКТУРА (зеркалит digest/exploration):
 *  - contribute() СТРОГО ЧИСТЫЙ (возвращает []) — мод ничего не инжектит в prompt: это внутренняя
 *    память, а не новый блок контекста. ВСЕ мутации — в onTickEnd.
 *  - Кадэнс через ключи периода в state (lastDayKey / lastWeekKey) — как exploration.joinDayKey:
 *    фиксируется один раз за период и переживает рестарты (заметка за день/неделю не дублируется).
 *
 * КОНСЕРВАТИВНО: ~1 дневная заметка/сутки + чуть более богатый недельный синтез (кап заметок за
 * период). Не лог-дамп. Если сигналов нет — молчим (ничего не пишем).
 *
 * @see metacognition.mod.ts — реактивная рефлексия на одно событие (этот мод — периодический синтез)
 * @see digest.mod.ts — owner-facing дневная сводка (НЕ дублируем; здесь internal-only)
 * @see kb.mod.ts / exploration.mod.ts — долговечное KB-хранилище (fact_type "kb" на self)
 * @see diary.mod.ts — рабочая память (источник недавних мыслей)
 * @see episode.mod.ts — когнитивные эпизоды (источник эмоциональных следов)
 */
import { desc } from "drizzle-orm";

import { createMod } from "../core/mod-builder.js";
import type { ContributionItem } from "../core/types.js";
import { readPressureApi } from "../core/types.js";
import { getDb } from "../db/connection.js";
import { episodes } from "../db/schema.js";
import { ALICE_SELF } from "../graph/constants.js";
import type { WorldModel } from "../graph/world-model.js";
import { createLogger } from "../utils/logger.js";
import { getContactFacts, normalizeFactContent } from "./relationships.mod.js";

const log = createLogger("self-reflection");

// ── KB-хранилище (та же воронка, что kb.mod / exploration.mod) ─────────────────

/** fact_type долговечного знания — общий с kb.mod (единый retrieval/recall, защита от свёртки). */
const KB_FACT_TYPE = "kb";
/** Очень высокая stability (как kb.mod): R у потолка, fading/consolidation не сворачивают. */
const KB_STABILITY = 100_000;
/** Максимальная длина одной автобиографической заметки. */
const MAX_NOTE_LEN = 280;
/** Ярлык-тема для автобиографических заметок (помогает recall и читаемости self-notes). */
const SELF_TOPIC = "о себе";
/** Module-level счётчик уникальных id KB-узлов саморефлексии. */
let _srIdCounter = 0;

// ── Параметры поведения (консервативные) ──────────────────────────────────────

/** Кап заметок за дневной обзор (не лог-дамп). */
export const DAILY_NOTE_CAP = 1;
/** Кап заметок за недельный обзор (чуть богаче дневного). */
export const WEEKLY_NOTE_CAP = 3;
/** Окно «недавнего» для дневного обзора (мс). */
const DAILY_WINDOW_MS = 24 * 60 * 60_000;
/** Окно «недавнего» для недельного обзора (мс). */
const WEEKLY_WINDOW_MS = 7 * 24 * 60 * 60_000;
/** Порог давления: при «занятости» (активная переписка) обзор не делаем — это тихий момент. */
const PRESSURE_GATE = 0.5;
/** Сколько последних эпизодов сканируем на эмоциональные следы. */
const EPISODE_SCAN_LIMIT = 40;

// ── Чистые типы сигналов/обзора ───────────────────────────────────────────────

/** Недавняя мысль из дневника (минимальная форма для чистого синтеза). */
export interface RecentThought {
  content: string;
  about: string | null;
  updatedAt: number;
}

/** Сдвиг tier у контакта в окне обзора (потеплело/похолодало). */
export interface TierShift {
  name: string;
  direction: "upgrade" | "downgrade";
  changedMs: number;
}

/** Эмоциональный след эпизода в окне обзора. */
export interface EmotionResidue {
  type: string;
  towardName: string | null;
  intensity: number;
  createdMs: number;
}

/** Сырые сигналы для синтеза (всё read-only, собирается в onTickEnd, передаётся в ЧИСТУЮ функцию). */
export interface ReflectionSignals {
  thoughts: RecentThought[];
  tierShifts: TierShift[];
  residues: EmotionResidue[];
}

// ── ЧИСТЫЕ функции кадэнса периода (тестируемые) ───────────────────────────────

/** Ключ суток (UTC, YYYY-MM-DD) — как exploration.dayKey. */
export function dayKey(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

/**
 * Ключ ISO-недели (UTC), формат "YYYY-Www". ЧИСТАЯ. ISO-8601: неделя начинается с понедельника,
 * неделя 1 — содержащая первый четверг года.
 */
export function isoWeekKey(nowMs: number): string {
  // Работаем в UTC, чтобы ключ был стабилен независимо от часового пояса процесса.
  const d = new Date(Date.UTC(
    new Date(nowMs).getUTCFullYear(),
    new Date(nowMs).getUTCMonth(),
    new Date(nowMs).getUTCDate(),
  ));
  // ISO: четверг этой недели определяет год. day 1=Пн … 7=Вс.
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const year = d.getUTCFullYear();
  const yearStart = Date.UTC(year, 0, 1);
  const week = Math.ceil(((d.getTime() - yearStart) / 86_400_000 + 1) / 7);
  return `${year}-W${String(week).padStart(2, "0")}`;
}

/** ЧИСТЫЙ гейт дневного обзора: сменился ли день относительно state.lastDayKey. */
export function isDailyDue(lastDayKey: string, nowMs: number): boolean {
  return dayKey(nowMs) !== lastDayKey;
}

/** ЧИСТЫЙ гейт недельного обзора: сменилась ли ISO-неделя относительно state.lastWeekKey. */
export function isWeeklyDue(lastWeekKey: string, nowMs: number): boolean {
  return isoWeekKey(nowMs) !== lastWeekKey;
}

// ── ЧИСТАЯ функция синтеза автобиографических заметок ──────────────────────────

/** Человекочитаемая метка эмоционального следа (её голосом). */
function residuePhrase(type: string): string {
  switch (type) {
    case "unresolved_emotion":
      return "что-то осталось эмоционально незакрытым";
    case "unfinished":
      return "осталось ощущение незавершённого";
    case "interrupted":
      return "меня будто оборвали на полуслове";
    case "curiosity":
      return "осталось любопытство, хочется вернуться";
    default:
      return "остался след";
  }
}

/**
 * ЧИСТАЯ функция: из сырых сигналов собирает НЕСКОЛЬКО durable автобиографических заметок
 * ЕЁ голосом, упорядоченных по значимости, и обрезает по капу периода. Если сигналов нет —
 * пустой массив (молчим). Ничего не мутирует.
 *
 * Приоритет тем (что даёт настоящую сквозную линию «про людей и про себя»):
 *   1. сдвиги отношений (потеплело/похолодало с конкретным человеком) — самый «автобиографичный»;
 *   2. повторяющийся эмоциональный паттерн (что чаще оставляет след — «про себя»);
 *   3. одна свежая значимая мысль из дневника (если место в капе ещё осталось).
 */
export function synthesizeNotes(
  signals: ReflectionSignals,
  scope: "daily" | "weekly",
  cap: number,
): string[] {
  const notes: string[] = [];
  const prefix = scope === "weekly" ? "За эту неделю я заметила" : "За сегодня я заметила";

  // 1. Сдвиги отношений — берём самые свежие, дедуп по человеку (последнее направление важнее).
  const byPerson = new Map<string, TierShift>();
  for (const s of [...signals.tierShifts].sort((a, b) => a.changedMs - b.changedMs)) {
    byPerson.set(s.name, s); // более поздний перезапишет — остаётся актуальное направление
  }
  const shifts = [...byPerson.values()].sort((a, b) => b.changedMs - a.changedMs);
  for (const s of shifts) {
    const dir = s.direction === "upgrade" ? "стало теплее" : "будто отдалились";
    notes.push(trimNote(`${prefix}, что с ${s.name} ${dir}.`));
    if (notes.length >= cap) return notes;
  }

  // 2. Повторяющийся эмоциональный паттерн — «про себя» (что чаще оставляет след).
  if (signals.residues.length > 0) {
    const counts = new Map<string, number>();
    for (const r of signals.residues) counts.set(r.type, (counts.get(r.type) ?? 0) + 1);
    const [topType, topCount] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    // Паттерн заслуживает заметки, если повторился (>=2) ИЛИ это недельный, более вдумчивый обзор.
    if (topCount >= 2 || scope === "weekly") {
      const often = topCount >= 2 ? "часто " : "";
      notes.push(trimNote(`${prefix}, что у меня ${often}${residuePhrase(topType)}.`));
      if (notes.length >= cap) return notes;
    }
  }

  // 3. Одна свежая значимая мысль из дневника (самая недавняя) — если место ещё есть.
  if (signals.thoughts.length > 0) {
    const latest = [...signals.thoughts].sort((a, b) => b.updatedAt - a.updatedAt)[0];
    const body = latest.content.trim();
    if (body.length >= 8) {
      notes.push(trimNote(`${prefix}, что думаю про это: ${body}`));
    }
  }

  return notes.slice(0, cap);
}

/** Обрезать заметку до MAX_NOTE_LEN (без жёсткой валидации — мягко, как diary/kb). */
function trimNote(s: string): string {
  const t = s.trim();
  return t.length > MAX_NOTE_LEN ? t.slice(0, MAX_NOTE_LEN) : t;
}

// ── Сбор сырых сигналов (read-only; в onTickEnd) ──────────────────────────────

/** Недавние мысли из diary.state (read-only, cross-mod). */
function collectThoughts(
  diaryState: { thoughts?: Array<{ content?: string; about?: string | null; updatedAt?: number }> } | undefined,
  windowStartMs: number,
): RecentThought[] {
  const raw = diaryState?.thoughts ?? [];
  const out: RecentThought[] = [];
  for (const t of raw) {
    const content = (t.content ?? "").trim();
    const updatedAt = t.updatedAt ?? 0;
    if (content.length < 8) continue;
    if (updatedAt < windowStartMs) continue;
    out.push({ content, about: t.about ?? null, updatedAt });
  }
  return out;
}

/** Сдвиги tier среди контактов в окне обзора (read-only из графа). */
function collectTierShifts(graph: WorldModel, windowStartMs: number): TierShift[] {
  const out: TierShift[] = [];
  for (const id of graph.getEntitiesByType("contact")) {
    let attrs: ReturnType<WorldModel["getContact"]>;
    try {
      attrs = graph.getContact(id);
    } catch {
      continue;
    }
    if (attrs.is_bot) continue; // про себя/ботов не пишем автобиографию
    const changedMs = attrs.tier_changed_ms ?? 0;
    const direction = attrs.tier_direction;
    if (!direction || changedMs < windowStartMs) continue;
    const name = attrs.display_name ?? id;
    out.push({ name, direction, changedMs });
  }
  return out;
}

/** Эмоциональные следы недавних эпизодов в окне обзора (read-only из DB). */
function collectResidues(graph: WorldModel, nowMs: number, windowStartMs: number): EmotionResidue[] {
  let rows: Array<{ residue: string | null; target: string | null; createdMs: number }>;
  try {
    rows = getDb()
      .select({
        residue: episodes.residue,
        target: episodes.target,
        createdMs: episodes.createdMs,
      })
      .from(episodes)
      .orderBy(desc(episodes.createdMs))
      .limit(EPISODE_SCAN_LIMIT)
      .all();
  } catch {
    return [];
  }
  const out: EmotionResidue[] = [];
  for (const row of rows) {
    if (row.createdMs < windowStartMs) continue;
    if (!row.residue) continue;
    let parsed: { type?: string; toward?: string | null; intensity?: number } | null;
    try {
      const p = JSON.parse(row.residue) as unknown;
      parsed = p && typeof p === "object" && !Array.isArray(p) ? p : null;
    } catch {
      parsed = null;
    }
    if (!parsed?.type) continue;
    const towardId = parsed.toward ?? row.target ?? null;
    const towardName =
      towardId && graph.has(towardId)
        ? String(graph.getDynamic(towardId, "display_name") ?? towardId)
        : null;
    out.push({
      type: parsed.type,
      towardName,
      intensity: typeof parsed.intensity === "number" ? parsed.intensity : 0,
      createdMs: row.createdMs,
    });
  }
  return out;
}

/**
 * Складывает автобиографическую заметку в долговечную память (KB) — ТА ЖЕ воронка, что note_kb
 * (kb.mod) и ingestChannelKb (exploration.mod): fact-узел на self, высокая stability, fact_type
 * "kb", нестрогая дедупликация. Возвращает true если новый факт записан.
 */
function storeNote(graph: WorldModel, note: string, nowMs: number): boolean {
  const body = note.trim().slice(0, MAX_NOTE_LEN);
  if (body.length < 8) return false;
  if (!graph.has(ALICE_SELF)) return false;
  const content = `[${SELF_TOPIC}] ${body}`;

  const normalized = normalizeFactContent(content);
  const selfFacts = getContactFacts(graph, ALICE_SELF).filter(
    (f) => f.attrs.fact_type === KB_FACT_TYPE,
  );
  const dup = selfFacts.find((f) => normalizeFactContent(f.attrs.content ?? "") === normalized);
  if (dup) {
    graph.updateFact(dup.id, {
      last_access_ms: nowMs,
      stability: KB_STABILITY,
      reinforcement_count: (dup.attrs.reinforcement_count ?? 1) + 1,
    });
    return false;
  }

  const id = `sr_${_srIdCounter++}_${nowMs}`;
  graph.addFact(id, {
    content,
    fact_type: KB_FACT_TYPE,
    importance: 0.8,
    stability: KB_STABILITY,
    last_access_ms: nowMs,
    volatility: 0,
    tracked: false,
    created_ms: nowMs,
    novelty: 1.0,
    reinforcement_count: 1,
    source_contact: ALICE_SELF,
    source: "perceive", // авто-консолидация из её же сигналов (интроспекция, не активная запись LLM)
  });
  graph.addRelation(ALICE_SELF, "knows", id);
  return true;
}

// ── Состояние мода ────────────────────────────────────────────────────────────

interface SelfReflectionState {
  /** Ключ суток последнего дневного обзора (персист → один раз за сутки, переживает рестарт). */
  lastDayKey: string;
  /** Ключ ISO-недели последнего недельного обзора (персист → один раз за неделю). */
  lastWeekKey: string;
}

// ── ЧИСТАЯ оркестрация обзора (тестируемая, без I/O) ──────────────────────────

/**
 * ЧИСТОЕ ядро одного обзора: из сигналов синтезирует заметки и решает, обновлять ли ключ периода.
 * Ключ периода двигаем ВСЕГДА (когда обзор был due) — даже если заметок нет: следующий обзор ровно
 * в следующем периоде, без повторов в этом. Возвращает заметки для записи + флаг сдвига ключа.
 */
export function runReview(
  signals: ReflectionSignals,
  scope: "daily" | "weekly",
  cap: number,
): { notes: string[] } {
  return { notes: synthesizeNotes(signals, scope, cap) };
}

// ── Определение мода ───────────────────────────────────────────────────────────

export const selfReflectionMod = createMod<SelfReflectionState>("self-reflection", {
  category: "mechanic",
  description:
    "Периодическая автобиографическая дуга: раз в сутки/неделю тихо консолидирует недавние сигналы (мысли, эмоциональные следы, сдвиги отношений) в несколько durable заметок её голосом — внутренняя непрерывность-Я (питает память, не отчёт владельцу)",
  depends: ["relationships"],
  topics: ["memory"],
  initialState: { lastDayKey: "", lastWeekKey: "" },
})
  // contribute — СТРОГО ЧИСТЫЙ no-op: мод ничего не инжектит в prompt. Это внутренняя память:
  // заметки складываются в KB (onTickEnd) и поднимаются её обычными путями recall/self-notes.
  .contribute((): ContributionItem[] => [])
  // Жизненный цикл (ВСЕ мутации) — кадэнс по ключам периода + тихий гейт + синтез + запись в KB.
  .onTickEnd((ctx) => {
    const now = ctx.nowMs;

    // Первый запуск (пустые ключи) — НЕ делаем обзор сразу, лишь привязываем текущий период,
    // чтобы первый реальный обзор случился на следующей смене дня/недели (даём периоду накопиться).
    if (ctx.state.lastDayKey === "") ctx.state.lastDayKey = dayKey(now);
    if (ctx.state.lastWeekKey === "") ctx.state.lastWeekKey = isoWeekKey(now);

    const dailyDue = isDailyDue(ctx.state.lastDayKey, now);
    const weeklyDue = isWeeklyDue(ctx.state.lastWeekKey, now);
    if (!dailyDue && !weeklyDue) return; // не пора — молчим

    // Тихий момент: при активной переписке обзор откладываем (ключ НЕ двигаем — попробуем позже,
    // но всё ещё в этом же периоде). Это «тихий внутренний обзор», не во время диалога.
    if (readPressureApi(ctx) > PRESSURE_GATE) return;

    // Недельный обзор «поглощает» дневной в тот же тик (богаче окно/кап) — без двойной записи.
    const scope: "daily" | "weekly" = weeklyDue ? "weekly" : "daily";
    const cap = scope === "weekly" ? WEEKLY_NOTE_CAP : DAILY_NOTE_CAP;
    const windowMs = scope === "weekly" ? WEEKLY_WINDOW_MS : DAILY_WINDOW_MS;
    const windowStartMs = now - windowMs;

    // Сбор сырых сигналов (read-only).
    const diaryState = ctx.getModState<{
      thoughts?: Array<{ content?: string; about?: string | null; updatedAt?: number }>;
    }>("diary");
    const signals: ReflectionSignals = {
      thoughts: collectThoughts(diaryState, windowStartMs),
      tierShifts: collectTierShifts(ctx.graph, windowStartMs),
      residues: collectResidues(ctx.graph, now, windowStartMs),
    };

    const { notes } = runReview(signals, scope, cap);

    // Двигаем ключи периода ВНЕ зависимости от наполненности (обзор «состоялся» в этом периоде).
    // Недельный due также закрывает дневной (тот же тихий момент).
    if (weeklyDue) {
      ctx.state.lastWeekKey = isoWeekKey(now);
      ctx.state.lastDayKey = dayKey(now);
    } else {
      ctx.state.lastDayKey = dayKey(now);
    }

    if (notes.length === 0) {
      log.info("self-reflection: обзор пустой — нечего консолидировать", { scope });
      return;
    }

    let written = 0;
    for (const note of notes) {
      if (storeNote(ctx.graph, note, now)) written++;
    }
    log.info("self-reflection: автобиографический обзор записан", {
      scope,
      synthesized: notes.length,
      written,
    });
  })
  .build();
