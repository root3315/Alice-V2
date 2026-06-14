/**
 * ADR-118 Единая временная линия — слияние 4 источников + IRC-рендеринг.
 *
 * Поток сообщений, мысли из action_log, действия engagement session и наблюдения ReAct
 * сортируются по временной метке и объединяются в единую временную линию для сборки prompt.
 *
 * @see docs/adr/118-unified-timeline.md
 */
import { getPeripheralMessages, getRecentActionsByChat } from "../../db/queries.js";
import type { MessageRecord } from "./messages.js";
import { computeChannelPresence, renderPresenceHint } from "./presence.js";
import { isWorkiActive } from "./worki-active.js";

// ═══════════════════════════════════════════════════════════════════════════
// Типы
// ═══════════════════════════════════════════════════════════════════════════

/** Тип метки записи временной линии. */
export type TimelineKind =
  | "message" // Telegram-сообщение (входящее или исходящее)
  | "thought" // Внутренний монолог (reasoning из action_log)
  | "action" // Сводка выполненного действия (текущий engagement session)
  | "gap" // Маркер временного разрыва
  | "context" // Разделитель контекста (reply chain / mention)
  | "observation"; // Результат запроса ReAct

export interface TimelineEntry {
  /** Настенное время в миллисекундах. */
  readonly ts: number;
  readonly kind: TimelineKind;
  /** Отрендеренная текстовая строка в стиле IRC. */
  readonly rendered: string;
  /** Опциональные метаданные. */
  readonly meta?: Record<string, unknown>;
}

export interface TimelineSource {
  entries(target: string, sinceMs: number, nowMs: number): TimelineEntry[];
}

// ═══════════════════════════════════════════════════════════════════════════
// Рендеринг содержимого сообщения с учётом приоритета
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Рендеринг содержимого сообщения с учётом приоритета.
 *
 * При наличии segments: media/image-сегменты не обрезаются, link-сегменты отбрасываются первыми, body/meta обрезаются по бюджету.
 * Без segments: откат к жёсткому усечению до 200 символов (история DB / eval fixture).
 */
export function renderMessageContent(record: MessageRecord, defaultBudget = 200): string {
  const segments = record.segments;
  if (!segments) {
    return record.text.length > defaultBudget
      ? `${record.text.slice(0, defaultBudget)}...`
      : record.text;
  }

  const hasMedia = segments.some((s) => s.kind === "media" || s.kind === "image");
  const budget = hasMedia ? 500 : defaultBudget;

  const full = segments.map((s) => s.text).join(" ");
  if (full.length <= budget) return full;

  // Phase 1: Отбросить link-сегменты
  const withoutLinks = segments.filter((s) => s.kind !== "link");
  const reduced = withoutLinks.map((s) => s.text).join(" ");
  if (reduced.length <= budget) return reduced;

  // Phase 2: Сохранить essential-сегменты (media/image), обрезать остальные
  const essential = withoutLinks.filter((s) => s.kind === "media" || s.kind === "image");
  const others = withoutLinks.filter((s) => s.kind !== "media" && s.kind !== "image");
  const essentialText = essential.map((s) => s.text).join(" ");
  const sep = essential.length > 0 && others.length > 0 ? 1 : 0;
  const otherBudget = Math.max(0, budget - essentialText.length - sep);
  const otherText = others.map((s) => s.text).join(" ");
  const truncatedOther =
    otherText.length > otherBudget ? `${otherText.slice(0, otherBudget)}...` : otherText;

  return [truncatedOther, essentialText].filter(Boolean).join(" ");
}

// ═══════════════════════════════════════════════════════════════════════════
// MessageTimelineSource — адаптер потока сообщений
// ═══════════════════════════════════════════════════════════════════════════
// Логика рендеринга перенесена из prompt.ts L382-448

