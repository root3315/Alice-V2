/**
 * Fix #5 — чистота contribute().
 *
 * Регрессионный тест к багу: collectContributions() вызывается несколько раз за один
 * ReAct-tick И спекулятивно в eval ablation. Раньше contribute() мутировал состояние
 * (инкремент exposures, обновление lastInjectMs) и расходовал Math.random() ВНУТРИ себя,
 * из-за чего повторные/спекулятивные вызовы двоили exposures и сбивали кулдаун.
 *
 * После фикса:
 * - решение принимается ровно один раз за tick в onTickStart (там и происходят все мутации);
 * - contribute() ЧИСТАЯ: многократный вызов в рамках одного tick не меняет состояние,
 *   не двоит exposures и не расходует Math.random() повторно.
 *
 * Этот тест НЕ редактирует существующие тест-файлы и проверяет только инвариант чистоты.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ContributionItem, ModContext } from "../src/core/types.js";
import { WorldModel } from "../src/graph/world-model.js";

// ── Общий минимальный ModContext ───────────────────────────────────────────

function makeGraph(): WorldModel {
  const graph = new WorldModel();
  graph.tick = 100;
  graph.addAgent("self");
  return graph;
}

function makeCtx<S>(
  state: S,
  graph: WorldModel,
  opts: { nowMs?: number; pressure?: number } = {},
): ModContext<S> {
  return {
    graph,
    state,
    tick: 100,
    nowMs: opts.nowMs ?? 1_700_000_000_000,
    getModState: ((modName: string) => {
      if (modName === "pressure") return { latest: { API: opts.pressure ?? 0 } };
      return undefined;
    }) as ModContext["getModState"],
    dispatch: () => undefined,
  } as ModContext<S>;
}

// ── Feeds ──────────────────────────────────────────────────────────────────

describe("Fix #5: feeds.contribute() чистая", () => {
  beforeEach(async () => {
    const mod = await import("../src/mods/feeds.mod.js");
    mod._resetFeedCache();
  });

  it("после принятого решения contribute() детерминирована, не двоит exposures/lastInjectMs и не расходует Math.random()", async () => {
    const feeds = await import("../src/mods/feeds.mod.js");

    // Инициализируем конфиг мода (нужен contribute, чтобы пройти ранний guard !feedsConfig).
    feeds.startFeedPoller();

    const graph = makeGraph();

    // Имитируем «решение уже принято в onTickStart для текущего tick (=100)»:
    // pendingInject заполнен, decidedTick совпадает с ctx.tick. Это публичный контракт после фикса —
    // contribute() обязана лишь читать это решение.
    const state = {
      pollerStarted: true,
      lastInjectMs: 1_700_000_000_000,
      pendingInject: ["news «Заголовок» https://x/1", "anime «Тайтл» https://x/2"],
      decidedTick: 100,
    };
    const ctx = makeCtx(state, graph, { nowMs: 1_700_000_000_000, pressure: 0 });

    const lastInjectBefore = state.lastInjectMs;
    const pendingSnapshot = JSON.stringify(state.pendingInject);

    // Math.random() НЕ должен вызываться в contribute(), так как решение уже принято.
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0.99);

    // biome-ignore lint/style/noNonNullAssertion: contribute существует
    const contribute = feeds.feedsMod.contribute!;

    // Несколько ReAct-раундов + спекулятивный ablation-вызов в рамках одного tick.
    const r1 = contribute(ctx as unknown as ModContext) as ContributionItem[];
    const r2 = contribute(ctx as unknown as ModContext) as ContributionItem[];
    const r3 = contribute(ctx as unknown as ModContext) as ContributionItem[];

    const randomCalls = randomSpy.mock.calls.length;
    randomSpy.mockRestore();

    // Чистота: Math.random() не расходуется в contribute().
    expect(randomCalls).toBe(0);
    // Чистота: состояние не изменилось.
    expect(state.lastInjectMs).toBe(lastInjectBefore);
    expect(JSON.stringify(state.pendingInject)).toBe(pendingSnapshot);
    // Вывод: одна секция feed-items с обеими строками решения.
    expect(r1.length).toBe(1);
    expect(r1[0].key).toBe("feed-items");
    expect(r1[0].lines.length).toBe(2);
    // Детерминизм между раундами.
    expect(JSON.stringify(r2)).toBe(JSON.stringify(r1));
    expect(JSON.stringify(r3)).toBe(JSON.stringify(r1));

    feeds.stopFeedPoller();
    feeds._resetFeedCache();
  });

  it("ленивый расчёт в contribute() (без onTickStart) фиксирует решение ровно один раз за tick", async () => {
    const feeds = await import("../src/mods/feeds.mod.js");

    // Сценарий-страховка: onTickStart не запускался (decidedTick != ctx.tick). Многократный вызов
    // contribute() должен зафиксировать решение РОВНО один раз (decidedTick = ctx.tick) и далее
    // только читать его — раньше каждый вызов перепринимал решение (двоил exposures/random).
    const graph = makeGraph();
    const state = {
      pollerStarted: false,
      lastInjectMs: 0,
      pendingInject: [] as string[],
      decidedTick: -1, // решение для этого tick ещё НЕ принято
    };
    const ctx = makeCtx(state, graph, { nowMs: 1_700_000_000_000, pressure: 0 });

    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0.99);

    // biome-ignore lint/style/noNonNullAssertion: contribute существует
    const contribute = feeds.feedsMod.contribute!;
    contribute(ctx as unknown as ModContext);
    contribute(ctx as unknown as ModContext);
    contribute(ctx as unknown as ModContext);

    const randomCalls = randomSpy.mock.calls.length;
    randomSpy.mockRestore();

    // Решение зафиксировано ровно один раз → decidedTick стал текущим tick.
    expect(state.decidedTick).toBe(100);
    // Math.random() расходуется не более одного раза за tick (а не по разу на каждый из 3 вызовов).
    expect(randomCalls).toBeLessThanOrEqual(1);
  });
});

// ── Channel ────────────────────────────────────────────────────────────────

describe("Fix #5: channel.contribute() чистая", () => {
  function addChannel(G: WorldModel, id: string, unread: number) {
    G.addChannel(id, {
      chat_type: "channel",
      tier_contact: 500,
      unread,
      pending_directed: 0,
      last_directed_ms: 0,
    });
    G.setDynamic(id, "display_name", id.replace("channel:", "@"));
  }

  it("решение принимается один раз в onTickStart; повторные contribute() не меняют lastInjectMs и не расходуют Math.random()", async () => {
    const channel = await import("../src/mods/channel.mod.js");

    const graph = makeGraph();
    addChannel(graph, "channel:a", 5);
    addChannel(graph, "channel:b", 20);
    addChannel(graph, "channel:c", 10);

    const now = 1_700_000_000_000;
    const state = {
      lastInjectMs: 0,
      pendingInject: [] as Array<{ name: string; unread: number; role: string; nodeId: string }>,
    };
    const ctx = makeCtx(state, graph, { nowMs: now, pressure: 0 });

    // Обходим вероятностный пропуск, чтобы решение точно состоялось.
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0.99);

    // Принимаем решение один раз (как dispatcher.startTick).
    // biome-ignore lint/style/noNonNullAssertion: onTickStart существует
    channel.channelMod.onTickStart!(ctx as unknown as ModContext);

    // onTickStart должен был принять решение и установить lastInjectMs.
    expect(state.lastInjectMs).toBe(now);
    expect(state.pendingInject.length).toBe(3); // top-3 по unread
    const randomCallsAfterDecision = randomSpy.mock.calls.length;
    const pendingSnapshot = JSON.stringify(state.pendingInject);

    // biome-ignore lint/style/noNonNullAssertion: contribute существует
    const contribute = channel.channelMod.contribute!;

    // Многократные вызовы contribute() (несколько ReAct-раундов + спекулятивный ablation-вызов).
    const r1 = contribute(ctx as unknown as ModContext) as ContributionItem[];
    const r2 = contribute(ctx as unknown as ModContext) as ContributionItem[];
    const r3 = contribute(ctx as unknown as ModContext) as ContributionItem[];

    // Счётчик читаем ДО mockRestore() — restore сбрасывает mock.calls в 0.
    const randomCallsAfterContribute = randomSpy.mock.calls.length;
    randomSpy.mockRestore();

    // Чистота: contribute() не трогает Math.random() и не меняет состояние.
    expect(randomCallsAfterContribute).toBe(randomCallsAfterDecision);
    expect(state.lastInjectMs).toBe(now);
    expect(JSON.stringify(state.pendingInject)).toBe(pendingSnapshot);

    // Корректность вывода сохранена: одна секция channel-updates с 3 строками,
    // отсортированными по убыванию unread (b > c > a).
    expect(r1.length).toBe(1);
    expect(r1[0].key).toBe("channel-updates");
    const rendered = r1[0].lines.map((l) => String(l));
    expect(rendered[0]).toContain("@b");
    expect(rendered[1]).toContain("@c");
    expect(rendered[2]).toContain("@a");

    // Детерминизм между раундами.
    expect(JSON.stringify(r2)).toBe(JSON.stringify(r1));
    expect(JSON.stringify(r3)).toBe(JSON.stringify(r1));
  });

  it("cooldown сохраняется: при свежем lastInjectMs onTickStart не инжектит и Math.random() не расходуется", async () => {
    const channel = await import("../src/mods/channel.mod.js");

    const graph = makeGraph();
    addChannel(graph, "channel:a", 5);

    const now = 1_700_000_000_000;
    const state = {
      lastInjectMs: now - 5 * 60_000, // 5 минут назад — внутри 10-минутного кулдауна
      pendingInject: [] as Array<{ name: string; unread: number; role: string; nodeId: string }>,
    };
    const ctx = makeCtx(state, graph, { nowMs: now, pressure: 0 });

    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0.99);

    // biome-ignore lint/style/noNonNullAssertion: onTickStart существует
    channel.channelMod.onTickStart!(ctx as unknown as ModContext);

    // Кулдаун срабатывает ДО вероятностного пропуска → Math.random() не вызывается.
    expect(randomSpy.mock.calls.length).toBe(0);
    expect(state.pendingInject).toEqual([]);

    // biome-ignore lint/style/noNonNullAssertion: contribute существует
    const contribute = channel.channelMod.contribute!;
    expect(contribute(ctx as unknown as ModContext)).toEqual([]);

    randomSpy.mockRestore();
  });
});
