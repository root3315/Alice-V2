/**
 * Sticker indexer — юнит-тесты batch-VLM индексации + семантического подбора + curated-защиты.
 *
 * Покрытие (всё замокано — никакой реальной сети):
 *  1. batchIndexStickerSet: upsert с setName+curated; идемпотентный skip при повторе.
 *  2. resolveLabelSemantic: null при выключенных эмбеддингах (без fetch);
 *     cosine-пик выше порога при включённых (мок эмбеддингов).
 *  3. curated-строки переживают симулированную очистку syncInstalledSets.
 *
 * describeMedia/getStickerAnalysis замоканы; эндпоинт эмбеддингов — vi.stubGlobal("fetch").
 * БД — реальный in-memory через initDb(":memory:") (применяет миграции, включая 0030).
 *
 * @see src/telegram/apps/sticker-palette.ts
 */
import type { TelegramClient } from "@mtcute/node";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// describeMedia/getStickerAnalysis/isVisionEnabled мокаем ДО импорта индексатора.
const mockDescribeMedia = vi.fn();
const mockGetStickerAnalysis = vi.fn();
vi.mock("../src/llm/vision.js", () => ({
  describeMedia: (...args: unknown[]) => mockDescribeMedia(...args),
  getStickerAnalysis: (...args: unknown[]) => mockGetStickerAnalysis(...args),
  isVisionEnabled: () => true,
}));

import type { Config } from "../src/config.js";
import { closeDb, getDb, initDb } from "../src/db/connection.js";
import { stickerPalette } from "../src/db/schema.js";
import { resetEmbeddingBreaker } from "../src/llm/embeddings.js";
import type { EmbeddingConfig } from "../src/llm/embeddings.js";
import {
  batchIndexStickerSet,
  resolveLabelSemantic,
  syncInstalledSets,
} from "../src/telegram/apps/sticker-palette.js";

// ── фикстуры ────────────────────────────────────────────────────────────────

const VISION_CONFIG = { visionModel: "vlm" } as unknown as Config;

const EMBED_ENABLED: EmbeddingConfig = {
  embeddingBaseUrl: "http://127.0.0.1:11434/v1",
  embeddingApiKey: "",
  embeddingModel: "bge-m3",
};
const EMBED_DISABLED: EmbeddingConfig = {
  embeddingBaseUrl: "",
  embeddingApiKey: "",
  embeddingModel: "",
};

/** Растровый WEBP-буфер достаточного размера (head НЕ '<?'/'<s', чтобы пройти head-byte гейт). */
function rasterBuffer(): Buffer {
  const buf = Buffer.alloc(4096, 0x42);
  buf[0] = 0x52; // 'R' (RIFF/WEBP-подобный head, не SVG/XML)
  buf[1] = 0x49;
  return buf;
}

/**
 * Фейковый mtcute-клиент: getStickerSet → набор статичных стикеров; downloadAsBuffer → растр.
 */
function fakeClient(
  shortName: string,
  stickers: Array<{ fileId: string; uniqueFileId: string; alt: string }>,
): TelegramClient {
  return {
    getStickerSet: vi.fn(async (_id: string) => ({
      shortName,
      title: shortName,
      isFull: true,
      stickers: stickers.map((s) => ({
        sticker: {
          fileId: s.fileId,
          uniqueFileId: s.uniqueFileId,
          sourceType: "static",
          thumbnails: [],
        },
        alt: s.alt,
      })),
    })),
    downloadAsBuffer: vi.fn(async () => rasterBuffer()),
  } as unknown as TelegramClient;
}

/** Детерминированный фейковый эмбеддинг: вектор по «теме» (ключевое слово в тексте). */
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
  mockDescribeMedia.mockReset();
  mockGetStickerAnalysis.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
  resetEmbeddingBreaker();
  closeDb();
});

// ── batchIndexStickerSet ──────────────────────────────────────────────────────

