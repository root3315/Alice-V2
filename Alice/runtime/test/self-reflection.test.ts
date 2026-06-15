/**
 * Self-Reflection Mod — модульные тесты ЧИСТОЙ логики.
 *
 * Покрытие:
 *  - кадэнс периода: dayKey / isoWeekKey / isDailyDue / isWeeklyDue (срабатывает раз за период)
 *  - синтез: synthesizeNotes (приоритет тем, порог паттерна, дневник-fallback)
 *  - кап: дневной/недельный лимит заметок (не лог-дамп)
 *
 * @see src/mods/self-reflection.mod.ts
 */
import { describe, expect, it } from "vitest";
import {
  DAILY_NOTE_CAP,
  dayKey,
  type EmotionResidue,
  isDailyDue,
  isoWeekKey,
  isWeeklyDue,
  type ReflectionSignals,
  runReview,
  synthesizeNotes,
  type TierShift,
  WEEKLY_NOTE_CAP,
} from "../src/mods/self-reflection.mod.js";

const DAY = 24 * 60 * 60_000;
// Среда, 2026-06-17 (UTC) — заведомо середина ISO-недели.
const NOW = Date.parse("2026-06-17T12:00:00Z");

const emptySignals = (): ReflectionSignals => ({ thoughts: [], tierShifts: [], residues: [] });

// ═══════════════════════════════════════════════════════════════════════════
// Кадэнс периода: day-key / week-key gating
// ═══════════════════════════════════════════════════════════════════════════

describe("self-reflection: дневной кадэнс (day-key)", () => {
  it("тот же день → не due (срабатывает раз за сутки)", () => {
    const key = dayKey(NOW);
    expect(isDailyDue(key, NOW)).toBe(false);
    expect(isDailyDue(key, NOW + 60_000)).toBe(false); // через минуту — всё ещё тот же день
  });

  it("сменился день → due", () => {
    const key = dayKey(NOW);
    expect(isDailyDue(key, NOW + DAY)).toBe(true);
  });

  it("пустой ключ (первый запуск) → due", () => {
    expect(isDailyDue("", NOW)).toBe(true);
  });

  it("ключ суток стабилен в пределах дня и меняется на следующий", () => {
    expect(dayKey(NOW)).toBe(dayKey(NOW + 60_000));
    expect(dayKey(NOW)).not.toBe(dayKey(NOW + DAY));
  });
});

