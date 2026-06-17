/**
 * Приватность recall: мысли дневника НЕ должны всплывать в группе.
 *
 * Дневник — внутренний мир Алисы, но он содержит интим из ЛС (напр. «соскучилась по нему»,
 * about=null). Раньше пул мыслей в recall был глобальным (scope не применялся), и при явном recall
 * в рабочем чате семантически близкая интимная мысль могла всплыть в группе. thoughtVisibleInScope
 * закрывает это: в группе/супергруппе приватные мысли скрыты, в приватном чате доступно всё.
 */
import { describe, expect, it } from "vitest";
import { WorldModel } from "../src/graph/world-model.js";
import { thoughtVisibleInScope } from "../src/mods/recall.mod.js";

const WORK = "channel:telegram:-1003737026444";

describe("thoughtVisibleInScope — приватность мыслей в recall", () => {
  const g = new WorldModel();

  it("приватный чат: доступно всё (не утечка третьим лицам)", () => {
    for (const about of [null, "contact:telegram:5707638365", WORK]) {
      expect(thoughtVisibleInScope(g, about, "channel:telegram:5707638365", "private")).toBe(true);
    }
  });

  it("группа: глобальная мысль (about=null) скрыта — это интимный фон из ЛС", () => {
    expect(thoughtVisibleInScope(g, null, WORK, "group")).toBe(false);
    expect(thoughtVisibleInScope(g, null, WORK, "supergroup")).toBe(false);
  });

  it("группа: мысль о человеке (contact:) скрыта — может быть про ЛС", () => {
    expect(thoughtVisibleInScope(g, "contact:telegram:5707638365", WORK, "supergroup")).toBe(false);
  });

  it("группа: мысль про САМ этот канал — видна", () => {
    expect(thoughtVisibleInScope(g, WORK, WORK, "supergroup")).toBe(true);
  });

  it("неизвестный chat_type трактуется консервативно (как группа) → приватное скрыто", () => {
    expect(thoughtVisibleInScope(g, null, WORK, undefined)).toBe(false);
    expect(thoughtVisibleInScope(g, "contact:telegram:5707638365", WORK, undefined)).toBe(false);
  });
});