describe("batchIndexStickerSet", () => {
  it("индексирует пак с setName + curated", async () => {
    mockDescribeMedia.mockImplementation(async (_b64, uid: string) => `desc for ${uid}`);
    mockGetStickerAnalysis.mockImplementation((uid: string) => ({
      description: `happy sticker ${uid}`,
      emotion: "happy",
      action: "none",
      intensity: "moderate",
    }));

    const client = fakeClient("mypack", [
      { fileId: "fid1", uniqueFileId: "uid1", alt: "😊" },
      { fileId: "fid2", uniqueFileId: "uid2", alt: "😢" },
    ]);

    const stats = await batchIndexStickerSet(client, getDb(), VISION_CONFIG, "mypack");

    expect(stats).toEqual({ tagged: 2, skipped: 0, failed: 0, total: 2 });

    const rows = getDb().select().from(stickerPalette).all();
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.setName).toBe("mypack");
      expect(r.curated).toBe(1);
      expect(r.label.startsWith("happy sticker")).toBe(true);
    }
  });

  it("идемпотентный skip на повторном прогоне (без force)", async () => {
    mockDescribeMedia.mockImplementation(async (_b64, uid: string) => `desc ${uid}`);
    mockGetStickerAnalysis.mockImplementation((uid: string) => ({
      description: `rich tag ${uid}`,
      emotion: "happy",
      action: "none",
      intensity: "moderate",
    }));

    const client = fakeClient("mypack", [{ fileId: "fid1", uniqueFileId: "uid1", alt: "😊" }]);

    const first = await batchIndexStickerSet(client, getDb(), VISION_CONFIG, "mypack");
    expect(first.tagged).toBe(1);

    // Второй прогон: стикер уже богато размечен → skip, describeMedia не зовётся снова.
    mockDescribeMedia.mockClear();
    const second = await batchIndexStickerSet(client, getDb(), VISION_CONFIG, "mypack");
    expect(second).toEqual({ tagged: 0, skipped: 1, failed: 0, total: 1 });
    expect(mockDescribeMedia).not.toHaveBeenCalled();
  });

  it("force=true переиндексирует уже размеченные стикеры", async () => {
    mockDescribeMedia.mockImplementation(async (_b64, uid: string) => `desc ${uid}`);
    mockGetStickerAnalysis.mockImplementation((uid: string) => ({
      description: `rich tag ${uid}`,
      emotion: "happy",
      action: "none",
      intensity: "moderate",
    }));
    const client = fakeClient("mypack", [{ fileId: "fid1", uniqueFileId: "uid1", alt: "😊" }]);

    await batchIndexStickerSet(client, getDb(), VISION_CONFIG, "mypack");
    mockDescribeMedia.mockClear();

    const forced = await batchIndexStickerSet(client, getDb(), VISION_CONFIG, "mypack", {
      force: true,
    });
    expect(forced.tagged).toBe(1);
    expect(mockDescribeMedia).toHaveBeenCalledTimes(1);
  });

  it("ошибка анализа одного стикера не прерывает батч (failed)", async () => {
    mockDescribeMedia.mockImplementation(async (_b64, uid: string) =>
      uid === "uid_bad" ? undefined : `desc ${uid}`,
    );
    mockGetStickerAnalysis.mockImplementation((uid: string) =>
      uid === "uid_bad"
        ? undefined
        : { description: `tag ${uid}`, emotion: "happy", action: "none", intensity: "moderate" },
    );

    const client = fakeClient("mypack", [
      { fileId: "fid_ok", uniqueFileId: "uid_ok", alt: "😊" },
      { fileId: "fid_bad", uniqueFileId: "uid_bad", alt: "😢" },
    ]);

    const stats = await batchIndexStickerSet(client, getDb(), VISION_CONFIG, "mypack");
    expect(stats.tagged).toBe(1);
    expect(stats.failed).toBe(1);
    expect(stats.total).toBe(2);
  });
});

// ── resolveLabelSemantic ──────────────────────────────────────────────────────

