/**
 * Engine API — Dispatcher syscall route.
 *
 * POST /dispatch/:instruction → { ok: true, result?: unknown }
 *
 * High-privilege bridge for instructions that must remain engine-owned.
 *
 * @see docs/adr/202-engine-api.md
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { EngineApiDeps } from "../server.js";

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

export async function handleDispatchInstruction(
  instruction: string,
  req: IncomingMessage,
  res: ServerResponse,
  deps: EngineApiDeps,
): Promise<void> {
  if (!deps.dispatchInstruction) {
    res.writeHead(501, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "dispatch not configured" }));
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

  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "body must be a JSON object" }));
    return;
  }

  try {
    const result = await deps.dispatchInstruction(instruction, body as Record<string, unknown>);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, result: result ?? null }));
  } catch (err) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        error: err instanceof Error ? err.message : "dispatch failed",
      }),
    );
  }
}
