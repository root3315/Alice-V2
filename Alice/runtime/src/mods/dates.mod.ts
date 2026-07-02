/**
 * Dates Mod — важные даты (дни рождения и т.п.) → тёплое проактивное поздравление её голосом.
 *
 * Идея: кто-то говорит «у Маши день рождения 15 марта» / «14 февраля годовщина». Алиса это
 * фиксирует, и в НУЖНЫЙ день сама, своим голосом, тепло поздравляет/напоминает в том же чате,
 * где узнала. Не робо-открытка: мод лишь поднимает повод (направленное давление + короткий нудж
 * в контекст), а поздравляет она СВОИМИ словами (или молчит, если не к месту).
 *
 * Зеркалит digest / commitment / topic-watch:
 *  - CAPTURE: remember_date / forget_date + запрос important_dates.
 *  - contribute() — ЧИСТЫЙ: нудж только для дат ЭТОГО чата, чей день настал (scope, без утечки).
 *  - onTickEnd — ВСЕ мутации: сверка «сегодня» по локальному времени, направленное давление,
 *    once-per-year (lastGreetedYear), TTL.
 *
 * Честность: мод НЕ формулирует поздравление за неё — только замечает дату и повод. Тон/слова/
 * «стоит ли» — её когниция. Локальный день считаем по timezone_offset (сеттер из index.ts).
 */
import { z } from "zod";

import { createMod } from "../core/mod-builder.js";
import { PromptBuilder } from "../core/prompt-style.js";
import type { ContributionItem } from "../core/types.js";
import { header, readModState } from "../core/types.js";
import { ensureChannelId } from "../graph/constants.js";
import type { WorldModel } from "../graph/world-model.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("dates");

/** Сколько держим «сегодня её день» на виду, пока она не поздравит (мс). */
const PENDING_TTL_MS = 12 * 60 * 60_000; // весь день
const MAX_DATES = 40;
const MAX_WHO_LENGTH = 60;
const MAX_NOTE_LENGTH = 160;

/** Часовой сдвиг для вычисления «сегодня локально». Ставится из index.ts (config.timezoneOffset). */
let _tzOffsetHours = 0;
export function setDatesTimezone(tzOffsetHours: number): void {
  _tzOffsetHours = Number.isFinite(tzOffsetHours) ? tzOffsetHours : 0;
  log.info("dates timezone set", { tzOffsetHours: _tzOffsetHours });
}

/** Локальные {day, month, year} для момента nowMs (UTC-геттеры по сдвинутой дате = локальные значения). */
function localYMD(nowMs: number): { day: number; month: number; year: number } {
  const d = new Date(nowMs + _tzOffsetHours * 3_600_000);
  return { day: d.getUTCDate(), month: d.getUTCMonth() + 1, year: d.getUTCFullYear() };
}

interface ImportantDate {
  id: string;
  /** Чьё/что за событие ('Маша', 'годовщина'). */
  who: string;
  /** День месяца 1..31. */
  day: number;
  /** Месяц 1..12. */
  month: number;
  /** Необязательная пометка ('30 лет', 'любит тюльпаны'). */
  note: string;
  /** Чат, где узнала — туда и поздравим. null → доставки нет. */
  chatId: string | null;
  createdMs: number;
  /** Год последнего поздравления (once-per-year). */
  lastGreetedYear: number;
  pending: boolean;
  directed: boolean;
  pendingSinceMs: number;
}

interface DatesState {
  dates: ImportantDate[];
}

