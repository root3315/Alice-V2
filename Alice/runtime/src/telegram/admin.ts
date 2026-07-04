/**
 * Обработчик команд администратора (owner-панель).
 *
 * Только ЛИЧКА владельца (TELEGRAM_ADMIN). Командные сообщения перехватываются ДО её
 * когниции (group=-1 + PropagationAction.Stop) и отвечаются СИСТЕМНЫМ стилем — это пульт
 * управления, персона Алисы к нему не притрагивается.
 *
 * /man     — статус среды + справочник её инструментов (как раньше).
 * /status  — краткий статус: аптайм, пауза, давления, граф, очередь.
 * /pause   — ручная пауза самоинициативы (30m/2h/1d; по умолчанию 2ч) → dormant.
 * /resume  — снять паузу.
 * /backup  — немедленный бэкап памяти (flushGraph + копия alice.db).
 *
 * Неизвестные /команды НЕ перехватываются — уходят в её обычное восприятие.
 */

import type { Dispatcher as MtcuteDispatcher } from "@mtcute/dispatcher";
import { PropagationAction } from "@mtcute/dispatcher";
import type { TelegramClient } from "@mtcute/node";
import { User } from "@mtcute/node";
import { copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Config } from "../config.js";
import type { Dispatcher as AliceDispatcher } from "../core/dispatcher.js";
import { typedQuery } from "../core/query-helpers.js";
import { generateShellManual } from "../core/shell-manual.js";
import type { ModDefinition } from "../core/types.js";
import { flushGraph } from "../db/snapshot.js";
import type { ActionQueue } from "../engine/action-queue.js";
import {
  clearManualPause,
  isManuallyPaused,
  manualPauseUntil,
  setManualPause,
} from "../engine/manual-pause.js";
import { requestExploreNow } from "../mods/exploration.mod.js";
import type { WorldModel } from "../graph/world-model.js";
import { ALICE_DB_PATH } from "../runtime-paths.js";
import { createLogger } from "../utils/logger.js";
import type { TickClock } from "../utils/time.js";
import { type PersonalityVector, VOICES } from "../voices/personality.js";
import { sendText } from "./actions.js";

const log = createLogger("admin");

/** Максимальное число символов в одном сообщении Telegram. */
const TG_MSG_LIMIT = 4096;

/**
 * Разбивает длинный текст на части по лимиту длины сообщения Telegram.
 * Предпочтительно разрывать на символе новой строки, чтобы не обрезать строки.
 */
export function splitMessage(text: string, limit: number = TG_MSG_LIMIT): string[] {
  if (text.length <= limit) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= limit) {
      chunks.push(remaining);
      break;
    }

    // ищем последний символ новой строки в пределах limit
    const newlineAt = remaining.lastIndexOf("\n", limit);
    if (newlineAt > 0) {
      chunks.push(remaining.slice(0, newlineAt));
      remaining = remaining.slice(newlineAt + 1); // пропускаем символ новой строки
    } else {
      // нет символа новой строки, принудительно обрезаем
      chunks.push(remaining.slice(0, limit));
      remaining = remaining.slice(limit);
    }
  }

  return chunks;
}

/**
 * Парсит длительность паузы: "30m"/"30м" (минуты), "2h"/"2ч" (часы), "1d"/"1д" (дни),
 * голое число = минуты. Пусто → 2 часа. Кап 7 дней. null = не распознано.
 */
export function parsePauseDuration(raw: string | undefined): number | null {
  if (!raw) return 2 * 60 * 60_000;
  const m = raw.trim().match(/^(\d+)\s*(m|м|min|h|ч|час|d|д)?\.?$/i);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = (m[2] ?? "m").toLowerCase();
  const ms = unit.startsWith("h") || unit.startsWith("ч")
    ? n * 60 * 60_000
    : unit.startsWith("d") || unit.startsWith("д")
      ? n * 24 * 60 * 60_000
      : n * 60_000;
  return Math.min(ms, 7 * 24 * 60 * 60_000);
}

