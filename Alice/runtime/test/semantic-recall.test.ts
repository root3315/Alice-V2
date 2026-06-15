/**
 * Семантическая память (ADDITIVE recall enrichment) — юнит-тесты.
 *
 * Покрытие:
 *  1. OFF BY DEFAULT: без сконфигурированного сервера эмбеддингов recall == keyword.
 *  2. GRACEFUL FALLBACK: сервер сконфигурирован, но недоступен/падает →
 *     recall идентичен keyword-пути (ничего не ломается, fetch проглатывается).
 *  3. EMBEDDING CACHE HIT: один и тот же текст не эмбеддится дважды.
 *  4. ADDITIVE BLEND: семантика ПОВЫШАЕТ keyword-хиты и ДОБАВЛЯЕТ новые
 *     (keyword их не нашёл), НЕ удаляя существующие.
 *  5. cosineSimilarity — чистая функция.
 *
 * Эндпоинт эмбеддингов МОКАЕТСЯ (никакого реального сервера).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModContext } from "../src/core/types.js";
import { closeDb, initDb } from "../src/db/connection.js";
import { WorldModel } from "../src/graph/world-model.js";
import { embeddingCacheSize, embedManyCached } from "../src/llm/embedding-store.js";
import {
  cosineSimilarity,
  type EmbeddingConfig,
  isEmbeddingEnabled,
  resetEmbeddingBreaker,
} from "../src/llm/embeddings.js";
import { resetEmbeddingConfig, setEmbeddingConfig } from "../src/llm/semantic-recall-config.js";
import { recallMod } from "../src/mods/recall.mod.js";

// -- helpers ------------------------------------------------------------------

// biome-ignore lint/style/noNonNullAssertion: test — query 已知存在
const recallQuery = recallMod.queries!.recall;

const ENABLED: EmbeddingConfig = {
  embeddingBaseUrl: "http://127.0.0.1:11434/v1",
  embeddingApiKey: "",
  embeddingModel: "bge-m3",
};

interface DiaryThoughtLike {
  content: string;
  about: string | null;
  salience: number;
  createdAt: number;
  updatedAt: number;
}

function makeCtx(opts: {
  graph: WorldModel;
  nowMs: number;
  thoughts?: DiaryThoughtLike[];
}): ModContext {
  return {
    graph: opts.graph,
    state: {},
    tick: 100,
    nowMs: opts.nowMs,
    getModState: (mod: string) => {
      if (mod === "memory") return { targetChatId: null } as unknown as undefined;
      if (mod === "diary") return { thoughts: opts.thoughts ?? [] } as unknown as undefined;
      return undefined;
    },
    dispatch: () => undefined,
  } as unknown as ModContext;
}

let _fid = 0;
function addFact(graph: WorldModel, contactId: string, content: string, nowMs: number): string {
  const id = `fact_test_${_fid++}`;
  graph.addFact(id, {
    content,
    fact_type: "observation",
    importance: 0.5,
    stability: 100, // высокий S → R≈1, чтобы fact-вес не подавлял
    last_access_ms: nowMs,
    volatility: 0,
    tracked: false,
    created_ms: nowMs,
    novelty: 1.0,
    reinforcement_count: 1,
    source_contact: contactId,
  });
  graph.addRelation(contactId, "knows", id);
  return id;
}

interface RecallResult {
  topic: string;
  facts: Array<{ text: string; about: string | null; ageS: number }>;
  thoughts: Array<{ text: string; ageS: number }>;
  episodes: Array<{ text: string; ageS: number }>;
  empty: boolean;
}

async function runRecall(ctx: ModContext, topic: string): Promise<RecallResult> {
  return (await recallQuery.impl(ctx, { topic })) as RecallResult;
}

/**
 * Детерминированный фейковый эмбеддинг: вектор по «теме». Тексты одной темы
 * получают близкие векторы (высокий косинус), разных тем — ортогональные.
 * Тема выбирается по ключевому слову в тексте.
 */
function fakeEmbedding(text: string): number[] {
  const t = text.toLowerCase();
  // 3 ортогональные оси-темы.
  let axis = 2; // прочее
  if (/(тревож|пережив|волнов|worry|anxious|нерв)/.test(t))
    axis = 0; // «тревога»
  else if (/(кофе|coffee|чай|tea)/.test(t)) axis = 1; // «напитки»
  const v = [0, 0, 0, 0];
  v[axis] = 1;
  // лёгкий шум, чтобы идентичные тексты не были строго равны, но оставались близки
  v[3] = (text.length % 7) / 100;
  return v;
}

