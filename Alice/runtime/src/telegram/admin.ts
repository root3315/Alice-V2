/**
 * Обработчик команд администратора.
 *
 * /man — выводит текущее состояние среды выполнения и справочник доступных команд.
 * Доступно только в личных сообщениях пользователя TELEGRAM_ADMIN.
 * Командные сообщения не попадают в EventBuffer (перехватываются через PropagationAction.Stop).
 */

import type { Dispatcher as MtcuteDispatcher } from "@mtcute/dispatcher";
import { PropagationAction } from "@mtcute/dispatcher";
import type { TelegramClient } from "@mtcute/node";
import { User } from "@mtcute/node";
import type { Config } from "../config.js";
import type { Dispatcher as AliceDispatcher } from "../core/dispatcher.js";
import { typedQuery } from "../core/query-helpers.js";
import { generateShellManual } from "../core/shell-manual.js";
import type { ModDefinition } from "../core/types.js";
import type { ActionQueue } from "../engine/action-queue.js";
import type { WorldModel } from "../graph/world-model.js";
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

    // только команда /man
    const text = msgCtx.text?.trim();
    if (text !== "/man") return;

    log.info("/man command received", { senderId });

    try {
      // собираем состояние среды выполнения (читаем personality из ctx, чтобы получить актуальную ссылку)
      const statusText = buildStatusMessage(clock, ctx.personality, queue, dispatcher);

      // отправляем статусное сообщение
      const statusChunks = splitMessage(statusText);
      for (const chunk of statusChunks) {
        await sendText(client, msgCtx.chat.id, chunk);
      }

      // генерируем и отправляем shell-native справочник
      const manual = await generateShellManual(mods);
      const manualChunks = splitMessage(manual);
      for (const chunk of manualChunks) {
        await sendText(client, msgCtx.chat.id, chunk);
      }
    } catch (err) {
      log.error("/man command failed", { error: err });
      await sendText(client, msgCtx.chat.id, "[Error] /man command failed. Check logs.");
    }

    return PropagationAction.Stop;
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
