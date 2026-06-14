import { describe, it, expect } from "vitest";
import {
  pickReflection,
  REFLECT_RECENCY_MS,
  REFLECT_THROTTLE_MS,
  SALIENCE_THRESHOLD,
} from "../src/mods/metacognition.mod.js";

const ptr = (id: number, salience: number, ageMs: number) =>
  ({ id, kind: "self:feel", summary: `event ${id}`, entityIds: [], salience, ageMs }) as any;
const NOW = 1_700_000_000_000;
const THROTTLE_OK = NOW - REFLECT_THROTTLE_MS - 1; // троттл прошёл

describe("metacognition: pickReflection (выбор события для осмысления)", () => {
  it("значимое свежее новое событие → выбирается", () => {
    const r = pickReflection([ptr(1, SALIENCE_THRESHOLD + 0.1, 60_000)], [], THROTTLE_OK, NOW);
    expect(r?.id).toBe(1);
  });

  it("низкая salience → не выбирается", () => {
    expect(pickReflection([ptr(1, SALIENCE_THRESHOLD - 0.2, 60_000)], [], THROTTLE_OK, NOW)).toBeNull();
  });

  it("слишком старое событие → не выбирается (осмысляем только свежее)", () => {
    expect(pickReflection([ptr(1, 0.9, REFLECT_RECENCY_MS + 1)], [], THROTTLE_OK, NOW)).toBeNull();
  });

  it("уже рефлексировали (дедуп) → не выбирается", () => {
    expect(pickReflection([ptr(1, 0.9, 60_000)], [1], THROTTLE_OK, NOW)).toBeNull();
  });

  it("в пределах троттла → не выбирается (рефлексия не каждый тик)", () => {
    expect(pickReflection([ptr(1, 0.9, 60_000)], [], NOW - 60_000, NOW)).toBeNull();
  });

  it("несколько кандидатов → берётся самый значимый", () => {
    const r = pickReflection(
      [ptr(1, 0.75, 60_000), ptr(2, 0.95, 60_000), ptr(3, 0.8, 60_000)],
      [],
      THROTTLE_OK,
      NOW,
    );
    expect(r?.id).toBe(2);
  });

  it("нет подходящих → null", () => {
    expect(pickReflection([], [], THROTTLE_OK, NOW)).toBeNull();
  });
});
