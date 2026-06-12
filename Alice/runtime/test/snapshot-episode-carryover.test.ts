import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDb, getDb, initDb } from "../src/db/connection.js";
import { episodes } from "../src/db/schema.js";
import { ALICE_SELF } from "../src/graph/constants.js";
import { WorldModel } from "../src/graph/world-model.js";
import { buildUserPromptSnapshot } from "../src/prompt/snapshot.js";

describe("ADR-274 episode carry-over prompt boundary", () => {
  beforeEach(() => initDb(":memory:"));
  afterEach(() => closeDb());

  it("does not render stored episode residue into ordinary prompt snapshots", () => {
    const G = new WorldModel();
    G.addAgent(ALICE_SELF);
    G.addContact("contact:telegram:42", { display_name: "Mika" });
    G.addChannel("channel:telegram:42", { chat_type: "private", display_name: "Mika" });

    getDb()
      .insert(episodes)
      .values({
        id: "episode:carry",
        tickStart: 1,
        tickEnd: 2,
        target: "channel:telegram:42",
        voice: "diligence",
        outcome: "message_sent",
        entityIds: JSON.stringify(["contact:telegram:42"]),
        residue: JSON.stringify({
          type: "curiosity",
          outcome: "message_sent",
          engagementOutcome: "complete",
          pressure: 0,
          intensity: 1,
          toward: "contact:telegram:42",
          summary: "stale carry-over should not leak",
          createdMs: Date.now(),
          decayHalfLifeMs: 60_000,
        }),
        createdMs: Date.now(),
      })
      .run();

    const snapshot = buildUserPromptSnapshot({
      G,
      messages: [],
      observations: [],
      item: { action: "conversation", target: "channel:telegram:42", facetId: "core" } as never,
      round: 0,
      board: { maxSteps: 3, contextVars: {} },
      nowMs: Date.now(),
      timezoneOffset: 9,
      chatType: "private",
      isGroup: false,
      isChannel: false,
    });

    expect(snapshot.episodeCarryOver).toBeUndefined();
  });
});
