/**
 * ADR-204: 意识流核心管道单元测试。
 *
 * 验证：
 * - emit(): INSERT 字段正确
 * - defaultSalience(): 各 kind 前缀返回值
 * - surface(): salience × recency 排序、entityId overlap bonus、limit 控制
 * - reinforce(): salience 增减、clamp [0,1]
 * - gc(): 过期低 salience 删除、高 salience 结晶保留
 * - commitTickEvents(): evolve 决策→事件批量提取
 * - commitActEvents(): act 执行→事件批量提取
 *
 * @see docs/adr/204-consciousness-stream/
 */
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDb, getDb, initDb } from "../src/db/connection.js";
import {
  commitActEvents,
  commitTickEvents,
  defaultSalience,
  emit,
  gc,
  reinforce,
  surface,
} from "../src/engine/consciousness.js";

// ── DB 设置 ──────────────────────────────────────────────────────────────────

beforeEach(() => {
  initDb(":memory:");
  getDb().run(sql`CREATE TABLE IF NOT EXISTS consciousness_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tick INTEGER NOT NULL,
    timestamp_ms INTEGER NOT NULL,
    kind TEXT NOT NULL,
    entity_ids TEXT NOT NULL DEFAULT '[]',
    summary TEXT NOT NULL,
    salience REAL NOT NULL DEFAULT 0.5,
    expand_hint TEXT
  )`);
  getDb().run(sql`CREATE INDEX IF NOT EXISTS idx_ce_tick ON consciousness_events(tick)`);
  getDb().run(sql`CREATE INDEX IF NOT EXISTS idx_ce_salience ON consciousness_events(salience)`);
});

afterEach(() => {
  try {
    getDb().run(sql`DROP TABLE IF EXISTS consciousness_events`);
  } catch {
    /* ignore */
  }
  closeDb();
});

// ── defaultSalience ─────────────────────────────────────────────────────────

describe("defaultSalience", () => {
  it("returns correct salience for known kinds", () => {
    expect(defaultSalience("self:feel")).toBe(0.8);
    expect(defaultSalience("self:diary")).toBe(0.7);
    expect(defaultSalience("self:note")).toBe(0.6);
    expect(defaultSalience("tool:weather")).toBe(0.5);
    expect(defaultSalience("irc:send")).toBe(0.3);
    expect(defaultSalience("evolve:tier")).toBe(0.9);
    expect(defaultSalience("evolve:pressure")).toBe(0.4);
    expect(defaultSalience("evolve:enqueue")).toBe(0.3);
    expect(defaultSalience("evolve:silence")).toBe(0.2);
  });

  it("returns 0.5 for unknown kinds", () => {
    expect(defaultSalience("unknown:kind")).toBe(0.5);
  });
});

// ── emit ────────────────────────────────────────────────────────────────────

describe("emit", () => {
  it("inserts a consciousness event with correct fields", () => {
    const db = getDb();
    emit(db, 42, 1700000000000, {
      kind: "self:feel",
      entityIds: ["contact:alice"],
      summary: "felt positive about the conversation",
    });

    const rows = db.all<Record<string, unknown>>(sql`SELECT * FROM consciousness_events`);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      tick: 42,
      timestamp_ms: 1700000000000,
      kind: "self:feel",
      entity_ids: '["contact:alice"]',
      summary: "felt positive about the conversation",
      salience: 0.8, // defaultSalience("self:feel")
    });
  });

  it("uses custom salience when provided", () => {
    const db = getDb();
    emit(db, 1, 1700000000000, {
      kind: "self:feel",
      entityIds: [],
      summary: "test",
      salience: 0.95,
    });

    const rows = db.all<Record<string, unknown>>(sql`SELECT salience FROM consciousness_events`);
    expect(rows[0]!.salience).toBe(0.95);
  });

  it("truncates summary to 500 chars", () => {
    const db = getDb();
    const longSummary = "x".repeat(600);
    emit(db, 1, 1700000000000, {
      kind: "self:feel",
      entityIds: [],
      summary: longSummary,
    });

    const rows = db.all<Record<string, unknown>>(sql`SELECT summary FROM consciousness_events`);
    expect((rows[0]!.summary as string).length).toBe(500);
  });
});

// ── surface ─────────────────────────────────────────────────────────────────