describe("resolveLabelSemantic", () => {
  it("выключенные эмбеддинги → null НЕМЕДЛЕННО, без fetch", async () => {
    const fetchFn = vi.fn();
    vi.stubGlobal("fetch", fetchFn);

    getDb()
      .insert(stickerPalette)
      .values({
        label: "happy dancing cat",
        fileId: "fid_h",
        fileUniqueId: "uid_h",
        emoji: "😊",
        setName: "mypack",
        curated: 1,
        emotion: "happy",
        action: "dance",
        intensity: "moderate",
      })
      .run();

    const result = await resolveLabelSemantic(getDb(), "joyful kitty", EMBED_DISABLED);
    expect(result).toBeNull();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("включённые эмбеддинги → cosine-пик выше порога возвращает fileId", async () => {
    mockEmbedFetch();

    getDb()
      .insert(stickerPalette)
      .values([
        {
          label: "happy smiling face",
          fileId: "fid_happy",
          fileUniqueId: "uid_happy",
          emoji: "😊",
          setName: "mypack",
          curated: 1,
          emotion: "happy",
          action: "none",
          intensity: "moderate",
        },
        {
          label: "sad crying face",
          fileId: "fid_sad",
          fileUniqueId: "uid_sad",
          emoji: "😢",
          setName: "mypack",
          curated: 1,
          emotion: "sad",
          action: "cry",
          intensity: "moderate",
        },
      ])
      .run();

    // Запрос «joy smile» → ось happy → совпадает с "happy smiling face".
    const result = await resolveLabelSemantic(getDb(), "joy smile", EMBED_ENABLED);
    expect(result).toBe("fid_happy");
  });

  it("включённые эмбеддинги, но ничего близкого → null (ниже порога)", async () => {
    mockEmbedFetch();

    getDb()
      .insert(stickerPalette)
      .values({
        label: "sad crying face",
        fileId: "fid_sad",
        fileUniqueId: "uid_sad",
        emoji: "😢",
        setName: "mypack",
        curated: 1,
        emotion: "sad",
        action: "cry",
        intensity: "moderate",
      })
      .run();

    // Запрос оси happy против единственного sad-кандидата → ортогонально → < 0.55 → null.
    const result = await resolveLabelSemantic(getDb(), "joy smile", EMBED_ENABLED);
    expect(result).toBeNull();
  });
});

// ── curated survives cleanup ─────────────────────────────────────────────────

describe("curated rows survive syncInstalledSets cleanup", () => {
  it("курируемый пак НЕ удаляется, даже если не установлен", async () => {
    // Курируемый пак "curated_pack" (не среди установленных) + обычный "old_pack".
    getDb()
      .insert(stickerPalette)
      .values([
        {
          label: "rich curated tag",
          fileId: "fid_cur",
          fileUniqueId: "uid_cur",
          emoji: "😊",
          setName: "curated_pack",
          curated: 1,
          emotion: "happy",
          action: "none",
          intensity: "moderate",
        },
        {
          label: "😢 sticker",
          fileId: "fid_old",
          fileUniqueId: "uid_old",
          emoji: "😢",
          setName: "old_pack",
          curated: 0,
          emotion: "sad",
          action: "cry",
          intensity: "medium",
        },
      ])
      .run();

    // Установлен только "installed_pack" → "old_pack" должен быть очищен, "curated_pack" — нет.
    const client = {
      getInstalledStickers: vi.fn(async () => [
        { shortName: "installed_pack", title: "Installed", count: 0 },
      ]),
      getStickerSet: vi.fn(async () => ({
        shortName: "installed_pack",
        title: "Installed",
        isFull: true,
        stickers: [],
      })),
    } as unknown as TelegramClient;

    const stats = await syncInstalledSets(client, getDb());
    expect(stats.removed).toBe(1); // только old_pack

    const surviving = getDb().select().from(stickerPalette).all();
    const ids = surviving.map((r) => r.fileUniqueId).sort();
    expect(ids).toEqual(["uid_cur"]);
  });

  it("нет установленных паков → курируемый всё равно выживает", async () => {
    getDb()
      .insert(stickerPalette)
      .values([
        {
          label: "rich curated tag",
          fileId: "fid_cur",
          fileUniqueId: "uid_cur",
          emoji: "😊",
          setName: "curated_pack",
          curated: 1,
          emotion: "happy",
          action: "none",
          intensity: "moderate",
        },
        {
          label: "😢 sticker",
          fileId: "fid_old",
          fileUniqueId: "uid_old",
          emoji: "😢",
          setName: "old_pack",
          curated: 0,
          emotion: "sad",
          action: "cry",
          intensity: "medium",
        },
      ])
      .run();

    const client = {
      getInstalledStickers: vi.fn(async () => []),
      getStickerSet: vi.fn(),
    } as unknown as TelegramClient;

    const stats = await syncInstalledSets(client, getDb());
    expect(stats.removed).toBe(1); // old_pack удалён

    const surviving = getDb().select().from(stickerPalette).all();
    expect(surviving.map((r) => r.fileUniqueId)).toEqual(["uid_cur"]);
  });
});
