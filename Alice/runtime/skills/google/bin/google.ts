#!/usr/bin/env npx tsx
/**
 * google CLI — 搜索 + LLM 综合答案管线。
 *
 * 用法: npx tsx bin/google.ts "question text" [--json]
 * 输出: 默认人类可读，--json 返回 JSON
 *
 * 管线：
 * 1. Engine API 获取 exaApiKey
 * 2. Exa Search API 搜索
 * 3. Engine API LLM synthesize 综合答案
 * 4. Engine API graph.write 存储结果
 *
 * @see docs/adr/202-engine-api.md
 * @see docs/adr/235-cli-human-readable-output.md
 */

import { engineGet, enginePost } from "../../_lib/engine-client.js";
import { die, renderJson } from "../../../src/system/cli-bridge.ts";

// ── Exa Search API ──

async function exaSearch(
  query: string,
  apiKey: string,
): Promise<Array<{ title: string; url: string; text: string }>> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const resp = await fetch("https://api.exa.ai/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        query,
        type: "auto",
        numResults: 3,
        contents: { text: { maxCharacters: 3000 } },
      }),
      signal: controller.signal,
    });
    if (!resp.ok) {
      throw new Error(`Exa API error: ${resp.status} ${resp.statusText}`);
    }
    const data = (await resp.json()) as {
      results: Array<{ title: string; url: string; text: string }>;
    };
    return (data.results ?? []).map((r) => ({
      title: r.title ?? "",
      url: r.url ?? "",
      text: r.text ?? "",
    }));
  } finally {
    clearTimeout(timeout);
  }
}

// ── main ──

const rawArgs = process.argv.slice(2);
const jsonMode = rawArgs.includes("--json");
const args = rawArgs.filter((a) => a !== "--json");

const question = args[0] ?? "";
if (!question.trim()) {
  die("google", "Usage: google <question>");
}

// 1. 获取 Exa API key
const configResp = (await engineGet("/config/exaApiKey")) as { value: string } | null;
const exaApiKey = configResp?.value;
if (!exaApiKey) {
  die("google", "EXA_API_KEY not configured");
}

// 2. 搜索
const sources = await exaSearch(question, exaApiKey);
if (sources.length === 0) {
  die("google", "Search returned no results");
}

// 3. LLM 综合答案
const synthResp = (await enginePost("/llm/synthesize", {
  question,
  sources,
})) as { answer: string } | null;

const answer = synthResp?.answer ?? sources[0].text.slice(0, 800);

// 4. 存储到图
const citations = sources.slice(0, 5).map((s) => ({ title: s.title, url: s.url }));
const result = { answer, sources: citations };
await enginePost("/graph/self/last_google_result", { value: result });

// 5. 输出（ADR-235: 默认人类可读）
if (jsonMode) {
  console.log(renderJson(result));
} else {
  console.log(`Answer: ${answer}`);
  if (citations.length > 0) {
    console.log("Sources:");
    for (const [i, s] of citations.entries()) {
      console.log(`${i + 1}. ${s.title} — ${s.url}`);
    }
  }
}