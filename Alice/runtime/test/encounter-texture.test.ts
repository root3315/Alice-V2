/**
 * Её желание «помнить не факты, а как человек говорил в прошлый раз»: felt-«текстура последней
 * встречи». buildEncounterTexture — ЧИСТАЯ: насколько давно виделись + как было в прошлый раз
 * (её прожитое ощущение из дневника, иначе эмоциональный след). Гендерно-нейтрально.
 *
 * @see src/mods/self-reflection.mod.ts
 */
import { describe, expect, it } from "vitest";
import { buildEncounterTexture } from "../src/mods/self-reflection.mod.js";

describe("buildEncounterTexture", () => {
  it("совсем недавно + прожитое ощущение из дневника вплетается", () => {
    const tx = buildEncounterTexture({
      name: "Степа",
      hoursSince: 2,
      feltThought: "был тёплый и немного уставший, но улыбался",
    });
    expect(tx).toContain("виделись совсем недавно");
    expect(tx).toContain("вот как ты запомнила тот раз: был тёплый и немного уставший");
  });

  it("вчера + эмоциональный след (без мысли) → фраза следа", () => {
    const tx = buildEncounterTexture({ name: "Икс", hoursSince: 30, residueType: "curiosity" });
    expect(tx).toContain("виделись вчера");
    expect(tx).toContain("любопытство"); // residuePhrase("curiosity")
  });

  it("давно не виделись + ничего больше → только насколько давно", () => {
    const tx = buildEncounterTexture({ name: "Зед", hoursSince: 24 * 30 });
    expect(tx).toContain("давно не пересекались");
    expect(tx).not.toContain("запомнила");
  });

  it("несколько дней назад", () => {
    const tx = buildEncounterTexture({ name: "Игрек", hoursSince: 24 * 3 });
    expect(tx).toContain("виделись несколько дней назад");
  });

  it("сегодня (>6ч, <24ч)", () => {
    const tx = buildEncounterTexture({ name: "Кью", hoursSince: 10, residueType: "interrupted" });
    expect(tx).toContain("виделись сегодня");
  });

  it("слишком короткую мысль (<8 символов) не вплетает", () => {
    const tx = buildEncounterTexture({ name: "Эл", hoursSince: 2, feltThought: "ок" });
    expect(tx).toContain("виделись совсем недавно");
    expect(tx).not.toContain("запомнила");
  });
});
