/**
 * 群组存在感计算 — 极乐迪斯科式低语。
 *
 * 纯函数模块：从消息窗口计算 Alice 的频道存在感，
 * 渲染为 IRC-style `---` 分隔符注入 prompt，
 * 让 LLM 感知"我已经说了多少"而不需要指令。
 *
 * 设计灵感：
 * - 极乐迪斯科技能低语 — 人格化环境感知，不是指令
 * - 叙事引擎 set_fact 渐进抑制 — 用 IRC 事实代替指令
 * - AGENTS.md 无障碍原则 — 自然语言事实，不暴露数字让 LLM 做算术
 *
 * @see docs/adr/118-group-presence-awareness.md
 */
import type { MessageRecord } from "./messages.js";

export interface ChannelPresence {
  /** 消息窗口总数。 */
  total: number;
  /** Alice 的消息数。 */
  yours: number;
  /** 窗口中 bot 发来的消息数。 */
  botIncoming: number;
  /** 窗口中真人发来的消息数。 */
  humanIncoming: number;
  /** 消息列表尾部连续 Alice 消息数。 */
  trailingYours: number;
  /** 消息列表尾部连续 bot 消息数。 */
  trailingBotIncoming: number;
  /** 最后一条非 Alice 消息距今 ms（Infinity = 全是 Alice）。 */
  lastOtherAgoMs: number;
}

/** 从消息窗口计算 Alice 的频道存在感。 */
export function computeChannelPresence(messages: readonly MessageRecord[]): ChannelPresence {
  if (messages.length === 0) {
    return {
      total: 0,
      yours: 0,
      botIncoming: 0,
      humanIncoming: 0,
      trailingYours: 0,
      trailingBotIncoming: 0,
      lastOtherAgoMs: Infinity,
    };
  }

  let yours = 0;
  let botIncoming = 0;
  let humanIncoming = 0;
  let lastOtherDate: Date | null = null;

  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].isOutgoing) {
      yours++;
    } else if (!lastOtherDate) {
      lastOtherDate = messages[i].date;
    }
    if (!messages[i].isOutgoing) {
      if (messages[i].isBot) botIncoming++;
      else humanIncoming++;
    }
  }

  // 尾部连续 Alice 消息数
  let trailingYours = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].isOutgoing) {
      trailingYours++;
    } else {
      break;
    }
  }

  let trailingBotIncoming = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg.isOutgoing && msg.isBot) {
      trailingBotIncoming++;
    } else {
      break;
    }
  }

  const lastOtherAgoMs = lastOtherDate ? Date.now() - lastOtherDate.getTime() : Infinity;

  return {
    total: messages.length,
    yours,
    botIncoming,
    humanIncoming,
    trailingYours,
    trailingBotIncoming,
    lastOtherAgoMs,
  };
}

/**
 * 渲染 IRC-style `---` 分隔符。
 *
 * 仅在 trailingYours >= 2 时渲染——低存在感时不显示，避免 LLM 产生"配额"心态。
 * 纯事实自然语言，不含指令，不暴露比例数字。
 *
 * 渲染规则（渐进信息密度）：
 * | trailingYours | 渲染 |
 * |---------------|------|
 * | < 2           | null（不显示） |
 * | 2             | `--- 2 consecutive from you ---` |
 * | 3             | `--- 3 consecutive from you ---` |
 * | ≥ 4           | `--- N consecutive from you — STOP, wait for their reply ---` |
 *
 * ADR-159: trailingYours ≥ 4 时从纯事实升级为指令。
 * 实证数据表明纯事实提示（"only you talking"）被 LLM 忽视，
 * 4 条连发已是明显独白，此处牺牲"纯事实"设计换取行为约束。
 *
 * @returns `--- N consecutive from you ---` 或 null
 */
export function renderPresenceHint(presence: ChannelPresence): string | null {
  if (
    presence.botIncoming >= 3 &&
    presence.humanIncoming === 0 &&
    presence.yours > 0 &&
    (presence.trailingBotIncoming >= 1 || presence.yours >= 2)
  ) {
    return "--- this is turning into a bot loop. Tool output is not a social conversation. Be brief, show mild annoyance if needed, then disengage ---";
  }
  if (presence.trailingBotIncoming >= 3) {
    return `--- ${presence.trailingBotIncoming} consecutive bot messages — this feels spammy. Treat it as tool output, not conversation ---`;
  }
  if (presence.trailingYours < 2) return null;
  if (presence.trailingYours >= 4) {
    return `--- ${presence.trailingYours} consecutive from you — STOP, wait for their reply ---`;
  }
  return `--- ${presence.trailingYours} consecutive from you ---`;
}
