/**
 * Channel Mod — ADR-206: лента каналов.
 *
 * Telegram-зрение Алисы: подписанные каналы — её нативный источник информации.
 * Дополняет Feed Mod (интернет-источники):
 * - Feed Mod = "увидела в ленте телефона" (API-получение внешних источников)
 * - Channel Mod = "листала Telegram" (непрочитанное в Telegram-каналах)
 *
 * Ключевые архитектурные решения (переиспользуют паттерн Feed Mod):
 * - contribute синхронно читает состояние непрочитанного узлов каналов в WorldModel
 * - поведенческий gate: давление > 0.5 — не листать каналы; кулдаун; вероятностный пропуск
 * - Token budget общий с Feed Mod (ADR-206 C2)
 * - Не создаёт треды — контент канала это фоновая информация, не транзакция
 * - Не добавляет новых action — LLM делится через существующие send_message/forward_message
 *
 * @see docs/adr/206-channel-information-flow/206-channel-information-flow.md §4
 * @see docs/adr/167-rsshub-perception-channel.md — архитектурный референс Feed Mod
 */
import { createMod } from "../core/mod-builder.js";
import { PromptBuilder } from "../core/prompt-style.js";
import type { ContributionItem } from "../core/types.js";
import { readPressureApi, section } from "../core/types.js";
import { safeDisplayName } from "../graph/display.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("channel-mod");

// ── Параметры реалистичности поведения (согласованы с Feed Mod) ────────────

/** Порог давления: при превышении Алиса "занята делами" и не листает каналы. */
const PRESSURE_GATE = 0.5;

/** Кулдаун инжекции (мс): если с последней инжекции прошло меньше — пропустить. */
const INJECT_COOLDOWN_MS = 10 * 60_000; // 10 min

/** Вероятностный пропуск: даже при выполнении условий с этой вероятностью не инжектировать (имитация "в этот раз не зашла в Telegram"). */
const SKIP_PROBABILITY = 0.3;

/** Максимальное число каналов для отображения за раз. */
const MAX_CHANNELS_PER_INJECT = 3;

/** ADR-206 C2: верхний предел доли канала в совместном token-бюджете Channel + Feed (приблизительно в символах). */
const MAX_CHARS = 600;

/** ADR-206 C3: кулдаун репоста контента одного и того же канала (мс). Предотвращает спам-пересылку. */
const SHARE_COOLDOWN_MS = 30 * 60_000; // 30 min

// ── Состояние Mod ─────────────────────────────────────────────────────────────

interface ChannelModState {
  /** Время последней успешной инжекции обновлений канала (мс). */
  lastInjectMs: number;
}

// ── Определение Mod ─────────────────────────────────────────────────────────

export const channelMod = createMod<ChannelModState>("channel", {
  category: "mechanic",
  description: "ADR-206: лента каналов — Telegram-зрение Алисы",
  initialState: { lastInjectMs: 0 },
})
  .contribute((ctx): ContributionItem[] => {
    // ── Поведенческий gate: имитация реального "листания Telegram" ──

    // 1. gate по давлению: не листать каналы когда занята обработкой сообщений
    const pressure = readPressureApi(ctx);
    if (pressure > PRESSURE_GATE) return [];

    // 2. кулдаун: только что смотрела каналы — не будет смотреть снова сразу
    const now = ctx.nowMs;
    if (ctx.state.lastInjectMs > 0 && now - ctx.state.lastInjectMs < INJECT_COOLDOWN_MS) {
      return [];
    }

    // 3. вероятностный пропуск: человек не сидит в Telegram каждую секунду
    if (Math.random() < SKIP_PROBABILITY) return [];

    // ── Сбор состояния непрочитанного каналов ──

    const G = ctx.graph;
    const channelSummaries: Array<{
      name: string;
      unread: number;
      role: string;
      nodeId: string;
    }> = [];

    for (const nodeId of G.getEntitiesByType("channel")) {
      const attrs = G.getChannel(nodeId);
      // обрабатывать только тип Telegram channel (не private/group/supergroup)
      if (attrs.chat_type !== "channel") continue;
      // Недостижимые/удалённые каналы (кикнули/удалили) — не показываем как живые.
      if (attrs.failure_type === "permanent" || (attrs.reachability_score ?? 1) <= 0) continue;

      const unread = attrs.unread ?? 0;
      const role = String(attrs.alice_role ?? "subscriber");
      const name = safeDisplayName(G, nodeId);

      // пропускать каналы без непрочитанных и не admin
      if (unread === 0 && role === "subscriber") continue;

      channelSummaries.push({ name, unread, role, nodeId });
    }

    if (channelSummaries.length === 0) return [];

    // сортировать по убыванию непрочитанных, брать top N
    channelSummaries.sort((a, b) => b.unread - a.unread);
    const toShow = channelSummaries.slice(0, MAX_CHANNELS_PER_INJECT);

    // фиксируем время инжекции
    ctx.state.lastInjectMs = now;

    // рендерим как prompt section
    let totalChars = 0;
    const lines = [];
    for (const ch of toShow) {
      const attrs = G.getChannel(ch.nodeId);
      let line: string;
      if (ch.role === "owner" || ch.role === "admin") {
        line = `${ch.name} (твой канал, ${ch.role})`;
        if (ch.unread > 0) line += ` — новых сообщений: ${ch.unread}`;
        // ADR-206 C4: подсказка о кулдауне публикации
        const lastPubMs = Number(attrs.last_publish_ms ?? 0);
        if (lastPubMs > 0) {
          const hoursSincePub = Math.floor((now - lastPubMs) / 3_600_000);
          if (hoursSincePub < 2) {
            line += ` (кулдаун публикации, можно постить через ${2 - hoursSincePub}h)`;
          } else {
            line += ` (последний пост ${hoursSincePub}h назад)`;
          }
        }
      } else {
        line = `${ch.name} — непрочитанных: ${ch.unread}`;
      }
      // ADR-206 C3: подсказка о частоте репостов — LLM должен знать о недавнем шаринге
      const lastSharedMs = Number(attrs.last_shared_ms ?? 0);
      if (lastSharedMs > 0 && now - lastSharedMs < SHARE_COOLDOWN_MS) {
        line += " (недавно уже делилась)";
      }

      totalChars += line.length;
      if (totalChars > MAX_CHARS) break; // ADR-206 C2: token-бюджет

      lines.push(PromptBuilder.of(line));
    }

    if (lines.length === 0) return [];

    log.debug("channel-mod: injecting", { count: lines.length });

    return [
      section(
        "channel-updates",
        lines,
        "Что нового в каналах",
        41, // order: после feed-items (40)
        25, // priority: ниже feed (feed=30), может быть урезан token-бюджетом
      ),
    ];
  })
  .build();
