#!/usr/bin/env npx tsx
/**
 * visit CLI — URL 内容提取 + LLM 摘要管线。
 *
 * 用法: npx tsx bin/visit.ts "https://example.com" ["focus text"] [--json]
 * 输出: 默认人类可读，--json 返回 JSON
 *
 * 管线：
 * 1. Engine API 获取 exaApiKey
 * 2. Exa Contents API 提取页面内容
 * 3. Engine API LLM summarize 摘要
 * 4. Engine API graph.write 存储结果
 *
 * @see docs/adr/202-engine-api.md
 * @see docs/adr/235-cli-human-readable-output.md
 */

import { engineGet, enginePost } from "../../_lib/engine-client.js";
import { die, renderJson } from "../../../src/system/cli-bridge.ts";

// ── Exa Contents API ──

async function exaExtract(
  urls: string[],
  apiKey: string,
): Promise<Array<{ title: string; url: string; text: string }>> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const resp = await fetch("https://api.exa.ai/contents", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
      },
      body: JSON.stringify({
        urls,
        text: { maxCharacters: 6000 },
        livecrawl: "fallback",
      }),
      signal: controller.signal,
    });
    if (!resp.ok) {
      throw new Error(`Exa Contents API error: ${resp.status} ${resp.statusText}`);
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

const url = args[0] ?? "";
if (!url.trim() || !/^https?:\/\//i.test(url)) {
  die("visit", "Usage: visit <url> [focus]");
}

const focus = args[1]?.trim() || undefined;

// 1. 获取 Exa API key
const configResp = (await engineGet("/config/exaApiKey")) as { value: string } | null;
const exaApiKey = configResp?.value;
if (!exaApiKey) {
  die("visit", "EXA_API_KEY not configured");
}

// 2. 提取页面内容
const raw = await exaExtract([url], exaApiKey);
if (raw.length === 0 || !raw[0].text) {
  die("visit", "URL extraction returned empty");
}

// 3. LLM 摘要
const summarizeResp = (await enginePost("/llm/summarize", {
  text: raw[0].text,
  url: raw[0].url,
  focus,
})) as { summary: string } | null;

const summary = summarizeResp?.summary ?? raw[0].text.slice(0, 800);

// 4. 存储到图
const result = {
  title: raw[0].title || "(untitled)",
  url: raw[0].url,
  summary,
};
await enginePost("/graph/self/last_visit_result", { value: result });

// 5. 输出（ADR-235: 默认人类可读）
if (jsonMode) {
  console.log(renderJson(result));
} else {
  console.log(`Summary of "${result.title}":`);
  console.log(summary);
  console.log(`URL: ${result.url}`);
}