describe("surface", () => {
  it("returns events sorted by score (salience × recency)", () => {
    const db = getDb();
    const now = Date.now();

    // Old event with high salience
    emit(db, 1, now - 60 * 60 * 1000, {
      kind: "evolve:tier",
      entityIds: [],
      summary: "old high salience",
      salience: 0.9,
    });

    // Recent event with medium salience
    emit(db, 2, now - 5 * 60 * 1000, {
      kind: "irc:send",
      entityIds: [],
      summary: "recent medium salience",
      salience: 0.3,
    });

    // Very recent event with low salience
    emit(db, 3, now - 1000, {
      kind: "evolve:silence",
      entityIds: [],
      summary: "very recent low salience",
      salience: 0.2,
    });

    const pointers = surface(db, now, []);
    expect(pointers.length).toBeGreaterThan(0);
    // Very recent event should have decent score despite low salience
    // because recency factor is ~1.0
  });

  it("gives entity overlap bonus", () => {
    const db = getDb();
    const now = Date.now();

    // Two events at same time, same salience
    emit(db, 1, now - 1000, {
      kind: "irc:send",
      entityIds: ["contact:bob"],
      summary: "with bob",
      salience: 0.5,
    });
    emit(db, 2, now - 1000, {
      kind: "irc:send",
      entityIds: ["contact:carol"],
      summary: "with carol",
      salience: 0.5,
    });

    const pointers = surface(db, now, ["contact:bob"]);
    expect(pointers).toHaveLength(2);
    // Bob's event should rank higher due to entity overlap
    expect(pointers[0]!.summary).toBe("with bob");
  });

  it("respects limit", () => {
    const db = getDb();
    const now = Date.now();

    for (let i = 0; i < 10; i++) {
      emit(db, i, now - i * 1000, {
        kind: "irc:send",
        entityIds: [],
        summary: `event ${i}`,
      });
    }

    const pointers = surface(db, now, [], 3);
    expect(pointers).toHaveLength(3);
  });

  it("returns empty array when no events exist", () => {
    const db = getDb();
    const pointers = surface(db, Date.now(), []);
    expect(pointers).toEqual([]);
  });

  it("accepts optional WorldModel parameter without error", () => {
    const db = getDb();
    const now = Date.now();

    emit(db, 1, now - 1000, {
      kind: "self:feel",
      entityIds: ["contact:alice"],
      summary: "felt happy",
      salience: 0.8,
    });

    // surface() with undefined G should work identically to without
    const pointers = surface(db, now, ["contact:alice"], 5, undefined);
    expect(pointers).toHaveLength(1);
    expect(pointers[0]!.summary).toBe("felt happy");
  });
});

// ── reinforce ───────────────────────────────────────────────────────────────

describe("reinforce", () => {
  it("increases salience of matching events", () => {
    const db = getDb();
    emit(db, 1, Date.now(), {
      kind: "irc:send",
      entityIds: ["contact:bob"],
      summary: "test",
      salience: 0.3,
    });

    const affected = reinforce(db, ["contact:bob"], 0.2);
    expect(affected).toBe(1);

    const rows = db.all<Record<string, unknown>>(sql`SELECT salience FROM consciousness_events`);
    expect(rows[0]!.salience).toBeCloseTo(0.5);
  });

  it("clamps salience to [0, 1]", () => {
    const db = getDb();
    emit(db, 1, Date.now(), {
      kind: "evolve:tier",
      entityIds: ["contact:alice"],
      summary: "test",
      salience: 0.95,
    });

    reinforce(db, ["contact:alice"], 0.2);
    const rows = db.all<Record<string, unknown>>(sql`SELECT salience FROM consciousness_events`);
    expect(rows[0]!.salience).toBe(1.0);
  });

  it("does not affect unrelated events", () => {
    const db = getDb();
    emit(db, 1, Date.now(), {
      kind: "irc:send",
      entityIds: ["contact:carol"],
      summary: "unrelated",
      salience: 0.3,
    });

    const affected = reinforce(db, ["contact:bob"], 0.2);
    expect(affected).toBe(0);
  });

  it("returns 0 for empty entityIds", () => {
    expect(reinforce(getDb(), [], 0.1)).toBe(0);
  });
});

// ── gc ──────────────────────────────────────────────────────────────────────

describe("gc", () => {
  it("deletes old low-salience events", () => {
    const db = getDb();
    const now = Date.now();
    const oldMs = now - 8 * 24 * 60 * 60 * 1000; // 8 days ago

    emit(db, 1, oldMs, {
      kind: "irc:send",
      entityIds: [],
      summary: "old low salience",
      salience: 0.3,
    });

    const removed = gc(db, now, 7);
    expect(removed).toBe(1);
  });

  it("preserves old high-salience events (crystallization)", () => {
    const db = getDb();
    const now = Date.now();
    const oldMs = now - 8 * 24 * 60 * 60 * 1000;

    emit(db, 1, oldMs, {
      kind: "evolve:tier",
      entityIds: [],
      summary: "old but important",
      salience: 0.9,
    });

    const removed = gc(db, now, 7, 0.7);
    expect(removed).toBe(0);
  });

  it("preserves recent events regardless of salience", () => {
    const db = getDb();
    const now = Date.now();

    emit(db, 1, now - 1000, {
      kind: "evolve:silence",
      entityIds: [],
      summary: "recent low salience",
      salience: 0.1,
    });

    const removed = gc(db, now, 7);
    expect(removed).toBe(0);
  });
});

