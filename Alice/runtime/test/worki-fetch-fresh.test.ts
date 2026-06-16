/**
 * Bug: ревью worki падало «fetch failed» — dev-клон отставал, а git fetch без авторизации на
 * приватном репо валился. Фикс: перед read-задачами (code_ask и т.п.) Алиса на ХОСТЕ делает
 * `git -C DEV_CLONE fetch <token-url> +refs/heads/<base>:refs/remotes/origin/<base>` токен-URL'ом
 * (как code_pr для push). Токен host-only — в Docker-песочницу не идёт.
 *
 * Тест мокает execFile (перехватываем git) и fetch (прокси не нужен), гоняет impl code_ask и
 * проверяет:
 *   1) перед запросом к прокси вызван `git fetch` с токен-URL на DEV_CLONE (FETCH-only: нет
 *      checkout/reset/pull/push — рабочее дерево и ветки не трогаются);
 *   2) при ошибке fetch токен НЕ утекает в лог (маскируется как x-access-token:***@), ревью не падает.
 *
 * Токен задаём ДО импорта мода (константа читается из env на загрузке модуля).
 */
import { EventEmitter } from "node:events";
import type { ClientRequest, IncomingMessage } from "node:http";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// Константы worki читаются из env на ЗАГРУЗКЕ модуля. ESM-импорты вычисляются раньше тела файла,
// поэтому env нужно задать в vi.hoisted() — он исполняется до импортов (и до import мода ниже).
const { FAKE_TOKEN } = vi.hoisted(() => {
  const token = "ghp_TESTONLYxxxxxxxxxxxxxxxxxxxxxxxxxx";
  process.env.WORKI_ALICE_TOKEN = token;
  process.env.WORKI_ALICE_REPO = "root3315/worki-alice";
  process.env.WORKI_DEV_CLONE = "C:\\fake\\alice-worki-dev";
  process.env.WORKI_BASE_BRANCH = "main";
  return { FAKE_TOKEN: token };
});

type ExecFileCallback = (
  error: Error | null,
  stdout: string | Buffer,
  stderr: string | Buffer,
) => void;
type ExecFileOptions = Parameters<typeof import("node:child_process").execFile>[2];

// Перехват git: запоминаем аргументы и режим callback'а (успех/ошибка) задаётся per-test.
const gitCalls: { cmd: string; args: string[] }[] = [];
let gitMode: "ok" | "fail" = "ok";

vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return {
    ...original,
    execFile: vi.fn((cmd: string, args: string[], _opts: ExecFileOptions, cb: ExecFileCallback) => {
      gitCalls.push({ cmd, args });
      if (cmd === "git" && args.includes("fetch") && gitMode === "fail") {
        // Сообщение об ошибке СОДЕРЖИТ токен-URL — ровно тот случай, где он мог бы утечь в лог.
        const url = args.find((a) => a.startsWith("https://")) ?? "";
        cb(new Error(`fatal: unable to access '${url}': The requested URL returned error: 403`), "", "");
        return;
      }
      cb(null, "", ""); // git fetch / branch --show-current и т.п. → успех
      return;
    }),
  };
});

// postJson теперь на node:http (обход 5-мин undici-таймаута) → мокаем request: мгновенный 200 + JSON.
vi.mock("node:http", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:http")>();
  return {
    ...original,
    request: vi.fn((_opts: unknown, cb: (res: IncomingMessage) => void): ClientRequest => {
      const res = Object.assign(new EventEmitter(), {
        statusCode: 200,
        setEncoding() {},
      }) as unknown as IncomingMessage;
      const req = Object.assign(new EventEmitter(), {
        setTimeout() {},
        write() {},
        destroy() {},
        end() {
          setImmediate(() => {
            cb(res);
            res.emit("data", JSON.stringify({ analysis: "разбор готов: файл foo.py" }));
            res.emit("end");
          });
        },
      }) as unknown as ClientRequest;
      return req;
    }) as unknown as typeof original.request,
  };
});

