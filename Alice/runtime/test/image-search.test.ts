/**
 * Keyless image-search парсинг (booru danbooru + web DuckDuckGo). Мокаем global fetch — без сети.
 * @see src/telegram/image-search.ts
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { descriptionLooksWrong, searchBooru, searchWeb } from "../src/telegram/image-search.js";

afterEach(() => vi.unstubAllGlobals());

/** Мок последовательности ответов fetch (по одному на каждый вызов). */
function mockFetchSeq(texts: string[]): void {
  let i = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      const text = texts[Math.min(i++, texts.length - 1)];
      return {
        ok: true,
        status: 200,
        text: async () => text,
        headers: { get: () => null },
      } as unknown as Response;
    }),
  );
}

describe("image-search: booru (danbooru)", () => {
  it("берёт file_url/large_file_url и отсекает не-картинки", async () => {
    mockFetchSeq([
      JSON.stringify([
        { directory: "12/34", image: "aura1.jpg" }, // safebooru: directory + image
        { file_url: "https://cdn.example/aura2.png" }, // прямой file_url тоже поддержан
        { directory: "9/9", image: "notimage.zip" }, // отсечётся (не картинка)
        {},
      ]),
    ]);
    expect(await searchBooru("aura sousou no frieren")).toEqual([
      "https://safebooru.org/images/12/34/aura1.jpg",
      "https://cdn.example/aura2.png",
    ]);
  });

  it("пустой/битый JSON → []", async () => {
    mockFetchSeq(["не json"]);
    expect(await searchBooru("x")).toEqual([]);
  });
});

describe("image-search: web (DuckDuckGo)", () => {
  it("двухшаговый vqd-поток → url картинок", async () => {
    mockFetchSeq([
      "... ,vqd='3-12345-67', ...", // шаг 1: страница с vqd
      JSON.stringify({
        results: [{ image: "https://i.example/cat1.jpg" }, { image: "https://i.example/cat2.png" }],
      }), // шаг 2: i.js
    ]);
    expect(await searchWeb("cute cat")).toEqual([
      "https://i.example/cat1.jpg",
      "https://i.example/cat2.png",
    ]);
  });

  it("нет vqd → [] (второй запрос не делается)", async () => {
    mockFetchSeq(["тут нет токена"]);
    expect(await searchWeb("x")).toEqual([]);
  });
});

describe("descriptionLooksWrong (релевантность)", () => {
  it("мужской портрет на поиске СЕБЯ (aura) → отвергается", () => {
    expect(
      descriptionLooksWrong(
        "aura sousou no frieren",
        "AI-generated anime-style illustration of a young adult male in a red suit",
      ),
    ).toBe(true);
  });
  it("женский/Аура-арт → ок", () => {
    expect(
      descriptionLooksWrong("aura sousou no frieren", "anime girl with purple hair holding golden scales"),
    ).toBe(false);
  });
  it("не-self запрос не переотсеивает", () => {
    expect(descriptionLooksWrong("cute cat", "a man holding a cat")).toBe(false);
  });
});
