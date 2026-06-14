/**
 * Расчёт присутствия в группе — в духе шёпотов Disco Elysium.
 *
 * Модуль чистых функций: вычисляет присутствие Alice в канале по окну сообщений,
 * рендерит в виде IRC-style разделителя `---` для внедрения в prompt,
 * давая LLM ощущение «сколько я уже сказала» без явных инструкций.
 *
 * Источники вдохновения:
 * - Шёпоты навыков Disco Elysium — очеловеченное восприятие среды, а не инструкции
 * - Постепенное подавление через set_fact нарративного движка — IRC-факты вместо инструкций
 * - Принцип безбарьерности AGENTS.md — факты на естественном языке, без чисел для арифметики LLM
 *
 * @see docs/adr/118-group-presence-awareness.md
 */
import type { MessageRecord } from "./messages.js";

export interface ChannelPresence {
  /** Общее количество сообщений в окне. */
  total: number;
  /** Количество сообщений Alice. */
  yours: number;
  /** Количество входящих сообщений от бота в окне. */
  botIncoming: number;
  /** Количество входящих сообщений от людей в окне. */
  humanIncoming: number;
  /** Количество последовательных сообщений Alice в конце списка сообщений. */
  trailingYours: number;
  /** Количество последовательных входящих сообщений от бота в конце списка. */
  trailingBotIncoming: number;
  /** Миллисекунд с последнего не-Alice сообщения (Infinity = все сообщения от Alice). */
  lastOtherAgoMs: number;
}

/** Вычисляет присутствие Alice в канале по окну сообщений. */
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

  // Количество последовательных сообщений Alice в конце
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
 * Рендерит IRC-style разделитель `---`.
 *
 * Рендерится только при trailingYours >= 2 — при низком присутствии не отображается, чтобы у LLM не формировалось «квотное» мышление.
 * Чистые факты на естественном языке, без инструкций, без числовых соотношений.
 *
 * Правила рендеринга (прогрессивная плотность информации):
 * | trailingYours | Рендер |
 * |---------------|--------|
 * | < 2           | null (не отображать) |
 * | 2             | `--- 2 consecutive from you ---` |
 * | 3             | `--- 3 consecutive from you ---` |
 * | ≥ 4           | `--- N consecutive from you — STOP, wait for their reply ---` |
 *
 * ADR-159: при trailingYours ≥ 4 переходим от чистых фактов к инструкции.
 * Эмпирические данные показывают, что факты-подсказки («only you talking») игнорируются LLM,
 * 4 подряд — явный монолог; здесь жертвуем принципом «только факты» ради поведенческого ограничения.
 *
 * @returns `--- N consecutive from you ---` или null
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