function mockEmbedFetch() {
  const fn = vi.fn(async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as { input: string[] };
    const data = body.input.map((text, index) => ({ embedding: fakeEmbedding(text), index }));
    return { ok: true, json: async () => ({ data }) };
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

// -- lifecycle ----------------------------------------------------------------

beforeEach(() => {
  initDb(":memory:");
  resetEmbeddingConfig();
  resetEmbeddingBreaker();
});

afterEach(() => {
  vi.restoreAllMocks();
  resetEmbeddingConfig();
  resetEmbeddingBreaker();
  closeDb();
});

// -- cosineSimilarity ---------------------------------------------------------

describe("cosineSimilarity", () => {
  it("идентичные векторы → 1", () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 6);
  });
  it("ортогональные → 0", () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 6);
  });
  it("разная длина → 0 (безопасно)", () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2])).toBe(0);
  });
  it("нулевой вектор → 0", () => {
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
  });
});

// -- isEmbeddingEnabled / OFF by default --------------------------------------

describe("isEmbeddingEnabled — OFF by default", () => {
  it("пустой base_url → выключено", () => {
    expect(
      isEmbeddingEnabled({ embeddingBaseUrl: "", embeddingApiKey: "", embeddingModel: "m" }),
    ).toBe(false);
  });
  it("пустая model → выключено", () => {
    expect(
      isEmbeddingEnabled({
        embeddingBaseUrl: "http://x/v1",
        embeddingApiKey: "",
        embeddingModel: "",
      }),
    ).toBe(false);
  });
  it("base_url + model → включено", () => {
    expect(isEmbeddingEnabled(ENABLED)).toBe(true);
  });
});

// -- embedding cache hit ------------------------------------------------------

describe("embedManyCached — кэш", () => {
  it("повторный текст НЕ эмбеддится снова (cache hit)", async () => {
    setEmbeddingConfig(ENABLED);
    const fetchFn = mockEmbedFetch();
    const nowMs = 1_000_000;

    const first = await embedManyCached(["люблю кофе", "тревожусь о работе"], ENABLED, nowMs);
    expect(first.size).toBe(2);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(embeddingCacheSize()).toBe(2);

    // Второй вызов с теми же текстами → попадание в кэш, без новой сети.
    const second = await embedManyCached(["люблю кофе", "тревожусь о работе"], ENABLED, nowMs + 1);
    expect(second.size).toBe(2);
    expect(fetchFn).toHaveBeenCalledTimes(1); // НЕ вырос — кэш-хит
  });

  it("новый текст при тёплом кэше эмбеддит только промах", async () => {
    setEmbeddingConfig(ENABLED);
    const fetchFn = mockEmbedFetch();
    const nowMs = 2_000_000;

    await embedManyCached(["люблю кофе"], ENABLED, nowMs);
    expect(fetchFn).toHaveBeenCalledTimes(1);

    await embedManyCached(["люблю кофе", "новый факт"], ENABLED, nowMs + 1);
    expect(fetchFn).toHaveBeenCalledTimes(2); // только "новый факт" ушёл в сеть
    // во втором запросе input содержал ровно один (промах)
    const secondBody = JSON.parse(fetchFn.mock.calls[1][1].body) as { input: string[] };
    expect(secondBody.input).toEqual(["новый факт"]);
  });
});

// -- OFF by default: recall == keyword ---------------------------------------

describe("recall — OFF by default (без конфигурации)", () => {
  it("семантика не вызывается, fetch не дёргается, результат = keyword", async () => {
    const fetchFn = vi.fn();
    vi.stubGlobal("fetch", fetchFn);
    const nowMs = 5_000_000;
    const graph = new WorldModel();
    graph.tick = 100;
    graph.addAgent("self", {});
    addFact(graph, "self", "люблю пить кофе по утрам", nowMs);
    addFact(graph, "self", "вчера переживал из-за дедлайна", nowMs);

    const ctx = makeCtx({ graph, nowMs });
    const res = await runRecall(ctx, "кофе");

    expect(fetchFn).not.toHaveBeenCalled();
    expect(res.facts.map((f) => f.text)).toContain("люблю пить кофе по утрам");
    // «переживал» не содержит "кофе" → keyword его не находит
    expect(res.facts.map((f) => f.text)).not.toContain("вчера переживал из-за дедлайна");
  });
});

// -- graceful fallback: server unreachable -----------------------------------