/**
 * Реестр записей о пересылке: msgId → список имён целей, куда переслано.
 * Записывается действием forward_message в dynamic property графа "forwarded_msgs",
 * передаётся через buildTimelineSlot. Цикл обратной связи BT — результаты действий возвращаются в слой наблюдения.
 */
export type ForwardRegistry = Record<string, string[]>;

export class MessageTimelineSource implements TimelineSource {
  constructor(
    private readonly messages: MessageRecord[],
    private readonly forwardRegistry?: ForwardRegistry,
  ) {}

  entries(target: string, _sinceMs: number, _nowMs: number): TimelineEntry[] {
    const result: TimelineEntry[] = [];
    const repliesByYou = new Map<number, number[]>();
    for (const msg of this.messages) {
      if (!msg.isOutgoing || !msg.replyToId) continue;
      const replies = repliesByYou.get(msg.replyToId) ?? [];
      replies.push(msg.id);
      repliesByYou.set(msg.replyToId, replies);
    }

    // ADR-97 + ADR-114 D2: Состояние разделителя контекста
    let contextType: "none" | "diffused" | "mention" = "none";

    for (let i = 0; i < this.messages.length; i++) {
      const msg = this.messages[i];
      const msgTs = msg.date.getTime();

      // Переключение типа контекста (reply chain / unanswered mention / обычное сообщение)
      const newCtx = msg.isMentionContext ? "mention" : msg.isDiffused ? "diffused" : "none";
      if (newCtx !== contextType) {
        if (contextType !== "none") {
          result.push({ ts: msgTs, kind: "context", rendered: "--- end context ---" });
        }
        if (newCtx === "mention") {
          result.push({
            ts: msgTs,
            kind: "context",
            rendered: "--- context: unanswered mention ---",
          });
        } else if (newCtx === "diffused") {
          result.push({ ts: msgTs, kind: "context", rendered: "--- context: reply chain ---" });
        }
        contextType = newCtx;
      }

      // Строка сообщения в стиле IRC (временная метка добавляется централизованно в renderTimeline)
      const senderTag = msg.senderId != null ? ` @${msg.senderId}` : "";
      const botTag = msg.isBot ? " [bot]" : "";
      const name = msg.isOutgoing ? "Alice (you)" : `${msg.senderName}${botTag}${senderTag}`;
      const preview = renderMessageContent(msg);
      const replyMark = msg.replyToId ? ` ↩${msg.replyToId}` : "";
      const editMark = msg.isEdited ? " [edited]" : "";
      const fwdMark = msg.forwardFrom ? ` [fwd ${msg.forwardFrom}]` : "";
      const repliesFromYou = !msg.isOutgoing ? repliesByYou.get(msg.id) : undefined;
      const alreadyRepliedMark =
        repliesFromYou && repliesFromYou.length > 0
          ? ` (already replied by you: ${repliesFromYou.map((id) => `#${id}`).join(", ")})`
          : "";
      let reactionStr = "";
      if (msg.reactions) {
        const sorted = Object.entries(msg.reactions)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 3);
        if (sorted.length > 0) {
          reactionStr = ` [${sorted.map(([e, c]) => `${e}×${c}`).join(" ")}]`;
        }
      }

      // Цикл обратной связи BT: помечать пересланные сообщения целью (Alice знает, что она пересылала)
      let sharedMark = "";
      if (this.forwardRegistry && msg.id != null) {
        const targets = this.forwardRegistry[String(msg.id)];
        if (targets && targets.length > 0) {
          sharedMark = ` (already shared with ${targets.join(", ")})`;
        }
      }

      result.push({
        ts: msgTs,
        kind: "message",
        rendered: `${name} (${msg.id})${replyMark}${editMark}${fwdMark}: ${preview}${alreadyRepliedMark}${reactionStr}${sharedMark}`,
      });
    }

    // Закрыть хвостовой контекст
    if (contextType !== "none" && this.messages.length > 0) {
      const lastTs = this.messages[this.messages.length - 1].date.getTime();
      result.push({ ts: lastTs + 1, kind: "context", rendered: "--- end context ---" });
    }

