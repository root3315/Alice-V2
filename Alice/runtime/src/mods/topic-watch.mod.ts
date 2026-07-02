/**
 * Topic-Watch Mod — «следи за темой» → проактивный дайджест её голосом.
 *
 * Идея: кто-то просит «Аура, следи за патчами MLBB / за новостями по X — кидай, когда что-то
 * выйдет». Она фиксирует «наблюдение» (тема + чат + кадэнс). Периодически (по wall-clock) мод
 * поднимает направленное давление на ТОТ чат и подкидывает ей в контекст лёгкий нудж: «загляни
 * в сеть по этой теме своим web_search, и если есть что-то свежее и стоящее — расскажи; если
 * ничего — промолчи». Саму сеть она смотрит СВОИМ web_search, формулирует и решает СВОЕЙ когницией.
 *
 * Зеркалит digest / commitment / health-watch:
 *  - CAPTURE: инструкции watch_topic / unwatch_topic + запрос watches.
 *  - contribute() — СТРОГО ЧИСТЫЙ: только читает и (если давление в ЭТОТ чат поднято) отдаёт нудж,
 *    scoped к текущему чату (без межчат-утечки).
 *  - onTickEnd — ВСЕ мутации: кадэнс, направленное давление, TTL «созревшего» нуджа.
 *
 * Честность/сдержанность: мод НЕ формулирует за неё и НЕ ходит в сеть сам — только повод и адресат.
 * Поиск/фразировку/«стоит ли вообще писать» решает она (web_search + её сдержанность). Не cron —
 * это мягкий периодический повод «глянуть, что нового», дополняет scheduler.mod и feeds.mod.
 */
import { z } from "zod";

import { createMod } from "../core/mod-builder.js";
import { PromptBuilder } from "../core/prompt-style.js";
import type { ContributionItem } from "../core/types.js";
import { header, readModState } from "../core/types.js";
import { ensureChannelId } from "../graph/constants.js";
import type { WorldModel } from "../graph/world-model.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("topic-watch");

// -- Константы ----------------------------------------------------------------

/** Кадэнс проверки по умолчанию — дважды в сутки. */
const DEFAULT_INTERVAL_MS = 12 * 60 * 60_000;
const MIN_INTERVAL_MS = 1 * 60 * 60_000; // не чаще раза в час
const MAX_INTERVAL_MS = 7 * 24 * 60 * 60_000; // не реже раза в неделю
/** Сколько держим «созревший» нудж на виду, пока она не глянет (мс). */
const PENDING_TTL_MS = 90 * 60_000;
/** Потолок числа наблюдений. */
const MAX_WATCHES = 20;
/** Максимальная длина темы. */
const MAX_TOPIC_LENGTH = 160;

interface Watch {
  id: string;
  /** Тема наблюдения, как сказано ('патчи MLBB', 'новости по X'). */
  topic: string;
  /** Чат, куда докладывать (где попросили). null → не привязан, доставки нет. */
  chatId: string | null;
  /** Кадэнс проверки (мс). */
  intervalMs: number;
  /** Когда последний раз ставили нудж-проверку (мс). */
  lastCheckedMs: number;
  /** Когда создано (мс). */
  createdMs: number;
  /** Нудж-проверка сейчас «на виду» (ждём, пока глянет). */
  pending: boolean;
  /** Направленное давление уже поднято. */
  directed: boolean;
  /** Когда стал pending (для TTL). */
  pendingSinceMs: number;
}

interface TopicWatchState {
  watches: Watch[];
}

