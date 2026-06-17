/**
 * KB note_kb — длина записи знания. Регресс на баг Worki:
 * сводка ~1k символов молча отлетала по старому капу MAX_KB_LENGTH=500
 * (Zod .max(500) → reject ДО impl → ничего не сохранялось, а Алиса думала, что
 * «запомнила»). Кап поднят до 2000, чтобы профиль проекта влезал одной записью.
 *
 * @see src/mods/kb.mod.ts
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAliceDispatcher } from "../src/core/dispatcher.js";
import { closeDb, initDb } from "../src/db/connection.js";
import { ALICE_SELF } from "../src/graph/constants.js";
import { WorldModel } from "../src/graph/world-model.js";
import { kbMod } from "../src/mods/kb.mod.js";
import { relationshipsMod } from "../src/mods/relationships.mod.js";

function createKbDispatcher() {
  const graph = new WorldModel();
  graph.addAgent(ALICE_SELF, { mood_valence: 0, mood_arousal: 0.2 });
  graph.addContact("contact:1", { tier: 150 });
  graph.addChannel("channel:test", { chat_type: "private" });
  const dispatcher = createAliceDispatcher({ graph, mods: [relationshipsMod, kbMod] });
  dispatcher.startTick(100);
  return { dispatcher, graph };
}

function kbFacts(graph: WorldModel) {
  return graph
    .getNeighbors(ALICE_SELF, "knows")
    .map((id) => graph.getFact(id))
    .filter((f) => f?.fact_type === "kb");
}

describe("kb note_kb — длина записи", () => {
  beforeEach(() => initDb(":memory:"));
  afterEach(() => closeDb());

  it("сводка ~1k символов (как у Worki) сохраняется, не отлетает по валидации", () => {
    const { dispatcher, graph } = createKbDispatcher();
    const text = "детали проекта Worki; ".repeat(60).slice(0, 1032);
    expect(text.length).toBe(1032); // ровно как payload, которым она пыталась запомнить Worki
    const result = dispatcher.dispatch("note_kb", { text, topic: "Worki" }) as {
      success: boolean;
      error?: string;
    };
    expect(result.success).toBe(true);
    const facts = kbFacts(graph);
    expect(facts.length).toBe(1);
    expect(String(facts[0]?.content)).toContain("Worki");
  });

  it("слишком длинное (>2000) всё ещё отклоняется Zod — ничего не пишется", () => {
    const { dispatcher, graph } = createKbDispatcher();
    const text = "я".repeat(2001);
    const result = dispatcher.dispatch("note_kb", { text }) as {
      success: boolean;
      error?: string;
    };
    expect(result.success).toBe(false);
    expect(String(result.error)).toContain("text");
    expect(kbFacts(graph).length).toBe(0);
  });

  it("kb-факт получает высокую stability + fact_type kb", () => {
    const { dispatcher, graph } = createKbDispatcher();
    dispatcher.dispatch("note_kb", { text: "по проекту X решили релиз 1 сентября", topic: "X" });
    const facts = kbFacts(graph);
    expect(facts.length).toBe(1);
    expect(facts[0]?.fact_type).toBe("kb");
    expect(Number(facts[0]?.stability)).toBeGreaterThan(1000);
  });
});
