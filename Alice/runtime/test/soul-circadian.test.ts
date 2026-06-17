/**
 * Циркадная фаза суток в персоне.
 *
 * У Алисы уже была циркадная модуляция ПРОАКТИВНОСТИ (circadianMultiplier → μ Hawkes): ночью она
 * реже сама пишет. Но её ТОН от времени суток не зависел — ночью писала так же бодро, как днём.
 * circadianSelfState() инжектит субъективный ФАКТ о состоянии (как awareness потери голоса), и
 * Alice сама окрашивает голос. Днём (9–17, её пора) — без инъекции, prompt не меняется.
 */
import { describe, expect, it } from "vitest";
import type { ModContext } from "../src/core/types.js";
import { WorldModel } from "../src/graph/world-model.js";
import { circadianSelfState, soulMod } from "../src/mods/soul.mod.js";

describe("circadianSelfState — субъективная фаза суток", () => {
  it("глубокая ночь (0–4) → мягче/тише", () => {
    for (const h of [0, 2, 4]) {
      expect(circadianSelfState(h)).toContain("глубокая ночь");
    }
  });

  it("раннее утро (5–8) → разгон со сна", () => {
    expect(circadianSelfState(5)).toContain("Раннее утро");
    expect(circadianSelfState(8)).toContain("Раннее утро");
  });

  it("день (9–17) → без инъекции (базовое состояние)", () => {
    for (const h of [9, 13, 17]) {
      expect(circadianSelfState(h)).toBeNull();
    }
  });

  it("вечер (18–21) → неспешнее", () => {
    expect(circadianSelfState(18)).toContain("Вечер");
    expect(circadianSelfState(21)).toContain("Вечер");
  });

  it("поздний вечер (22–23) → закругляться, мягче", () => {
    expect(circadianSelfState(22)).toContain("Поздний вечер");
    expect(circadianSelfState(23)).toContain("Поздний вечер");
  });
});

describe("soul.mod contribute — circadian-energy инъекция", () => {
  // biome-ignore lint/style/noNonNullAssertion: test — contribute 已知存在
  const contribute = soulMod.contribute!;

  function ctxAtLocalHour(hour: number): ModContext {
    const graph = new WorldModel();
    graph.tick = 100;
    // new Date(y,m,d,h) строит ЛОКАЛЬНОЕ время; getHours() читает локальное → tz-независимо.
    const nowMs = new Date(2026, 0, 1, hour, 0, 0).getTime();
    return {
      graph,
      state: { activeVoice: null, activeFacet: null, voiceLostSince: null },
      tick: 100,
      nowMs,
      getModState: () => undefined,
      dispatch: () => undefined,
    } as unknown as ModContext;
  }

  it("ночью инжектит строку энергии (priority=70)", () => {
    const items = contribute(ctxAtLocalHour(3));
    const circadian = items.find((i) => i.priority === 70 && i.bucket === "header");
    expect(circadian).toBeDefined();
    expect(circadian?.lines.join("\n")).toContain("глубокая ночь");
  });

  it("днём НЕ инжектит (prompt без изменений)", () => {
    const items = contribute(ctxAtLocalHour(13));
    const circadian = items.filter((i) => i.priority === 70 && i.bucket === "header");
    expect(circadian).toHaveLength(0);
  });
});
