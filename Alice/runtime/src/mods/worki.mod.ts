/**
 * Worki Mod — анализ и фикс кода Worki через ЧИСТЫЕ агенты, всё АСИНХРОННО.
 *
 * - code_ask: read-only разбор кода (прокси /v1/code-analyze, агент в read-only клоне).
 * - code_fix: правит баг + узкий тест + ветка+коммит локально (прокси /v1/code-fix). Без push.
 * - code_pr:  пушит ветку фикса в worki-alice + открывает PR (Node: git push + GitHub API).
 *
 * ДОСТАВКА (после аудита async-delivery): результат привязан к спросившему каналу
 * (`askGraphId`, захват TARGET_CHAT через deriveParams). На завершении `onTickEnd`
 * ставит НАПРАВЛЕННОЕ давление (`pending_directed`) на этот канал → движок гарантированно
 * приведёт тик туда (= «доделала текущее → сразу отдала»). Факт доставки ловим listener'ом
 * SEND_MESSAGE. `contribute()` — чистый (без мутаций); жизненный цикл/TTL — в `onTickEnd`
 * по wall-clock, удаляем только после доставки. Гейты — человеческие в чате.
 *
 * Phase B (TODO): персистентность очереди в ctx.state (переживать рестарт), топик форума
 * в send_message, target-scoped contribution (полностью убрать окно межчат-утечки).
 */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { z } from "zod";
import { createMod } from "../core/mod-builder.js";
import { PromptBuilder } from "../core/prompt-style.js";
import { header } from "../core/types.js";
import type { ContributionItem } from "../core/types.js";
import { telegramChannelId } from "../graph/constants.js";
import type { WorldModel } from "../graph/world-model.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("worki");
const execFileP = promisify(execFile);

const PROXY = process.env.PROXY_BASE_URL ?? "http://127.0.0.1:8787";
const CODE_ANALYZE_URL = process.env.PROXY_CODE_ANALYZE_URL ?? `${PROXY}/v1/code-analyze`;
const CODE_FIX_URL = process.env.PROXY_CODE_FIX_URL ?? `${PROXY}/v1/code-fix`;
const DEFAULT_TIMEOUT_MIN = 5;
const MAX_TIMEOUT_MIN = 20;
// Готовый-но-недоставленный результат держим по WALL-CLOCK (а не по счётчику тиков —
// прошлый костыль SHOW_TICKS ронял ответ, пока она отвлекалась на другие чаты).
const RESULT_TTL_MS = 5 * 60_000;
// Сторож зависших running (AbortSignal в postJson обычно снимает раньше — это belt-and-suspenders).
const RUNNING_TTL_MS = (MAX_TIMEOUT_MIN + 5) * 60_000;
const GIT_TIMEOUT_MS = 120_000;
const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: "0" };

// worki-alice (репо-песочница) + токен (host-only, из .env — в Docker-песочницу не идёт).
const WORKI_ALICE_REPO = process.env.WORKI_ALICE_REPO ?? "root3315/worki-alice";
const WORKI_ALICE_TOKEN = process.env.WORKI_ALICE_TOKEN ?? "";
const DEV_CLONE = process.env.WORKI_DEV_CLONE ?? "C:\\Users\\sozda\\alice-worki-dev";
const BASE_BRANCH = process.env.WORKI_BASE_BRANCH ?? "main";

// Краткая «душа» — чтобы ответ был в голосе Алисы. Только это из личности идёт агенту.
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

function clampTimeoutMin(raw: unknown): number {
  const n = Number(raw);
  return Math.max(1, Math.min(Number.isFinite(n) && n > 0 ? n : DEFAULT_TIMEOUT_MIN, MAX_TIMEOUT_MIN));
}

type Kind = "ask" | "fix" | "pr";
interface Pending {
  kind: Kind;
  task: string;
  status: "running" | "done" | "error";
  result: string;
  branch?: string;
  /** Канал, КУДА вернуть ответ ("channel:telegram:<id>"); захвачен на старте. */
  askGraphId?: string;
  createdMs: number;
  completedMs?: number;
  /** Направленное давление на канал уже выставлено (ставим один раз). */
  directed?: boolean;
  /** Подтверждена отправка сообщения в askGraphId (listener SEND_MESSAGE). */
  delivered?: boolean;
}
interface WorkiState {
  /** Готовые-но-недоставленные результаты — переживают рестарт (HIGH-10). */
  saved: Record<string, Pending>;
}

const pending = new Map<string, Pending>();
let _rehydrated = false;

