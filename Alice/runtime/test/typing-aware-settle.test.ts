import { beforeEach, describe, expect, it } from "vitest";
import { nextSettleWait, TYPING_WAIT_CAP_MS } from "../src/engine/react/orchestrator.js";
import {
  __resetTypingTracker,
  isTyping,
  lastTypingMs,
  recordTyping,
} from "../src/engine/react/typing-tracker.js";

// ── Эфемерный трекер typing: record / expire / окно isTyping ──────────────────
describe("typing tracker (ephemeral)", () => {
  const chat = "telegram:channel:42";
  const now = 1_000_000;

  beforeEach(() => __resetTypingTracker());

  it("returns undefined / false when no typing was ever recorded", () => {
    expect(lastTypingMs(chat)).toBeUndefined();
    expect(isTyping(chat, now, 6000)).toBe(false);
  });

  it("records a typing timestamp and reports it as the most recent", () => {
    recordTyping(chat, "telegram:contact:7", now);
    expect(lastTypingMs(chat)).toBe(now);
  });

  it("isTyping is true within the freshness window", () => {
    recordTyping(chat, null, now - 500);
    expect(isTyping(chat, now, 6000)).toBe(true);
  });

  it("isTyping expires once the signal is older than the window", () => {
    recordTyping(chat, null, now - 6000);
    // 6000 >= window(6000) → истёк (строгое <)
    expect(isTyping(chat, now, 6000)).toBe(false);
  });

  it("does not leak across distinct chats", () => {
    recordTyping(chat, null, now);
    expect(isTyping("telegram:channel:99", now, 6000)).toBe(false);
  });

  it("a newer typing signal overwrites the older one", () => {
    recordTyping(chat, null, now - 5000);
    recordTyping(chat, null, now - 200);
    expect(lastTypingMs(chat)).toBe(now - 200);
    expect(isTyping(chat, now, 6000)).toBe(true);
  });

  it("ignores empty chat ids (never throws)", () => {
    expect(() => recordTyping("", null, now)).not.toThrow();
    expect(lastTypingMs("")).toBeUndefined();
  });
});

// ── Решение typing-aware ожидания (чистая функция nextSettleWait) ─────────────
describe("typing-aware settle decision (nextSettleWait)", () => {
  const CAP = TYPING_WAIT_CAP_MS;
  const POLL = 700;
  const QUIET = 1500;

  it("keeps waiting while the user is still typing (recent keystroke, not capped)", () => {
    // последний typing 300мс назад (< порога тишины) → продолжаем ждать
    const d = nextSettleWait({ quietForMs: 300, waitedMs: 1400, quietMs: QUIET, capMs: CAP, pollMs: POLL });
    expect(d.wait).toBe(true);
    expect(d.sleepMs).toBe(POLL);
  });

  it("stops waiting once typing went quiet for the quiet threshold", () => {
    // тишина ровно порог (1500мс) → набор окончен, выходим
    const d = nextSettleWait({ quietForMs: QUIET, waitedMs: 1400, quietMs: QUIET, capMs: CAP, pollMs: POLL });
    expect(d.wait).toBe(false);
    expect(d.sleepMs).toBe(0);
  });

  it("stops immediately when there is no typing signal at all (fallback path)", () => {
    const d = nextSettleWait({ quietForMs: undefined, waitedMs: 0, quietMs: QUIET, capMs: CAP, pollMs: POLL });
    expect(d.wait).toBe(false);
    expect(d.sleepMs).toBe(0);
  });

  it("respects the hard cap even if the user keeps typing forever", () => {
    const d = nextSettleWait({ quietForMs: 100, waitedMs: CAP, quietMs: QUIET, capMs: CAP, pollMs: POLL });
    expect(d.wait).toBe(false);
    expect(d.sleepMs).toBe(0);
  });

  it("never sleeps past the cap (clamps the final poll)", () => {
    const waited = CAP - 200; // осталось 200мс < POLL
    const d = nextSettleWait({ quietForMs: 100, waitedMs: waited, quietMs: QUIET, capMs: CAP, pollMs: POLL });
    expect(d.wait).toBe(true);
    expect(d.sleepMs).toBe(200);
  });

  it("a full wait loop terminates after the typist goes quiet before the cap", () => {
    // Симуляция: печатает 2 шага подряд (свежий typing), затем замолкает на порог → выходим до потолка.
    // quietForMs по шагам: 100 (печатает), 100 (печатает), 1500 (замолчал).
    const quietByStep = [100, 100, QUIET];
    let waited = 0;
    let steps = 0;
    for (;;) {
      const quietForMs = quietByStep[steps] ?? QUIET;
      const d = nextSettleWait({ quietForMs, waitedMs: waited, quietMs: QUIET, capMs: CAP, pollMs: POLL });
      if (!d.wait) break;
      waited += d.sleepMs;
      steps++;
      expect(steps).toBeLessThan(100); // защита от бесконечного цикла в тесте
    }
    expect(steps).toBe(2);
    expect(waited).toBe(2 * POLL);
    expect(waited).toBeLessThan(CAP);
  });

  it("a full wait loop terminates exactly at the cap when typing never stops", () => {
    // Печатает бесконечно (всегда свежий typing) → цикл выходит ровно по достижении потолка.
    let waited = 0;
    let steps = 0;
    for (;;) {
      const d = nextSettleWait({ quietForMs: 50, waitedMs: waited, quietMs: QUIET, capMs: CAP, pollMs: POLL });
      if (!d.wait) break;
      waited += d.sleepMs;
      steps++;
      expect(steps).toBeLessThan(1000);
    }
    expect(waited).toBe(CAP); // суммарное ожидание ровно потолок, не больше
  });
});
