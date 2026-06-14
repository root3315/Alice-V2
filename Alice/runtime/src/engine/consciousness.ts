/**
 * ADR-204: Основной конвейер потока сознания.
 *
 * emit() сохраняет событие → surface() всплывает в prompt → reinforce() замыкает петлю обратной связи.
 * Все функции — чистые DB-операции, без побочных эффектов Telegram / LLM.
 *
 * @see docs/adr/204-consciousness-stream/
 */
import { and, desc, gt, like, lt, sql } from "drizzle-orm";
import { consciousnessEvents } from "../db/schema.js";
import { activationRetrieval } from "../graph/activation.js";
import type { WorldModel } from "../graph/world-model.js";

/** Нестрогий псевдоним возвращаемого типа getDb() (во избежание несовместимости дженериков drizzle). */
// biome-ignore lint/suspicious/noExplicitAny: drizzle schema generic variance
type Db = any;

// ── ADR-210: voice → Человекочитаемое отображение эмоций ──────────────────────────────────────

/** Имя voice → понятное человеку описание эмоции/намерения (для summary потока сознания). */
const VOICE_FEELING: Record<string, string> = {
  diligence: "felt responsible",
  curiosity: "got curious",
  sociability: "felt like chatting",
  caution: "held back a bit",
};

// ── Типы ────────────────────────────────────────────────────────────────────

/** Записываемое событие (аргумент emit). */
export interface CEvent {
  kind: string;
  entityIds: string[];
  summary: string;
  salience?: number;
  expandHint?: string;
}

/** Всплывающий указатель (возвращаемый surface). */
export interface CPointer {
  id: number;
  kind: string;
  summary: string;
  entityIds: string[];
  salience: number;
  ageMs: number;
}

// ── Таблица правил salience ─────────────────────────────────────────────────────────

const SALIENCE_RULES: [string, number][] = [
  ["evolve:tier", 0.9],
  ["self:feel", 0.8],
  ["self:diary", 0.7],
  ["self:note", 0.6],
  ["tool:", 0.5],
  ["evolve:pressure", 0.4],
  ["irc:send", 0.3],
  ["evolve:enqueue", 0.3],
  ["evolve:silence", 0.2],
];

/** Возвращает salience по умолчанию по префиксу kind. */
export function defaultSalience(kind: string): number {
  for (const [prefix, val] of SALIENCE_RULES) {
    if (kind === prefix || kind.startsWith(prefix)) return val;
  }
  return 0.5;
}

// ── emit ────────────────────────────────────────────────────────────────────

/** INSERT одного события потока сознания. */
export function emit(db: Db, tick: number, timestampMs: number, event: CEvent): void {
  db.insert(consciousnessEvents)
    .values({
      tick,
      timestampMs,
      kind: event.kind,
      entityIds: JSON.stringify(event.entityIds),
      summary: event.summary.slice(0, 500),
      salience: event.salience ?? defaultSalience(event.kind),
      expandHint: event.expandHint ?? null,
    })
    .run();
}

// ── surface ─────────────────────────────────────────────────────────────────

const HALF_LIFE_MS = 30 * 60 * 1000; // Период полураспада 30 минут
const LN2 = Math.LN2;

/**
 * Всплывает наиболее релевантные события потока сознания.
 * score = (salience + entityOverlap) × recency (экспоненциальное затухание с периодом полураспада 30 минут).
 */
