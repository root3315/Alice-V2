/**
 * Worki Mod — анализ кода Worki через ЧИСТЫЙ opus-агент (инструмент `code-ask`).
 *
 * В живом тике (sonnet) Алиса не умеет надёжно читать /work/worki: галлюцинирует
 * «не смонтировано» из собственной истории сообщений, а большой живой промпт ронял
 * opus по таймауту. Решение: делегировать вопрос про код отдельному ЧИСТОМУ
 * opus-агенту (прокси /v1/code-analyze) — он запускается прямо в read-only клоне с
 * ТОЛЬКО задачей (без её контекста/истории), сам грепает/читает код своими
 * Read/Grep/Glob и возвращает разбор. Алиса пересказывает результат своим голосом.
 *
 * Обходит и конфабуляцию (чистый контекст), и таймаут (лёгкий промпт).
 */
import { z } from "zod";
import { createMod } from "../core/mod-builder.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("worki");

const CODE_ANALYZE_URL =
  process.env.PROXY_CODE_ANALYZE_URL ?? "http://127.0.0.1:8787/v1/code-analyze";
// Opus-анализ может занять до ~неск. минут; держим выше прокси-овского OPUS_TIMEOUT_S.
const CODE_ANALYZE_TIMEOUT_MS = 245_000;

export const workiMod = createMod<Record<string, never>>("worki", {
  category: "mechanic",
  description: "Анализ кода Worki: делегирует вопрос чистому opus-агенту (он сам читает код)",
  topics: ["worki"],
  initialState: {},
}).instruction("code-ask", {
  params: z.object({
    task: z.coerce
      .string()
      .trim()
      .min(1)
      .describe('Вопрос/задача по коду Worki своими словами (напр. "какие парсеры и что делает tg-парсер")'),
  }),
  description: "Спросить про код Worki — чистый opus прочитает реальный код и вернёт разбор",
  affordance: {
    priority: "capability",
    category: "memory",
    whenToUse:
      "Любой вопрос/анализ по коду Worki (что где в коде, как устроено, есть ли баг). Анализатор сам читает реальный код и отвечает — НЕ грепай файлы сама.",
    whenNotToUse: "Не про код Worki",
  },
  async impl(_ctx, args): Promise<unknown> {
    const task = String(args.task);
    try {
      const res = await fetch(CODE_ANALYZE_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ task }),
        signal: AbortSignal.timeout(CODE_ANALYZE_TIMEOUT_MS),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        log.warn("code-analyze HTTP error", { status: res.status, body: body.slice(0, 200) });
        return { success: false, error: `анализатор вернул HTTP ${res.status}` };
      }
      const data = (await res.json()) as { analysis?: string };
      const analysis = (data.analysis ?? "").trim();
      if (!analysis) return { success: false, error: "анализатор вернул пустой ответ" };
      log.info("code-ask ok", { taskLen: task.length, analysisLen: analysis.length });
      return { success: true, analysis };
    } catch (e) {
      log.warn("code-analyze failed", e);
      return { success: false, error: `анализатор недоступен: ${(e as Error).message}` };
    }
  },
}).build();