describe("recall — GRACEFUL fallback (сервер недоступен)", () => {
  it("fetch падает → recall идентичен keyword-пути (не ломается)", async () => {
    setEmbeddingConfig(ENABLED);
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));

    const nowMs = 6_000_000;
    const graph = new WorldModel();
    graph.tick = 100;
    graph.addAgent("self", {});
    addFact(graph, "self", "люблю пить кофе по утрам", nowMs);
    addFact(graph, "self", "вчера переживал из-за дедлайна", nowMs);

    const ctx = makeCtx({ graph, nowMs });
    const res = await runRecall(ctx, "кофе");

    // Идентично keyword: только кофейный факт, без падения.
    expect(res.facts.map((f) => f.text)).toEqual(["люблю пить кофе по утрам"]);
    expect(res.empty).toBe(false);
  });

  it("HTTP 500 → keyword-поведение", async () => {
    setEmbeddingConfig(ENABLED);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500 }));

    const nowMs = 6_500_000;
    const graph = new WorldModel();
    graph.tick = 100;
    graph.addAgent("self", {});
    addFact(graph, "self", "люблю пить кофе по утрам", nowMs);

    const ctx = makeCtx({ graph, nowMs });
    const res = await runRecall(ctx, "кофе");
    expect(res.facts.map((f) => f.text)).toEqual(["люблю пить кофе по утрам"]);
  });
});

// -- additive blend -----------------------------------------------------------

describe("recall — ADDITIVE семантический бленд", () => {
  it("поднимает семантически близкий факт, который keyword НЕ нашёл", async () => {
    setEmbeddingConfig(ENABLED);
    mockEmbedFetch();

    const nowMs = 7_000_000;
    const graph = new WorldModel();
    graph.tick = 100;
    graph.addAgent("self", {});
    // Запрос «тревога»; этот факт по словам не совпадает, но по смыслу — да.
    addFact(graph, "self", "вчера сильно волновался перед встречей", nowMs);
    // Нерелевантный по смыслу факт (тема напитков).
    addFact(graph, "self", "купил новый сорт чая", nowMs);

    const ctx = makeCtx({ graph, nowMs });
    const res = await runRecall(ctx, "тревожусь о будущем");

    const texts = res.facts.map((f) => f.text);
    // Семантика подняла «волновался» (та же ось «тревога»).
    expect(texts).toContain("вчера сильно волновался перед встречей");
    // Чай — другая ось → ниже порога → не всплывает.
    expect(texts).not.toContain("купил новый сорт чая");
  });

  it("keyword-хиты СОХРАНЯЮТСЯ (семантика только добавляет)", async () => {
    setEmbeddingConfig(ENABLED);
    mockEmbedFetch();

    const nowMs = 8_000_000;
    const graph = new WorldModel();
    graph.tick = 100;
    graph.addAgent("self", {});
    addFact(graph, "self", "люблю кофе с молоком", nowMs); // keyword + семантика
    addFact(graph, "self", "переживаю из-за кофе вечером", nowMs); // keyword «кофе»

    const ctx = makeCtx({ graph, nowMs });
    const res = await runRecall(ctx, "кофе");

    const texts = res.facts.map((f) => f.text);
    // Оба keyword-хита остаются.
    expect(texts).toContain("люблю кофе с молоком");
    expect(texts).toContain("переживаю из-за кофе вечером");
  });

  it("результат с семантикой ⊇ результата без неё (никогда не теряет keyword-кандидатов)", async () => {
    const nowMs = 9_000_000;
    const build = () => {
      const graph = new WorldModel();
      graph.tick = 100;
      graph.addAgent("self", {});
      addFact(graph, "self", "люблю пить кофе по утрам", nowMs);
      addFact(graph, "self", "тревожусь о работе постоянно", nowMs);
      return graph;
    };

    // Без семантики
    resetEmbeddingConfig();
    const fetchOff = vi.fn();
    vi.stubGlobal("fetch", fetchOff);
    const keywordRes = await runRecall(makeCtx({ graph: build(), nowMs }), "кофе");
    const keywordTexts = new Set(keywordRes.facts.map((f) => f.text));

    // С семантикой
    resetEmbeddingBreaker();
    setEmbeddingConfig(ENABLED);
    mockEmbedFetch();
    const semRes = await runRecall(makeCtx({ graph: build(), nowMs }), "кофе");
    const semTexts = new Set(semRes.facts.map((f) => f.text));

    // Все keyword-кандидаты присутствуют и в семантическом результате.
    for (const t of keywordTexts) expect(semTexts.has(t)).toBe(true);
  });
});