export function surface(
  db: Db,
  nowMs: number,
  seedEntityIds: string[],
  limit = 5,
  G?: WorldModel,
): CPointer[] {
  // Получаем события с высоким salience за последние 2 часа (предфильтрация, чтобы снизить вычисления на стороне JS)
  const cutoff = nowMs - 2 * 60 * 60 * 1000;
  const rows = db
    .select()
    .from(consciousnessEvents)
    .where(gt(consciousnessEvents.timestampMs, cutoff))
    .orderBy(desc(consciousnessEvents.timestampMs))
    .limit(50)
    .all();

  if (rows.length === 0) return [];

  const seedSet = new Set(seedEntityIds);

  // C13: Распространяющаяся активация — добавляем высокоактивированные fact-узлы в расширенное начальное множество
  if (G && seedEntityIds.length > 0) {
    try {
      const hits = activationRetrieval(G, seedEntityIds, nowMs);
      for (const hit of hits.slice(0, 10)) {
        seedSet.add(hit.entityId);
      }
    } catch {
      /* Сбой операции с графом не влияет на базовую логику surface */
    }
  }

  interface Row {
    id: number;
    tick: number;
    timestampMs: number;
    kind: string;
    entityIds: string;
    summary: string;
    salience: number;
    expandHint: string | null;
  }
  const scored = (rows as Row[]).map((row) => {
    const ageMs = nowMs - row.timestampMs;
    const recency = Math.exp((-LN2 * ageMs) / HALF_LIFE_MS);

    // entityId overlap bonus: +0.2 per match, max 0.4
    let overlap = 0;
    try {
      const ids: string[] = JSON.parse(row.entityIds);
      for (const id of ids) {
        if (seedSet.has(id)) overlap += 0.2;
      }
    } catch {
      /* malformed JSON → no bonus */
    }
    overlap = Math.min(overlap, 0.4);

    const score = (row.salience + overlap) * recency;
    return { row, score, ageMs };
  });

  scored.sort((a: { score: number }, b: { score: number }) => b.score - a.score);

  // diary.mod является авторитетным рендерером дневника (полный контент + about + форматирование времени),
  // summary из consciousness.mod — деградированная версия; исключаем, чтобы избежать двойного внедрения.
  const filtered = scored.filter(({ row }) => row.kind !== "self:diary");

  return filtered.slice(0, limit).map(({ row, ageMs }: { row: Row; ageMs: number }) => ({
    id: row.id,
    kind: row.kind,
    summary: row.summary,
    entityIds: JSON.parse(row.entityIds) as string[],
    salience: row.salience,
    ageMs,
  }));
}

// ── reinforce ───────────────────────────────────────────────────────────────

/**
 * Усиливает/ослабляет salience последних событий, связанных с указанными сущностями.
 * Возвращает количество затронутых строк.
 */
export function reinforce(db: Db, entityIds: string[], delta: number): number {
  if (entityIds.length === 0 || delta === 0) return 0;

  let affected = 0;
  for (const eid of entityIds) {
    // SQL LIKE для сопоставления ID сущности в JSON-массиве
    const result = db
      .update(consciousnessEvents)
      .set({
        salience: sql`min(1.0, max(0.0, ${consciousnessEvents.salience} + ${delta}))`,
      })
      .where(like(consciousnessEvents.entityIds, `%${eid}%`))
      .run();
    affected += result.changes;
  }
  return affected;
}

// ── gc ──────────────────────────────────────────────────────────────────────

/**
 * Очищает устаревшие события с низким salience. События с высоким salience сохраняются (кристаллизация).
 * Возвращает количество удалённых строк.
 */
export function gc(
  db: Db,
  nowMs: number,
  retentionDays = 7,
  crystallizationThreshold = 0.7,
): number {
  const cutoffMs = nowMs - retentionDays * 24 * 60 * 60 * 1000;
  const result = db
    .delete(consciousnessEvents)
    .where(
      and(
        lt(consciousnessEvents.timestampMs, cutoffMs),
        lt(consciousnessEvents.salience, crystallizationThreshold),
      ),
    )
    .run();
  return result.changes;
}

// ── commitTickEvents — пакетное извлечение событий из решений evolve ─────────────────────────────

/**
 * Извлекает события потока сознания из TickPlan конвейера evolve.
 *
 * Принимает нестрогий тип во избежание циклических зависимостей с внутренними типами evolve.ts —
 * читает только публичные поля: type, target, voice, reason, pressures.API и т.п.
 */
