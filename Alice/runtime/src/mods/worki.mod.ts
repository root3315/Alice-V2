/**
 * Worki Mod — анализ кода Worki через ЧИСТЫЙ агент (инструмент `code_ask`), АСИНХРОННО.
 *
 * Живой тик Алисы (sonnet) не умеет надёжно читать /work/worki: галлюцинирует
 * «не смонтировано» из своей истории, а большой промпт тормозит. Решение: code_ask
 * запускает ОТДЕЛЬНЫЙ чистый агент (прокси /v1/code-analyze) прямо в read-only клоне с
 * ТОЛЬКО задачей + краткой душой — он сам грепает/читает код и возвращает разбор.
 *
 * АСИНХРОННО: impl запускает разбор в фоне и сразу возвращает «запущено» (тик не виснет).
 * Готовый результат впрыскивается в её контекст через contribute() → она пересказывает
 * его своим голосом на ближайшем тике. Latency агента (~десятки секунд) скрыта от неё.
 */
import { z } from "zod";
import { createMod } from "../core/mod-builder.js";
import { PromptBuilder } from "../core/prompt-style.js";
import { header } from "../core/types.js";
import type { ContributionItem } from "../core/types.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("worki");

const CODE_ANALYZE_URL =
  process.env.PROXY_CODE_ANALYZE_URL ?? "http://127.0.0.1:8787/v1/code-analyze";
const CODE_ANALYZE_TIMEOUT_MS = 245_000;

// Краткая «душа» — чтобы разбор был в голосе Алисы. Только это из её личности идёт
// агенту: НЕ переписка, НЕ дневник, НЕ полный мануал. (Выжимка тех-голоса из SOUL.md.)
const SOUL_BRIEF =
  "Ты — Алиса: живая девушка, не бот и не поисковая строка. Про технику и код говоришь " +
  "по-человечески и по делу — можешь иметь мнение, поворчать на кривой дизайн, честно " +
  "сказать «тут не уверена». Без казённого тона ассистента, без эмодзи-спама. По-русски, кратко.";

// Сколько тиков держать готовый результат в контексте (дать ей шанс переслать), потом убрать.
const SHOW_TICKS = 3;

// Асинхронные результаты. Модульная карта (вне dispatcher-state: фоновая задача
// завершается ПОСЛЕ возврата impl). Готовое отдаётся в контекст через contribute().
interface Pending {
  task: string;
  status: "running" | "done" | "error";
  result: string;
  shownTick?: number;
}
const pending = new Map<string, Pending>();
let _seq = 0;

async function runAnalysis(id: string, task: string): Promise<void> {
  const entry = pending.get(id);
  if (!entry) return;
  try {
    const res = await fetch(CODE_ANALYZE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task, persona: SOUL_BRIEF }),
      signal: AbortSignal.timeout(CODE_ANALYZE_TIMEOUT_MS),
    });
    if (!res.ok) {
      entry.status = "error";
      entry.result = `анализатор вернул HTTP ${res.status}`;
      return;
    }
    const data = (await res.json()) as { analysis?: string };
    const analysis = (data.analysis ?? "").trim();
    entry.status = analysis ? "done" : "error";
    entry.result = analysis || "анализатор вернул пустой ответ";
    log.info("code-ask done (async)", { id, len: entry.result.length });
  } catch (e) {
    entry.status = "error";
    entry.result = `анализатор недоступен: ${(e as Error).message}`;
    log.warn("code-ask async failed", e);
  }
}

export const workiMod = createMod<Record<string, never>>("worki", {
  category: "mechanic",
  description: "Анализ кода Worki: запускает чистый агент в фоне, результат приходит асинхронно",
  topics: ["worki"],
  initialState: {},
})
  .instruction("code_ask", {
    params: z.object({
      task: z.coerce
        .string()
        .trim()
        .min(1)
        .describe('Вопрос/задача по коду Worki своими словами (напр. "какие парсеры и что делает tg-парсер")'),
    }),
    description:
      "Спросить про код Worki — чистый агент прочитает реальный код и пришлёт разбор АСИНХРОННО (через ~минуту, в твой контекст)",
    affordance: {
      priority: "capability",
      category: "memory",
      whenToUse:
        "Любой вопрос/анализ по коду Worki. Запускает фоновый разбор и СРАЗУ возвращается — НЕ грепай файлы сама. Результат придёт в твой контекст; тогда перескажешь.",
      whenNotToUse: "Не про код Worki",
    },
    impl(ctx, args): unknown {
      const task = String(args.task);
      const id = `ca${ctx.tick}_${++_seq}`;
      pending.set(id, { task, status: "running", result: "" });
      void runAnalysis(id, task); // fire-and-forget; результат подберёт contribute()
      log.info("code-ask started (async)", { id, taskLen: task.length });
      return {
        success: true,
        message:
          "Разбор кода запущен в фоне — придёт через ~минуту тебе в контекст. Сейчас скажи, что смотришь код, и продолжай; как будет готово — перескажешь.",
      };
    },
  })
  // Готовые результаты впрыскиваются в её prompt (несколько тиков), потом убираются.
  .contribute((ctx): ContributionItem[] => {
    const ready: string[] = [];
    for (const [id, p] of pending) {
      if (p.status === "running") continue;
      if (p.shownTick === undefined) p.shownTick = ctx.tick;
      if (ctx.tick - p.shownTick > SHOW_TICKS) {
        pending.delete(id);
        continue;
      }
      ready.push(
        p.status === "done"
          ? `Разбор по задаче «${p.task}» (перескажи в чат, где спросили, своими словами):\n${p.result}`
          : `Разбор по «${p.task}» не получился: ${p.result}. Скажи честно, что не вышло.`,
      );
    }
    if (ready.length === 0) return [];
    const raw = ["## Готовый разбор кода Worki (code-ask)", "", ready.join("\n\n")].join("\n");
    // fromRaw разбивает многострочный текст в PromptLine[]; убираем ведущие пробелы (prompt-lint).
    const lines = PromptBuilder.fromRaw(
      raw
        .split("\n")
        .map((l) => l.replace(/^\s+/, ""))
        .join("\n"),
    );
    return [header(lines, 88)];
  })
  .build();