    // ADR-118: Подсказка о присутствии (ADR-159: расширено на личные чаты — там серийные ответы особенно проблематичны)
    if (this.messages.length > 0) {
      const presence = computeChannelPresence(this.messages);
      // Во время worki-ревью анти-монолог ослаблен — Алиса свободно нарратит прогресс своим голосом.
      const hint = isWorkiActive(target) ? null : renderPresenceHint(presence);
      if (hint) {
        const lastTs = this.messages[this.messages.length - 1].date.getTime();
        result.push({ ts: lastTs + 1, kind: "context", rendered: hint });
      }
    }

    return result;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// ThoughtTimelineSource — адаптер мыслей action_log
// ═══════════════════════════════════════════════════════════════════════════
// @see docs/adr/117-*.md — D1: Непрерывность между тиками

export class ThoughtTimelineSource implements TimelineSource {
  entries(target: string, sinceMs: number, _nowMs: number): TimelineEntry[] {
    const TEN_MINUTES_MS = 10 * 60 * 1000;
    const effectiveSince = Math.max(sinceMs, Date.now() - TEN_MINUTES_MS);
    const recentThoughts = getRecentActionsByChat(target, effectiveSince, 3);
    // getRecentActionsByChat возвращает порядок DESC, нужно reverse
    return recentThoughts.reverse().flatMap((thought) => {
      const reasoning = thought.reasoning
        ? [...thought.reasoning].slice(0, 120).join("")
        : thought.actionType.includes("silence") || thought.actionType === "stay_silent"
          ? "[silence] observing"
          : null;
      if (!reasoning) return [];
      return [
        {
          ts: thought.createdAt.getTime(),
          kind: "thought" as const,
          rendered: `* ${reasoning}`,
        },
      ];
    });
  }
}

// ADR-214 Wave A: PendingActionTimelineSource и renderPendingMessage удалены.
// В shell-native архитектуре Blackboard.actions (RecordedAction[]) всегда пуст,
// pending actions больше не проходят через этот конвейер — Telegram-действия выполняются напрямую через Engine API HTTP внутри контейнера.

// ═══════════════════════════════════════════════════════════════════════════
// ObservationTimelineSource — адаптер результатов запросов ReAct
// ═══════════════════════════════════════════════════════════════════════════
// @see docs/adr/70-react-native-sandbox-architecture.md

/**
 * ADR-160 Fix D: Изоляция наблюдений из других чатов.
 *
 * Обнаруживает наблюдения с содержимым из других чатов (по маркеру `[recent_chat]`
 * и паттерну `messages from`) и оборачивает их в тип context.
 * Тип context не имеет префикса `[HH:MM]`, визуально чётко отделяя их от текущего разговора.
 *
 * Для сравнения: PeripheralTimelineSource уже корректно использует `kind: "context"`,
 * и LLM правильно воспринимает это как внешний источник. Здесь применяется тот же паттерн.
 *
 * @see docs/adr/158-outbound-feedback-gap.md §Fix D
 */

/** Определяет, содержит ли текст наблюдения контент из другого чата. */
function isCrossChatObservation(obs: string, target: string): boolean {
  // Типичный вывод recent_chat содержит "[recent_chat]" или "messages from"
  if (!obs.includes("recent_chat") && !obs.includes("recentChat") && !obs.includes("messages from"))
    return false;
  // Если наблюдение явно упоминает target channel, это не межчатовый контент
  if (obs.includes(target)) return false;
  return true;
}

export class ObservationTimelineSource implements TimelineSource {
  constructor(private readonly observations: readonly string[]) {}

