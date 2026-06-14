/**
 * Engine API — маршрут конфигурации.
 *
 * GET /config/:key → { "value": ... }
 *
 * @see docs/adr/202-engine-api.md
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { EngineApiDeps } from "../server.js";

/** Белый список допустимых ключей конфигурации. */
const ALLOWED_KEYS = new Set(["timezoneOffset", "exaApiKey", "musicApiBaseUrl", "youtubeApiKey"]);

/**
 * Обрабатывает GET /config/:key.
 * @param key Имя параметра конфигурации (URL-сегмент)
 */
export function handleConfigGet(
  key: string,
  _req: IncomingMessage,
  res: ServerResponse,
  deps: EngineApiDeps,
): void {
  if (!ALLOWED_KEYS.has(key)) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "unknown config key" }));
    return;
  }
  const value = deps.config[key as keyof EngineApiDeps["config"]];
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ value }));
}