/** Канал-источник из авто-параметра _reply_chat (deriveParams ← TARGET_CHAT, числовой ID). */
function askGraphFromArgs(args: Record<string, unknown>): string | undefined {
  const n = Number(args._reply_chat);
  return Number.isFinite(n) ? (telegramChannelId(n) as string) : undefined;
}

/** Один раз ставим направленное давление на спросивший канал → движок приведёт тик туда. */
function bumpDirected(graph: WorldModel, e: Pending): void {
  if (e.directed || !e.askGraphId) return;
  try {
    if (graph.has(e.askGraphId)) {
      const cur = Number((graph.getChannel(e.askGraphId) as { pending_directed?: number }).pending_directed ?? 0);
      graph.updateChannel(e.askGraphId, { pending_directed: cur + 1, last_directed_ms: Date.now() });
    }
    e.directed = true; // даже если канала нет в графе — не долбим повторно
  } catch (err) {
    log.warn("directed bump failed", { ch: e.askGraphId, err: (err as Error).message });
  }
}

function isBusy(kind: Kind): boolean {
  for (const p of pending.values()) if (p.kind === kind && p.status === "running") return true;
  return false;
}

/** Отличить таймаут/«не успело» от реальной недоступности сервиса (MED-17). */
function classifyErr(err: unknown): string {
  const e = err as Error;
  const msg = e?.message ?? String(err);
  if (e?.name === "TimeoutError" || e?.name === "AbortError" || /HTTP 504|timed?\s?out|таймаут/i.test(msg)) {
    return "не успело вовремя — попробуй с бОльшим timeout_min (напр. 10–15)";
  }
  return `сервис недоступен: ${msg}`;
}

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
    e.status = "done"; // пустой ответ на HTTP 200 — не ошибка (LOW-20)
    e.result = a || "разбор вышел пустой — попроси переспросить конкретнее";
    log.info("code-ask done", { id, len: e.result.length });
  } catch (err) {
    e.status = "error";
    e.result = classifyErr(err);
    log.warn("code-ask failed", { id, task, err: (err as Error).message });
  }
  e.completedMs = Date.now();
}

async function runFix(id: string, task: string, model: string, timeoutSec: number): Promise<void> {
  const e = pending.get(id);
  if (!e) return;
  try {
    const data = await postJson(CODE_FIX_URL, { task, persona: SOUL_BRIEF, model, timeout_s: timeoutSec }, timeoutSec);
    const r = String(data.report ?? "").trim();
    e.result = r || "fix-агент вернул пустой отчёт";
    e.status = r ? "done" : "error";
    try {
      const { stdout } = await execFileP("git", ["-C", DEV_CLONE, "branch", "--show-current"], {
        timeout: GIT_TIMEOUT_MS,
        env: GIT_ENV,
      });
      const br = stdout.trim();
      if (br && br !== BASE_BRANCH) e.branch = br;
    } catch {
      /* ветку не определили — она есть в отчёте */
    }
    log.info("code-fix done", { id, branch: e.branch });
  } catch (err) {
    e.status = "error";
    e.result = classifyErr(err);
    log.warn("code-fix failed", { id, err: (err as Error).message });
  }
  e.completedMs = Date.now();
}

async function runPr(id: string, branch: string, title: string): Promise<void> {
  const e = pending.get(id);
  if (!e) return;
  if (!WORKI_ALICE_TOKEN) {
    e.status = "error";
    e.result = "не задан WORKI_ALICE_TOKEN в .env — пуш невозможен";
    e.completedMs = Date.now();
    return;
  }
  try {
    const pushUrl = `https://x-access-token:${WORKI_ALICE_TOKEN}@github.com/${WORKI_ALICE_REPO}.git`;
    await execFileP("git", ["-C", DEV_CLONE, "push", pushUrl, `${branch}:${branch}`], {
      timeout: GIT_TIMEOUT_MS,
      env: GIT_ENV,
    });
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
    } else {
      const pr = (await res.json()) as { html_url?: string };
      e.status = "done";
      e.result = `PR открыт: ${pr.html_url ?? "(ссылка не пришла)"}`;
      log.info("code-pr done", { id, branch, url: pr.html_url });
    }
  } catch (err) {
    e.status = "error";
    e.result = `push/PR не вышло: ${(err as Error).message}`;
    log.warn("code-pr failed", { id, err: (err as Error).message });
  }
  e.completedMs = Date.now();
}

const TIMEOUT_DESC = "Таймаут в минутах (по умолч. 5). Подними, если просят дольше — напр. 10 или 15.";
const MODEL_DESC = "Модель: sonnet (по умолч., быстро) / opus (глубже, дольше) / haiku. Ставь opus, если просят «на опусе».";
const REPLY_CHAT_DESC = "служебный — НЕ заполняй, проставляется автоматически (чат, куда вернуть ответ).";
const deriveReplyChat = { _reply_chat: (cv: Record<string, unknown>) => cv.TARGET_CHAT };

