import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as connection from "../src/db/connection.js";
import { episodes } from "../src/db/schema.js";
import { closeEpisodeFromAct, injectResidueContributions } from "../src/engine/episode.js";
import { episodeMod } from "../src/mods/episode.mod.js";

let sqlite: InstanceType<typeof Database>;
let db: ReturnType<typeof drizzle>;

beforeEach(() => {
  sqlite = new Database(":memory:");
  db = drizzle(sqlite, { schema: { episodes } });
  sqlite.exec(`
    CREATE TABLE episodes (
      id TEXT PRIMARY KEY,
      tick_start INTEGER NOT NULL,
      tick_end INTEGER,
      target TEXT,
      voice TEXT,
      outcome TEXT,
      pressure_api REAL,
      pressure_dominant TEXT,
      trigger_event TEXT,
      entity_ids TEXT NOT NULL DEFAULT '[]',
      residue TEXT,
      caused_by TEXT,
      consults TEXT,
      resolves TEXT,
      created_ms INTEGER NOT NULL
    );
    CREATE INDEX idx_episodes_tick ON episodes (tick_start);
    CREATE INDEX idx_episodes_target ON episodes (target);
  `);
  vi.spyOn(connection, "getDb").mockReturnValue(db as ReturnType<typeof connection.getDb>);
});

afterEach(() => {
  vi.restoreAllMocks();
  sqlite.close();
});

function insertEpisode(id = "episode:274"): void {
  db.insert(episodes)
    .values({
      id,
      tickStart: 274,
      target: "channel:telegram:274",
      voice: "diligence",
      pressureApi: 1,
      pressureDominant: "p1",
      entityIds: "[]",
      createdMs: Date.now(),
    })
    .run();
}

describe("ADR-274 episode residue cleanup", () => {
  it("llm_failed without explicit residue does not create targetless unfinished residue", () => {
    insertEpisode();

    closeEpisodeFromAct("episode:274", {
      messageSent: false,
      isSilence: false,
      success: false,
      errorCount: 1,
      scriptErrors: 0,
      silenceReason: null,
      engagementOutcome: "llm_failed",
      subcycles: 1,
      durationMs: 10,
      target: "channel:telegram:274",
      tick: 275,
    });

    const row = db
      .select({ outcome: episodes.outcome, residue: episodes.residue })
      .from(episodes)
      .where(eq(episodes.id, "episode:274"))
      .get();

    expect(row?.outcome).toBe("error");
    expect(row?.residue).toBeNull();
  });

  it("explicit LLM residue is still preserved when it names a target", () => {
    insertEpisode("episode:275");

    closeEpisodeFromAct(
      "episode:275",
      {
        messageSent: true,
        isSilence: false,
        success: true,
        errorCount: 0,
        scriptErrors: 0,
        silenceReason: null,
        engagementOutcome: "complete",
        subcycles: 1,
        durationMs: 10,
        target: "channel:telegram:274",
        tick: 276,
      },
      { feeling: "curious", toward: "channel:telegram:-274", reason: "still open" },
    );

    const row = db
      .select({ residue: episodes.residue })
      .from(episodes)
      .where(eq(episodes.id, "episode:275"))
      .get();

    expect(row?.residue).not.toBeNull();
    expect(JSON.parse(row?.residue ?? "{}")).toMatchObject({
      type: "curiosity",
      toward: "channel:telegram:-274",
    });
  });

  it("stored residue does not inject runtime pressure while continuity is untyped", () => {
    const pressures = new Map<string, number>([["channel:telegram:274", 1]]);

    injectResidueContributions(
      [
        {
          episodeId: "episode:276",
          residue: {
            type: "curiosity",
            outcome: "message_sent",
            engagementOutcome: "complete",
            pressure: 0,
            intensity: 1,
            toward: "channel:telegram:274",
            decayHalfLifeMs: 60_000,
            createdMs: Date.now(),
          },
        },
      ],
      pressures,
      Date.now(),
    );

    expect(pressures.get("channel:telegram:274")).toBe(1);
  });

  it("injects a same-target prompt carry-over for explicit unresolved residue", () => {
    const nowMs = Date.now();
    db.insert(episodes)
      .values({
        id: "episode:continuity",
        tickStart: 300,
        tickEnd: 301,
        target: "channel:telegram:274",
        voice: "diligence",
        outcome: "message_sent",
        pressureApi: 1,
        pressureDominant: "p1",
        entityIds: "[]",
        residue: JSON.stringify({
          type: "unresolved_emotion",
          outcome: "message_sent",
          engagementOutcome: "complete",
          pressure: 0,
          intensity: 0.5,
          toward: "channel:telegram:274",
          reason: "the last question still needs a real answer",
          decayHalfLifeMs: 60_000,
          createdMs: nowMs,
        }),
        createdMs: nowMs,
      })
      .run();

    const contribute = episodeMod.contribute;
    expect(contribute).toBeDefined();
    const items = contribute?.({
      graph: {
        has: () => false,
      },
      state: {},
      tick: 301,
      nowMs,
      getModState: (name: string) =>
        name === "relationships" ? { targetNodeId: "channel:telegram:274" } : undefined,
      dispatch: () => undefined,
    } as never);

    expect(items).toHaveLength(1);
    expect(items?.[0]?.key).toBe("conversation-continuity");
    expect(items?.[0]?.lines.join("\n")).toContain("the last question still needs a real answer");
  });

  it("does not inject carry-over across targets or for curiosity residue", () => {
    const nowMs = Date.now();
    db.insert(episodes)
      .values([
        {
          id: "episode:other-target",
          tickStart: 310,
          tickEnd: 311,
          target: "channel:telegram:999",
          voice: "diligence",
          outcome: "message_sent",
          pressureApi: 1,
          pressureDominant: "p1",
          entityIds: "[]",
          residue: JSON.stringify({
            type: "unresolved_emotion",
            toward: "channel:telegram:999",
            reason: "belongs elsewhere",
            createdMs: nowMs,
          }),
          createdMs: nowMs,
        },
        {
          id: "episode:curious",
          tickStart: 312,
          tickEnd: 313,
          target: "channel:telegram:274",
          voice: "diligence",
          outcome: "message_sent",
          pressureApi: 1,
          pressureDominant: "p1",
          entityIds: "[]",
          residue: JSON.stringify({
            type: "curiosity",
            toward: "channel:telegram:274",
            reason: "interesting but not an open thread",
            createdMs: nowMs,
          }),
          createdMs: nowMs + 1,
        },
      ])
      .run();

    const items = episodeMod.contribute?.({
      graph: {
        has: () => false,
      },
      state: {},
      tick: 313,
      nowMs,
      getModState: (name: string) =>
        name === "relationships" ? { targetNodeId: "channel:telegram:274" } : undefined,
      dispatch: () => undefined,
    } as never);

    expect(items).toHaveLength(0);
  });
});
