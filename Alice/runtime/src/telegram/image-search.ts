/**
 * Поиск + скачивание изображений (БЕЗ API-ключей) для способности Алисы «найди картинку и пришли».
 *
 * Источники:
 *  - "booru": danbooru.donmai.us, только SFW (rating:g) — аниме/персонажи (напр. Аура из Frieren).
 *  - "web":  DuckDuckGo images (keyless, двухшаговый vqd-поток) — общий веб-поиск картинок («как гугл»).
 *
 * Работает на стороне ДВИЖКА (у него есть сеть; песочница ограничена). Возвращает URL-кандидаты;
 * вызывающий выбирает + качает в буфер и отправляет как фото. Никогда не бросает наружу секреты.
 */

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

export type ImageSource = "booru" | "web";

async function fetchText(
  url: string,
  headers: Record<string, string> = {},
  timeoutMs = 12_000,
): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { headers: { "User-Agent": UA, ...headers }, signal: ctrl.signal });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return await resp.text();
  } finally {
    clearTimeout(timer);
  }
}

const IMG_EXT_RE = /\.(jpe?g|png|gif|webp)(\?|$)/i;

/**
 * safebooru.org (по умолчанию SFW): пробелы в тегах → подчёркивания. danbooru отдаёт 403 на keyless,
 * поэтому используем safebooru dapi (json). URL картинки строим из directory+image (или file_url).
 */
export async function searchBooru(query: string, limit = 40): Promise<string[]> {
  const tags = query.trim().replace(/\s+/g, "_");
  const url = `https://safebooru.org/index.php?page=dapi&s=post&q=index&json=1&limit=${limit}&tags=${encodeURIComponent(
    tags,
  )}`;
  const text = await fetchText(url, { Accept: "application/json" });
  let posts: Array<{ directory?: string; image?: string; file_url?: string }>;
  try {
    posts = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(posts)) return [];
  return posts
    .map((p) => {
      if (p.file_url && /^https?:\/\//.test(p.file_url)) return p.file_url;
      if (p.directory && p.image) return `https://safebooru.org/images/${p.directory}/${p.image}`;
      return "";
    })
    .filter((u) => /^https?:\/\//.test(u) && IMG_EXT_RE.test(u));
}

/** DuckDuckGo images (keyless, двухшаговый vqd). */
export async function searchWeb(query: string, limit = 40): Promise<string[]> {
  const q = encodeURIComponent(query.trim());
  // 1) токен vqd со страницы поиска
  const html = await fetchText(`https://duckduckgo.com/?q=${q}&iax=images&ia=images`);
  const vqd = (html.match(/vqd=["']?([\d-]+)["']?/) ?? html.match(/vqd=([\d-]+)&/))?.[1];
  if (!vqd) return [];
  // 2) JSON с результатами картинок
  const api = `https://duckduckgo.com/i.js?l=us-en&o=json&q=${q}&vqd=${vqd}&f=,,,&p=1`;
  const text = await fetchText(api, {
    Referer: "https://duckduckgo.com/",
    Accept: "application/json",
  });
  let json: { results?: Array<{ image?: string }> };
  try {
    json = JSON.parse(text);
  } catch {
    return [];
  }
  return (json.results ?? [])
    .map((r) => r.image || "")
    .filter((u) => /^https?:\/\//.test(u))
    .slice(0, limit);
}

/** Кандидаты-URL картинок из выбранного источника. booru с фолбэком на web (если пусто/недоступно). */
export async function searchImageUrls(query: string, source: ImageSource): Promise<string[]> {
  if (source === "booru") {
    try {
      const urls = await searchBooru(query);
      if (urls.length > 0) return urls;
    } catch {
      // booru недоступен → фолбэк на общий веб-поиск ниже
    }
    return searchWeb(query);
  }
  return searchWeb(query);
}

/**
 * Грубая проверка релевантности по vision-описанию: ловит явные промахи. В частности, при поиске
 * СЕБЯ (Аура — девушка) мужской портрет = точно не то. true → картинка ЯВНО не подходит, пропустить.
 */
export function descriptionLooksWrong(query: string, description: string): boolean {
  const q = query.toLowerCase();
  const d = description.toLowerCase();
  const isSelfFemale = /aura|себя|self|myself|меня|her\b/.test(q);
  const looksMale = /\bmale\b|\ba man\b|\byoung man\b|\bboy\b|\bguy\b|\bman with\b|мужчин|парен/.test(d);
  const looksFemale = /\bfemale\b|\bgirl\b|\bwoman\b|\bshe\b|демонесс|девушк|женщин/.test(d);
  if (isSelfFemale && looksMale && !looksFemale) return true;
  return false;
}

/** Скачивает картинку в буфер (с валидацией Content-Type). Бросает при не-картинке/ошибке. */
export async function fetchImageBuffer(
  url: string,
  timeoutMs = 15_000,
): Promise<{ buffer: Buffer; mime: string; fileName: string }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { headers: { "User-Agent": UA }, signal: ctrl.signal });
    if (!resp.ok) throw new Error(`download HTTP ${resp.status}`);
    const mime = (resp.headers.get("content-type") || "image/jpeg").split(";")[0].trim();
    if (!/^image\//.test(mime)) throw new Error(`not an image (${mime})`);
    const buffer = Buffer.from(await resp.arrayBuffer());
    if (buffer.length < 256) throw new Error("image too small");
    if (buffer.length > 10 * 1024 * 1024) throw new Error("image too large (>10MB)");
    const ext = (mime.split("/")[1] || "jpg").replace("jpeg", "jpg");
    return { buffer, mime, fileName: `image.${ext}` };
  } finally {
    clearTimeout(timer);
  }
}