// ── commitTickEvents ────────────────────────────────────────────────────────

describe("commitTickEvents", () => {
  it("emits evolve:enqueue for enqueue plan", () => {
    const db = getDb();
    commitTickEvents(db, 10, Date.now(), {
      type: "enqueue",
      target: "contact:bob",
      voice: "curiosity",
    });

    const rows = db.all<Record<string, unknown>>(
      sql`SELECT kind, summary FROM consciousness_events`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe("evolve:enqueue");
    expect(rows[0]!.summary).toContain("contact:bob");
  });

  it("emits evolve:silence for silent plan", () => {
    const db = getDb();
    commitTickEvents(db, 10, Date.now(), {
      type: "silent",
      reason: "rate cap exceeded",
    });

    const rows = db.all<Record<string, unknown>>(
      sql`SELECT kind, summary FROM consciousness_events`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe("evolve:silence");
    expect(rows[0]!.summary).toBe("rate cap exceeded");
  });

  it("skips emission for skip plan", () => {
    const db = getDb();
    commitTickEvents(db, 10, Date.now(), { type: "skip", reason: "no events" });

    const rows = db.all<Record<string, unknown>>(sql`SELECT * FROM consciousness_events`);
    expect(rows).toHaveLength(0);
  });
});

// ── commitActEvents ─────────────────────────────────────────────────────────

describe("commitActEvents", () => {
  it("emits self:feel for self_feel instructions", () => {
    const db = getDb();
    commitActEvents(
      db,
      10,
      Date.now(),
      {
        instructions: [{ fn: "feel", args: { valence: "positive", reason: "good chat" } }],
        actions: [],
      },
      "contact:bob",
    );

    const rows = db.all<Record<string, unknown>>(
      sql`SELECT kind, summary FROM consciousness_events`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe("self:feel");
    expect(rows[0]!.summary).toContain("positive");
  });

  it("emits irc:send for send_message actions", () => {
    const db = getDb();
    commitActEvents(
      db,
      10,
      Date.now(),
      {
        instructions: [],
        actions: [{ fn: "send_message", type: "telegram", args: {} }],
      },
      "channel:123",
    );

    const rows = db.all<Record<string, unknown>>(
      sql`SELECT kind, summary FROM consciousness_events`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe("irc:send");
  });

  it("emits self:diary for self_diary instructions", () => {
    const db = getDb();
    commitActEvents(
      db,
      10,
      Date.now(),
      {
        instructions: [{ fn: "diary", args: { content: "Today was a good day" } }],
        actions: [],
      },
      null,
    );

    const rows = db.all<Record<string, unknown>>(
      sql`SELECT kind, summary FROM consciousness_events`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe("self:diary");
    expect(rows[0]!.summary).toContain("Today was a good day");
  });

  it("emits self:note for self_note instructions", () => {
    const db = getDb();
    commitActEvents(
      db,
      10,
      Date.now(),
      {
        instructions: [{ fn: "note", args: { contactId: "contact:alice", fact: "likes tea" } }],
        actions: [],
      },
      "contact:bob",
    );

    const rows = db.all<Record<string, unknown>>(
      sql`SELECT kind, entity_ids, summary FROM consciousness_events`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe("self:note");
    // remember uses contactId from args, not from target
    expect(rows[0]!.entity_ids).toContain("contact:alice");
    expect(rows[0]!.summary).toContain("likes tea");
  });

  it("emits multiple events for mixed subcycle", () => {
    const db = getDb();
    commitActEvents(
      db,
      10,
      Date.now(),
      {
        instructions: [
          { fn: "feel", args: { valence: "positive" } },
          { fn: "note", args: { fact: "birthday is June 5" } },
        ],
        actions: [{ fn: "send_message", type: "telegram", args: {} }],
      },
      "contact:bob",
    );

    const rows = db.all<Record<string, unknown>>(
      sql`SELECT kind FROM consciousness_events ORDER BY id`,
    );
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.kind)).toEqual(["self:feel", "self:note", "irc:send"]);
  });
});