export function commitTickEvents(
  db: Db,
  tick: number,
  nowMs: number,
  plan: {
    type: string;
    target?: string | null;
    voice?: string;
    reason?: string;
    pressures?: { API?: number };
  },
): void {
  if (plan.type === "skip") return;

  const entityIds = plan.target ? [plan.target] : [];

  if (plan.type === "enqueue") {
    emit(db, tick, nowMs, {
      kind: "evolve:enqueue",
      entityIds,
      summary: `${VOICE_FEELING[plan.voice ?? ""] ?? "turned attention"}${plan.target ? ` toward ${plan.target}` : ""}`,
    });
  } else if (plan.type === "silent") {
    emit(db, tick, nowMs, {
      kind: "evolve:silence",
      entityIds,
      summary: plan.reason ?? "chose silence",
    });
  }
  // system1 → treat like enqueue
  else if (plan.type === "system1") {
    emit(db, tick, nowMs, {
      kind: "evolve:enqueue",
      entityIds,
      summary: `something caught attention${plan.target ? ` in ${plan.target}` : ""}`,
    });
  }
}

// ── commitActEvents — пакетное извлечение событий из выполнения act ──────────────────────────────────

/**
 * Извлекает события потока сознания из SubcycleResult потока act.
 *
 * Нестрогий тип: читает только поля fn/type из instructions/actions.
 */
export function commitActEvents(
  db: Db,
  tick: number,
  nowMs: number,
  sub: {
    instructions: Array<{ fn: string; args?: Record<string, unknown> }>;
    actions: Array<{ fn: string; type?: string; args?: Record<string, unknown> }>;
    completedActions?: string[];
  },
  target: string | null,
): void {
  const entityIds = target ? [target] : [];

  for (const inst of sub.instructions) {
    const fn = inst.fn;
    if (fn === "feel") {
      const valence = inst.args?.valence ?? "?";
      const reason = inst.args?.reason ?? "";
      emit(db, tick, nowMs, {
        kind: "self:feel",
        entityIds,
        summary: `felt ${valence}${reason ? `: ${reason}` : ""}`,
      });
    } else if (fn === "diary") {
      const content = String(inst.args?.content ?? "").slice(0, 100);
      emit(db, tick, nowMs, {
        kind: "self:diary",
        entityIds,
        summary: `wrote diary: ${content}`,
      });
    } else if (fn === "note") {
      const fact = String(inst.args?.fact ?? inst.args?.content ?? "").slice(0, 100);
      emit(db, tick, nowMs, {
        kind: "self:note",
        entityIds: inst.args?.contactId ? [String(inst.args.contactId)] : entityIds,
        summary: `remembered: ${fact}`,
      });
    }
  }

  for (const action of sub.actions) {
    if (action.type === "telegram" && action.fn === "send_message") {
      emit(db, tick, nowMs, {
        kind: "irc:send",
        entityIds,
        summary: `replied${target ? ` in ${target}` : ""}`,
      });
    }
  }

  // ADR-204 C11: kind tool:* — события выполнения Skill/shell
  // completedActions поступают из управляющих строк __ALICE_ACTION__ оболочки shell-executor
  if (sub.completedActions && sub.completedActions.length > 0) {
    for (const ca of sub.completedActions) {
      // Формат: "sent:chatId=X:msgId=Y", "downloaded:chatId=X:...", "sent-file:chatId=X:..."
      const kind = ca.startsWith("downloaded:")
        ? "tool:download"
        : ca.startsWith("sent-file:")
          ? "tool:upload"
          : ca.startsWith("sticker:")
            ? "tool:sticker"
            : `tool:${ca.split(":")[0]}`;
      emit(db, tick, nowMs, {
        kind,
        entityIds,
        summary: ca.slice(0, 200),
      });
    }
  }
}