  entries(target: string, _sinceMs: number, nowMs: number): TimelineEntry[] {
    const result: TimelineEntry[] = [];
    const normalObs: string[] = [];

    for (const obs of this.observations) {
      if (isCrossChatObservation(obs, target)) {
        // Межчатовое наблюдение: обернуть в context, явно пометить как недопустимое для ответа
        result.push({
          ts: nowMs - 1,
          kind: "context",
          rendered: "--- cross-chat reference (do NOT reply to these messages) ---",
        });
        result.push({
          ts: nowMs,
          kind: "observation",
          rendered: obs,
        });
        result.push({
          ts: nowMs + 1,
          kind: "context",
          rendered: "--- end cross-chat ---",
        });
      } else {
        normalObs.push(obs);
      }
    }

    // ADR-196 F16: Блочный маркер вместо построчного префикса [observation]
    if (normalObs.length > 0) {
      result.push({
        ts: nowMs - 1,
        kind: "context",
        rendered: "--- observations ---",
      });
      for (const obs of normalObs) {
        result.push({
          ts: nowMs,
          kind: "observation" as const,
          rendered: obs,
        });
      }
      result.push({
        ts: nowMs + 1,
        kind: "context",
        rendered: "--- end observations ---",
      });
    }

    return result;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// PeripheralTimelineSource — адаптер социальной периферии
// ═══════════════════════════════════════════════════════════════════════════
// @see docs/adr/121-social-peripheral-vision/README.md

/** Конфигурация социальной периферии. */
export interface PeripheralVisionConfig {
  contactId: string;
  contactName: string;
  currentChat: string;
  /** Общие не-личные каналы Map<channelId, displayName>. */
  sharedChats: Map<string, string>;
  /** Максимум записей на канал. */
  perChannelCap: number;
  /** Общий максимум записей. */
  totalCap: number;
  /** Временное окно (секунды). */
  windowS: number;
  /** Минимальная длина текста. */
  minTextLength: number;
}

/** Строка из DB — суженный подтип используется на этапе фильтрации. */
interface PeripheralRow {
  chatId: string;
  text: string | null;
  msgId: number;
  createdAt: Date;
  senderName: string | null;
}

/** text сужен через type guard до непустого значения. */
type ValidPeripheralRow = PeripheralRow & { text: string };

export class PeripheralTimelineSource implements TimelineSource {
  constructor(private readonly config: PeripheralVisionConfig) {}

  entries(_target: string, _sinceMs: number, nowMs: number): TimelineEntry[] {
    // Барьер приватности: нет общих каналов или окно = 0 → не активировать
    if (this.config.sharedChats.size === 0 || this.config.windowS <= 0) return [];

    const sinceMs = nowMs - this.config.windowS * 1000;

    let rows: PeripheralRow[];
    try {
      rows = getPeripheralMessages(
        this.config.contactId,
        sinceMs,
        this.config.currentChat,
        this.config.totalCap * 3, // over-fetch для компенсации фильтрации на прикладном уровне
      );
    } catch {
      // DB недоступна — молча деградировать (по аналогии с паттерном Formative Memories)
      return [];
    }

    // Фильтрация на прикладном уровне + сужение типа text → string
    const filtered = rows.filter(
      (r): r is ValidPeripheralRow =>
        typeof r.text === "string" &&
        r.text.length >= this.config.minTextLength &&
        this.config.sharedChats.has(r.chatId),
    );
    if (filtered.length === 0) return [];

    // Двухуровневый cap: K на канал + M глобально
    const capped = this.applyCaps(filtered);
    if (capped.length === 0) return [];

    // getPeripheralMessages возвращает DESC, перевернуть в ASC
    capped.reverse();

    return this.renderBlock(capped);
  }

  /** Усечение по perChannelCap на канал + totalCap глобально. */
  private applyCaps(rows: ValidPeripheralRow[]): ValidPeripheralRow[] {
    const counts = new Map<string, number>();
    const result: ValidPeripheralRow[] = [];
    for (const row of rows) {
      const n = counts.get(row.chatId) ?? 0;
      if (n >= this.config.perChannelCap) continue;
      counts.set(row.chatId, n + 1);
      result.push(row);
      if (result.length >= this.config.totalCap) break;
    }
    return result;
  }

  /** Рендеринг в разделённый блок временной линии: заголовочный маркер → сообщения → завершающий маркер. */
  private renderBlock(rows: ValidPeripheralRow[]): TimelineEntry[] {
    const { contactName, sharedChats } = this.config;
    const firstTs = rows[0].createdAt.getTime();
    const lastTs = rows[rows.length - 1].createdAt.getTime();

    const header: TimelineEntry = {
      ts: firstTs - 1,
      kind: "context",
      rendered: `--- peripheral: what ${contactName} has been up to ---`,
    };
    const footer: TimelineEntry = {
      ts: lastTs + 1,
      kind: "context",
      rendered: "--- end peripheral ---",
    };

    const messages = rows.map((row): TimelineEntry => {
      const label = sharedChats.get(row.chatId) ?? row.chatId;
      const text = row.text.length > 150 ? `${row.text.slice(0, 147)}...` : row.text;
      const name = row.senderName ?? contactName;
      return {
        ts: row.createdAt.getTime(),
        kind: "message",
        rendered: `${name} in ${label}: "${text}"`,
      };
    });

    return [header, ...messages, footer];
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Слияние + инъекция Gap + рендеринг
// ═══════════════════════════════════════════════════════════════════════════

/** 30 минут молчания → маркер gap. Соответствует порогу conversation break из ADR-85 D3. */
const GAP_THRESHOLD_MS = 30 * 60_000;

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** Форматирование настенного времени — h:MM AM/PM, удобно для восприятия LLM. */
function formatTime(ts: number, timezoneOffset?: number): string {
  // ADR-34: Использовать настроенный часовой пояс, а не системный
  // Сдвигаем UTC-метку к локальному времени пользователя, затем отображаем в часовом поясе UTC
  const adjustedTs = timezoneOffset != null ? ts + timezoneOffset * 60 * 60 * 1000 : ts;
  return new Date(adjustedTs).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: "UTC",
  });
}

/** Человекочитаемая метка относительного времени. */
function relativeLabel(deltaMs: number): string {
  const min = Math.round(deltaMs / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `~${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `~${hr}h ago`;
  const days = Math.round(hr / 24);
  return `~${days}d ago`;
}

/** Форматирование длительности — используется совместно в маркерах gap и tail gap. */
function formatDuration(ms: number): string {
  const min = ms / 60_000;
  return min >= 120 ? `${Math.round(min / 60)}h` : `${Math.round(min)}m`;
}

/**
 * Разделитель смены дня в стиле IRC + инъекция хвостового gap.
 *
 * Настоящие IRC-клиенты вставляют при смене даты:
 *   --- Day changed to Wednesday March 12 ---
 *
 * Также обнаруживает хвостовое молчание между последней записью и nowMs,
 * чтобы LLM знал, сколько прошло с последнего сообщения до текущего момента.
 */
function injectDayChangesAndTailGap(entries: TimelineEntry[], nowMs: number): TimelineEntry[] {
  if (entries.length === 0) return entries;

  function dayKey(ts: number): string {
    const d = new Date(ts);
    return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
  }
  function dayLabel(ts: number): string {
    const d = new Date(ts);
    return `${DAY_NAMES[d.getDay()]} ${MONTH_NAMES[d.getMonth()]} ${d.getDate()}`;
  }

  const result: TimelineEntry[] = [];
  let prevDay = "";

  for (const e of entries) {
    // Записи gap/context не триггерят смену дня (они структурные маркеры, а не временные события)
    if (e.kind !== "gap" && e.kind !== "context") {
      const dk = dayKey(e.ts);
      if (dk !== prevDay) {
        // Вставить day marker даже перед первой записью (чтобы LLM знал, к какому дню относятся сообщения)
        result.push({
          ts: e.ts - 1,
          kind: "context",
          rendered: `--- Day changed to ${dayLabel(e.ts)} ---`,
        });
        prevDay = dk;
      }
    }
    result.push(e);
  }

  // Хвостовой gap: последняя содержательная запись → nowMs
  const lastContent = result.findLast((e) => e.kind !== "gap" && e.kind !== "context");
  if (lastContent) {
    const tailGapMs = nowMs - lastContent.ts;
    if (tailGapMs >= GAP_THRESHOLD_MS) {
      result.push({
        ts: nowMs - 1,
        kind: "gap",
        rendered: `--- ${formatDuration(tailGapMs)} since last message ---`,
      });
    }
  }

  return result;
}

/**
 * Инъекция gap на уровне временной линии — обнаружение молчания ≥30 мин между любыми соседними записями.
 *
 * В отличие от старой реализации (MessageTimelineSource обнаруживал только gap между сообщениями),
 * здесь операция производится на глобальной временной линии после сортировки слиянием —
 * временные разрывы между сообщениями, мыслями, действиями и наблюдениями фиксируются все.
 *
 * @see docs/adr/118-unified-timeline.md §2.2
 */
function injectGaps(entries: TimelineEntry[]): TimelineEntry[] {
  if (entries.length < 2) return entries;
  const result: TimelineEntry[] = [entries[0]];
  for (let i = 1; i < entries.length; i++) {
    const prev = entries[i - 1];
    const curr = entries[i];
    const gapMs = curr.ts - prev.ts;
    if (gapMs >= GAP_THRESHOLD_MS) {
      result.push({
        ts: curr.ts - 1,
        kind: "gap",
        rendered: `--- ${formatDuration(gapMs)} gap ---`,
      });
    }
    result.push(curr);
  }
  return result;
}

/**
 * Сортировка слиянием из нескольких источников + инъекция gap.
 *
 * Реализация T(v, [t₀, t]) = sort_τ(M ∪ R ∪ S ∪ O) из документации:
 * 1. Collect — собрать записи из каждого source
 * 2. Sort — отсортировать по ts по возрастанию
 * 3. Enrich — внедрить межисточниковые маркеры gap
 *
 * @see docs/adr/118-unified-timeline.md §3.3
 */
export function buildTimeline(
  sources: TimelineSource[],
  target: string,
  sinceMs: number,
  nowMs: number,
): TimelineEntry[] {
  const entries: TimelineEntry[] = [];
  for (const source of sources) {
    entries.push(...source.entries(target, sinceMs, nowMs));
  }
  entries.sort((a, b) => a.ts - b.ts);
  const withGaps = injectGaps(entries);
  return injectDayChangesAndTailGap(withGaps, nowMs);
}

/**
 * Рендеринг временной линии в строки текста с нулевым отступом.
 *
 * Единый временной хребет: содержательные записи (message/thought/action/observation) получают префикс [HH:MM],
 * структурные записи (gap/context) — нет: они визуальные разделители, а не контент.
 *
 * Если передан nowMs и сообщение старше ≥30 мин, добавляется метка относительного времени (вдохновлено IRC):
 *   [11:21, ~8h ago] Bob: hello
 * Это позволяет LLM чувствовать временную дистанцию при чтении каждой строки, без кросс-сегментного вывода.
 *
 * @see docs/adr/141-prompt-style-spec.md — спецификация нулевого отступа
 */
export function renderTimeline(
  entries: TimelineEntry[],
  nowMs?: number,
  timezoneOffset?: number,
): string[] {
  return entries.map((e) => {
    if (e.kind === "gap" || e.kind === "context") {
      return e.rendered;
    }
    const time = formatTime(e.ts, timezoneOffset);
    // Добавлять относительную метку только при ≥30 мин — к свежим сообщениям шум не нужен
    if (nowMs != null && nowMs - e.ts >= GAP_THRESHOLD_MS) {
      return `[${time}, ${relativeLabel(nowMs - e.ts)}] ${e.rendered}`;
    }
    return `[${time}] ${e.rendered}`;
  });
}
