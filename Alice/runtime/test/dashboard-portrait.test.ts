/**
 * Dashboard «портрет + семантика» — тесты формы ответа и резильентности.
 *
 * Покрывает:
 *  - GET /dashboard/embeddings: форма ответа + ЖИВАЯ проба TEI (мок embeddingProbe:
 *    достижим / недоступен / отсутствует deps);
 *  - GET /dashboard/data: новые блоки портрета (voicesState/affect/explore/commitments/
 *    memory/llmStatus/embeddings) присутствуют и не роняют дашборд при пустой БД.
 *
 * Использует реальную in-memory БД (initDb), чтобы миграции создали embedding_cache /
 * mod_states / diary_entries / tick_log с актуальным DDL (никакого inline CREATE TABLE).
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDb, initDb } from "../src/db/connection.js";
import { routeRequest } from "../src/engine-api/server.js";
import { WorldModel } from "../src/graph/world-model.js";

function makeGetReq(url: string): IncomingMessage {
  return { method: "GET", url, headers: {} } as IncomingMessage;
}

function makeRes() {
  let statusCode = 200;
  let body = "";
  const res = {
    headersSent: false,
    writeHead(code: number) {
      statusCode = code;
      return this;
    },
    end(chunk?: string) {
      body = chunk ?? "";
      this.headersSent = true;
      return this;
    },
  };
  return {
    res: res as unknown as ServerResponse,
    snapshot: () => ({ statusCode, body: body ? JSON.parse(body) : null }),
  };
}

function baseDeps(G: WorldModel, extra: Record<string, unknown> = {}) {
  return {
    config: { timezoneOffset: 8, exaApiKey: "", musicApiBaseUrl: "", youtubeApiKey: "" },
    G,
    strictCapabilities: false,
    registry: {},
    ...extra,
  };
}

describe("Dashboard page browser JS", () => {
  beforeEach(() => {
    initDb(":memory:");
  });
  afterEach(() => {
    closeDb();
  });

  // Регресс: инлайн-JS дашборда собирается внутри template-literal DASHBOARD_HTML.
  // Неверное экранирование (\" схлопывается в ") рвёт строку → весь скрипт не парсится
  // → дашборд висит на «загрузка». Тесты эндпоинтов это НЕ ловят (браузерный JS).
  it("inline <script> of the dashboard page parses (no browser syntax errors)", async () => {
    const G = new WorldModel();
    G.addAgent("self");
    const deps = baseDeps(G);
    let html = "";
    const res = {
      writeHead() {},
      end(chunk?: string) {
        html = chunk ?? "";
      },
    } as unknown as ServerResponse;

    await routeRequest(makeGetReq("/dashboard"), res, deps);
    expect(html).toContain("<html");

    const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
    const blocks: string[] = [];
    let m: RegExpExecArray | null;
    // biome-ignore lint/suspicious/noAssignInExpressions: regex exec loop
    while ((m = re.exec(html)) !== null) {
      if (m[1]?.trim()) blocks.push(m[1]);
    }
    expect(blocks.length).toBeGreaterThan(0);
    for (const b of blocks) {
      // new Function ПАРСИТ тело (не исполняет) — бросает на синтакс-ошибке браузерного JS.
      // biome-ignore lint/security/noGlobalEval: намеренная синтакс-проверка
      // biome-ignore lint/complexity/noUselessConstructorInitializer: parse-check
      expect(() => new Function(b)).not.toThrow();
    }
  });
});

describe("Dashboard embeddings endpoint", () => {
  beforeEach(() => {
    initDb(":memory:");
  });
  afterEach(() => {
    closeDb();
  });

  it("reports reachable=true and dim from a live probe", async () => {
    const G = new WorldModel();
    G.addAgent("self");
    const embeddingProbe = vi.fn(async () => ({
      reachable: true,
      dim: 1024,
      latencyMs: 12,
      reason: null,
    }));
    const deps = baseDeps(G, { embeddingProbe });

    const r = makeRes();
    await routeRequest(makeGetReq("/dashboard/embeddings"), r.res, deps);
    const snap = r.snapshot();

    expect(embeddingProbe).toHaveBeenCalledOnce();
    expect(snap.statusCode).toBe(200);
    expect(snap.body).toMatchObject({
      reachable: true,
      dim: 1024,
      probeLatencyMs: 12,
      // disabled by default (no embedding config set) — статика честно говорит enabled=false
      enabled: false,
      cacheRows: 0,
    });
    // Форма: ключи живой пробы + статики присутствуют.
    expect(snap.body).toHaveProperty("model");
    expect(snap.body).toHaveProperty("baseUrl");
    expect(snap.body).toHaveProperty("probeReason");
  });

  it("reports reachable=false with a reason when the server is unreachable", async () => {
    const G = new WorldModel();
    G.addAgent("self");
    const embeddingProbe = vi.fn(async () => ({
      reachable: false,
      dim: null,
      latencyMs: 4000,
      reason: "timeout",
    }));
    const deps = baseDeps(G, { embeddingProbe });

    const r = makeRes();
    await routeRequest(makeGetReq("/dashboard/embeddings"), r.res, deps);
    const snap = r.snapshot();

    expect(snap.statusCode).toBe(200);
    expect(snap.body).toMatchObject({
      reachable: false,
      probeReason: "timeout",
      probeLatencyMs: 4000,
    });
  });

  it("never throws when the probe dep itself rejects — degrades to reachable=false", async () => {
    const G = new WorldModel();
    G.addAgent("self");
    const embeddingProbe = vi.fn(async () => {
      throw new Error("boom");
    });
    const deps = baseDeps(G, { embeddingProbe });

    const r = makeRes();
    await routeRequest(makeGetReq("/dashboard/embeddings"), r.res, deps);
    const snap = r.snapshot();

    expect(snap.statusCode).toBe(200);
    expect(snap.body.reachable).toBe(false);
    expect(snap.body.probeReason).toBe("boom");
  });

  it("works with no probe dep configured (reachable=false, reason=disabled)", async () => {
    const G = new WorldModel();
    G.addAgent("self");
    const deps = baseDeps(G); // no embeddingProbe

    const r = makeRes();
    await routeRequest(makeGetReq("/dashboard/embeddings"), r.res, deps);
    const snap = r.snapshot();

    expect(snap.statusCode).toBe(200);
    expect(snap.body.reachable).toBe(false);
    // enabled=false (no config) → проба отдаёт reason="disabled"
    expect(snap.body.enabled).toBe(false);
  });
});

describe("Dashboard data endpoint — portrait blocks", () => {
  beforeEach(() => {
    initDb(":memory:");
  });
  afterEach(() => {
    closeDb();
  });

  it("returns the new portrait blocks and degrades gracefully on an empty graph/DB", async () => {
    const G = new WorldModel();
    G.addAgent("self");
    const deps = baseDeps(G, { getTick: () => 0 });

    const r = makeRes();
    await routeRequest(makeGetReq("/dashboard/data"), r.res, deps);
    const snap = r.snapshot();

    expect(snap.statusCode).toBe(200);
    const d = snap.body;

    // Новые блоки присутствуют (не undefined): voicesState/affect/explore/commitments/memory/
    // llmStatus/embeddings. На пустой БД они дают безопасные нули/null, а не падают.
    expect(d).toHaveProperty("voicesState");
    expect(d).toHaveProperty("affect");
    expect(d).toHaveProperty("explore");
    expect(d).toHaveProperty("commitments");
    expect(d).toHaveProperty("memory");
    expect(d).toHaveProperty("llmStatus");
    expect(d).toHaveProperty("embeddings");

    // explore: пустое mod-state → counts = 0, флаг — булев или null.
    expect(d.explore).toMatchObject({ joinsToday: 0, dailyCap: expect.any(Number) });

    // commitments: пусто → open/done/total = 0.
    expect(d.commitments).toMatchObject({ open: 0, done: 0, total: 0 });

    // memory: facts=0, дневник=0, недавние записи — массив.
    expect(d.memory).toMatchObject({ facts: 0, diary: 0 });
    expect(Array.isArray(d.memory.recentDiary)).toBe(true);

    // embeddings (статика): выключено по умолчанию, кеш пуст.
    expect(d.embeddings).toMatchObject({ enabled: false, cacheRows: 0 });

    // summary обогащён новыми сводными полями.
    expect(d.summary).toHaveProperty("commitmentsOpen");
    expect(d.summary).toHaveProperty("embeddingsEnabled");
    expect(d.summary).toHaveProperty("embeddingCacheRows");
  });
});
