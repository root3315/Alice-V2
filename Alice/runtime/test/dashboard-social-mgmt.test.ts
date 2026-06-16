/**
 * Dashboard управление контактами/каналами (TASK E) + содержимое памяти (TASK D) +
 * расширенная семантика (TASK B) — тесты эндпоинтов и формы ответа.
 *
 * Покрывает:
 *  - POST /dashboard/contact-mute: ставит/снимает muted на узле channel ИЛИ contact;
 *    подтверждает off-by-default (узел без флага), reversible (снятие), keeps memory (узел жив);
 *  - POST /dashboard/contact-delete: удаляет узел + его факты (деструктивно);
 *  - GET /dashboard/memory-detail: содержимое (selfFacts/contactFacts/kb/diary), резильентно;
 *  - GET /dashboard/embeddings-detail: расширенная форма ответа (кеш + живая проба).
 *
 * БД — реальный in-memory через initDb(":memory:") (миграции создают embedding_cache/diary_entries).
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { closeDb, initDb } from "../src/db/connection.js";
import { handleDashboard } from "../src/engine-api/routes/dashboard.js";
import type { EngineApiDeps } from "../src/engine-api/server.js";
import { ALICE_SELF } from "../src/graph/constants.js";
import { WorldModel } from "../src/graph/world-model.js";
import { getContactFacts } from "../src/mods/relationships.mod.js";

// ── http моки (зеркалят sticker-admin.test) ──────────────────────────────────

function makeReq(url: string, method = "GET"): IncomingMessage {
  // biome-ignore lint/suspicious/noExplicitAny: test mock
  const listeners: Record<string, Array<(...args: any[]) => void>> = {};
  return {
    method,
    url,
    headers: {},
    // biome-ignore lint/suspicious/noExplicitAny: test mock
    on(event: string, cb: (...args: any[]) => void) {
      listeners[event] ??= [];
      listeners[event].push(cb);
      return this;
    },
    [Symbol.for("vitest.dispatchListeners")]: listeners,
    resume() {
      return this;
    },
  } as unknown as IncomingMessage;
}

async function runBody(req: IncomingMessage, body?: unknown): Promise<void> {
  const listeners = (req as unknown as Record<PropertyKey, unknown>)[
    Symbol.for("vitest.dispatchListeners")
    // biome-ignore lint/suspicious/noExplicitAny: test mock callback
  ] as Record<string, Array<(...args: any[]) => void>> | undefined;
  if (!listeners) return;
  if (body !== undefined) {
    for (const cb of listeners.data ?? []) cb(Buffer.from(JSON.stringify(body)));
  }
  for (const cb of listeners.end ?? []) cb();
}

function makeRes() {
  let statusCode = 200;
  let bodyBuf: Buffer = Buffer.alloc(0);
  const res = {
    headersSent: false,
    writeHead(code: number) {
      statusCode = code;
      return this;
    },
    end(chunk?: string | Buffer) {
      if (chunk != null) bodyBuf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      this.headersSent = true;
      return this;
    },
  };
  return {
    res: res as unknown as ServerResponse,
    snapshot: () => ({
      statusCode,
      // biome-ignore lint/suspicious/noExplicitAny: тестовый снимок
      json: (bodyBuf.length ? JSON.parse(bodyBuf.toString("utf-8")) : null) as any,
    }),
  };
}

function baseDeps(G: WorldModel, extra: Partial<EngineApiDeps> = {}): EngineApiDeps {
  return {
    config: { timezoneOffset: 0, exaApiKey: "", musicApiBaseUrl: "", youtubeApiKey: "" },
    G,
    ...extra,
  } as EngineApiDeps;
}

function makeContactGraph(): WorldModel {
  const G = new WorldModel();
  G.addAgent(ALICE_SELF);
  G.addContact("contact:telegram:42", { tier: 50, display_name: "Боб" });
  G.addChannel("channel:telegram:-100", {
    chat_type: "supergroup",
    unread: 0,
    tier_contact: 150,
    pending_directed: 0,
    last_directed_ms: 0,
    display_name: "Группа",
  });
  return G;
}

beforeEach(() => {
  initDb(":memory:");
});
afterEach(() => {
  vi.restoreAllMocks();
  closeDb();
});

// ═══════════════════════════════════════════════════════════════════════════
// TASK E: contact-mute
// ═══════════════════════════════════════════════════════════════════════════

describe("POST /dashboard/contact-mute", () => {
  it("off-by-default: узел без действий не имеет muted", () => {
    const G = makeContactGraph();
    expect(G.getContact("contact:telegram:42").muted).toBeUndefined();
    expect(G.getChannel("channel:telegram:-100").muted).toBeUndefined();
  });

  it("ставит muted на контакт и снимает (reversible), узел и память остаются (keeps memory)", async () => {
    const G = makeContactGraph();
    const deps = baseDeps(G);

    // mute
    {
      const res = makeRes();
      const req = makeReq("/dashboard/contact-mute", "POST");
      const p = handleDashboard("contact-mute", "POST", req, res.res, deps);
      await runBody(req, { id: "contact:telegram:42", muted: true });
      await p;
      const snap = res.snapshot();
      expect(snap.statusCode).toBe(200);
      expect(snap.json).toEqual({ ok: true, id: "contact:telegram:42", muted: true });
    }
    expect(G.getContact("contact:telegram:42").muted).toBe(true);
    // Узел жив (keeps memory).
    expect(G.has("contact:telegram:42")).toBe(true);

    // unmute (reversible)
    {
      const res = makeRes();
      const req = makeReq("/dashboard/contact-mute", "POST");
      const p = handleDashboard("contact-mute", "POST", req, res.res, deps);
      await runBody(req, { id: "contact:telegram:42", muted: false });
      await p;
      expect(res.snapshot().json).toEqual({ ok: true, id: "contact:telegram:42", muted: false });
    }
    expect(G.getContact("contact:telegram:42").muted).toBe(false);
    expect(G.has("contact:telegram:42")).toBe(true);
  });

  it("ставит muted на канал", async () => {
    const G = makeContactGraph();
    const deps = baseDeps(G);
    const res = makeRes();
    const req = makeReq("/dashboard/contact-mute", "POST");
    const p = handleDashboard("contact-mute", "POST", req, res.res, deps);
    await runBody(req, { id: "channel:telegram:-100", muted: true });
    await p;
    expect(res.snapshot().statusCode).toBe(200);
    expect(G.getChannel("channel:telegram:-100").muted).toBe(true);
  });

  it("неизвестный узел → 404", async () => {
    const G = makeContactGraph();
    const res = makeRes();
    const req = makeReq("/dashboard/contact-mute", "POST");
    const p = handleDashboard("contact-mute", "POST", req, res.res, baseDeps(G));
    await runBody(req, { id: "contact:telegram:999", muted: true });
    await p;
    expect(res.snapshot().statusCode).toBe(404);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// TASK E: contact-delete (деструктивно)
// ═══════════════════════════════════════════════════════════════════════════

describe("POST /dashboard/contact-delete", () => {
  it("удаляет узел и его факты", async () => {
    const G = makeContactGraph();
    // Навешиваем факт на контакт.
    G.addFact("fact_x", { content: "любит кофе", source_contact: "contact:telegram:42" });
    G.addRelation("contact:telegram:42", "knows", "fact_x");
    expect(getContactFacts(G, "contact:telegram:42")).toHaveLength(1);

    const res = makeRes();
    const req = makeReq("/dashboard/contact-delete", "POST");
    const p = handleDashboard("contact-delete", "POST", req, res.res, baseDeps(G));
    await runBody(req, { id: "contact:telegram:42" });
    await p;
    const snap = res.snapshot();
    expect(snap.statusCode).toBe(200);
    expect(snap.json).toMatchObject({ ok: true, id: "contact:telegram:42", removedFacts: 1 });

    // Узел и факт исчезли.
    expect(G.has("contact:telegram:42")).toBe(false);
    expect(G.has("fact_x")).toBe(false);
  });

  it("неизвестный узел → 404", async () => {
    const G = makeContactGraph();
    const res = makeRes();
    const req = makeReq("/dashboard/contact-delete", "POST");
    const p = handleDashboard("contact-delete", "POST", req, res.res, baseDeps(G));
    await runBody(req, { id: "contact:telegram:404" });
    await p;
    expect(res.snapshot().statusCode).toBe(404);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// TASK D: memory-detail
// ═══════════════════════════════════════════════════════════════════════════

describe("GET /dashboard/memory-detail", () => {
  it("возвращает корзины selfFacts/contactFacts/kb/diary; резильентен на пустом графе", async () => {
    const G = new WorldModel();
    G.addAgent(ALICE_SELF);
    const res = makeRes();
    await handleDashboard("memory-detail", "GET", makeReq("/dashboard/memory-detail"), res.res, baseDeps(G));
    const snap = res.snapshot();
    expect(snap.statusCode).toBe(200);
    expect(snap.json).toMatchObject({ selfFacts: [], contactFacts: [], kb: [], diary: [] });
  });

  it("раскладывает факты по корзинам (self / contact / kb)", async () => {
    const G = new WorldModel();
    G.addAgent(ALICE_SELF);
    G.addContact("contact:telegram:7", { tier: 50, display_name: "Кай" });
    // self-факт
    G.addFact("f_self", { content: "я люблю дождь", source_contact: ALICE_SELF, fact_type: "preference" });
    G.addRelation(ALICE_SELF, "knows", "f_self");
    // факт о контакте
    G.addFact("f_c", { content: "Кай играет на гитаре", source_contact: "contact:telegram:7" });
    G.addRelation("contact:telegram:7", "knows", "f_c");
    // kb-факт
    G.addFact("f_kb", { content: "столица Франции — Париж", fact_type: "kb", source: "llm" });

    const res = makeRes();
    await handleDashboard("memory-detail", "GET", makeReq("/dashboard/memory-detail"), res.res, baseDeps(G));
    const snap = res.snapshot();
    expect(snap.statusCode).toBe(200);
    expect(snap.json.counts).toMatchObject({ selfFacts: 1, contactFacts: 1, kb: 1 });
    expect(snap.json.selfFacts[0].content).toBe("я люблю дождь");
    expect(snap.json.contactFacts[0]).toMatchObject({ content: "Кай играет на гитаре", owner: "Кай" });
    expect(snap.json.kb[0].content).toBe("столица Франции — Париж");
    // R вычислен (число 0..1).
    expect(typeof snap.json.selfFacts[0].R).toBe("number");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// TASK B: embeddings-detail
// ═══════════════════════════════════════════════════════════════════════════

describe("GET /dashboard/embeddings-detail", () => {
  it("форма ответа: расширенная разбивка кеша + живая проба", async () => {
    const G = new WorldModel();
    G.addAgent(ALICE_SELF);
    const embeddingProbe = vi.fn(async () => ({
      reachable: true,
      dim: 1024,
      latencyMs: 9,
      reason: null,
    }));
    const res = makeRes();
    await handleDashboard(
      "embeddings-detail",
      "GET",
      makeReq("/dashboard/embeddings-detail"),
      res.res,
      baseDeps(G, { embeddingProbe }),
    );
    const snap = res.snapshot();
    expect(snap.statusCode).toBe(200);
    expect(embeddingProbe).toHaveBeenCalledOnce();
    // Новые поля присутствуют (на пустом кеше — нули/null, без падений).
    expect(snap.json).toMatchObject({
      reachable: true,
      dim: 1024,
      cacheRows: 0,
      cachedModels: 0,
    });
    expect(snap.json).toHaveProperty("oldestMs");
    expect(snap.json).toHaveProperty("newestMs");
    expect(snap.json).toHaveProperty("approxBytes");
    expect(snap.json).toHaveProperty("currentModelRows");
    expect(snap.json).toHaveProperty("staleRows");
    expect(Array.isArray(snap.json.recent)).toBe(true);
  });

  it("never throws когда проба rejects — degrade to reachable=false", async () => {
    const G = new WorldModel();
    G.addAgent(ALICE_SELF);
    const embeddingProbe = vi.fn(async () => {
      throw new Error("boom");
    });
    const res = makeRes();
    await handleDashboard(
      "embeddings-detail",
      "GET",
      makeReq("/dashboard/embeddings-detail"),
      res.res,
      baseDeps(G, { embeddingProbe }),
    );
    const snap = res.snapshot();
    expect(snap.statusCode).toBe(200);
    expect(snap.json.reachable).toBe(false);
    expect(snap.json.probeReason).toBe("boom");
  });
});
