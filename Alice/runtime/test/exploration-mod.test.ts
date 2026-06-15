/**
 * Exploration Mod — модульные тесты ЧИСТОЙ логики решений + KB-ингеста.
 *
 * Покрытие:
 *  - interest-pick: aggregateInterests / pickStrongestInterest (агрегация сигналов, порог силы)
 *  - candidate filter: isJoinableChannelCandidate (channel-only + not-already-member)
 *  - daily-cap gate: canJoinToday (кап в сутки, обнуление при смене дня)
 *  - config gate: isExploreEnabled (ALICE_CHANNEL_EXPLORE)
 *  - KB-ингест: ingestChannelKb (запись на self, дедуп, отказ при пустом/коротком)
 *
 * @see src/mods/exploration.mod.ts
 */
import { afterEach, describe, expect, it } from "vitest";
import { WorldModel } from "../src/graph/world-model.js";
import {
  aggregateInterests,
  type CandidateChat,
  canJoinToday,
  DEFAULT_DAILY_JOIN_CAP,
  dayKey,
  type InterestSources,
  ingestChannelKb,
  isExploreEnabled,
  isJoinableChannelCandidate,
  MIN_INTEREST_STRENGTH,
  pickStrongestInterest,
} from "../src/mods/exploration.mod.js";

// ═══════════════════════════════════════════════════════════════════════════
// interest-pick
// ═══════════════════════════════════════════════════════════════════════════

