/**
 * Engine API — LLM 管线路由。
 *
 * POST /llm/synthesize → { answer: string }
 * POST /llm/summarize  → { summary: string }
 *
 * 包装 actions.ts 中的 synthesizeAnswer / summarizeWebContent 纯函数，
 * 供 Skill CLI 脚本通过 Engine API 调用引擎内 LLM。
 *
 * @see docs/adr/202-engine-api.md
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { summarizeWebContent, synthesizeAnswer } from "../../telegram/actions.js";

/** 从 request body 收集 JSON。 */
function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
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
 * POST /llm/synthesize
 *
 * body: { question: string, sources: Array<{title,url,text}> }
 * response: { answer: string }
 */
export async function handleLlmSynthesize(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  let body: unknown;
  try {
    body = await readBody(req);
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "invalid JSON body" }));
    return;
  }

  if (body === null || typeof body !== "object" || !("question" in body) || !("sources" in body)) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        error: 'body must be { "question": string, "sources": Array<{title,url,text}> }',
      }),
    );
    return;
  }

  const { question, sources } = body as {
    question: string;
    sources: Array<{ title: string; url: string; text: string }>;
  };

  try {
    const answer = await synthesizeAnswer(question, sources);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ answer }));
  } catch (err) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        error: err instanceof Error ? err.message : "synthesize failed",
      }),
    );
  }
}

/**
 * POST /llm/summarize
 *
 * body: { text: string, url: string, focus?: string }
 * response: { summary: string }
 */
export async function handleLlmSummarize(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: unknown;
  try {
    body = await readBody(req);
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "invalid JSON body" }));
    return;
  }

  if (body === null || typeof body !== "object" || !("text" in body) || !("url" in body)) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        error: 'body must be { "text": string, "url": string, "focus"?: string }',
      }),
    );
    return;
  }

  const { text, url, focus } = body as {
    text: string;
    url: string;
    focus?: string;
  };

  try {
    const summary = await summarizeWebContent(text, url, focus);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ summary }));
  } catch (err) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        error: err instanceof Error ? err.message : "summarize failed",
      }),
    );
  }
}