/** Локальное HH:MM для метки времени (тот же приём, что localYMD в dates.mod). */
function fmtLocalHm(ms: number, tzOffsetHours: number): string {
  const d = new Date(ms + tzOffsetHours * 3_600_000);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

/** Немедленный бэкап памяти: flushGraph + копия alice.db(+wal/shm). Возвращает отчёт. */
function runManualBackup(G: WorldModel): string {
  flushGraph(G);
  const dir = process.env.ALICE_BACKUP_DIR ?? join(dirname(ALICE_DB_PATH), "backups");
  mkdirSync(dir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19);
  const copied: string[] = [];
  for (const suffix of ["", "-wal", "-shm"]) {
    const src = `${ALICE_DB_PATH}${suffix}`;
    if (!existsSync(src)) continue;
    const dst = join(dir, `manual-${ts}-alice.db${suffix}`);
    copyFileSync(src, dst);
    copied.push(`alice.db${suffix} (${(statSync(dst).size / 1024 / 1024).toFixed(1)} MB)`);
  }
  return `[backup] сохранено в ${dir}:\n${copied.map((c) => `  ${c}`).join("\n")}`;
}

export interface BindAdminCommandsContext {
  config: Config;
  client: TelegramClient;
  clock: TickClock;
  G: WorldModel;
  personality: PersonalityVector;
  queue: ActionQueue;
  dispatcher: AliceDispatcher;
  mods: readonly ModDefinition[];
}

/**
 * Привязывает команды администратора к mtcute Dispatcher.
 *
 * group=-1 гарантирует выполнение до EventBuffer handler (group=0 по умолчанию);
 * при совпадении возвращает PropagationAction.Stop, блокируя попадание сообщения в EventBuffer.
 */
export function bindAdminCommands(dp: MtcuteDispatcher, ctx: BindAdminCommandsContext): void {
  const { config, client, clock, queue, dispatcher, mods } = ctx;

  if (!config.telegramAdmin) {
    log.info("TELEGRAM_ADMIN not set, admin commands disabled");
    return;
  }

  dp.onNewMessage(async (msgCtx) => {
    // только личные сообщения
    if (!(msgCtx.chat instanceof User)) return;

    // только admin
    const senderId = msgCtx.sender ? String(msgCtx.sender.id) : null;
    if (senderId !== config.telegramAdmin) return;

    const text = msgCtx.text?.trim();
    if (!text || !text.startsWith("/")) return;
    const [cmd, ...args] = text.split(/\s+/);

    const reply = async (t: string) => {
      for (const chunk of splitMessage(t)) {
        await sendText(client, msgCtx.chat.id, chunk);
      }
    };

    try {
      switch (cmd) {
        case "/help": {
          await reply(
            [
              "🖤 Пульт Ауры (только тут, в нашей личке):",
              "",
              "/status — жива? аптейм, память, пауза, давления, граф",
              "/pause [30m|2h|1d] — усыпить её самоинициативу (по умолч. 2ч)",
              "/resume — разбудить (снять паузу)",
              "/backup — снять бэкап её памяти прямо сейчас",
              "/explore — сходить прямо сейчас поискать канал по её интересам",
              "/man — полный статус + справочник её инструментов",
              "/help — этот список",
              "",
              "Обычные сообщения (без /) — это просто разговор с ней, не команды.",
            ].join("\n"),
          );
          return PropagationAction.Stop;
        }
        case "/explore": {
          requestExploreNow();
          log.info("/explore requested");
          await reply(
            "[explore] ок — на ближайшем тике схожу поищу канал по своим интересам " +
              "(кап 1/сутки в силе). Если найду — скажу тут своими словами.",
          );
          return PropagationAction.Stop;
        }
        case "/man": {
          log.info("/man command received", { senderId });
          await reply(buildStatusMessage(clock, ctx.personality, queue, dispatcher));
          await reply(await generateShellManual(mods));
          return PropagationAction.Stop;
        }
        case "/status": {
          const now = Date.now();
          const lines: string[] = [];
          const up = process.uptime();
          lines.push(
            `uptime: ${Math.floor(up / 3600)}h ${Math.floor((up % 3600) / 60)}m | rss: ${(process.memoryUsage().rss / 1024 / 1024).toFixed(0)} MB`,
          );
          lines.push(
            isManuallyPaused(now)
              ? `pause: ДА, до ${fmtLocalHm(manualPauseUntil(), config.timezoneOffset)} (/resume — снять)`
              : "pause: нет",
          );
          lines.push("");
          lines.push(buildStatusMessage(clock, ctx.personality, queue, dispatcher));
          await reply(lines.join("\n"));
          return PropagationAction.Stop;
        }
        case "/pause": {
          const ms = parsePauseDuration(args[0]);
          if (ms == null) {
            await reply("[pause] не понял срок. Примеры: /pause (2ч), /pause 30m, /pause 2h, /pause 1d");
            return PropagationAction.Stop;
          }
          const until = Date.now() + ms;
          setManualPause(until);
          log.info("/pause set", { untilMs: until });
          await reply(
            `[pause] самоинициатива спит до ${fmtLocalHm(until, config.timezoneOffset)} ` +
              "(на прямое обращение близких всё же может проснуться). /resume — разбудить.",
          );
          return PropagationAction.Stop;
        }
        case "/resume": {
          clearManualPause();
          log.info("/resume");
          await reply("[resume] пауза снята — живёт дальше.");
          return PropagationAction.Stop;
        }
        case "/backup": {
          log.info("/backup requested");
          await reply(runManualBackup(ctx.G));
          return PropagationAction.Stop;
        }
        default:
          return; // не команда панели — пусть уходит в её обычное восприятие
      }
    } catch (err) {
      log.error("admin command failed", { cmd, error: err });
      await reply(`[error] ${cmd} failed. Check logs.`);
      return PropagationAction.Stop;
    }
  }, -1); // group=-1: выполняется до EventBuffer handler

  log.info("Admin commands bound", { adminId: config.telegramAdmin });
}

/**
 * Формирует текст сводки состояния среды выполнения.
 */
function buildStatusMessage(
  clock: TickClock,
  personality: PersonalityVector,
  queue: ActionQueue,
  dispatcher: AliceDispatcher,
): string {
  const lines: string[] = [];

  lines.push(`Alice Runtime Status (tick #${clock.tick})`);
  lines.push("");

  // значения давления
  const pressures = typedQuery(dispatcher, "debugPressures");

  lines.push("Pressures:");
  if (pressures) {
    lines.push(
      `  P1=${pressures.P1.toFixed(1)} P2=${pressures.P2.toFixed(1)} P3=${pressures.P3.toFixed(1)} P4=${pressures.P4.toFixed(1)} P5=${pressures.P5.toFixed(1)} P6=${pressures.P6.toFixed(1)}`,
    );
    lines.push(`  API=${pressures.API.toFixed(2)}`);
  } else {
    lines.push("  (no data yet)");
  }
  lines.push("");

  // статистика графа
  const graphStats = typedQuery(dispatcher, "debugGraphStats");

  lines.push("Graph:");
  if (graphStats) {
    lines.push(`  ${graphStats.nodeCount} nodes, ${graphStats.edgeCount} edges`);
    const typeStr = Object.entries(graphStats.byType)
      .map(([t, c]) => `${t}: ${c}`)
      .join(", ");
    lines.push(`  ${typeStr}`);
  } else {
    lines.push("  (no data)");
  }
  lines.push("");

  // вектор личности
  const piStr = VOICES.map((v, i) => `${v.short}=${personality.weights[i].toFixed(3)}`).join(" ");
  lines.push(`Personality: ${piStr}`);
  lines.push("");

  // распределение по Tier
  const tierDist = typedQuery(dispatcher, "debugTierDistribution");

  lines.push("Tier Distribution:");
  if (tierDist) {
    for (const [bucket, count] of Object.entries(tierDist.buckets)) {
      lines.push(`  ${bucket}: ${count}`);
    }
  } else {
    lines.push("  (no data)");
  }
  lines.push("");

  // очередь
  lines.push(`Queue: ${queue.length} pending actions`);

  return lines.join("\n");
}