let _idCounter = 0;
function nextDateId(): string {
  return `date_${_idCounter++}_${Date.now()}`;
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

/** Поднять направленное давление на чат (как bumpDirected в digest). true = канал есть. */
function bumpDirected(graph: WorldModel, target: string): boolean {
  try {
    if (graph.has(target)) {
      const cur = Number(
        (graph.getChannel(target) as { pending_directed?: number }).pending_directed ?? 0,
      );
      if (cur <= 0) {
        graph.updateChannel(target, { pending_directed: 1, last_directed_ms: Date.now() });
      }
      return true;
    }
  } catch (err) {
    log.warn("directed bump failed", { target, err: (err as Error).message });
  }
  return false;
}

export const datesMod = createMod<DatesState>("dates", {
  category: "mechanic",
  description:
    "Важные даты: помнит дни рождения/годовщины и в нужный день сама тепло поздравляет своим голосом в том чате, где узнала",
  depends: ["relationships"],
  topics: ["memory"],
  initialState: { dates: [] },
})
  .instruction("remember_date", {
    params: z.object({
      who: z
        .string()
        .trim()
        .min(1)
        .max(MAX_WHO_LENGTH)
        .describe("Чьё событие / что за дата ('Маша', 'годовщина с ним')"),
      day: z.coerce.number().int().min(1).max(31).describe("День месяца (1-31)"),
      month: z.coerce.number().int().min(1).max(12).describe("Месяц (1-12)"),
      note: z
        .string()
        .trim()
        .max(MAX_NOTE_LENGTH)
        .optional()
        .describe("Необязательно: деталь ('30 лет', 'любит тюльпаны')"),
    }),
    perTurnCap: 3,
    description:
      "Запомнить важную дату (день рождения, годовщину), чтобы в нужный день самой тепло поздравить своими словами.",
    examples: [
      'remember_date({ who: "Маша", day: 15, month: 3 })',
      'remember_date({ who: "годовщина", day: 14, month: 2, note: "3 года" })',
    ],
    affordance: {
      priority: "capability",
      category: "memory",
      whenToUse:
        "When someone mentions a birthday or an important recurring date ('у Маши др 15 марта', '14 февраля годовщина') — remember it to warmly greet on the day",
      whenNotToUse:
        "For a one-off timed reminder (schedule_task) or a soft intent to follow up (note_commitment)",
    },
    impl(ctx, args) {
      const who = String(args.who).trim();
      const day = Number(args.day);
      const month = Number(args.month);
      const note = args.note ? String(args.note).trim() : "";

      const relState = readModState(ctx, "relationships");
      const targetNode = relState?.targetNodeId ?? null;
      const chatId = targetNode ? (ensureChannelId(targetNode) ?? targetNode) : null;

      // Дедуп: тот же who + та же дата → обновим note/chatId.
      const dup = ctx.state.dates.find(
        (d) => norm(d.who) === norm(who) && d.day === day && d.month === month,
      );
      if (dup) {
        if (note) dup.note = note;
        if (chatId) dup.chatId = chatId;
        return { success: true, isDuplicate: true, dateId: dup.id };
      }

      const id = nextDateId();
      ctx.state.dates.push({
        id,
        who,
        day,
        month,
        note,
        chatId,
        createdMs: ctx.nowMs,
        lastGreetedYear: 0,
        pending: false,
        directed: false,
        pendingSinceMs: 0,
      });

      if (ctx.state.dates.length > MAX_DATES) {
        ctx.state.dates.sort((a, b) => a.createdMs - b.createdMs);
        ctx.state.dates.shift();
      }

      log.info("date remembered", { who, day, month, chatId });
      return { success: true, isDuplicate: false, dateId: id };
    },
  })
  .instruction("forget_date", {
    params: z.object({
      who: z.string().trim().min(1).max(MAX_WHO_LENGTH).describe("Чью дату забыть"),
    }),
    description: "Забыть важную дату.",
    examples: ['forget_date({ who: "Маша" })'],
    affordance: {
      priority: "capability",
      category: "memory",
      whenToUse: "When asked to forget/remove an important date",
      whenNotToUse: "For anything else",
    },
    impl(ctx, args) {
      const who = norm(String(args.who));
      const before = ctx.state.dates.length;
      ctx.state.dates = ctx.state.dates.filter((d) => norm(d.who) !== who);
      return { success: true, removed: before - ctx.state.dates.length };
    },
  })
  .query("important_dates", {
    params: z.object({}),
    description: "Список важных дат, которые я помню.",
    returns: "{ dates: Array<{who, day, month, note}> }",
    affordance: {
      priority: "capability",
      category: "memory",
      whenToUse: "When asked what birthdays / important dates you remember",
      whenNotToUse: "For unrelated recall",
    },
    impl(ctx) {
      return {
        dates: ctx.state.dates.map((d) => ({
          who: d.who,
          day: d.day,
          month: d.month,
          note: d.note,
        })),
      };
    },
    format(result) {
      const r = result as {
        dates: Array<{ who: string; day: number; month: number; note: string }>;
      };
      const m = new PromptBuilder();
      if (r.dates.length === 0) {
        m.line("Особых дат пока не запомнила.");
        return m.build();
      }
      m.line("Помню даты:");
      m.list(
        r.dates.map(
          (d) => `${d.who} — ${d.day}.${String(d.month).padStart(2, "0")}${d.note ? ` (${d.note})` : ""}`,
        ),
      );
      return m.build();
    },
  })
  // contribute() — ЧИСТЫЙ: нудж только для дат ЭТОГО чата, чей день настал.
  .contribute((ctx): ContributionItem[] => {
    const relState = readModState(ctx, "relationships");
    const targetNode = relState?.targetNodeId ?? null;
    const chatId = targetNode ? (ensureChannelId(targetNode) ?? targetNode) : null;
    if (!chatId) return [];

    const today = ctx.state.dates.filter(
      (d) => d.pending && d.directed && d.chatId === chatId,
    );
    if (today.length === 0) return [];

    const lines = today
      .map((d) => `— ${d.who}${d.note ? ` (${d.note})` : ""}`)
      .join("\n");
    const raw = [
      "## Сегодня важная дата (только для этого чата)",
      "",
      "Сегодня — день, который ты отметила как важный:",
      lines,
      "",
      "Если момент уместный — тепло поздравь/напомни СВОИМИ словами, по-человечески, не шаблоном " +
        "и не робо-открыткой. Если сейчас не к месту — можно и промолчать. В других чатах об этом молчи.",
    ].join("\n");
    return [header(PromptBuilder.fromRaw(raw), 86)];
  })
  // onTickEnd — ВСЕ мутации: сверка «сегодня», направленное давление, once-per-year, TTL.
  .onTickEnd((ctx) => {
    const now = ctx.nowMs;
    const { day, month, year } = localYMD(now);

    for (const d of ctx.state.dates) {
      // 1. Настал её день и в этом году ещё не поздравляла → поднять повод.
      if (!d.pending && d.day === day && d.month === month && d.lastGreetedYear !== year) {
        d.pending = true;
        d.pendingSinceMs = now;
        d.lastGreetedYear = year; // once-per-year: двигаем сразу, повторно не поднимем
        d.directed = false;
      }
      // 2. Пока «сегодня»: держим направленное давление; по TTL (конец дня) снимаем.
      if (d.pending) {
        if (now - d.pendingSinceMs >= PENDING_TTL_MS) {
          d.pending = false;
          d.directed = false;
        } else if (!d.directed && d.chatId) {
          d.directed = bumpDirected(ctx.graph, d.chatId);
        }
      }
    }
  })
  .build();
