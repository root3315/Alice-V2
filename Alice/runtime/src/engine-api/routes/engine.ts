/**
 * Engine API — 引擎查询路由。
 *
 * GET  /engine/tick       → { "tick": number }
 * POST /engine/selfcheck  → SelfcheckResult JSON
 *
 * @see docs/adr/202-engine-api.md
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { getSelfcheckData } from "../../telegram/apps/selfcheck.js";
import type { EngineApiDeps } from "../server.js";

/** 从 request body 收集 JSON。 */
function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf-8");
        resolve(raw.length > 0 ? JSON.parse(raw) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

/**
 * 处理 GET /engine/tick。
 */
export function handleEngineTick(
  _req: IncomingMessage,
  res: ServerResponse,
  deps: EngineApiDeps,
): void {
  const tick = deps.getTick?.() ?? 0;
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ tick }));
}

/**
 * 处理 POST /engine/selfcheck。
 *
 * body: { focus?: "mood" | "social" | "personality" | "pressure" | "actions" }
 * response: SelfcheckResult JSON
 */
export async function handleEngineSelfcheck(
  req: IncomingMessage,
  res: ServerResponse,
  deps: EngineApiDeps,
): Promise<void> {
  let body: unknown;
  try {
    body = await readBody(req);
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "invalid JSON body" }));
    return;
  }

  const validFocus = ["mood", "social", "personality", "pressure", "actions"] as const;
  type Focus = (typeof validFocus)[number];
  const rawFocus =
    body !== null && typeof body === "object" && "focus" in body
      ? String((body as { focus: unknown }).focus)
          .trim()
          .toLowerCase()
      : "";
  const focus: Focus | undefined = validFocus.includes(rawFocus as Focus)
    ? (rawFocus as Focus)
    : undefined;

  const tick = deps.getTick?.() ?? 0;

  try {
    const data = getSelfcheckData(deps.G, Date.now(), tick, focus);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(data));
  } catch (err) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: err instanceof Error ? err.message : "selfcheck failed" }));
  }
}