export const workiMod = createMod<WorkiState>("worki", {
  category: "mechanic",
  description: "Анализ и фикс кода Worki чистыми агентами (async): code_ask / code_fix / code_pr",
  topics: ["worki"],
  initialState: { saved: {} },
})
  .instruction("code_ask", {
    params: z.object({
      task: z.coerce.string().trim().min(1).describe('Вопрос/задача по коду Worki своими словами (напр. "какие парсеры и что делает tg-парсер")'),
      model: z.coerce.string().optional().describe(MODEL_DESC),
      timeout_min: z.coerce.number().optional().describe(TIMEOUT_DESC),
      _reply_chat: z.coerce.number().optional().describe(REPLY_CHAT_DESC),
    }),
    deriveParams: deriveReplyChat,
    description: "Спросить про код Worki — чистый агент прочитает реальный код и пришлёт разбор АСИНХРОННО в этот чат",
    affordance: {
      priority: "capability",
      category: "memory",
      whenToUse: "Любой вопрос/анализ по коду Worki. Запускает фоновый разбор и СРАЗУ возвращается — НЕ грепай файлы сама. Ответ сам придёт в этот чат.",
      whenNotToUse: "Не про код Worki",
    },
    impl(ctx, args): unknown {
      const task = String(args.task);
      if (isBusy("ask")) {
        return { success: true, message: "Уже разбираю код — погоди, результат вот-вот придёт в этот чат. Повторно не запускай." };
      }
      const model = normalizeModel(args.model as string | undefined);
      const tmin = clampTimeoutMin(args.timeout_min);
      const id = `ask-${randomUUID()}`;
      pending.set(id, { kind: "ask", task, status: "running", result: "", askGraphId: askGraphFromArgs(args), createdMs: ctx.nowMs });
      void runAnalysis(id, task, model, tmin * 60);
      log.info("code-ask started", { id, model, tmin });
      return { success: true, message: `Разбор запущен (${model}, до ${tmin} мин) — приду с ответом в этот чат. Скажи, что смотришь код, и живи дальше.` };
    },
  })
  .instruction("code_fix", {
    params: z.object({
      task: z.coerce.string().trim().min(1).describe("Что починить, своими словами (опиши баг и желаемую правку). Только ПОСЛЕ одобрения человека."),
      model: z.coerce.string().optional().describe(MODEL_DESC),
      timeout_min: z.coerce.number().optional().describe(TIMEOUT_DESC),
      _reply_chat: z.coerce.number().optional().describe(REPLY_CHAT_DESC),
    }),
    deriveParams: deriveReplyChat,
    description: "Починить баг в коде Worki: агент правит + гоняет тесты + создаёт ветку и коммитит (БЕЗ push). Async. Только после одобрения.",
    affordance: {
      priority: "capability",
      category: "memory",
      whenToUse: "Когда человек ОДОБРИЛ фикс. Агент правит код в dev-клоне, гоняет относящиеся тесты, делает ветку+коммит. Потом спроси «открыть PR?» и зови code_pr.",
      whenNotToUse: "Без одобрения; для простого чтения кода (это code_ask)",
    },
    impl(ctx, args): unknown {
      const task = String(args.task);
      if (isBusy("fix")) {
        return { success: true, message: "Один фикс уже в работе — дождись его, потом запускай следующий (общий dev-клон)." };
      }
      const model = normalizeModel(args.model as string | undefined);
      const tmin = clampTimeoutMin(args.timeout_min);
      const id = `fix-${randomUUID()}`;
      pending.set(id, { kind: "fix", task, status: "running", result: "", askGraphId: askGraphFromArgs(args), createdMs: ctx.nowMs });
      void runFix(id, task, model, tmin * 60);
      log.info("code-fix started", { id, model, tmin });
      return { success: true, message: `Фикс запущен (${model}, до ${tmin} мин): правлю + тесты + ветка. Результат придёт в этот чат; не пушу — спросишь «открыть PR?».` };
    },
  })
  .instruction("code_pr", {
    params: z.object({
      branch: z.coerce.string().trim().min(1).describe("Ветка фикса (alice/<slug>) из отчёта code_fix."),
      title: z.coerce.string().optional().describe("Заголовок PR (необязательно)."),
      _reply_chat: z.coerce.number().optional().describe(REPLY_CHAT_DESC),
    }),
    deriveParams: deriveReplyChat,
    description: "Запушить ветку фикса в worki-alice и открыть PR. Async. Только после «открыть PR?» → одобрения.",
    affordance: {
      priority: "capability",
      category: "memory",
      whenToUse: "Когда человек одобрил открытие PR по готовому фиксу. Пушит ветку + открывает PR, мержит человек.",
      whenNotToUse: "Без одобрения; до того как code_fix успешно сделал ветку",
    },
    impl(ctx, args): unknown {
      const branch = String(args.branch);
      if (isBusy("pr")) {
        return { success: true, message: "Уже открываю PR — погоди ссылку." };
      }
      const title = args.title != null ? String(args.title) : "";
      const id = `pr-${randomUUID()}`;
      pending.set(id, { kind: "pr", task: branch, status: "running", result: "", askGraphId: askGraphFromArgs(args), createdMs: ctx.nowMs });
      void runPr(id, branch, title);
      log.info("code-pr started", { id, branch });
      return { success: true, message: `Пушу ветку ${branch} и открываю PR — ссылка придёт в этот чат.` };
    },
  })
  // Честная детекция доставки: она отправила сообщение в спросивший чат → результат доставлен.
  .listen("SEND_MESSAGE", (_ctx, args) => {
    const chatId = args.chatId ? String(args.chatId) : null;
    if (!chatId) return;
    for (const p of pending.values()) {
      if (p.askGraphId === chatId && (p.status === "done" || p.status === "error") && !p.delivered) {
        p.delivered = true;
      }
    }
  })
  // contribute() — ЧИСТЫЙ: только читает и отдаёт готовые недоставленные результаты.
  .contribute((): ContributionItem[] => {
    const ready: string[] = [];
    for (const p of pending.values()) {
      if (p.status === "running" || p.delivered) continue;
      // Анти-утечка: эмитим ТОЛЬКО после направленного давления (ставится в onTickEnd) —
      // тогда следующий тик уже в спросившем чате, и результат не мелькнёт в чужом промпте.
      if (!p.directed) continue;
      if (p.status === "error") {
        ready.push(`«${p.task}» — не вышло: ${p.result}. Скажи честно в чат, где спросили, что не получилось.`);
      } else if (p.kind === "ask") {
        ready.push(`Готов разбор кода («${p.task}»). Ответь им этим сейчас в чат, где спросили про код — ждут. Своими словами, по делу:\n${p.result}`);
      } else if (p.kind === "fix") {
        const prHint = p.branch ? `\nЕсли ок и человек одобрит — открой PR: self code-pr --branch ${p.branch}` : "";
        ready.push(`Готов фикс по «${p.task}» (перескажи в чат, где просили, + спроси «открыть PR?»):\n${p.result}${prHint}`);
      } else {
        ready.push(p.result); // pr: "PR открыт: <url>"
      }
    }
    if (ready.length === 0) return [];
    const raw = ["## Готово по коду Worki", "", ready.join("\n\n")].join("\n");
    const lines = PromptBuilder.fromRaw(
      raw
        .split("\n")
        .map((l) => l.replace(/^\s+/, "").replace(/\*\*/g, ""))
        .join("\n"),
    );
    return [header(lines, 88)];
  })
  // Жизненный цикл (мутации) — здесь, не в contribute(): направленное давление + TTL + сторож.
  .onTickEnd((ctx) => {
    // Регидрация один раз после рестарта: вернуть в очередь недоставленные результаты (HIGH-10).
    if (!_rehydrated) {
      _rehydrated = true;
      for (const [id, p] of Object.entries(ctx.state.saved ?? {})) {
        if (!pending.has(id)) pending.set(id, { ...p, directed: false, completedMs: ctx.nowMs });
      }
    }
    const now = ctx.nowMs;
    for (const [id, p] of pending) {
      if (p.delivered) {
        pending.delete(id);
        continue;
      }
      if (p.status === "running") {
        if (now - p.createdMs > RUNNING_TTL_MS) {
          p.status = "error";
          p.result = "разбор завис и снят по таймауту";
          p.completedMs = now;
        }
        continue;
      }
      // done/error: один раз толкаем спросивший чат, чтобы движок привёл тик туда.
      if (!p.directed) bumpDirected(ctx.graph, p);
      // Недоставленный результат живёт по wall-clock, потом сдаёмся.
      if (p.completedMs && now - p.completedMs > RESULT_TTL_MS) pending.delete(id);
    }
    // Персист готовых-недоставленных (running-промисы рестарт не переживают) → переживут рестарт.
    const saved: Record<string, Pending> = {};
    for (const [id, p] of pending) {
      if ((p.status === "done" || p.status === "error") && !p.delivered) saved[id] = p;
    }
    ctx.state.saved = saved;
  })
  .build();
