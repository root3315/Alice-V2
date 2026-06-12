/**
 * 管理员命令处理器。
 *
 * /man — 显示当前运行时状态和可用指令手册。
 * 仅限 TELEGRAM_ADMIN 用户私聊使用。
 * 命令消息不进入 EventBuffer（通过 PropagationAction.Stop 拦截）。
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

/** Telegram 单条消息最大字符数。 */
const TG_MSG_LIMIT = 4096;

/**
 * 将长文本按 Telegram 消息长度限制分段。
 * 优先在换行符处断开，避免截断行。
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

    // 在 limit 内找最后一个换行符
    const newlineAt = remaining.lastIndexOf("\n", limit);
    if (newlineAt > 0) {
      chunks.push(remaining.slice(0, newlineAt));
      remaining = remaining.slice(newlineAt + 1); // 跳过换行符
    } else {
      // 无换行符，强制截断
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
 * 绑定管理员命令到 mtcute Dispatcher。
 *
 * 使用 group=-1 确保在 EventBuffer handler (默认 group=0) 之前执行，
 * 命中时返回 PropagationAction.Stop 阻止消息进入 EventBuffer。
 */
export function bindAdminCommands(dp: MtcuteDispatcher, ctx: BindAdminCommandsContext): void {
  const { config, client, clock, queue, dispatcher, mods } = ctx;

  if (!config.telegramAdmin) {
    log.info("TELEGRAM_ADMIN not set, admin commands disabled");
    return;
  }

  dp.onNewMessage(async (msgCtx) => {
    // 仅限私聊
    if (!(msgCtx.chat instanceof User)) return;

    // 仅限 admin
    const senderId = msgCtx.sender ? String(msgCtx.sender.id) : null;
    if (senderId !== config.telegramAdmin) return;

    // 仅限 /man 命令
    const text = msgCtx.text?.trim();
    if (text !== "/man") return;

    log.info("/man command received", { senderId });

    try {
      // 汇总运行时状态（从 ctx 读取 personality 确保获取最新引用）
      const statusText = buildStatusMessage(clock, ctx.personality, queue, dispatcher);

      // 发送状态消息
      const statusChunks = splitMessage(statusText);
      for (const chunk of statusChunks) {
        await sendText(client, msgCtx.chat.id, chunk);
      }

      // 生成并发送 shell-native 手册
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
  }, -1); // group=-1: 在 EventBuffer handler 之前执行

  log.info("Admin commands bound", { adminId: config.telegramAdmin });
}

/**
 * 构建运行时状态摘要文本。
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

  // 压力值
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

  // 图统计
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

  // 人格向量
  const piStr = VOICES.map((v, i) => `${v.short}=${personality.weights[i].toFixed(3)}`).join(" ");
  lines.push(`Personality: ${piStr}`);
  lines.push("");

  // Tier 分布
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

  // 队列
  lines.push(`Queue: ${queue.length} pending actions`);

  return lines.join("\n");
}
