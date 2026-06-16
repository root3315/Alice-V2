/**
 * Worki Mod — анализ и фикс кода Worki через ЧИСТЫЕ агенты, всё АСИНХРОННО.
 *
 * - code_ask:  read-only разбор кода (прокси /v1/code-analyze, агент в read-only клоне).
 * - code_fix:  правит баг + узкий тест + ветка+коммит локально (прокси /v1/code-fix). Без push.
 * - code_test: гоняет относящиеся тесты в чистом клоне (прокси /v1/code-test) → pass/fail.
 * - code_run:  ограниченная команда build/lint/test (прокси /v1/code-run, allowlist) → exit+хвост.
 * - code_pr:   пушит ветку фикса в worki-alice + открывает PR (Node: git push + GitHub API).
 *
 * Все code_*-инструкции АСИНХРОННЫ по одной схеме: impl ставит Pending в `pending` и сразу
 * возвращается, runX дёргает прокси с task_id (live-прогресс), результат доставляется в
 * спросивший канал через направленное давление. Опциональный `project` пробрасывается в тело
 * запроса (omit = текущий единственный проект, полная обратная совместимость).
 * `getWorkiSnapshot()` — read-only снимок очереди для дашборда.
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
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { promisify } from "node:util";
import { z } from "zod";
import { createMod } from "../core/mod-builder.js";
import { PromptBuilder } from "../core/prompt-style.js";
import { header } from "../core/types.js";
import type { ContributionItem } from "../core/types.js";
import { telegramChannelId } from "../graph/constants.js";
import { syncWorkiActive } from "../engine/act/worki-active.js";
import type { WorldModel } from "../graph/world-model.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("worki");
const execFileP = promisify(execFile);

const PROXY = process.env.PROXY_BASE_URL ?? "http://127.0.0.1:8787";
const CODE_ANALYZE_URL = process.env.PROXY_CODE_ANALYZE_URL ?? `${PROXY}/v1/code-analyze`;
const CODE_FIX_URL = process.env.PROXY_CODE_FIX_URL ?? `${PROXY}/v1/code-fix`;
const CODE_TEST_URL = process.env.PROXY_CODE_TEST_URL ?? `${PROXY}/v1/code-test`;
const CODE_RUN_URL = process.env.PROXY_CODE_RUN_URL ?? `${PROXY}/v1/code-run`;
const CODE_RESEARCH_URL = process.env.PROXY_RESEARCH_URL ?? `${PROXY}/v1/research`;
const CODE_PROGRESS_BASE = process.env.PROXY_CODE_PROGRESS_URL ?? `${PROXY}/v1/code-progress/`;
const DEFAULT_TIMEOUT_MIN = 5;
const MAX_TIMEOUT_MIN = 20;
// Готовый-но-недоставленный результат держим по WALL-CLOCK (а не по счётчику тиков —
// прошлый костыль SHOW_TICKS ронял ответ, пока она отвлекалась на другие чаты).
// Раньше было 5 мин → ответ терялся, если она надолго занята в другом чате. Теперь держим ДОЛГО:
// она НЕ должна «забыть» отдать результат. Дроп лишь по жёсткому хард-капу (защита от накопления)
// или если спросивший чат стал недостижим (см. onTickEnd).
const UNDELIVERED_MAX_MS = 6 * 60 * 60_000; // 6h
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

type Kind = "ask" | "fix" | "pr" | "test" | "run" | "research";
interface Pending {
  kind: Kind;
  task: string;
  status: "running" | "done" | "error";
  result: string;
  branch?: string;
  /** Опциональный проект (если песочница станет мульти-проектной); по умолч. omit = текущий. */
  project?: string;
  /** Канал, КУДА вернуть ответ ("channel:telegram:<id>"); захвачен на старте. */
  askGraphId?: string;
  createdMs: number;
  completedMs?: number;
  /** Направленное давление на канал уже выставлено (ставим один раз). */
  directed?: boolean;
  /** Подтверждена отправка сообщения в askGraphId (listener SEND_MESSAGE). */
  delivered?: boolean;
  /** Прогресс-стриминг во время running (опрашивается с прокси /v1/code-progress). */
  progress?: { latest?: string; recent?: string[]; updated?: number };
  /** Сказала «секунду, гляну» при старте (один раз). */
  acked?: boolean;
  /** Троттл опроса прогресса (мс). */
  lastPollMs?: number;
  /** Троттл нарратива прогресса в чат (мс), против спама. */
  lastNarrateMs?: number;
  /** Троттл прямой отправки статус-строки worki (мс). */
  lastStatusMs?: number;
  /** Последняя отправленная статус-строка (антидубль). */
  lastStatusText?: string;
  /** Счётчик статус-строк (для ротации живых фраз). */
  statusCount?: number;
  /** Статус-строка сейчас в полёте (async): не шлём дубль, троттл/счётчик двигаем лишь на success. */
  statusSending?: boolean;
}
interface WorkiState {
  /** Готовые-но-недоставленные результаты — переживают рестарт (HIGH-10). */
  saved: Record<string, Pending>;
}

