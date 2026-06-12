#!/usr/bin/env npx tsx
/**
 * selfcheck CLI — Alice 的镜子（五维自我感知）。
 *
 * 用法: npx tsx bin/selfcheck.ts [focus]
 *   focus: "mood" | "social" | "personality" | "pressure" | "actions"
 *   省略则全景概览。
 *
 * 核心逻辑在引擎侧执行（通过 Engine API selfcheck 端点），
 * CLI 只做 IPC + 结果存图 + stdout JSON。
 *
 * @see docs/adr/202-engine-api.md
 * @see docs/adr/133-app-social-value-audit.md — Wave 5 Agent 专属 App
 */

import { request } from "node:http";

const engineUrl = process.env.ALICE_ENGINE_URL;
const skillName = process.env.ALICE_SKILL ?? "selfcheck";

if (!engineUrl) {
  console.log(JSON.stringify({ error: "ALICE_ENGINE_URL not set" }));
  process.exit(1);
}

const url = new URL(engineUrl);

// ── Engine API 请求工具 ──

function apiRequest(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; data: unknown }> {
  return new Promise((resolve, reject) => {
    const bodyStr = body != null ? JSON.stringify(body) : undefined;
    const req = request(
      {
        hostname: url.hostname,
        port: Number(url.port),
        path,
        method,
        headers: {
          "X-Alice-Skill": skillName,
          ...(bodyStr ? { "Content-Type": "application/json" } : {}),
        },
      },
      (res) => {
        let raw = "";
        res.on("data", (chunk: Buffer) => {
          raw += chunk.toString();
        });
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode ?? 500, data: JSON.parse(raw) });
          } catch {
            resolve({ status: res.statusCode ?? 500, data: raw });
          }
        });
      },
    );
    req.on("error", reject);
    req.setTimeout(10_000, () => {
      req.destroy(new Error("Engine API timeout"));
    });
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// ── main ──

const focus = process.argv[2]?.trim() || undefined;

// 1. 调用 Engine API selfcheck 端点
const selfcheckBody: Record<string, string> = {};
if (focus) selfcheckBody.focus = focus;

const { status, data } = await apiRequest("POST", "/engine/selfcheck", selfcheckBody);

if (status !== 200) {
  console.log(JSON.stringify({ error: `selfcheck failed: ${JSON.stringify(data)}` }));
  process.exit(1);
}

// 2. 将结果存入图属性 self.last_selfcheck_result
try {
  await apiRequest("POST", "/graph/self/last_selfcheck_result", { value: data });
} catch {
  // 存图失败不影响输出
}

// 3. stdout 输出 JSON
console.log(JSON.stringify(data));
