/**
 * Channel Mod — ADR-206: 频道信息流。
 *
 * Alice 的 Telegram 视觉：订阅频道是她的原生信息源。
 * 与 Feed Mod（互联网信息源）互补：
 * - Feed Mod = "刷手机看到的"（API 拉取外部数据源）
 * - Channel Mod = "刷 Telegram 看到的"（Telegram 频道未读）
 *
 * 架构要点（复用 Feed Mod 模式）：
 * - contribute 同步读取 WorldModel 中频道节点的未读状态
 * - 行为门控：压力 > 0.5 不刷频道、冷却期、概率跳过
 * - Token budget 与 Feed Mod 共享上限（ADR-206 C2）
 * - 不创建线程——频道内容是环境信息，不是事务
 * - 不新增 action——LLM 用现有 send_message/forward_message 分享
 *
 * @see docs/adr/206-channel-information-flow/206-channel-information-flow.md §4
 * @see docs/adr/167-rsshub-perception-channel.md — Feed Mod 架构参考
 */
import { createMod } from "../core/mod-builder.js";
import { PromptBuilder } from "../core/prompt-style.js";
import type { ContributionItem } from "../core/types.js";
import { readPressureApi, section } from "../core/types.js";
import { safeDisplayName } from "../graph/display.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("channel-mod");

// ── 行为真实性参数（与 Feed Mod 对齐）──────────────────────────────────────

/** 压力阈值：高于此值时 Alice 在"忙正事"，不刷频道。 */
const PRESSURE_GATE = 0.5;

/** 注入冷却期（ms）：距上次注入不足此时间则跳过。 */
const INJECT_COOLDOWN_MS = 10 * 60_000; // 10 min

/** 概率性跳过：即使满足条件也有此概率不注入（模拟"这次没看 Telegram"）。 */
const SKIP_PROBABILITY = 0.3;

/** 每次最多展示频道数。 */
const MAX_CHANNELS_PER_INJECT = 3;

/** ADR-206 C2: Channel + Feed 共享 token 预算的 channel 份额上限（字符数近似）。 */
const MAX_CHARS = 600;

/** ADR-206 C3: 同一频道的内容分享冷却时间（ms）。避免刷屏式转发。 */
const SHARE_COOLDOWN_MS = 30 * 60_000; // 30 min

// ── Mod 状态 ─────────────────────────────────────────────────────────────────

interface ChannelModState {
  /** 上次成功注入频道动态的时间（ms）。 */
  lastInjectMs: number;
}

// ── Mod 定义 ─────────────────────────────────────────────────────────────────

export const channelMod = createMod<ChannelModState>("channel", {
  category: "mechanic",
  description: "ADR-206: лента каналов — Telegram-зрение Алисы",
  initialState: { lastInjectMs: 0 },
})
  .contribute((ctx): ContributionItem[] => {
    // ── 行为门控：模拟真实"刷 Telegram"条件 ──

    // 1. 压力门控：忙着处理消息时不刷频道
    const pressure = readPressureApi(ctx);
    if (pressure > PRESSURE_GATE) return [];

    // 2. 冷却期：刚看过频道不会马上又看
    const now = ctx.nowMs;
    if (ctx.state.lastInjectMs > 0 && now - ctx.state.lastInjectMs < INJECT_COOLDOWN_MS) {
      return [];
    }

    // 3. 概率性跳过：人不是每时每刻都在刷 Telegram
    if (Math.random() < SKIP_PROBABILITY) return [];

    // ── 收集频道未读状态 ──

    const G = ctx.graph;
    const channelSummaries: Array<{
      name: string;
      unread: number;
      role: string;
      nodeId: string;
    }> = [];

    for (const nodeId of G.getEntitiesByType("channel")) {
      const attrs = G.getChannel(nodeId);
      // 只处理 Telegram channel 类型（不是 private/group/supergroup）
      if (attrs.chat_type !== "channel") continue;
      // Недостижимые/удалённые каналы (кикнули/удалили) — не показываем как живые.
      if (attrs.failure_type === "permanent" || (attrs.reachability_score ?? 1) <= 0) continue;

      const unread = attrs.unread ?? 0;
      const role = String(attrs.alice_role ?? "subscriber");
      const name = safeDisplayName(G, nodeId);

      // 跳过无未读且非 admin 的频道
      if (unread === 0 && role === "subscriber") continue;

      channelSummaries.push({ name, unread, role, nodeId });
    }

    if (channelSummaries.length === 0) return [];

    // 按未读数降序排列，取 top N
    channelSummaries.sort((a, b) => b.unread - a.unread);
    const toShow = channelSummaries.slice(0, MAX_CHANNELS_PER_INJECT);

    // 记录注入时间
    ctx.state.lastInjectMs = now;

    // 渲染为 prompt section
    let totalChars = 0;
    const lines = [];
    for (const ch of toShow) {
      const attrs = G.getChannel(ch.nodeId);
      let line: string;
      if (ch.role === "owner" || ch.role === "admin") {
        line = `${ch.name} (твой канал, ${ch.role})`;
        if (ch.unread > 0) line += ` — новых сообщений: ${ch.unread}`;
        // ADR-206 C4: 发布冷却提示
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
      // ADR-206 C3: 分享频率提示——让 LLM 知道最近已分享过
      const lastSharedMs = Number(attrs.last_shared_ms ?? 0);
      if (lastSharedMs > 0 && now - lastSharedMs < SHARE_COOLDOWN_MS) {
        line += " (недавно уже делилась)";
      }

      totalChars += line.length;
      if (totalChars > MAX_CHARS) break; // ADR-206 C2: token budget

      lines.push(PromptBuilder.of(line));
    }

    if (lines.length === 0) return [];

    log.debug("channel-mod: injecting", { count: lines.length });

    return [
      section(
        "channel-updates",
        lines,
        "Что нового в каналах",
        41, // order: 在 feed-items (40) 之后
        25, // priority: 低于 feed（feed=30），可被 token 预算裁剪
      ),
    ];
  })
  .build();