describe("exploration: interest-pick", () => {
  it("нет сигнала → пустой список (никаких случайных join'ов)", () => {
    expect(aggregateInterests({})).toEqual([]);
    expect(pickStrongestInterest({})).toBeNull();
  });

  it("слабый сигнал (одно упоминание) ниже порога → отсеивается", () => {
    const src: InterestSources = {
      contactProfiles: { "contact:1": { interests: ["фотография"] } },
    };
    // одно упоминание = сила 1 < MIN_INTEREST_STRENGTH(2)
    expect(MIN_INTEREST_STRENGTH).toBeGreaterThan(1);
    expect(pickStrongestInterest(src)).toBeNull();
  });

  it("повторяющийся интерес у нескольких контактов набирает силу и проходит порог", () => {
    const src: InterestSources = {
      contactProfiles: {
        "contact:1": { interests: ["AI"] },
        "contact:2": { interests: ["AI"] },
        "contact:3": { interests: ["рыбалка"] },
      },
    };
    const seed = pickStrongestInterest(src);
    expect(seed).not.toBeNull();
    expect(seed?.topic).toBe("AI");
    expect(seed?.strength).toBeGreaterThanOrEqual(MIN_INTEREST_STRENGTH);
  });

  it("кристаллизованный интерес весит больше сырого тега", () => {
    const src: InterestSources = {
      contactProfiles: {
        "contact:1": {
          crystallizedInterests: { "machine learning": { confidence: 1 } },
        },
      },
    };
    const seed = pickStrongestInterest(src);
    expect(seed).not.toBeNull();
    expect(seed?.topic.toLowerCase()).toContain("machine");
    // кристаллизация даёт >= 2 → проходит порог даже одна
    expect(seed?.strength).toBeGreaterThanOrEqual(MIN_INTEREST_STRENGTH);
  });

  it("сильнейшая тема выбирается первой; учитываются и группы", () => {
    const src: InterestSources = {
      contactProfiles: {
        "contact:1": { interests: ["крипта", "крипта"] },
      },
      groupProfiles: {
        "channel:1": { topic: "крипта" },
      },
    };
    const list = aggregateInterests(src);
    expect(list[0].topic).toBe("крипта");
    // 2 (повтор тега, но Set по нормализованному ключу копит силу) + 1 (группа)
    expect(list[0].strength).toBeGreaterThanOrEqual(2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// candidate filter: channels-only + not-already-member
// ═══════════════════════════════════════════════════════════════════════════

describe("exploration: candidate filter (channels-only + not-already-member)", () => {
  const notMember = () => false;
  const isMember = () => true;

  it("broadcast-канал, не состоит → допускается", () => {
    const c: CandidateChat = { chatType: "channel", graphId: "channel:telegram:111" };
    expect(isJoinableChannelCandidate(c, notMember)).toBe(true);
  });

  it("supergroup НИКОГДА не допускается (риск: Алиса могла бы постить)", () => {
    const c: CandidateChat = { chatType: "supergroup", graphId: "channel:telegram:222" };
    expect(isJoinableChannelCandidate(c, notMember)).toBe(false);
  });

  it("group НИКОГДА не допускается", () => {
    const c: CandidateChat = { chatType: "group", graphId: "channel:telegram:333" };
    expect(isJoinableChannelCandidate(c, notMember)).toBe(false);
  });

  it("private НИКОГДА не допускается", () => {
    const c: CandidateChat = { chatType: "private", graphId: "channel:telegram:444" };
    expect(isJoinableChannelCandidate(c, notMember)).toBe(false);
  });

  it("уже состоит → не допускается (no re-join)", () => {
    const c: CandidateChat = { chatType: "channel", graphId: "channel:telegram:555" };
    expect(isJoinableChannelCandidate(c, isMember)).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// daily-cap gate
// ═══════════════════════════════════════════════════════════════════════════

describe("exploration: daily-cap gate", () => {
  const t0 = Date.parse("2026-06-15T10:00:00Z");

  it("под капом → можно; на капе → нельзя", () => {
    const key = dayKey(t0);
    expect(canJoinToday({ joinDayKey: key, joinsToday: 0 }, t0)).toBe(true);
    expect(canJoinToday({ joinDayKey: key, joinsToday: 1 }, t0)).toBe(true);
    expect(canJoinToday({ joinDayKey: key, joinsToday: DEFAULT_DAILY_JOIN_CAP }, t0)).toBe(false);
  });

  it("счётчик прошлых суток игнорируется (день сменился → обнуление)", () => {
    // joinDayKey = вчера, joinsToday = на капе, но сегодня другой день → можно
    const yesterday = dayKey(t0 - 24 * 3600_000);
    expect(canJoinToday({ joinDayKey: yesterday, joinsToday: DEFAULT_DAILY_JOIN_CAP }, t0)).toBe(
      true,
    );
  });

  it("кастомный кап уважается", () => {
    const key = dayKey(t0);
    expect(canJoinToday({ joinDayKey: key, joinsToday: 4 }, t0, 5)).toBe(true);
    expect(canJoinToday({ joinDayKey: key, joinsToday: 5 }, t0, 5)).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// config gate
// ═══════════════════════════════════════════════════════════════════════════

describe("exploration: config gate (ALICE_CHANNEL_EXPLORE)", () => {
  const prev = process.env.ALICE_CHANNEL_EXPLORE;
  afterEach(() => {
    if (prev === undefined) delete process.env.ALICE_CHANNEL_EXPLORE;
    else process.env.ALICE_CHANNEL_EXPLORE = prev;
  });

  it("по умолчанию (не задан) → включено", () => {
    delete process.env.ALICE_CHANNEL_EXPLORE;
    expect(isExploreEnabled()).toBe(true);
  });

  it("'0' / 'false' / 'off' / 'no' → выключено", () => {
    for (const v of ["0", "false", "off", "no", "FALSE", "Off"]) {
      process.env.ALICE_CHANNEL_EXPLORE = v;
      expect(isExploreEnabled()).toBe(false);
    }
  });

  it("любое другое значение → включено", () => {
    process.env.ALICE_CHANNEL_EXPLORE = "1";
    expect(isExploreEnabled()).toBe(true);
    process.env.ALICE_CHANNEL_EXPLORE = "yes";
    expect(isExploreEnabled()).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// KB-ингест (общая воронка авто-исследования И ручного Wiki-канала)
// ═══════════════════════════════════════════════════════════════════════════

describe("exploration: ingestChannelKb (durable KB)", () => {
  function makeGraph(): WorldModel {
    const G = new WorldModel();
    G.addAgent("self");
    return G;
  }

  const NOTE =
    "По проекту Орбита решили перенести релиз на сентябрь и переписать пайплайн ингеста.";

  it("записывает заметный фрагмент как KB-факт на self", () => {
    const G = makeGraph();
    const ok = ingestChannelKb(G, NOTE, {
      topic: "Орбита",
      sourceChannel: "channel:telegram:999",
      nowMs: 1_700_000_000_000,
    });
    expect(ok).toBe(true);
    const factIds = G.getEntitiesByType("fact");
    expect(factIds.length).toBe(1);
    const f = G.getFact(factIds[0]);
    expect(f.fact_type).toBe("kb");
    expect(f.content).toContain("Орбита");
    expect(f.source_channel).toBe("channel:telegram:999");
    // высокая stability → не затухает (как note_kb)
    expect(f.stability).toBeGreaterThan(1000);
  });

  it("дубликат не создаёт второй факт (нестрогая дедупликация)", () => {
    const G = makeGraph();
    expect(ingestChannelKb(G, NOTE, { topic: "Орбита" })).toBe(true);
    expect(ingestChannelKb(G, NOTE, { topic: "Орбита" })).toBe(false);
    expect(G.getEntitiesByType("fact").length).toBe(1);
  });

  it("слишком короткий текст → не записывается", () => {
    const G = makeGraph();
    expect(ingestChannelKb(G, "ок")).toBe(false);
    expect(G.getEntitiesByType("fact").length).toBe(0);
  });

  it("нет self-узла → мягкий отказ", () => {
    const G = new WorldModel();
    expect(ingestChannelKb(G, NOTE)).toBe(false);
  });
});
