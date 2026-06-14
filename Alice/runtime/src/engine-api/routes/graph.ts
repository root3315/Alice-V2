/**
 * Engine API — граф-маршруты.
 *
 * GET  /graph/:entity/:attr → { "value": ... }
 * POST /graph/:entity/:attr → body { "value": ... }
 *
 * Формат entity: self, contact:<platform>:xxx, channel:<platform>:xxx
 *
 * @see docs/adr/202-engine-api.md
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { EngineApiDeps } from "../server.js";

/** Белый список форматов entity: self | contact:<platform>:id | channel:<platform>:id. */
const ENTITY_PATTERN = /^(?:self|(?:contact|channel):[a-z][a-z0-9_-]*:.+)$/u;

/** Разбирает сегмент entity из URL в graph nodeId. При неверном формате возвращает null. */
function resolveEntityId(entity: string): string | null {
  const decoded = decodeURIComponent(entity);
  if (!ENTITY_PATTERN.test(decoded)) return null;
  return decoded;
}

/** Лимит размера тела запроса (1 МБ) — защита от OOM при вредоносных/аномальных клиентах. */
const MAX_BODY = 1024 * 1024;

/** Читает JSON из тела запроса. Отклоняет при превышении MAX_BODY. */
function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY) {
        req.destroy();
        reject(new Error("body too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf-8")));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

/**
 * Обрабатывает GET /graph/:entity/:attr.
 */
export function handleGraphGet(
  entity: string,
  attr: string,
  _req: IncomingMessage,
  res: ServerResponse,
  deps: EngineApiDeps,
): void {
  const nodeId = resolveEntityId(entity);
  if (!nodeId) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "invalid entity format" }));
    return;
  }
  if (!deps.G.has(nodeId)) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "node not found" }));
    return;
  }
  const value = deps.G.getDynamic(nodeId, attr);
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ value }));
}

/**
 * Обрабатывает POST /graph/:entity/:attr.
 *
 * Ограничение записи: attr должен начинаться с `last_` (все resultAttrKey, генерируемые компилятором, имеют этот префикс).
 * Защищает внутренние атрибуты графа (display_name, trust_tier и др.) от перезаписи Skill-ом.
 */
export async function handleGraphSet(
  entity: string,
  attr: string,
  req: IncomingMessage,
  res: ServerResponse,
  deps: EngineApiDeps,
): Promise<void> {
  const nodeId = resolveEntityId(entity);
  if (!nodeId) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "invalid entity format" }));
    return;
  }
  // Белый список записи: разрешён только префикс last_* (resultAttrKey от компилятора)
  if (!attr.startsWith("last_")) {
    res.writeHead(403, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "write restricted to last_* attributes" }));
    return;
  }
  if (!deps.G.has(nodeId)) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "node not found" }));
    return;
  }

  let body: unknown;
  try {
    body = await readBody(req);
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "invalid JSON body" }));
    return;
  }

  if (body === null || typeof body !== "object" || !("value" in body)) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: 'body must be { "value": ... }' }));
    return;
  }

  deps.G.setDynamic(nodeId, attr, (body as { value: unknown }).value);
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true }));
}
