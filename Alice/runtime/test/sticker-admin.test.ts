/**
 * Sticker Admin — юнит-тесты панели стикеров дашборда + гарантии исключения disabled.
 *
 * Покрытие (всё замокано — никакой реальной сети):
 *  1. Селекторы НИКОГДА не возвращают disabled=1 стикер: resolveLabel (измерение/текст/vlm),
 *     resolveByEmoji (own/fallback), pickAnySticker (own/all), resolveLabelSemantic (own/fallback).
 *  2. listStickerPacks: группировка по set_name + count/enabledCount/curated + NULL-группа.
 *  3. getStickerPack: возвращает строки пака (вкл. отключённые); setStickerDisabled пишет флаг.
 *  4. lookupStickerFileId: поиск по id и по fileUniqueId.
 *  5. Эндпоинты дашборда: sticker-packs / sticker-pack / sticker-toggle / sticker-image
 *     (downloader замокан через deps.telegramStickerImage; 204 при null).
 *
 * БД — реальный in-memory через initDb(":memory:") (применяет миграции, включая 0031).
 *
 * @see src/telegram/apps/sticker-palette.ts
 * @see src/engine-api/routes/dashboard.ts
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { closeDb, getDb, initDb } from "../src/db/connection.js";
import { stickerPalette } from "../src/db/schema.js";
import { handleDashboard } from "../src/engine-api/routes/dashboard.js";
import type { EngineApiDeps } from "../src/engine-api/server.js";
import { ALICE_SELF } from "../src/graph/constants.js";
import { WorldModel } from "../src/graph/world-model.js";
import { getContactFacts } from "../src/mods/relationships.mod.js";
import { resetEmbeddingBreaker } from "../src/llm/embeddings.js";
import type { EmbeddingConfig } from "../src/llm/embeddings.js";
import {
  deleteSticker,
  getStickerPack,
  listStickerPacks,
  lookupStickerFileId,
  pickAnySticker,
  resolveByEmoji,
  resolveLabel,
  resolveLabelSemantic,
  setStickerDisabled,
} from "../src/telegram/apps/sticker-palette.js";

// ── фикстуры ────────────────────────────────────────────────────────────────

const EMBED_ENABLED: EmbeddingConfig = {
  embeddingBaseUrl: "http://127.0.0.1:11434/v1",
  embeddingApiKey: "",
  embeddingModel: "bge-m3",
};

interface Row {
  label: string;
  fileId: string;
  fileUniqueId: string;
  emoji?: string;
  setName?: string;
  curated?: number;
  emotion?: string;
  action?: string;
  intensity?: string;
  disabled?: number;
  signature?: number;
  meaning?: string;
}

function insert(rows: Row[]): void {
  getDb()
    .insert(stickerPalette)
    .values(
      rows.map((r) => ({
        label: r.label,
        fileId: r.fileId,
        fileUniqueId: r.fileUniqueId,
        emoji: r.emoji,
        setName: r.setName,
        curated: r.curated ?? 0,
        emotion: r.emotion ?? "neutral",
        action: r.action ?? "none",
        intensity: r.intensity ?? "medium",
        disabled: r.disabled ?? 0,
        signature: r.signature ?? 0,
        meaning: r.meaning,
      })),
    )
    .run();
}

/** Детерминированный фейковый эмбеддинг (как в sticker-indexer.test). */
function fakeEmbedding(text: string): number[] {
  const t = text.toLowerCase();
  let axis = 2;
  if (/(happy|рад|весел|joy|smile)/.test(t)) axis = 0;
  else if (/(sad|груст|cry|плач)/.test(t)) axis = 1;
  const v = [0, 0, 0, 0];
  v[axis] = 1;
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

// ── жизненный цикл ────────────────────────────────────────────────────────────

beforeEach(() => {
  initDb(":memory:");
  resetEmbeddingBreaker();
});

afterEach(() => {
  vi.restoreAllMocks();
  resetEmbeddingBreaker();
  closeDb();
});

// ═══════════════════════════════════════════════════════════════════════════
// 1. Селекторы исключают disabled=1 по ВСЕМ путям
// ═══════════════════════════════════════════════════════════════════════════

describe("selection excludes disabled stickers", () => {
  it("resolveLabel: совпадение по измерению (own pool) пропускает disabled", () => {
    insert([
      {
        label: "happy own",
        fileId: "fid_off",
        fileUniqueId: "uid_off",
        setName: "pack",
        emotion: "happy",
        disabled: 1,
      },
    ]);
    // Единственный happy-стикер отключён → null (не просачивается).
    expect(resolveLabel(getDb(), "happy")).toBeNull();

    // Добавляем включённый — теперь возвращается он, а не отключённый.
    insert([
      {
        label: "happy own 2",
        fileId: "fid_on",
        fileUniqueId: "uid_on",
        setName: "pack",
        emotion: "happy",
        disabled: 0,
      },
    ]);
    expect(resolveLabel(getDb(), "happy")).toBe("fid_on");
  });

  it("resolveLabel: измерение fallback pool (setName NULL) пропускает disabled", () => {
    insert([
      {
        label: "sad vlm",
        fileId: "fid_sad_off",
        fileUniqueId: "uid_sad_off",
        emotion: "sad",
        disabled: 1,
      },
    ]);
    expect(resolveLabel(getDb(), "sad")).toBeNull();
  });

  it("resolveLabel: текстовое совпадение (own/vlm) пропускает disabled", () => {
    insert([
      {
        label: "exact dancing label",
        fileId: "fid_txt_off",
        fileUniqueId: "uid_txt_off",
        setName: "pack",
        emotion: "neutral",
        action: "none",
        disabled: 1,
      },
      {
        label: "exact crying label",
        fileId: "fid_vlm_off",
        fileUniqueId: "uid_vlm_off",
        emotion: "neutral",
        action: "none",
        disabled: 1,
      },
    ]);
    expect(resolveLabel(getDb(), "exact dancing label")).toBeNull();
    expect(resolveLabel(getDb(), "exact crying label")).toBeNull();
  });

  it("resolveByEmoji: own и fallback пулы пропускают disabled", () => {
    // happy → 😊. Own отключён → null.
    insert([
      {
        label: "smile own",
        fileId: "fid_e_off",
        fileUniqueId: "uid_e_off",
        emoji: "😊",
        setName: "pack",
        disabled: 1,
      },
    ]);
    expect(resolveByEmoji(getDb(), "happy")).toBeNull();

    // fallback (NULL setName) тоже отключён → по-прежнему null.
    insert([
      {
        label: "smile vlm",
        fileId: "fid_e_off2",
        fileUniqueId: "uid_e_off2",
        emoji: "😊",
        disabled: 1,
      },
    ]);
    expect(resolveByEmoji(getDb(), "happy")).toBeNull();
  });

  it("pickAnySticker: own и all-fallback пулы пропускают disabled", () => {
    insert([
      {
        label: "any own off",
        fileId: "fid_any_off",
        fileUniqueId: "uid_any_off",
        setName: "pack",
        disabled: 1,
      },
    ]);
    // own отключён, all-fallback тоже пуст (та же отключённая строка) → null.
    expect(pickAnySticker(getDb())).toBeNull();

    insert([
      {
        label: "any own on",
        fileId: "fid_any_on",
        fileUniqueId: "uid_any_on",
        setName: "pack",
        disabled: 0,
      },
    ]);
    expect(pickAnySticker(getDb())).toBe("fid_any_on");
  });

  it("resolveLabelSemantic: own и fallback кандидаты пропускают disabled", async () => {
    mockEmbedFetch();
    // Единственный happy-кандидат (own, curated) отключён → null даже при попадании в ось.
    insert([
      {
        label: "happy smiling face",
        fileId: "fid_sem_off",
        fileUniqueId: "uid_sem_off",
        setName: "pack",
        curated: 1,
        emotion: "happy",
        disabled: 1,
      },
    ]);
    expect(await resolveLabelSemantic(getDb(), "joy smile", EMBED_ENABLED)).toBeNull();

    // Включённый happy-кандидат → возвращается.
    insert([
      {
        label: "happy grinning face",
        fileId: "fid_sem_on",
        fileUniqueId: "uid_sem_on",
        setName: "pack",
        curated: 1,
        emotion: "happy",
        disabled: 0,
      },
    ]);
    expect(await resolveLabelSemantic(getDb(), "joy smile", EMBED_ENABLED)).toBe("fid_sem_on");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. listStickerPacks — группировка + счётчики
// ═══════════════════════════════════════════════════════════════════════════

describe("listStickerPacks", () => {
  it("группирует по set_name, считает count/enabledCount/curated + NULL-группа", () => {
    insert([
      { label: "a", fileId: "f1", fileUniqueId: "u1", setName: "packA", curated: 1, disabled: 0 },
      { label: "b", fileId: "f2", fileUniqueId: "u2", setName: "packA", curated: 0, disabled: 1 },
      { label: "c", fileId: "f3", fileUniqueId: "u3", setName: "packB", curated: 0, disabled: 0 },
      { label: "d", fileId: "f4", fileUniqueId: "u4", disabled: 0 }, // NULL group
    ]);
    const packs = listStickerPacks(getDb());

    const a = packs.find((p) => p.setName === "packA");
    expect(a).toMatchObject({ count: 2, enabledCount: 1, curated: true });
    const b = packs.find((p) => p.setName === "packB");
    expect(b).toMatchObject({ count: 1, enabledCount: 1, curated: false });
    const nul = packs.find((p) => p.setName === null);
    expect(nul).toMatchObject({ count: 1, enabledCount: 1 });
    expect(nul?.label).toBe("(найденные в чатах)");

    // NULL-группа последняя.
    expect(packs[packs.length - 1].setName).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. getStickerPack + setStickerDisabled + lookupStickerFileId
// ═══════════════════════════════════════════════════════════════════════════

describe("getStickerPack / setStickerDisabled / lookup", () => {
  it("getStickerPack возвращает строки пака, включая отключённые", () => {
    insert([
      { label: "x", fileId: "fx", fileUniqueId: "ux", setName: "pk", emoji: "😊", disabled: 0 },
      { label: "y", fileId: "fy", fileUniqueId: "uy", setName: "pk", emoji: "😢", disabled: 1 },
      { label: "z", fileId: "fz", fileUniqueId: "uz", setName: "other", disabled: 0 },
    ]);
    const rows = getStickerPack(getDb(), "pk");
    expect(rows).toHaveLength(2);
    const y = rows.find((r) => r.fileUniqueId === "uy");
    expect(y?.disabled).toBe(true);
  });

  it("getStickerPack поддерживает NULL-группу (setName=null)", () => {
    insert([
      { label: "v", fileId: "fv", fileUniqueId: "uv", disabled: 0 },
      { label: "w", fileId: "fw", fileUniqueId: "uw", setName: "pk", disabled: 0 },
    ]);
    const rows = getStickerPack(getDb(), null);
    expect(rows.map((r) => r.fileUniqueId)).toEqual(["uv"]);
  });

  it("setStickerDisabled пишет флаг и влияет на выборку", () => {
    insert([
      {
        label: "happy live",
        fileId: "f_live",
        fileUniqueId: "u_live",
        setName: "pk",
        emotion: "happy",
        disabled: 0,
      },
    ]);
    const row = getDb().select().from(stickerPalette).get();
    expect(row).toBeTruthy();
    const id = row?.id ?? 0;

    // До: стикер выбирается.
    expect(resolveLabel(getDb(), "happy")).toBe("f_live");

    // Toggle off.
    expect(setStickerDisabled(getDb(), id, true)).toBe(true);
    expect(resolveLabel(getDb(), "happy")).toBeNull();

    // Toggle on снова.
    expect(setStickerDisabled(getDb(), id, false)).toBe(true);
    expect(resolveLabel(getDb(), "happy")).toBe("f_live");

    // Несуществующий id → false.
    expect(setStickerDisabled(getDb(), 999999, true)).toBe(false);
  });

  it("deleteSticker удаляет строку насовсем и убирает её из выборки", () => {
    insert([
      {
        label: "happy doomed",
        fileId: "f_del",
        fileUniqueId: "u_del",
        setName: "pk",
        emotion: "happy",
        disabled: 0,
      },
    ]);
    const id = getDb().select().from(stickerPalette).get()?.id ?? 0;

    // До удаления стикер выбирается.
    expect(resolveLabel(getDb(), "happy")).toBe("f_del");

    // Удаление → строки больше нет, выборка пуста.
    expect(deleteSticker(getDb(), id)).toBe(true);
    expect(getDb().select().from(stickerPalette).get()).toBeFalsy();
    expect(resolveLabel(getDb(), "happy")).toBeNull();
    expect(lookupStickerFileId(getDb(), { id })).toBeNull();

    // Повторное удаление того же id → false (строки уже нет).
    expect(deleteSticker(getDb(), id)).toBe(false);
    // Несуществующий id → false.
    expect(deleteSticker(getDb(), 999999)).toBe(false);
  });

  it("lookupStickerFileId: по id и по fileUniqueId", () => {
    insert([{ label: "l", fileId: "fl", fileUniqueId: "ul", setName: "pk" }]);
    const row = getDb().select().from(stickerPalette).get();
    const id = row?.id ?? 0;
    expect(lookupStickerFileId(getDb(), { id })?.fileId).toBe("fl");
    expect(lookupStickerFileId(getDb(), { fileUniqueId: "ul" })?.fileId).toBe("fl");
    expect(lookupStickerFileId(getDb(), { id: 999999 })).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. Эндпоинты дашборда (sticker admin)
// ═══════════════════════════════════════════════════════════════════════════

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
  let headers: Record<string, unknown> = {};
  let bodyBuf: Buffer = Buffer.alloc(0);
  const res = {
    headersSent: false,
    writeHead(code: number, h?: Record<string, unknown>) {
      statusCode = code;
      if (h) headers = h;
      return this;
    },
    end(chunk?: string | Buffer) {
      if (chunk != null) bodyBuf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      this.headersSent = true;
      return this;
    },
  };
  const parseJson = (): unknown => {
    if (!bodyBuf.length) return null;
    try {
      return JSON.parse(bodyBuf.toString("utf-8"));
    } catch {
      return null; // бинарное тело (превью) — не JSON
    }
  };
  return {
    res: res as unknown as ServerResponse,
    snapshot: () => ({
      statusCode,
      headers,
      raw: bodyBuf,
      // biome-ignore lint/suspicious/noExplicitAny: тестовый снимок
      json: parseJson() as any,
    }),
  };
}

function baseDeps(extra: Partial<EngineApiDeps> = {}): EngineApiDeps {
  return {
    config: { timezoneOffset: 0, exaApiKey: "", musicApiBaseUrl: "", youtubeApiKey: "" },
    G: new WorldModel(),
    ...extra,
  } as EngineApiDeps;
}

describe("dashboard sticker admin endpoints", () => {
  it("GET /dashboard/sticker-packs → JSON со сводками", async () => {
    insert([
      { label: "a", fileId: "f1", fileUniqueId: "u1", setName: "pk", disabled: 0 },
      { label: "b", fileId: "f2", fileUniqueId: "u2", setName: "pk", disabled: 1 },
    ]);
    const res = makeRes();
    await handleDashboard("sticker-packs", "GET", makeReq("/dashboard/sticker-packs"), res.res, baseDeps());
    const snap = res.snapshot();
    expect(snap.statusCode).toBe(200);
    expect(snap.json).toEqual([{ setName: "pk", label: "pk", count: 2, enabledCount: 1, curated: false }]);
  });

  it("GET /dashboard/sticker-pack?set=pk → стикеры пака", async () => {
    insert([{ label: "a", fileId: "f1", fileUniqueId: "u1", setName: "pk", emoji: "😊", disabled: 1 }]);
    const res = makeRes();
    await handleDashboard(
      "sticker-pack",
      "GET",
      makeReq("/dashboard/sticker-pack?set=pk"),
      res.res,
      baseDeps(),
    );
    const snap = res.snapshot();
    expect(snap.statusCode).toBe(200);
    expect(snap.json).toHaveLength(1);
    expect(snap.json[0]).toMatchObject({ fileUniqueId: "u1", emoji: "😊", disabled: true });
  });

  it("GET /dashboard/sticker-pack без set → 400", async () => {
    const res = makeRes();
    await handleDashboard(
      "sticker-pack",
      "GET",
      makeReq("/dashboard/sticker-pack"),
      res.res,
      baseDeps(),
    );
    expect(res.snapshot().statusCode).toBe(400);
  });

  it("POST /dashboard/sticker-toggle обновляет строку", async () => {
    insert([
      {
        label: "happy",
        fileId: "f_t",
        fileUniqueId: "u_t",
        setName: "pk",
        emotion: "happy",
        disabled: 0,
      },
    ]);
    const id = getDb().select().from(stickerPalette).get()?.id ?? 0;

    const res = makeRes();
    const req = makeReq("/dashboard/sticker-toggle", "POST");
    const p = handleDashboard("sticker-toggle", "POST", req, res.res, baseDeps());
    await runBody(req, { id, disabled: true });
    await p;
    const snap = res.snapshot();
    expect(snap.statusCode).toBe(200);
    expect(snap.json).toEqual({ ok: true, id, disabled: true });
    // Реально записано → выборка теперь пуста.
    expect(resolveLabel(getDb(), "happy")).toBeNull();
  });

  it("POST /dashboard/sticker-toggle с неизвестным id → 404", async () => {
    const res = makeRes();
    const req = makeReq("/dashboard/sticker-toggle", "POST");
    const p = handleDashboard("sticker-toggle", "POST", req, res.res, baseDeps());
    await runBody(req, { id: 424242, disabled: true });
    await p;
    expect(res.snapshot().statusCode).toBe(404);
  });

  it("POST /dashboard/sticker-delete удаляет строку и возвращает {ok,id}", async () => {
    insert([
      {
        label: "happy",
        fileId: "f_d",
        fileUniqueId: "u_d",
        setName: "pk",
        emotion: "happy",
        disabled: 0,
      },
    ]);
    const id = getDb().select().from(stickerPalette).get()?.id ?? 0;

    const res = makeRes();
    const req = makeReq("/dashboard/sticker-delete", "POST");
    const p = handleDashboard("sticker-delete", "POST", req, res.res, baseDeps());
    await runBody(req, { id });
    await p;
    const snap = res.snapshot();
    expect(snap.statusCode).toBe(200);
    expect(snap.json).toEqual({ ok: true, id });
    // Реально удалено → выборка пуста.
    expect(getDb().select().from(stickerPalette).get()).toBeFalsy();
    expect(resolveLabel(getDb(), "happy")).toBeNull();
  });

  it("POST /dashboard/sticker-delete с неизвестным id → 404", async () => {
    const res = makeRes();
    const req = makeReq("/dashboard/sticker-delete", "POST");
    const p = handleDashboard("sticker-delete", "POST", req, res.res, baseDeps());
    await runBody(req, { id: 555555 });
    await p;
    expect(res.snapshot().statusCode).toBe(404);
  });

  it("POST /dashboard/sticker-signature ставит флаг + meaning и пишет self-факт", async () => {
    insert([{ label: "наш мишка", fileId: "f_s", fileUniqueId: "u_s", setName: "pk", emoji: "🧸" }]);
    const id = getDb().select().from(stickerPalette).get()?.id ?? 0;

    // Граф с узлом self → self-факт реально записывается.
    const G = new WorldModel();
    G.addAgent(ALICE_SELF);
    const deps = baseDeps({ G });

    const res = makeRes();
    const req = makeReq("/dashboard/sticker-signature", "POST");
    const p = handleDashboard("sticker-signature", "POST", req, res.res, deps);
    await runBody(req, { id, signature: true, meaning: "напоминает мне о тебе" });
    await p;
    const snap = res.snapshot();
    expect(snap.statusCode).toBe(200);
    expect(snap.json).toEqual({ ok: true, id, signature: true, meaning: "напоминает мне о тебе" });

    // БД: флаг + meaning записаны.
    const row = getDb().select().from(stickerPalette).get();
    expect(row?.signature).toBe(1);
    expect(row?.meaning).toBe("напоминает мне о тебе");

    // Self-факт в памяти Алисы создан.
    const facts = getContactFacts(G, ALICE_SELF);
    expect(facts.some((f) => (f.attrs.content ?? "").includes("напоминает мне о тебе"))).toBe(true);
  });

  it("POST /dashboard/sticker-signature signature=false снимает флаг, meaning и self-факт", async () => {
    insert([
      {
        label: "наш мишка",
        fileId: "f_s2",
        fileUniqueId: "u_s2",
        setName: "pk",
        emoji: "🧸",
        signature: 1,
        meaning: "особенный",
      },
    ]);
    const id = getDb().select().from(stickerPalette).get()?.id ?? 0;

    const G = new WorldModel();
    G.addAgent(ALICE_SELF);
    const deps = baseDeps({ G });
    // Сначала создадим self-факт через set=true, затем снимем.
    {
      const res = makeRes();
      const req = makeReq("/dashboard/sticker-signature", "POST");
      const p = handleDashboard("sticker-signature", "POST", req, res.res, deps);
      await runBody(req, { id, signature: true, meaning: "особенный" });
      await p;
    }
    expect(getContactFacts(G, ALICE_SELF).length).toBe(1);

    const res = makeRes();
    const req = makeReq("/dashboard/sticker-signature", "POST");
    const p = handleDashboard("sticker-signature", "POST", req, res.res, deps);
    await runBody(req, { id, signature: false });
    await p;
    const snap = res.snapshot();
    expect(snap.statusCode).toBe(200);
    expect(snap.json).toEqual({ ok: true, id, signature: false, meaning: null });

    const row = getDb().select().from(stickerPalette).get();
    expect(row?.signature).toBe(0);
    expect(row?.meaning).toBeNull();
    // Self-факт удалён.
    expect(getContactFacts(G, ALICE_SELF).length).toBe(0);
  });

  it("POST /dashboard/sticker-signature неизвестный id → 404", async () => {
    const res = makeRes();
    const req = makeReq("/dashboard/sticker-signature", "POST");
    const p = handleDashboard("sticker-signature", "POST", req, res.res, baseDeps());
    await runBody(req, { id: 777777, signature: true, meaning: "x" });
    await p;
    expect(res.snapshot().statusCode).toBe(404);
  });

  it("GET /dashboard/sticker-pack включает signature/meaning", async () => {
    insert([
      {
        label: "a",
        fileId: "f1",
        fileUniqueId: "u1",
        setName: "pk",
        signature: 1,
        meaning: "особый",
      },
    ]);
    const res = makeRes();
    await handleDashboard(
      "sticker-pack",
      "GET",
      makeReq("/dashboard/sticker-pack?set=pk"),
      res.res,
      baseDeps(),
    );
    const snap = res.snapshot();
    expect(snap.statusCode).toBe(200);
    expect(snap.json[0]).toMatchObject({ signature: true, meaning: "особый" });
  });

  it("GET /dashboard/sticker-image?id=… ищет file_id и отдаёт байты (downloader замокан)", async () => {
    insert([{ label: "a", fileId: "FILEID_X", fileUniqueId: "u1", setName: "pk" }]);
    const id = getDb().select().from(stickerPalette).get()?.id ?? 0;

    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
    const telegramStickerImage = vi.fn(async (fileId: string) => {
      expect(fileId).toBe("FILEID_X"); // эндпоинт разрешил id → file_id
      return { bytes: png, contentType: "image/png" };
    });

    const res = makeRes();
    await handleDashboard(
      "sticker-image",
      "GET",
      makeReq(`/dashboard/sticker-image?id=${id}`),
      res.res,
      baseDeps({ telegramStickerImage }),
    );
    const snap = res.snapshot();
    expect(snap.statusCode).toBe(200);
    expect(snap.headers["Content-Type"]).toBe("image/png");
    expect(snap.raw.equals(png)).toBe(true);
    expect(telegramStickerImage).toHaveBeenCalledOnce();
  });

  it("GET /dashboard/sticker-image → 204 когда downloader вернул null (анимированный)", async () => {
    insert([{ label: "a", fileId: "FILEID_Y", fileUniqueId: "u2", setName: "pk" }]);
    const id = getDb().select().from(stickerPalette).get()?.id ?? 0;
    const telegramStickerImage = vi.fn(async () => null);

    const res = makeRes();
    await handleDashboard(
      "sticker-image",
      "GET",
      makeReq(`/dashboard/sticker-image?id=${id}`),
      res.res,
      baseDeps({ telegramStickerImage }),
    );
    expect(res.snapshot().statusCode).toBe(204);
  });

  it("GET /dashboard/sticker-image неизвестный id → 404", async () => {
    const telegramStickerImage = vi.fn(async () => null);
    const res = makeRes();
    await handleDashboard(
      "sticker-image",
      "GET",
      makeReq("/dashboard/sticker-image?id=99999"),
      res.res,
      baseDeps({ telegramStickerImage }),
    );
    expect(res.snapshot().statusCode).toBe(404);
    expect(telegramStickerImage).not.toHaveBeenCalled();
  });
});