// ВНИМАНИЕ (НЕ sandbox-rollback-safe): `pending` и `_rehydrated` — module-global, ВНЕ снимка
// диспетчера (snapshot/rollback гоняет только ctx.state, не модульные переменные). Это осознанно:
// worki — single-instance (один процесс рантайма, один dev-клон, code_*-инструкции сериализованы
// через isBusy), а живой цикл доставки завязан на in-flight промисы (runAnalysis/runFix/runPr),
// listener SEND_MESSAGE и async-статусы — всё это живёт в `pending`, а НЕ в ctx.state.
// Перенос `pending` в ctx.state ломает доставку (промисы и listener мутируют объект напрямую,
// rollback отыграл бы их назад) → НЕ делать без отдельного аудита. Долговечность через рестарт
// решена иначе: недоставленные результаты (вкл. running → честная ошибка) персистятся в
// ctx.state.saved в onTickEnd и регидрируются после рестарта. Откат тика worki НЕ откатит
// (приемлемо: статус-строки идемпотентны по антидублю, доставка — по wall-clock и delivered).
const pending = new Map<string, Pending>();
let _rehydrated = false;

/** Read-only снимок одной задачи для дашборда (без секретов/каналов — только статус-факты). */
export interface WorkiTaskSnapshot {
  id: string;
  kind: Kind;
  task: string;
  status: "running" | "done" | "error";
  /** Последняя строка прогресса worki-агента (если была). */
  latestProgress?: string;
  project?: string;
  createdMs: number;
  completedMs?: number;
  delivered: boolean;
}

/**
 * READ-ONLY снимок текущих in-flight + недоставленных задач worki — для дашборда.
 * Возвращает простые сериализуемые объекты (никаких ссылок на внутренние Pending),
 * чтобы потребитель не мог случайно мутировать живое состояние доставки.
 */
export function getWorkiSnapshot(): WorkiTaskSnapshot[] {
  const out: WorkiTaskSnapshot[] = [];
  for (const [id, p] of pending) {
    out.push({
      id,
      kind: p.kind,
      task: p.task,
      status: p.status,
      latestProgress: p.progress?.latest,
      project: p.project,
      createdMs: p.createdMs,
      completedMs: p.completedMs,
      delivered: Boolean(p.delivered),
    });
  }
  // Стабильный порядок: свежие сверху — удобнее для дашборда.
  out.sort((a, b) => b.createdMs - a.createdMs);
  return out;
}

/**
 * Прямая отправка статус-строк (подключается из index.ts телеграм-клиентом). Живые фразы, её стиль.
 * Возвращает Promise<boolean> — true только при УСПЕШНОЙ доставке. worki продвигает троттл/
 * антидубль/счётчик строк лишь на success (раньше провал глотался → строка терялась молча).
 */
let _statusSender: ((chatId: number, text: string, topicId?: number) => Promise<boolean>) | null =
  null;
export function setWorkiStatusSender(
  fn: (chatId: number, text: string, topicId?: number) => Promise<boolean>,
): void {
  _statusSender = fn;
}
/** Живые лид-фразы для статус-строк — чтобы читалось как её реплики, не робо-лог. */
const STATUS_LEADS = ["ага, ", "так, ", "сейчас ", "о, ", "угу, ", ""];

/** Троттл статус-строк прогресса: в ЛС живой темп (18с), в группе медленнее (60с) — меньше спама. */
const STATUS_THROTTLE_DM_MS = 18_000;
const STATUS_THROTTLE_GROUP_MS = 60_000;

/**
 * Похоже ли отправленное сообщение на ДОСТАВКУ результата (а не на короткий ack/реакцию/
 * постороннюю реплику в том же чате)? Она пересказывает результат СВОИМИ словами, поэтому
 * точный матч не годится: для готового разбора ловим топикальное пересечение (файлы/длинные
 * термины из задачи+результата), для ошибки — маркеры провала. Так короткое «привет/секунду»
 * больше не «съедает» готовый ответ (КРИТ-баг доставки: раньше delivered ставился от ЛЮБОГО
 * сообщения в спросивший чат).
 */
export function looksLikeDelivery(text: string | undefined, p: Pending): boolean {
  const t = (text ?? "").toLowerCase();
  if (t.length < 24) return false; // ack / реакция / приветствие — это не результат
  if (t.length >= 200) return true; // длинный текст — почти наверняка пересказ разбора
  if (
    p.status === "error" &&
    /не вы|не получ|не смог|не могу|ошибк|сбой|упал|fail|недоступ|увы|таймаут|завис/.test(t)
  ) {
    return true; // объявление провала общими словами, без терминов задачи
  }
  const src = `${p.task} ${p.result}`.toLowerCase();
  const distinctive = (src.match(/[a-zа-яё0-9_./-]{5,}/gi) ?? []).filter(
    (w) => w.length >= 8 || /[._/-]/.test(w),
  );
  return distinctive.some((tok) => t.includes(tok));
}

/** Канал-источник из авто-параметра _reply_chat (deriveParams ← TARGET_CHAT, числовой ID). */
function askGraphFromArgs(args: Record<string, unknown>): string | undefined {
  const n = Number(args._reply_chat);
  return Number.isFinite(n) ? (telegramChannelId(n) as string) : undefined;
}

/**
 * Держим направленное давление на спросивший канал, ПОКА результат не доставлен → движок будет
 * приводить тик туда. Re-assert: если давление уже потрачено (упало до 0), а ответ ещё не отдан —
 * ставим снова (без инфляции, только до 1), чтобы она не «забыла» доделать доставку.
 */