describe("self-reflection: недельный кадэнс (ISO week-key)", () => {
  it("та же неделя → не due (срабатывает раз за ISO-неделю)", () => {
    const key = isoWeekKey(NOW);
    expect(isWeeklyDue(key, NOW)).toBe(false);
    expect(isWeeklyDue(key, NOW + DAY)).toBe(false); // следующий день, та же неделя
  });

  it("сменилась неделя → due", () => {
    const key = isoWeekKey(NOW);
    expect(isWeeklyDue(key, NOW + 7 * DAY)).toBe(true);
  });

  it("формат ключа YYYY-Www корректен", () => {
    expect(isoWeekKey(NOW)).toMatch(/^\d{4}-W\d{2}$/);
  });

  it("понедельник и воскресенье одной ISO-недели дают один ключ; следующий понедельник — другой", () => {
    // 2026-06-15 (Пн) … 2026-06-21 (Вс) — одна ISO-неделя; 2026-06-22 (Пн) — следующая.
    const mon = Date.parse("2026-06-15T00:00:00Z");
    const sun = Date.parse("2026-06-21T23:00:00Z");
    const nextMon = Date.parse("2026-06-22T00:00:00Z");
    expect(isoWeekKey(mon)).toBe(isoWeekKey(sun));
    expect(isoWeekKey(mon)).not.toBe(isoWeekKey(nextMon));
  });

  it("ISO-неделя на стыке года считается корректно (2026-01-01 — четверг → W01)", () => {
    expect(isoWeekKey(Date.parse("2026-01-01T12:00:00Z"))).toBe("2026-W01");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Синтез заметок: приоритет тем + пустой вход
// ═══════════════════════════════════════════════════════════════════════════

describe("self-reflection: synthesizeNotes (синтез)", () => {
  it("нет сигналов → пустой массив (молчим, не лог-дамп)", () => {
    expect(synthesizeNotes(emptySignals(), "daily", DAILY_NOTE_CAP)).toEqual([]);
    expect(synthesizeNotes(emptySignals(), "weekly", WEEKLY_NOTE_CAP)).toEqual([]);
  });

  it("сдвиг отношений — высший приоритет; upgrade → «теплее», её голосом", () => {
    const tierShifts: TierShift[] = [
      { name: "Стёпа", direction: "upgrade", changedMs: NOW - 60_000 },
    ];
    const notes = synthesizeNotes({ ...emptySignals(), tierShifts }, "weekly", WEEKLY_NOTE_CAP);
    expect(notes.length).toBe(1);
    expect(notes[0]).toContain("Стёпа");
    expect(notes[0]).toContain("теплее");
    expect(notes[0]).toContain("За эту неделю я заметила");
  });

  it("downgrade → «отдалились»", () => {
    const tierShifts: TierShift[] = [
      { name: "Игорь", direction: "downgrade", changedMs: NOW - 60_000 },
    ];
    const notes = synthesizeNotes({ ...emptySignals(), tierShifts }, "daily", DAILY_NOTE_CAP);
    expect(notes[0]).toContain("отдалились");
  });

  it("повторяющийся эмоциональный паттерн (>=2) → заметка «про себя» даже в daily", () => {
    const residues: EmotionResidue[] = [
      { type: "interrupted", towardName: null, intensity: 0.6, createdMs: NOW - 1000 },
      { type: "interrupted", towardName: null, intensity: 0.7, createdMs: NOW - 2000 },
    ];
    const notes = synthesizeNotes({ ...emptySignals(), residues }, "daily", DAILY_NOTE_CAP);
    expect(notes.length).toBe(1);
    expect(notes[0]).toContain("часто");
    expect(notes[0]).toContain("оборвали"); // interrupted phrase
  });

  it("одиночный эмоциональный след в daily НЕ даёт заметку (порог паттерна), но в weekly — даёт", () => {
    const residues: EmotionResidue[] = [
      { type: "unresolved_emotion", towardName: null, intensity: 0.6, createdMs: NOW - 1000 },
    ];
    expect(synthesizeNotes({ ...emptySignals(), residues }, "daily", DAILY_NOTE_CAP)).toEqual([]);
    const weekly = synthesizeNotes({ ...emptySignals(), residues }, "weekly", WEEKLY_NOTE_CAP);
    expect(weekly.length).toBe(1);
    expect(weekly[0]).not.toContain("часто"); // одиночный — без «часто»
  });

  it("свежая мысль из дневника — fallback, когда есть место в капе", () => {
    const thoughts = [
      { content: "мне было хорошо сегодня вечером", about: null, updatedAt: NOW - 1000 },
    ];
    const notes = synthesizeNotes({ ...emptySignals(), thoughts }, "weekly", WEEKLY_NOTE_CAP);
    expect(notes.length).toBe(1);
    expect(notes[0]).toContain("мне было хорошо");
  });

  it("дедуп сдвига по человеку: последнее направление побеждает", () => {
    const tierShifts: TierShift[] = [
      { name: "Маша", direction: "downgrade", changedMs: NOW - 10 * 60_000 },
      { name: "Маша", direction: "upgrade", changedMs: NOW - 60_000 }, // позже → актуально
    ];
    const notes = synthesizeNotes({ ...emptySignals(), tierShifts }, "weekly", WEEKLY_NOTE_CAP);
    const mashaNotes = notes.filter((n) => n.includes("Маша"));
    expect(mashaNotes.length).toBe(1);
    expect(mashaNotes[0]).toContain("теплее");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Кап заметок за период (не лог-дамп)
// ═══════════════════════════════════════════════════════════════════════════

describe("self-reflection: кап заметок за период", () => {
  const richSignals = (): ReflectionSignals => ({
    tierShifts: [
      { name: "A", direction: "upgrade", changedMs: NOW - 1000 },
      { name: "B", direction: "downgrade", changedMs: NOW - 2000 },
      { name: "C", direction: "upgrade", changedMs: NOW - 3000 },
      { name: "D", direction: "upgrade", changedMs: NOW - 4000 },
    ],
    residues: [
      { type: "interrupted", towardName: null, intensity: 0.6, createdMs: NOW - 1000 },
      { type: "interrupted", towardName: null, intensity: 0.7, createdMs: NOW - 2000 },
    ],
    thoughts: [{ content: "длинная развёрнутая мысль о дне", about: null, updatedAt: NOW - 1000 }],
  });

  it("дневной обзор ограничен DAILY_NOTE_CAP", () => {
    expect(DAILY_NOTE_CAP).toBe(1);
    const notes = synthesizeNotes(richSignals(), "daily", DAILY_NOTE_CAP);
    expect(notes.length).toBe(DAILY_NOTE_CAP);
  });

  it("недельный обзор ограничен WEEKLY_NOTE_CAP (богаче дневного, но всё ещё кап)", () => {
    expect(WEEKLY_NOTE_CAP).toBeGreaterThan(DAILY_NOTE_CAP);
    const notes = synthesizeNotes(richSignals(), "weekly", WEEKLY_NOTE_CAP);
    expect(notes.length).toBe(WEEKLY_NOTE_CAP);
  });

  it("runReview прокидывает синтез под капом scope", () => {
    expect(runReview(richSignals(), "daily", DAILY_NOTE_CAP).notes.length).toBe(DAILY_NOTE_CAP);
    expect(runReview(richSignals(), "weekly", WEEKLY_NOTE_CAP).notes.length).toBe(WEEKLY_NOTE_CAP);
  });

  it("заметок не больше, чем сигналов (нет выдуманного контента)", () => {
    const onlyOneShift: ReflectionSignals = {
      ...emptySignals(),
      tierShifts: [{ name: "X", direction: "upgrade", changedMs: NOW - 1000 }],
    };
    expect(synthesizeNotes(onlyOneShift, "weekly", WEEKLY_NOTE_CAP).length).toBe(1);
  });
});