// pollProgress ещё на fetch: возвращаем валидный разбор/пустой прогресс.
const realFetch = globalThis.fetch;
beforeEach(() => {
  gitCalls.length = 0;
  gitMode = "ok";
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/v1/code-analyze")) {
      return new Response(JSON.stringify({ analysis: "разбор готов: файл foo.py" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    // code-progress и всё прочее — не критично для теста
    return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
});
afterAll(() => {
  globalThis.fetch = realFetch;
});

// Лог-капчер: consola пишет в process.stdout/stderr — перехватываем write, собираем всё в строку.
// Надёжнее reporter'а (не зависит от внутренней буферизации/дедупликации consola).
const logChunks: string[] = [];
function captureStream(stream: NodeJS.WriteStream): void {
  const orig = stream.write.bind(stream);
  vi.spyOn(stream, "write").mockImplementation(((chunk: unknown, ...rest: unknown[]) => {
    logChunks.push(typeof chunk === "string" ? chunk : String(chunk));
    return (orig as (...a: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof stream.write);
}
captureStream(process.stdout);
captureStream(process.stderr);

import { getWorkiSnapshot, workiMod } from "../src/mods/worki.mod.js";

type AnyCtx = Parameters<NonNullable<typeof workiMod.onTickEnd>>[0];
function makeCtx(): AnyCtx {
  return {
    graph: { has: () => false, getChannel: () => ({}), updateChannel: () => {} },
    state: { saved: {} },
    nowMs: Date.now(),
  } as unknown as AnyCtx;
}

/** Дёрнуть impl code_ask и дождаться терминального статуса задачи в снимке очереди. */
async function runAskAndWait(): Promise<void> {
  const impl = workiMod.instructions?.code_ask?.impl;
  expect(impl).toBeTypeOf("function");
  impl?.(makeCtx() as never, { task: "глянь foo" } as never);
  // runAnalysis fire-and-forget → ждём, пока задача дойдёт до done/error.
  for (let i = 0; i < 100; i++) {
    const snap = getWorkiSnapshot();
    if (snap.length > 0 && snap[0].status !== "running") return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("задача не завершилась за отведённое время");
}

describe("worki: fetchDevCloneFresh перед read-задачей (fix «fetch failed»)", () => {
  it("code_ask делает git fetch токен-URL'ом на DEV_CLONE, FETCH-only", async () => {
    await runAskAndWait();

    const fetchCall = gitCalls.find((c) => c.cmd === "git" && c.args.includes("fetch"));
    expect(fetchCall, "git fetch должен быть вызван перед ревью").toBeDefined();

    // Токен-URL: https://x-access-token:<token>@github.com/<repo>.git (зеркалит code_pr push).
    const url = fetchCall?.args.find((a) => a.startsWith("https://")) ?? "";
    expect(url).toBe(`https://x-access-token:${FAKE_TOKEN}@github.com/root3315/worki-alice.git`);

    // На правильном клоне.
    expect(fetchCall?.args).toContain("-C");
    expect(fetchCall?.args).toContain("C:\\fake\\alice-worki-dev");

    // Обновляем именно локальный origin/<base>-реф (не трогая дерево/ветки).
    expect(fetchCall?.args.some((a) => a.includes("refs/remotes/origin/main"))).toBe(true);

    // FETCH-only: никаких мутирующих git-подкоманд в рамках ревью.
    const mutating = gitCalls.filter((c) =>
      ["checkout", "reset", "pull", "push", "merge", "rebase"].some((m) => c.args.includes(m)),
    );
    expect(mutating, "read-путь не должен мутировать дерево/ветки").toEqual([]);
  });

  it("при ошибке fetch токен НЕ утекает в лог, ревью не падает", async () => {
    gitMode = "fail";
    logChunks.length = 0;
    await runAskAndWait();

    const all = logChunks.join("");
    // Сырой токен НЕ должен встречаться нигде в логах.
    expect(all.includes(FAKE_TOKEN)).toBe(false);
    // Маска присутствует (значит URL логировался, но санитизированный).
    expect(all.includes("x-access-token:***@")).toBe(true);

    // Ревью не упало из-за fetch: задача дошла до терминального статуса (а не зависла/кинула).
    const snap = getWorkiSnapshot();
    expect(snap[0].status === "done" || snap[0].status === "error").toBe(true);
  });
});
