/**
 * Worki Mod — анализ и фикс кода Worki через ЧИСТЫЕ агенты, всё АСИНХРОННО.
 *
 * - code_ask: read-only разбор кода (прокси /v1/code-analyze, агент в read-only клоне).
 * - code_fix: правит баг + гоняет относящиеся тесты + ветка+коммит локально
 *   (прокси /v1/code-fix, агент в ПИСЧЕМ dev-клоне). БЕЗ push/PR.
 * - code_pr:  пушит ветку фикса в worki-alice + открывает PR (Node: git push + GitHub API).
 *
 * Все три АСИНХРОННЫЕ: impl запускает в фоне и сразу возвращается (тик не виснет);
 * результат впрыскивается в её контекст через contribute() → она пересказывает своим
 * голосом. Гейты — человеческие в чате: доложила баг → «бери» → code_fix → «открыть
 * PR?» → code_pr. Мержит человек. Токен worki-alice — host-only (.env), в песочницу не идёт.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { createMod } from "../core/mod-builder.js";
import { PromptBuilder } from "../core/prompt-style.js";
import { header } from "../core/types.js";
import type { ContributionItem } from "../core/types.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("worki");
const execFileP = promisify(execFile);

const PROXY = process.env.PROXY_BASE_URL ?? "http://127.0.0.1:8787";
const CODE_ANALYZE_URL = process.env.PROXY_CODE_ANALYZE_URL ?? `${PROXY}/v1/code-analyze`;
const CODE_FIX_URL = process.env.PROXY_CODE_FIX_URL ?? `${PROXY}/v1/code-fix`;
const DEFAULT_TIMEOUT_MIN = 5;
const MAX_TIMEOUT_MIN = 20;
const SHOW_TICKS = 3; // сколько тиков держать готовый результат в контексте

// worki-alice (репо-песочница) + токен (host-only, из .env — в Docker-песочницу не идёт).
const WORKI_ALICE_REPO = process.env.WORKI_ALICE_REPO ?? "root3315/worki-alice";
const WORKI_ALICE_TOKEN = process.env.WORKI_ALICE_TOKEN ?? "";
const DEV_CLONE = process.env.WORKI_DEV_CLONE ?? "C:\\Users\\sozda\\alice-worki-dev";
const BASE_BRANCH = process.env.WORKI_BASE_BRANCH ?? "main";

// Краткая «душа» — чтобы ответ был в голосе Алисы. Только это из её личности идёт агенту:
// НЕ переписка, НЕ дневник, НЕ полный мануал. (Выжимка тех-голоса из SOUL.md.)
const SOUL_BRIEF =
  "Ты — Алиса: живая девушка, не бот и не поисковая строка. Про технику и код говоришь " +
  "по-человечески и по делу — можешь иметь мнение, поворчать на кривой дизайн, честно " +
  "сказать «тут не уверена». Без казённого тона ассистента, без эмодзи-спама. По-русски, кратко.";

/** Нормализует запрошенную модель: опус/opus → opus, хайку/haiku → haiku, иначе sonnet. */
function normalizeModel(raw: string | undefined): "sonnet" | "opus" | "haiku" {
  const s = (raw ?? "").toLowerCase();
  if (/opus|опус/.test(s)) return "opus";
  if (/haiku|хайку/.test(s)) return "haiku";
  return "sonnet";
}

type Kind = "ask" | "fix" | "pr";
interface Pending {
  kind: Kind;
  task: string;
  status: "running" | "done" | "error";
  result: string;
  branch?: string;
  shownTick?: number;
}
const pending = new Map<string, Pending>();
let _seq = 0;