function ensureDirected(graph: WorldModel, e: Pending): void {
  if (!e.askGraphId) return;
  try {
    if (graph.has(e.askGraphId)) {
      const cur = Number((graph.getChannel(e.askGraphId) as { pending_directed?: number }).pending_directed ?? 0);
      if (cur <= 0) {
        graph.updateChannel(e.askGraphId, { pending_directed: 1, last_directed_ms: Date.now() });
      }
      e.directed = true; // канал есть → давление активно (и переустанавливаем при потере)
    }
    // канал ещё не в графе → directed=false, повторим на следующем onTickEnd (не эмитим в чужой чат)
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

/** Вырезать GitHub-PAT из строки перед логом/чатом (H5: токен не должен утечь наружу). */
function scrubToken(s: string): string {
  let out = s;
  if (WORKI_ALICE_TOKEN) out = out.split(WORKI_ALICE_TOKEN).join("***");
  return out.replace(/x-access-token:[^@\s]*@/g, "x-access-token:***@");
}

/**
 * Подтянуть свежие объекты base-ветки в dev-клон НА ХОСТЕ перед read-задачами по коду.
 *
 * Зачем: read-путь (ревью/анализ/тест/прогон) резолвит конкретный коммит/реф в read-only
 * dev-клоне через прокси. Если клон отстал и нужного коммита нет — ревью идёт по СТАРОМУ коду,
 * а git fetch без авторизации на ПРИВАТНОМ репо падает с «fetch failed» (нет кэша host-creds).
 * Поэтому фетчим ЗДЕСЬ, на хосте, токен-URL'ом (как code_pr для push). Токен host-only —
 * в Docker-песочницу не идёт (это просто локальный `git -C DEV_CLONE fetch`, не sandbox-команда).
 *
 * ТОЛЬКО fetch: НЕ трогаем рабочее дерево / текущую ветку / локальные fix-ветки (никаких
 * checkout/reset/pull) — нужно лишь чтобы объекты были на месте, реф резолвит сам ревью-путь.
 * Обновляем и локальный refs/remotes/origin/<base>, чтобы прокси/клон видел новые коммиты.
 * Идемпотентно и дёшево; ошибки/пустой токен — не валим ревью, лишь предупреждаем (санитизировано).
 */
async function fetchDevCloneFresh(): Promise<void> {
  if (!WORKI_ALICE_TOKEN) {
    log.warn("worki: WORKI_ALICE_TOKEN пуст — пропускаю fetch dev-клона (приватный репо не обновить)");
    return;
  }
  const tokenUrl = `https://x-access-token:${WORKI_ALICE_TOKEN}@github.com/${WORKI_ALICE_REPO}.git`;
  try {
    // FETCH-only: тянем base-ветку и обновляем локальный origin/<base>-реф (никаких мутаций дерева).
    const { stdout, stderr } = await execFileP(
      "git",
      [
        "-C",
        DEV_CLONE,
        "fetch",
        tokenUrl,
        `+refs/heads/${BASE_BRANCH}:refs/remotes/origin/${BASE_BRANCH}`,
      ],
      { timeout: GIT_TIMEOUT_MS, env: GIT_ENV },
    );
    const tail = scrubToken(`${stdout}\n${stderr}`.trim());
    log.debug("worki: dev-клон обновлён (fetch)", { out: tail.slice(0, 200) });
  } catch (err) {
    // Не валим ревью: реф может уже быть на месте (стоп-гэп ручного фетча) — отдаём что есть.
    log.warn("worki: fetch dev-клона не удался — продолжаю на текущем состоянии", {
      err: scrubToken((err as Error).message),
    });
  }
}

// node:http(s) вместо global fetch: у Node fetch (undici) ДЕФОЛТНЫЙ headersTimeout = 300с (5 мин),
// и длинные code-задачи (opus-ревью идёт >5 мин) упирались в него → «fetch failed», хотя
// agent-таймаут (timeout_s) и AbortSignal разрешали до 20 мин. node:http не навязывает 5-минутный
// потолок — ставим свой idle-таймаут по запросу (+30с буфер). Прокси молчит до конца агента, так что
// это именно ожидание ответа (socket idle), а не активность.
function postJson(url: string, body: unknown, timeoutSec: number): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const u = new URL(url);
    const reqFn = u.protocol === "https:" ? httpsRequest : httpRequest;
    const req = reqFn(
      {
        hostname: u.hostname,
        port: u.port,
        path: `${u.pathname}${u.search}`,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (c) => {
          data += c;
        });
        res.on("end", () => {
          const status = res.statusCode ?? 0;
          if (status >= 200 && status < 300) {
            try {
              resolve(JSON.parse(data) as Record<string, unknown>);
            } catch {
              reject(new Error(`bad JSON from ${u.pathname}: ${data.slice(0, 120)}`));
            }
          } else {
            reject(new Error(`HTTP ${status} ${data.slice(0, 120)}`));
          }
        });
      },
    );
    // Idle-таймаут ожидания ответа: agent-время + 30с буфер (никакого 5-минутного потолка undici).
    req.setTimeout((timeoutSec + 30) * 1000, () => {
      req.destroy(new Error(`postJson timeout after ${timeoutSec + 30}s`));
    });
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

/** Опрос прогресса worki-агента с прокси (best-effort, не критично). */
async function pollProgress(id: string): Promise<void> {
  const e = pending.get(id);
  if (!e || e.status !== "running") return;
  try {
    const res = await fetch(`${CODE_PROGRESS_BASE}${encodeURIComponent(id)}`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return;
    const d = (await res.json()) as { latest?: string; recent?: string[]; updated?: number };
    if (d && (d.latest || (d.recent && d.recent.length))) {
      const changed = e.progress?.latest !== d.latest;
      e.progress = { latest: d.latest, recent: d.recent, updated: d.updated };
      if (changed && d.latest) log.debug("worki: прогресс агента", { id, latest: d.latest });
    }
  } catch {
    /* прогресс — best-effort, молча */
  }
}

/** Тело запроса к прокси: общая база + опциональный project (omit = текущий единственный проект). */
function withProject(body: Record<string, unknown>, project?: string): Record<string, unknown> {
  return project ? { ...body, project } : body;
}

async function runAnalysis(
  id: string,
  task: string,
  model: string,
  timeoutSec: number,
  project?: string,
): Promise<void> {
  const e = pending.get(id);
  if (!e) return;
  // Read-путь: сначала подтягиваем свежую base в dev-клон (host-only токен), чтобы ревью шло по
  // актуальному коду, а резолв нужного коммита не падал «fetch failed» на приватном репо.
  await fetchDevCloneFresh();
  try {
    const data = await postJson(
      CODE_ANALYZE_URL,
      withProject({ task, persona: SOUL_BRIEF, model, timeout_s: timeoutSec, task_id: id }, project),
      timeoutSec,
    );
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

async function runResearch(
  id: string,
  task: string,
  model: string,
  timeoutSec: number,
): Promise<void> {
  const e = pending.get(id);
  if (!e) return;
  try {
    // Веб-ресёрч — это НЕ репозиторий: project не пробрасываем (прокси ходит в сеть из
    // чистой папки). Прокси сам держит keyless WebSearch/WebFetch через Max-подписку.
    const data = await postJson(
      CODE_RESEARCH_URL,
      { task, persona: SOUL_BRIEF, model, timeout_s: timeoutSec, task_id: id },
      timeoutSec,
    );
    const r = String(data.research ?? "").trim();
    e.status = "done"; // пустой ответ на HTTP 200 — не ошибка (как в code-ask)
    e.result = r || "ничего толкового не нашла — попроси уточнить, что искать";
    log.info("research done", { id, len: e.result.length });
  } catch (err) {
    e.status = "error";
    e.result = classifyErr(err);
    log.warn("research failed", { id, task, err: (err as Error).message });
  }
  e.completedMs = Date.now();
}

async function runFix(
  id: string,
  task: string,
  model: string,
  timeoutSec: number,
  project?: string,
): Promise<void> {
  const e = pending.get(id);
  if (!e) return;
  // Фикс ветвится от свежей base — подтягиваем её перед стартом (host-only токен).
  await fetchDevCloneFresh();
  try {
    const data = await postJson(
      CODE_FIX_URL,
      withProject({ task, persona: SOUL_BRIEF, model, timeout_s: timeoutSec, task_id: id }, project),
      timeoutSec,
    );
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

async function runTest(
  id: string,
  task: string,
  model: string,
  timeoutSec: number,
  project?: string,
): Promise<void> {
  const e = pending.get(id);
  if (!e) return;
  // Тесты гоняем по свежей base — подтягиваем перед прогоном (host-only токен).
  await fetchDevCloneFresh();
  try {
    const data = await postJson(
      CODE_TEST_URL,
      withProject({ task, persona: SOUL_BRIEF, model, timeout_s: timeoutSec, task_id: id }, project),
      timeoutSec,
    );
    // Прокси гоняет тесты в чистом клоне и возвращает pass/fail + отчёт. Уважаем явный
    // флаг `passed`, если он есть; иначе считаем пустой отчёт за ошибку прогона.
    const report = String(data.report ?? data.analysis ?? "").trim();
    const passed = data.passed === true ? true : data.passed === false ? false : undefined;
    if (passed === false) {
      e.status = "done"; // прогон состоялся — это валидный результат «упали тесты»
      e.result = report ? `тесты КРАСНЫЕ:\n${report}` : "тесты не прошли (отчёт пустой)";
    } else if (passed === true) {
      e.status = "done";
      e.result = report ? `тесты ЗЕЛЁНЫЕ:\n${report}` : "тесты прошли — всё зелёное";
    } else {
      e.status = report ? "done" : "error";
      e.result = report || "тест-агент вернул пустой отчёт";
    }
    log.info("code-test done", { id, passed, len: e.result.length });
  } catch (err) {
    e.status = "error";
    e.result = classifyErr(err);
    log.warn("code-test failed", { id, task, err: (err as Error).message });
  }
  e.completedMs = Date.now();
}

async function runCommand(
  id: string,
  command: string,
  timeoutSec: number,
  project?: string,
): Promise<void> {
  const e = pending.get(id);
  if (!e) return;
  // Команду (build/lint/test) гоняем по свежей base — подтягиваем перед запуском (host-only токен).
  await fetchDevCloneFresh();
  try {
    // Прокси держит allowlist (build/lint/test и т.п.) и сам режет всё остальное — мы лишь
    // передаём команду. Возвращает exit-код + хвост вывода.
    const data = await postJson(
      CODE_RUN_URL,
      withProject({ command, timeout_s: timeoutSec, task_id: id }, project),
      timeoutSec,
    );
    const code = Number(data.exit_code ?? data.code ?? data.exitCode);
    const tail = String(data.output ?? data.tail ?? data.stdout ?? "").trim();
    if (data.rejected === true || data.allowed === false) {
      e.status = "error";
      e.result = `команда не из allowlist — не запускаю: ${String(data.error ?? command)}`;
    } else {
      const ok = Number.isFinite(code) ? code === 0 : true;
      e.status = "done"; // команда отработала (даже с ненулевым кодом — это валидный результат)
      const head = Number.isFinite(code)
        ? ok
          ? `готово (exit ${code})`
          : `упало (exit ${code})`
        : "готово";
      e.result = tail ? `${head}:\n${tail}` : head;
    }
    log.info("code-run done", { id, code: Number.isFinite(code) ? code : "?" });
  } catch (err) {
    e.status = "error";
    e.result = classifyErr(err);
    log.warn("code-run failed", { id, command, err: (err as Error).message });
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
    e.result = scrubToken(`push/PR не вышло: ${(err as Error).message}`);
    log.warn("code-pr failed", { id, err: scrubToken((err as Error).message) });
  }
  e.completedMs = Date.now();
}

const TIMEOUT_DESC = "Таймаут в минутах (по умолч. 5). Подними, если просят дольше — напр. 10 или 15.";
const MODEL_DESC = "Модель: sonnet (по умолч., быстро) / opus (глубже, дольше) / haiku. Ставь opus, если просят «на опусе».";
const REPLY_CHAT_DESC = "служебный — НЕ заполняй, проставляется автоматически (чат, куда вернуть ответ).";
const PROJECT_DESC = "Проект (необязательно). По умолчанию — текущий единственный (Worki); указывай, только если просят явно другой.";
const deriveReplyChat = { _reply_chat: (cv: Record<string, unknown>) => cv.TARGET_CHAT };

/** Опциональный проект из аргументов: пустую строку трактуем как omit (= текущий проект). */
function projectFromArgs(args: Record<string, unknown>): string | undefined {
  const p = args.project != null ? String(args.project).trim() : "";
  return p ? p : undefined;
}

export const workiMod = createMod<WorkiState>("worki", {
  category: "mechanic",
  description: "Анализ/фикс/тесты/запуск кода Worki чистыми агентами (async): code_ask / code_fix / code_test / code_run / code_pr",
  topics: ["worki"],
  initialState: { saved: {} },
})
  .instruction("code_ask", {
    params: z.object({
      task: z.coerce.string().trim().min(1).describe('Вопрос/задача по коду Worki своими словами (напр. "какие парсеры и что делает tg-парсер")'),
      model: z.coerce.string().optional().describe(MODEL_DESC),
      timeout_min: z.coerce.number().optional().describe(TIMEOUT_DESC),
      project: z.coerce.string().optional().describe(PROJECT_DESC),
      _reply_chat: z.coerce.number().optional().describe(REPLY_CHAT_DESC),
    }),
    deriveParams: deriveReplyChat,
    description: "Спросить про код Worki — чистый агент прочитает реальный код и пришлёт разбор АСИНХРОННО в этот чат",
    affordance: {
      priority: "capability",
      category: "memory",
      whenToUse: "Любой вопрос/анализ по коду Worki. Запускает фоновый разбор и СРАЗУ возвращается — НЕ грепай файлы сама. Ответ сам придёт в этот чат. ПРОАКТИВНО: если в рабочем чате кто-то обмолвился про код/баг или «ревью бы не помешало» — можешь сама предложить «могу глянуть», к месту и без навязчивости.",
      whenNotToUse: "Не про код Worki",
    },
    impl(ctx, args): unknown {
      const task = String(args.task);
      if (isBusy("ask")) {
        return { success: true, message: "Уже разбираю код — погоди, результат вот-вот придёт в этот чат. Повторно не запускай." };
      }
      const model = normalizeModel(args.model as string | undefined);
      const tmin = clampTimeoutMin(args.timeout_min);
      const project = projectFromArgs(args);
      const id = `ask-${randomUUID()}`;
      pending.set(id, { kind: "ask", task, status: "running", result: "", project, askGraphId: askGraphFromArgs(args), createdMs: ctx.nowMs });
      void runAnalysis(id, task, model, tmin * 60, project);
      log.info("code-ask started", { id, model, tmin, project });
      return { success: true, message: `Разбор запущен (${model}, до ${tmin} мин) — приду с ответом в этот чат. Скажи, что смотришь код, и живи дальше.` };
    },
  })
  .instruction("research", {
    params: z.object({
      task: z.coerce.string().trim().min(1).describe('Ссылка или тема, своими словами (напр. "изучи https://… что там" или "поищи про релиз X")'),
      model: z.coerce.string().optional().describe(MODEL_DESC),
      timeout_min: z.coerce.number().optional().describe(TIMEOUT_DESC),
      _reply_chat: z.coerce.number().optional().describe(REPLY_CHAT_DESC),
    }),
    deriveParams: deriveReplyChat,
    description: "Изучить ссылку/тему в сети — сама схожу по веб-инструментам (читаю страницы, иду по ссылкам, ищу) и пришлю сводку АСИНХРОННО в этот чат.",
    affordance: {
      priority: "capability",
      category: "memory",
      whenToUse: "Когда кто-то кидает ссылку и просит «глянь/изучи, что там», или просит «поищи про <тему>». Я реально хожу в сеть: читаю страницы, иду по ссылкам, ищу — и возвращаюсь со сводкой. Фоном, СРАЗУ возвращается; сама ничего не открывай — ответ придёт в этот чат. ПРОАКТИВНО: если в разговоре всплыла ссылка/новость, про которую толком никто не в курсе — могу сама предложить «давай гляну».",
      whenNotToUse: "Ерунда, которую и так знаю наизусть — не лезу в сеть ради банальностей.",
    },
    impl(ctx, args): unknown {
      const task = String(args.task);
      if (isBusy("research")) {
        return { success: true, message: "Уже копаюсь в сети — погоди, сводка вот-вот придёт в этот чат. Повторно не запускай." };
      }
      const model = normalizeModel(args.model as string | undefined);
      const tmin = clampTimeoutMin(args.timeout_min);
      const id = `research-${randomUUID()}`;
      pending.set(id, { kind: "research", task, status: "running", result: "", askGraphId: askGraphFromArgs(args), createdMs: ctx.nowMs });
      void runResearch(id, task, model, tmin * 60);
      log.info("research started", { id, model, tmin });
      return { success: true, message: `Гляну в сети по «${task}» (${model}, до ${tmin} мин) — приду с тем, что нашла, в этот чат. Скажи коротко «гляну» и живи дальше.` };
    },
  })
  .instruction("code_fix", {
    params: z.object({
      task: z.coerce.string().trim().min(1).describe("Что починить, своими словами (опиши баг и желаемую правку). Только ПОСЛЕ одобрения человека."),
      model: z.coerce.string().optional().describe(MODEL_DESC),
      timeout_min: z.coerce.number().optional().describe(TIMEOUT_DESC),
      project: z.coerce.string().optional().describe(PROJECT_DESC),
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
      const project = projectFromArgs(args);
      const id = `fix-${randomUUID()}`;
      pending.set(id, { kind: "fix", task, status: "running", result: "", project, askGraphId: askGraphFromArgs(args), createdMs: ctx.nowMs });
      void runFix(id, task, model, tmin * 60, project);
      log.info("code-fix started", { id, model, tmin, project });
      return { success: true, message: `Фикс запущен (${model}, до ${tmin} мин): правлю + тесты + ветка. Результат придёт в этот чат; не пушу — спросишь «открыть PR?».` };
    },
  })
  .instruction("code_test", {
    params: z.object({
      task: z.coerce.string().trim().min(1).describe('Что прогнать тестами, своими словами (напр. "прогони тесты по парсеру tg" или "все тесты воркера")'),
      model: z.coerce.string().optional().describe(MODEL_DESC),
      timeout_min: z.coerce.number().optional().describe(TIMEOUT_DESC),
      project: z.coerce.string().optional().describe(PROJECT_DESC),
      _reply_chat: z.coerce.number().optional().describe(REPLY_CHAT_DESC),
    }),
    deriveParams: deriveReplyChat,
    description: "Прогнать тесты по коду Worki в чистом клоне: агент находит и гоняет относящиеся тесты, шлёт pass/fail АСИНХРОННО в этот чат.",
    affordance: {
      priority: "capability",
      category: "memory",
      whenToUse: "Когда просят «прогони тесты по <X>» / проверить, зелено ли. Фоновый прогон в чистом клоне, СРАЗУ возвращается — сама ничего не запускай. Результат (красное/зелёное + хвост) придёт в этот чат. ПРОАКТИВНО: после своего же фикса не грех самой прогнать тесты, прежде чем звать PR.",
      whenNotToUse: "Не про тесты Worki; для чтения/разбора кода это code_ask, для правки — code_fix",
    },
    impl(ctx, args): unknown {
      const task = String(args.task);
      if (isBusy("test")) {
        return { success: true, message: "Уже гоняю тесты — погоди, pass/fail вот-вот придёт в этот чат. Повторно не запускай." };
      }
      const model = normalizeModel(args.model as string | undefined);
      const tmin = clampTimeoutMin(args.timeout_min);
      const project = projectFromArgs(args);
      const id = `test-${randomUUID()}`;
      pending.set(id, { kind: "test", task, status: "running", result: "", project, askGraphId: askGraphFromArgs(args), createdMs: ctx.nowMs });
      void runTest(id, task, model, tmin * 60, project);
      log.info("code-test started", { id, model, tmin, project });
      return { success: true, message: `Гоняю тесты (${model}, до ${tmin} мин) по «${task}» — приду с красным/зелёным в этот чат. Скажи коротко «погнала тесты» и живи дальше.` };
    },
  })
  .instruction("code_run", {
    params: z.object({
      command: z.coerce.string().trim().min(1).describe('Команда из allowlist — build / lint / тест и т.п. (напр. "npm run build", "npm run lint"). Прокси сам режет всё, чего нет в списке.'),
      timeout_min: z.coerce.number().optional().describe(TIMEOUT_DESC),
      project: z.coerce.string().optional().describe(PROJECT_DESC),
      _reply_chat: z.coerce.number().optional().describe(REPLY_CHAT_DESC),
    }),
    deriveParams: deriveReplyChat,
    description: "Запустить ограниченную команду (build/lint/test) в клоне Worki через прокси-allowlist. Async: exit-код + хвост вывода придут в этот чат.",
    affordance: {
      priority: "capability",
      category: "memory",
      whenToUse: "Когда просят «запусти <команда>» — собрать, прогнать линтер или тест-скрипт. Команды БОЗОПАСНЫ и ограничены: прокси держит белый список (build/lint/test), всё постороннее не запустится. Фоном, СРАЗУ возвращается; exit-код и хвост лога придут в этот чат.",
      whenNotToUse: "Произвольные/опасные команды (их прокси всё равно отклонит); осмысленный прогон тестов «по теме» удобнее через code_test",
    },
    impl(ctx, args): unknown {
      const command = String(args.command);
      if (isBusy("run")) {
        return { success: true, message: "Уже выполняю команду — дождись её вывода, потом следующую (общий клон)." };
      }
      const tmin = clampTimeoutMin(args.timeout_min);
      const project = projectFromArgs(args);
      const id = `run-${randomUUID()}`;
      pending.set(id, { kind: "run", task: command, status: "running", result: "", project, askGraphId: askGraphFromArgs(args), createdMs: ctx.nowMs });
      void runCommand(id, command, tmin * 60, project);
      log.info("code-run started", { id, command, tmin, project });
      return { success: true, message: `Запускаю \`${command}\` (до ${tmin} мин, в рамках allowlist) — exit-код и хвост лога придут в этот чат.` };
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
  // Control-plane: снять зависшую/недоставленную задачу из очереди (вызывается дашбордом).
  // БЕЗ affordance → невидима для LLM (только engine-owned dispatch). Чистит и `pending`
  // (живая очередь доставки), и ctx.state.saved (персист недоставленных), чтобы задача не
  // регидрировалась после рестарта. Идемпотентна: повторный вызов на уже снятый id → success.
  .instruction("worki_dismiss", {
    params: z.object({
      id: z.coerce.string().trim().min(1).describe("ID задачи worki из снимка очереди (getWorkiSnapshot)."),
    }),
    description: "Снять зависшую/недоставленную задачу worki из очереди (dashboard control-plane).",
    impl(ctx, args): unknown {
      const id = String(args.id);
      const wasPending = pending.delete(id);
      let wasSaved = false;
      if (ctx.state.saved && id in ctx.state.saved) {
        delete ctx.state.saved[id];
        wasSaved = true;
      }
      const removed = wasPending || wasSaved;
      log.info("worki_dismiss", { id, wasPending, wasSaved });
      return { success: true, id, removed };
    },
  })
  // Честная детекция доставки: она отправила сообщение в спросивший чат → результат доставлен.
  .listen("SEND_MESSAGE", (_ctx, args) => {
    const chatId = args.chatId ? String(args.chatId) : null;
    if (!chatId) return;
    for (const p of pending.values()) {
      // delivered ставим ТОЛЬКО если результат уже доставляется (directed) — иначе постороннее
      // сообщение в этот чат до показа результата тихо «съело» бы его (MEDIUM regression).
      if (p.askGraphId !== chatId) continue;
      if (
        p.directed &&
        (p.status === "done" || p.status === "error") &&
        !p.delivered &&
        // КРИТ-фикс: засчитываем доставку ТОЛЬКО если сообщение похоже на пересказ результата,
        // а не короткий ack/реакция/посторонняя реплика в том же чате (иначе ответ терялся).
        looksLikeDelivery(args.text != null ? String(args.text) : "", p)
      ) {
        p.delivered = true;
      } else if (p.status === "running" && p.directed) {
        // Она черкнула в спросивший чат во время работы → засчитываем ack/нарратив прогресса.
        p.acked = true;
        p.lastNarrateMs = Date.now();
      }
    }
  })
  // contribute() — ЧИСТЫЙ: только читает и отдаёт готовые недоставленные результаты.
  .contribute((): ContributionItem[] => {
    const ready: string[] = [];
    const live: string[] = [];
    for (const p of pending.values()) {
      if (p.delivered) continue;
      if (p.status === "running") {
        // Прогресс/ack — только когда давление в спросивший чат активно (она там тикает).
        if (p.askGraphId && p.directed) {
          if (!p.acked) {
            live.push(`Ты взялась за код по «${p.task}» — черкни им коротко «секунду, гляну».`);
          }
          // Прогресс worki шлёт сам напрямую её стилем (см. onTickEnd) — когниция не пробивается.
        }
        continue;
      }
      // Анти-утечка: при заданном askGraphId эмитим ТОЛЬКО после направленного давления
      // (ставится в onTickEnd) — тогда следующий тик уже в спросившем чате. Если канала нет
      // (askGraphId undefined — self/системный тик), скоупить некуда → эмитим без гейта.
      if (p.askGraphId && !p.directed) continue;
      if (p.status === "error") {
        ready.push(`«${p.task}» — не вышло: ${p.result}. Скажи честно в чат, где спросили, что не получилось.`);
      } else if (p.kind === "ask") {
        ready.push(`Готов разбор кода («${p.task}»). Ответь им этим сейчас в чат, где спросили про код — ждут. Своими словами, по делу:\n${p.result}`);
      } else if (p.kind === "fix") {
        const prHint = p.branch ? `\nЕсли ок и человек одобрит — открой PR: self code-pr --branch ${p.branch}` : "";
        ready.push(`Готов фикс по «${p.task}» (перескажи в чат, где просили, + спроси «открыть PR?»):\n${p.result}${prHint}`);
      } else if (p.kind === "test") {
        ready.push(`Тесты по «${p.task}» отработали (скажи в чат, где просили, красное/зелёное своими словами):\n${p.result}`);
      } else if (p.kind === "run") {
        ready.push(`Команда «${p.task}» отработала (доложи в чат, где просили, exit-код и суть вывода):\n${p.result}`);
      } else if (p.kind === "research") {
        ready.push(`Изучила «${p.task}» — расскажи им, что нашла, своими словами в чат, где спросили:\n${p.result}`);
      } else {
        ready.push(p.result); // pr: "PR открыт: <url>"
      }
    }
    const items: ContributionItem[] = [];
    if (live.length > 0) {
      items.push(header(PromptBuilder.fromRaw(["## По коду — в процессе", "", live.join("\n")].join("\n")), 87));
    }
    if (ready.length > 0) {
      const raw = ["## Готово по коду Worki", "", ready.join("\n\n")].join("\n");
      const lines = PromptBuilder.fromRaw(
        raw
          .split("\n")
          .map((l) => l.replace(/^\s+/, "").replace(/\*\*/g, ""))
          .join("\n"),
      );
      items.push(header(lines, 88));
    }
    return items;
  })
  // Жизненный цикл (мутации) — здесь, не в contribute(): направленное давление + TTL + сторож.
  .onTickEnd((ctx) => {
    // Регидрация один раз после рестарта: вернуть в очередь недоставленные результаты (HIGH-10).
    if (!_rehydrated) {
      _rehydrated = true;
      for (const [id, p] of Object.entries(ctx.state.saved ?? {})) {
        if (pending.has(id)) continue;
        // running-задача не переживает рестарт (in-flight промис умер вместе с процессом).
        // Спросившему обещали результат → честно говорим, что прервалось, а не молчим.
        if (p.status === "running") {
          pending.set(id, {
            ...p,
            status: "error",
            result: "прервалось рестартом — переспроси",
            directed: false,
            statusSending: false,
            completedMs: ctx.nowMs,
          });
          log.warn("worki: running-задача прервана рестартом → отдам честную ошибку", {
            id,
            kind: p.kind,
          });
        } else {
          pending.set(id, { ...p, directed: false, completedMs: ctx.nowMs });
        }
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
          continue;
        }
        // Прогресс-стриминг: опрашиваем прокси (троттл 4с), складываем в p.progress.
        if (p.askGraphId && now - (p.lastPollMs ?? 0) > 4000) {
          p.lastPollMs = now;
          void pollProgress(id);
        }
        // Ack — её голосом (нудж в спросивший чат, пока не подтвердила «гляну»).
        if (p.askGraphId && !p.acked) ensureDirected(ctx.graph, p);
        // Прогресс — worki ШЛЁТ САМ её стилем (когниция не пробивается: её реляционное суждение
        // «он молчит → не строчить» перебивает любой промпт — доказано тестами). Троттл 18с, антидубль.
        const latest = p.progress?.latest;
        if (
          p.askGraphId &&
          _statusSender &&
          latest &&
          latest !== p.lastStatusText &&
          // Не шлём дубль, пока предыдущая отправка ещё в полёте (async success/failure).
          !p.statusSending &&
          // ЛС — живой темп; группа (отрицательный chat_id) — реже, чтобы не спамить.
          now - (p.lastStatusMs ?? 0) >
            (Number(p.askGraphId.split(":").pop()) < 0
              ? STATUS_THROTTLE_GROUP_MS
              : STATUS_THROTTLE_DM_MS)
        ) {
          const numeric = Number(p.askGraphId.split(":").pop());
          if (Number.isFinite(numeric)) {
            let topicId: number | undefined;
            try {
              if (ctx.graph.has(p.askGraphId)) {
                const t = Number(
                  (ctx.graph.getChannel(p.askGraphId) as { current_topic_id?: unknown }).current_topic_id,
                );
                if (Number.isFinite(t) && t > 0) topicId = t;
              }
            } catch {
              /* топик опционален */
            }
            const lead = STATUS_LEADS[(p.statusCount ?? 0) % STATUS_LEADS.length];
            // Отправка асинхронна: троттл/антидубль/счётчик двигаем ТОЛЬКО на success
            // (раньше двигали безусловно, а .catch(()=>{}) в index.ts глотал сбой → строка
            // терялась молча). Антидубль в полёте — флаг statusSending; на провале он снимается
            // и при следующем тике строка будет переотправлена.
            p.statusSending = true;
            void _statusSender(numeric, `${lead}${latest}`, topicId)
              .then((ok) => {
                p.statusSending = false;
                if (ok) {
                  p.lastStatusMs = Date.now();
                  p.lastStatusText = latest;
                  p.statusCount = (p.statusCount ?? 0) + 1;
                  log.debug("worki: статус отправлен", { id, latest });
                } else {
                  log.warn("worki: статус не доставлен (переотправлю)", { id, latest });
                }
              })
              .catch((err) => {
                p.statusSending = false;
                log.warn("worki: статус не отправлен", { id, err: (err as Error).message });
              });
          }
        }
        continue;
      }
      // done/error. Если спросивший чат стал недостижим (кикнули/удалён) — отдавать некуда,
      // НЕ зацикливаемся: бросаем результат с логом (доставлять в чужой чат нельзя).
      if (p.askGraphId && ctx.graph.has(p.askGraphId)) {
        const ch = ctx.graph.getChannel(p.askGraphId) as {
          failure_type?: string;
          reachability_score?: number;
        };
        if (ch.failure_type === "permanent" || (ch.reachability_score ?? 1) <= 0) {
          log.warn("worki: спросивший чат недостижим — отдавать некуда, бросаю результат", {
            id,
            kind: p.kind,
            ch: p.askGraphId,
          });
          pending.delete(id);
          continue;
        }
      }
      // Держим направленное давление на спросивший чат, ПОКА не доставим (re-assert) → не «забывает».
      ensureDirected(ctx.graph, p);
      // Хард-кап: снимаем лишь если очень долго (часы) не смогли отдать — защита от вечного накопления.
      if (p.completedMs && now - p.completedMs > UNDELIVERED_MAX_MS) {
        log.warn("worki: результат не доставлен за хард-кап, снимаю", { id, kind: p.kind });
        pending.delete(id);
      }
    }
    // Персист недоставленных. ВКЛЮЧАЯ running: in-flight промис рестарт не переживёт, но мы
    // обещали спросившему результат → сохраняем running, чтобы при регидрации честно сказать
    // «прервалось рестартом», а не молчать (раньше running терялись бесследно).
    const saved: Record<string, Pending> = {};
    for (const [id, p] of pending) {
      if ((p.status === "done" || p.status === "error" || p.status === "running") && !p.delivered) {
        saved[id] = p;
      }
    }
    ctx.state.saved = saved;
    // Отметить чаты с активным worki-ревью → там анти-монолог ослаблен (timeline/presence),
    // чтобы Алиса нарратила прогресс не упираясь в «четыре подряд → молчать».
    const activeChats = new Set<string>();
    for (const p of pending.values()) {
      if (p.askGraphId && !p.delivered) activeChats.add(p.askGraphId);
    }
    syncWorkiActive(activeChats);
  })
  .build();