let _idCounter = 0;
function nextWatchId(): string {
  return `watch_${_idCounter++}_${Date.now()}`;
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

/** Поднять направленное давление на чат наблюдения (как bumpDirected в digest). true = канал есть. */
function bumpDirected(graph: WorldModel, target: string): boolean {
  try {
    if (graph.has(target)) {
      const cur = Number(
        (graph.getChannel(target) as { pending_directed?: number }).pending_directed ?? 0,
      );
      if (cur <= 0) {
        graph.updateChannel(target, { pending_directed: 1, last_directed_ms: Date.now() });
      }
      return true;
    }
  } catch (err) {
    log.warn("directed bump failed", { target, err: (err as Error).message });
  }
  return false; // канала ещё нет в графе → повторим на следующем onTickEnd
}

export const topicWatchMod = createMod<TopicWatchState>("topic_watch", {
  category: "mechanic",
  description:
    "«Следи за темой»: периодически напоминает себе глянуть в сеть по заданной теме и рассказать, если есть свежее",
  depends: ["relationships"],
  topics: ["memory"],
  initialState: { watches: [] },
})
  .instruction("watch_topic", {
    params: z.object({
      topic: z
        .string()
        .trim()
        .min(2)
        .max(MAX_TOPIC_LENGTH)
        .describe("За чем следить, как сказано ('патчи MLBB', 'новости по релизу X')"),
      every_hours: z
        .number()
        .optional()
        .describe("Как часто проверять, в часах (по умолчанию 12; от 1 до 168)"),
    }),
    perTurnCap: 3,
    description:
      "Начать следить за темой в сети: периодически сама заглядываю через web_search и приношу свежее в этот чат.",
    examples: [
      'watch_topic({ topic: "патчи MLBB" })',
      'watch_topic({ topic: "новости по X", every_hours: 24 })',
    ],
    affordance: {
      priority: "capability",
      category: "memory",
      whenToUse:
        "When someone asks you to keep an eye on a topic and ping when something new appears ('следи за патчами MLBB', 'кидай новости по X'). You'll periodically web_search it yourself and share fresh finds.",
      whenNotToUse:
        "For a one-off lookup right now (use web_search directly), a hard timed reminder (schedule_task), or a personal follow-up on someone's intent (note_commitment)",
    },
    impl(ctx, args) {
      const topic = String(args.topic).trim();
      const everyHours = typeof args.every_hours === "number" ? args.every_hours : 12;
      const intervalMs = Math.max(
        MIN_INTERVAL_MS,
        Math.min(MAX_INTERVAL_MS, everyHours * 60 * 60_000),
      );

      // Чат, где это прозвучало — текущая цель действия (как у note_commitment).
      const relState = readModState(ctx, "relationships");
      const targetNode = relState?.targetNodeId ?? null;
      const chatId = targetNode ? (ensureChannelId(targetNode) ?? targetNode) : null;

      // Дедуп по теме (нестрого): та же тема уже под наблюдением → обновим кадэнс.
      const dup = ctx.state.watches.find((w) => norm(w.topic) === norm(topic));
      if (dup) {
        dup.intervalMs = intervalMs;
        if (chatId) dup.chatId = chatId;
        return { success: true, isDuplicate: true, watchId: dup.id };
      }

      const id = nextWatchId();
      ctx.state.watches.push({
        id,
        topic,
        chatId,
        intervalMs,
        lastCheckedMs: ctx.nowMs, // первая авто-проверка — через интервал (свежая инфа уже в разговоре)
        createdMs: ctx.nowMs,
        pending: false,
        directed: false,
        pendingSinceMs: 0,
      });

      // Потолок: вытесняем самое старое.
      if (ctx.state.watches.length > MAX_WATCHES) {
        ctx.state.watches.sort((a, b) => a.createdMs - b.createdMs);
        ctx.state.watches.shift();
      }

      log.info("topic watch added", { topic, intervalHours: intervalMs / 3_600_000, chatId });
      return { success: true, isDuplicate: false, watchId: id };
    },
  })
  .instruction("unwatch_topic", {
    params: z.object({
      topic: z.string().trim().min(2).max(MAX_TOPIC_LENGTH).describe("Тема, за которой перестать следить"),
    }),
    description: "Перестать следить за темой.",
    examples: ['unwatch_topic({ topic: "патчи MLBB" })'],
    affordance: {
      priority: "capability",
      category: "memory",
      whenToUse: "When asked to stop watching a topic ('хватит следить за X', 'больше не кидай про Y')",
      whenNotToUse: "When just pausing the conversation — a watch persists across chats intentionally",
    },
    impl(ctx, args) {
      const topic = norm(String(args.topic));
      const before = ctx.state.watches.length;
      ctx.state.watches = ctx.state.watches.filter((w) => norm(w.topic) !== topic);
      const removed = before - ctx.state.watches.length;
      log.info("topic unwatch", { topic, removed });
      return { success: true, removed };
    },
  })
  .query("watches", {
    params: z.object({}),
    description: "Список тем, за которыми я сейчас слежу.",
    returns: "{ watches: Array<{topic, everyHours, chatId}> }",
    affordance: {
      priority: "capability",
      category: "memory",
      whenToUse: "When asked what topics you're currently watching / following",
      whenNotToUse: "For unrelated recall",
    },
    impl(ctx) {
      return {
        watches: ctx.state.watches.map((w) => ({
          topic: w.topic,
          everyHours: Math.round(w.intervalMs / 3_600_000),
          chatId: w.chatId,
        })),
      };
    },
    format(result) {
      const r = result as { watches: Array<{ topic: string; everyHours: number }> };
      const m = new PromptBuilder();
      if (r.watches.length === 0) {
        m.line("Сейчас ни за чем специально не слежу.");
        return m.build();
      }
      m.line("Слежу за:");
      m.list(r.watches.map((w) => `${w.topic} (каждые ~${w.everyHours}ч)`));
      return m.build();
    },
  })
  // contribute() — ЧИСТЫЙ: нудж только для наблюдений ЭТОГО чата, у которых давление поднято.
  .contribute((ctx): ContributionItem[] => {
    const relState = readModState(ctx, "relationships");
    const targetNode = relState?.targetNodeId ?? null;
    const chatId = targetNode ? (ensureChannelId(targetNode) ?? targetNode) : null;
    if (!chatId) return [];

    const ripe = ctx.state.watches.filter(
      (w) => w.pending && w.directed && w.chatId === chatId,
    );
    if (ripe.length === 0) return [];

    const topics = ripe.map((w) => `«${w.topic}»`).join(", ");
    const raw = [
      "## Пора глянуть, что нового (только для этого чата)",
      "",
      `Ты обещала последить за темой: ${topics}. Если сейчас уместно — загляни в сеть своим ` +
        "web_search (или research), что нового по ней с прошлого раза. Если нашлось свежее и " +
        "стоящее — расскажи в ЭТОТ чат своими словами, коротко и по-человечески. Если ничего " +
        "нового или сейчас не к месту — просто промолчи, не тревожь по пустякам.",
    ].join("\n");
    return [header(PromptBuilder.fromRaw(raw), 82)];
  })
  // onTickEnd — ВСЕ мутации: кадэнс, направленное давление, TTL.
  .onTickEnd((ctx) => {
    const now = ctx.nowMs;
    for (const w of ctx.state.watches) {
      // 1. Кадэнс: пора проверять? Ставим нудж и СРАЗУ двигаем кадэнс (не дёргаем повторно).
      if (!w.pending && now - w.lastCheckedMs >= w.intervalMs) {
        w.pending = true;
        w.pendingSinceMs = now;
        w.lastCheckedMs = now;
        w.directed = false;
      }
      // 2. Пока «созрело»: держим направленное давление; по TTL — снимаем (не нагло).
      if (w.pending) {
        if (now - w.pendingSinceMs >= PENDING_TTL_MS) {
          w.pending = false;
          w.directed = false;
        } else if (!w.directed && w.chatId) {
          w.directed = bumpDirected(ctx.graph, w.chatId);
        }
      }
    }
  })
  .build();
