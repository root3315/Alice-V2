/**
 * Commitment Mod — юнит-тесты ЧИСТОЙ логики follow-through.
 *
 * Покрытие:
 *  1. parseSoftWhen — мягкое «когда» (завтра/в пятницу/на выходных/через N/нераспарсенное).
 *  2. dueCommitments — созревание ровно после срока + grace (не раньше).
 *  3. pruneCommitments — TTL/decay для asked / ripe / нераспарсенного pending.
 *  4. one-touch — asked не пере-созревает и со временем отпускается.
 */
import { describe, expect, it } from "vitest";
import {
  ASKED_TTL_MS,
  type Commitment,
  type CommitmentStatus,
  dueCommitments,
  parseSoftWhen,
  pruneCommitments,
  RESURFACE_GRACE_MS,
  RESURFACE_TTL_MS,
} from "../src/mods/commitment.mod.js";

// Опорный момент: среда, 2024-06-12 12:00 локального времени.
// (new Date(2024,5,12,12,0,0).getDay() === 3 → среда.)
const WED_NOON = new Date(2024, 5, 12, 12, 0, 0, 0).getTime();
const DAY = 24 * 60 * 60_000;

function mk(over: Partial<Commitment>): Commitment {
  return {
    id: over.id ?? "c1",
    who: over.who ?? "self",
    what: over.what ?? "отправить фикс",
    softWhenMs: over.softWhenMs ?? 0,
    chatId: over.chatId ?? "channel:tg:1",
    createdMs: over.createdMs ?? WED_NOON,
    status: (over.status ?? "pending") as CommitmentStatus,
    directed: over.directed,
    ripeMs: over.ripeMs,
    askedMs: over.askedMs,
  };
}

describe("commitment: parseSoftWhen (мягкое «когда»)", () => {
  it("«завтра» → начало следующего дня (строго в будущем, в пределах дня)", () => {
    const when = parseSoftWhen("завтра", WED_NOON);
    expect(when).toBeGreaterThan(WED_NOON);
    // следующий день от среды-полудня — четверг 00:00; в пределах (12ч, 36ч).
    expect(when - WED_NOON).toBeGreaterThan(11 * 60 * 60_000);
    expect(when - WED_NOON).toBeLessThan(36 * 60 * 60_000);
  });

  it("«послезавтра» дальше, чем «завтра»", () => {
    expect(parseSoftWhen("послезавтра", WED_NOON)).toBeGreaterThan(
      parseSoftWhen("завтра", WED_NOON),
    );
  });

  it("«в пятницу» от среды → ближайшая пятница (через 2 дня), строго вперёд", () => {
    const when = parseSoftWhen("в пятницу", WED_NOON);
    const dow = new Date(when).getDay();
    expect(dow).toBe(5); // пятница
    expect(when).toBeGreaterThan(WED_NOON);
    expect(when - WED_NOON).toBeLessThan(3 * DAY);
  });

  it("день недели = сегодня (среда) → берём СЛЕДУЮЩУЮ неделю (не сейчас/назад)", () => {
    const when = parseSoftWhen("в среду", WED_NOON);
    expect(new Date(when).getDay()).toBe(3);
    expect(when - WED_NOON).toBeGreaterThan(6 * DAY); // через неделю
  });

  it("«на выходных» → ближайшая суббота", () => {
    const when = parseSoftWhen("на выходных", WED_NOON);
    expect(new Date(when).getDay()).toBe(6); // суббота
    expect(when).toBeGreaterThan(WED_NOON);
  });

  it("«через 2 дня» → +2 дня", () => {
    const when = parseSoftWhen("через 2 дня", WED_NOON);
    expect(when).toBeGreaterThan(WED_NOON + DAY);
    expect(when).toBeLessThan(WED_NOON + 3 * DAY);
  });

  it("«через 3 часа» → +~3 часа", () => {
    const when = parseSoftWhen("через 3 часа", WED_NOON);
    expect(when - WED_NOON).toBeGreaterThan(2.5 * 60 * 60_000);
    expect(when - WED_NOON).toBeLessThan(3.5 * 60 * 60_000);
  });

  it("«на следующей неделе» → следующий понедельник", () => {
    const when = parseSoftWhen("на следующей неделе", WED_NOON);
    expect(new Date(when).getDay()).toBe(1); // понедельник
    expect(when).toBeGreaterThan(WED_NOON);
  });

  it("нераспознанное / пустое → 0", () => {
    expect(parseSoftWhen("когда-нибудь потом", WED_NOON)).toBe(0);
    expect(parseSoftWhen("", WED_NOON)).toBe(0);
    expect(parseSoftWhen("   ", WED_NOON)).toBe(0);
  });

  it("результат всегда строго в будущем (никогда не в прошлое)", () => {
    for (const w of ["завтра", "в пятницу", "на выходных", "через 1 дн", "вечером"]) {
      const v = parseSoftWhen(w, WED_NOON);
      if (v !== 0) expect(v).toBeGreaterThan(WED_NOON);
    }
  });
});