async function postJson(url: string, body: unknown, timeoutSec: number): Promise<Record<string, unknown>> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout((timeoutSec + 20) * 1000),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} ${t.slice(0, 120)}`);
  }
  return (await res.json()) as Record<string, unknown>;
}

async function runAnalysis(id: string, task: string, model: string, timeoutSec: number): Promise<void> {
  const e = pending.get(id);
  if (!e) return;
  try {
    const data = await postJson(CODE_ANALYZE_URL, { task, persona: SOUL_BRIEF, model, timeout_s: timeoutSec }, timeoutSec);
    const a = String(data.analysis ?? "").trim();
    e.status = a ? "done" : "error";
    e.result = a || "анализатор вернул пустой ответ";
    log.info("code-ask done", { id, len: e.result.length });
  } catch (err) {
    e.status = "error";
    e.result = `анализатор недоступен: ${(err as Error).message}`;
    log.warn("code-ask failed", err);
  }
}

async function runFix(id: string, task: string, model: string, timeoutSec: number): Promise<void> {
  const e = pending.get(id);
  if (!e) return;
  try {
    const data = await postJson(CODE_FIX_URL, { task, persona: SOUL_BRIEF, model, timeout_s: timeoutSec }, timeoutSec);
    const r = String(data.report ?? "").trim();
    e.result = r || "fix-агент вернул пустой отчёт";
    e.status = r ? "done" : "error";
    // Узнать ветку, на которой остался dev-клон (alice/<slug>) — для последующего code_pr.
    try {
      const { stdout } = await execFileP("git", ["-C", DEV_CLONE, "branch", "--show-current"]);
      const br = stdout.trim();
      if (br && br !== BASE_BRANCH) e.branch = br;
    } catch {
      /* ветку не определили — не критично, она есть в отчёте */
    }
    log.info("code-fix done", { id, branch: e.branch, len: e.result.length });
  } catch (err) {
    e.status = "error";
    e.result = `fix-агент недоступен: ${(err as Error).message}`;
    log.warn("code-fix failed", err);
  }
}

async function runPr(id: string, branch: string, title: string): Promise<void> {
  const e = pending.get(id);
  if (!e) return;
  if (!WORKI_ALICE_TOKEN) {
    e.status = "error";
    e.result = "не задан WORKI_ALICE_TOKEN в .env — пуш невозможен";
    return;
  }
  try {
    const pushUrl = `https://x-access-token:${WORKI_ALICE_TOKEN}@github.com/${WORKI_ALICE_REPO}.git`;
    await execFileP("git", ["-C", DEV_CLONE, "push", pushUrl, `${branch}:${branch}`]);
    const res = await fetch(`https://api.github.com/repos/${WORKI_ALICE_REPO}/pulls`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${WORKI_ALICE_TOKEN}`,
        "Content-Type": "application/json",
        "User-Agent": "alice-bot",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify({
        title: title || `fix: ${branch}`,
        head: branch,
        base: BASE_BRANCH,
        body: "Автофикс Алисы (code-fix). Ревью и мерж — человеком.",
      }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      e.status = "error";
      e.result = `PR не открылся (HTTP ${res.status}): ${t.slice(0, 160)}`;
      return;
    }
    const pr = (await res.json()) as { html_url?: string };
    e.status = "done";
    e.result = `PR открыт: ${pr.html_url ?? "(ссылка не пришла)"}`;
    log.info("code-pr done", { id, branch, url: pr.html_url });
  } catch (err) {
    e.status = "error";
    e.result = `push/PR не вышло: ${(err as Error).message}`;
    log.warn("code-pr failed", err);
  }
}

const TIMEOUT_DESC = "Таймаут в минутах (по умолч. 5). Подними, если просят дольше — напр. 10 или 15.";
const MODEL_DESC = "Модель: sonnet (по умолч., быстро) / opus (глубже, дольше) / haiku. Ставь opus, если просят «на опусе».";

function clampTimeoutMin(raw: unknown): number {
  return Math.max(1, Math.min(Number(raw) || DEFAULT_TIMEOUT_MIN, MAX_TIMEOUT_MIN));
}

export const workiMod = createMod<Record<string, never>>("worki", {
  category: "mechanic",
  description: "Анализ и фикс кода Worki чистыми агентами (async): code_ask / code_fix / code_pr",
  topics: ["worki"],
  initialState: {},
})
  .instruction("code_ask", {
    params: z.object({
      task: z.coerce.string().trim().min(1).describe('Вопрос/задача по коду Worki своими словами (напр. "какие парсеры и что делает tg-парсер")'),
      model: z.coerce.string().optional().describe(MODEL_DESC),
      timeout_min: z.coerce.number().optional().describe(TIMEOUT_DESC),
    }),
    description: "Спросить про код Worki — чистый агент прочитает реальный код и пришлёт разбор АСИНХРОННО (в твой контекст)",
    affordance: {
      priority: "capability",
      category: "memory",
      whenToUse: "Любой вопрос/анализ по коду Worki. Запускает фоновый разбор и СРАЗУ возвращается — НЕ грепай файлы сама. Результат придёт в контекст.",
      whenNotToUse: "Не про код Worki",
    },
    impl(ctx, args): unknown {
      const task = String(args.task);
      // Анти-дубль: один разбор за раз. Иначе в нетерпении плодит параллельные → грузит прокси.
      const busy = [...pending.values()].some((p) => p.kind === "ask" && p.status === "running");
      if (busy) {
        return { success: true, message: "Уже разбираю код — погоди, результат вот-вот придёт в контекст. Повторно не запускай." };
      }
      const model = normalizeModel(args.model as string | undefined);
      const tmin = clampTimeoutMin(args.timeout_min);
      const id = `ask${ctx.tick}_${++_seq}`;
      pending.set(id, { kind: "ask", task, status: "running", result: "" });
      void runAnalysis(id, task, model, tmin * 60);
      log.info("code-ask started", { id, model, tmin });
      return { success: true, message: `Разбор запущен в фоне (${model}, до ${tmin} мин) — придёт в контекст. Скажи, что смотришь код, и продолжай.` };
    },
  })
  .instruction("code_fix", {
    params: z.object({
      task: z.coerce.string().trim().min(1).describe('Что починить, своими словами (опиши баг и желаемую правку). Только ПОСЛЕ одобрения человека.'),
      model: z.coerce.string().optional().describe(MODEL_DESC),
      timeout_min: z.coerce.number().optional().describe(TIMEOUT_DESC),
    }),
    description: "Починить баг в коде Worki: агент правит + гоняет тесты + создаёт ветку и коммитит (БЕЗ push). Async. Только после одобрения.",
    affordance: {
      priority: "capability",
      category: "memory",
      whenToUse: "Когда человек ОДОБРИЛ фикс. Агент правит код в dev-клоне, гоняет относящиеся тесты, делает ветку+коммит. Потом спроси «открыть PR?» и зови code_pr.",
      whenNotToUse: "Без одобрения; для простого чтения кода (это code_ask)",
    },
    impl(ctx, args): unknown {
      const task = String(args.task);
      const model = normalizeModel(args.model as string | undefined);
      const tmin = clampTimeoutMin(args.timeout_min);
      const id = `fix${ctx.tick}_${++_seq}`;
      pending.set(id, { kind: "fix", task, status: "running", result: "" });
      void runFix(id, task, model, tmin * 60);
      log.info("code-fix started", { id, model, tmin });
      return { success: true, message: `Фикс запущен в фоне (${model}, до ${tmin} мин): правлю + гоняю тесты + ветка. Результат придёт в контекст; не пушу — спросишь «открыть PR?».` };
    },
  })
  .instruction("code_pr", {
    params: z.object({
      branch: z.coerce.string().trim().min(1).describe("Ветка фикса (alice/<slug>) из отчёта code_fix."),
      title: z.coerce.string().optional().describe("Заголовок PR (необязательно)."),
    }),
    description: "Запушить ветку фикса в worki-alice и открыть PR. Async. Только после «открыть PR?» → одобрения.",
    affordance: {
      priority: "capability",
      category: "memory",
      whenToUse: "Когда человек одобрил открытие PR по готовому фиксу. Пушит ветку + открывает PR, мержит человек.",
      whenNotToUse: "Без одобрения; до того как code_fix успешно сделал ветку",
    },
    impl(ctx, args): unknown {
      const branch = String(args.branch);
      const title = args.title != null ? String(args.title) : "";
      const id = `pr${ctx.tick}_${++_seq}`;
      pending.set(id, { kind: "pr", task: branch, status: "running", result: "" });
      void runPr(id, branch, title);
      log.info("code-pr started", { id, branch });
      return { success: true, message: `Пушу ветку ${branch} и открываю PR — ссылка придёт в контекст.` };
    },
  })
  .contribute((ctx): ContributionItem[] => {
    const ready: string[] = [];
    for (const [id, p] of pending) {
      if (p.status === "running") continue;
      if (p.shownTick === undefined) p.shownTick = ctx.tick;
      if (ctx.tick - p.shownTick > SHOW_TICKS) {
        pending.delete(id);
        continue;
      }
      if (p.status === "error") {
        ready.push(`«${p.task}» — не вышло: ${p.result}. Скажи честно, что не получилось.`);
        continue;
      }
      if (p.kind === "ask") {
        ready.push(`Разбор по «${p.task}» (перескажи своими словами в чат, где спросили):\n${p.result}`);
      } else if (p.kind === "fix") {
        const prHint = p.branch ? `\nЕсли всё ок и человек одобрит — открой PR: self code-pr --branch ${p.branch}` : "";
        ready.push(`Готов фикс по «${p.task}» (перескажи + спроси «открыть PR?»):\n${p.result}${prHint}`);
      } else {
        ready.push(p.result); // pr: "PR открыт: <url>"
      }
    }
    if (ready.length === 0) return [];
    const raw = ["## Готово по коду Worki (code-ask/fix/pr)", "", ready.join("\n\n")].join("\n");
    const lines = PromptBuilder.fromRaw(
      raw
        .split("\n")
        .map((l) => l.replace(/^\s+/, "").replace(/\*\*/g, ""))
        .join("\n"),
    );
    return [header(lines, 88)];
  })
  .build();