describe("commitment: dueCommitments (созревание по сроку + grace)", () => {
  it("срок ещё не прошёл → НЕ созрело", () => {
    const c = mk({ softWhenMs: WED_NOON + DAY });
    expect(dueCommitments([c], WED_NOON)).toHaveLength(0);
  });

  it("срок прошёл, но grace ещё не вышел → НЕ созрело (не дёргаем в секунду срока)", () => {
    const c = mk({ softWhenMs: WED_NOON });
    expect(dueCommitments([c], WED_NOON + RESURFACE_GRACE_MS - 1)).toHaveLength(0);
  });

  it("срок прошёл + grace → созрело", () => {
    const c = mk({ softWhenMs: WED_NOON });
    expect(dueCommitments([c], WED_NOON + RESURFACE_GRACE_MS + 1)).toHaveLength(1);
  });

  it("нераспарсенный срок (0) → никогда не созревает по сроку", () => {
    const c = mk({ softWhenMs: 0 });
    expect(dueCommitments([c], WED_NOON + 10 * DAY)).toHaveLength(0);
  });

  it("уже asked → не пере-созревает (one-touch)", () => {
    const c = mk({ softWhenMs: WED_NOON, status: "asked", askedMs: WED_NOON });
    expect(dueCommitments([c], WED_NOON + RESURFACE_GRACE_MS + 1)).toHaveLength(0);
  });
});

describe("commitment: pruneCommitments (TTL / decay)", () => {
  it("свежий asked-след остаётся; протухший — отпускается", () => {
    const fresh = mk({ id: "a", status: "asked", askedMs: WED_NOON });
    const stale = mk({ id: "b", status: "asked", askedMs: WED_NOON });
    expect(pruneCommitments([fresh], WED_NOON + ASKED_TTL_MS - 1).map((c) => c.id)).toEqual(["a"]);
    expect(pruneCommitments([stale], WED_NOON + ASKED_TTL_MS + 1)).toHaveLength(0);
  });

  it("ripe, момент так и не настал дольше TTL → отпускается (не висит вечно)", () => {
    const c = mk({ status: "ripe", ripeMs: WED_NOON, directed: true });
    expect(pruneCommitments([c], WED_NOON + RESURFACE_TTL_MS - 1)).toHaveLength(1);
    expect(pruneCommitments([c], WED_NOON + RESURFACE_TTL_MS + 1)).toHaveLength(0);
  });

  it("pending с нераспарсенным сроком (0) старше TTL → отпускается", () => {
    const c = mk({ status: "pending", softWhenMs: 0, createdMs: WED_NOON });
    expect(pruneCommitments([c], WED_NOON + RESURFACE_TTL_MS + 1)).toHaveLength(0);
  });

  it("pending с валидным будущим сроком → НЕ трогаем, даже спустя время", () => {
    const c = mk({ status: "pending", softWhenMs: WED_NOON + 100 * DAY, createdMs: WED_NOON });
    expect(pruneCommitments([c], WED_NOON + RESURFACE_TTL_MS + 1)).toHaveLength(1);
  });
});

describe("commitment: end-to-end жизненный цикл (чистые шаги)", () => {
  it("pending → due → (помечаем ripe) → asked → отпускается по ASKED_TTL", () => {
    let list = [mk({ softWhenMs: WED_NOON, status: "pending" })];

    // до grace — не due.
    expect(dueCommitments(list, WED_NOON + RESURFACE_GRACE_MS - 1)).toHaveLength(0);

    // после grace — due; эмулируем переход pending→ripe (как делает onTickEnd).
    const ripeNow = WED_NOON + RESURFACE_GRACE_MS + 1;
    const due = dueCommitments(list, ripeNow);
    expect(due).toHaveLength(1);
    due[0].status = "ripe";
    due[0].ripeMs = ripeNow;

    // one-touch: помечаем asked; больше не due.
    list[0].status = "asked";
    list[0].askedMs = ripeNow;
    expect(dueCommitments(list, ripeNow + DAY)).toHaveLength(0);

    // спустя ASKED_TTL след убирается prune.
    list = pruneCommitments(list, ripeNow + ASKED_TTL_MS + 1);
    expect(list).toHaveLength(0);
  });
});
