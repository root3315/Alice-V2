/**
 * Commitment Mod — «follow-through» по обещаниям и мягким срокам.
 *
 * Идея (её SOUL: «обещание, данное в прошлый раз, ненадолго задерживается в ней»): когда кто-то —
 * человек или она сама — обронил намерение с мягким «когда» («я отправлю фикс в пятницу»,
 * «завтра экзамен», «позвоню маме на выходных»), Алиса это ЗАМЕЧАЕТ и фиксирует. Когда мягкий срок
 * проходит, она САМА, своим голосом, ненавязчиво возвращается к этому в том же чате: «ну как, отправил
 * тот фикс?», «как экзамен прошёл?». Это переносит кусочек жизни человека между разговорами.
 *
 * Зеркалит существующие behavior-моды (digest / health-watch / dev-offer / exploration):
 *  - CAPTURE: LLM-инструкция `note_commitment({ who, what, when })` (как note/note_kb/schedule_task) —
 *    мягкая affordance «когда кто-то говорит, что сделает X к какому-то сроку, или упоминает событие».
 *    Мягкое «когда» парсится ЧИСТОЙ функцией parseSoftWhen (относительное ок: завтра/в пятницу/на выходных).
 *  - contribute() — СТРОГО ЧИСТЫЙ: только читает список и (если давление в этот чат уже поднято)
 *    отдаёт ОДНУ тихую контекст-заметку, чтобы она спросила СВОИМИ словами. Ничего не мутирует.
 *  - onTickEnd — ВСЕ мутации: когда softWhenMs прошёл (+ grace), поднять направленное давление на ЭТОТ
 *    чат и пометить «созрело»; ONE-TOUCH — спросить ОДИН раз, затем resolved/decay (SOUL: «спросить
 *    один раз достаточно… она не стоит в проёме»); TTL-чистка протухших.
 *
 * Принцип честности и сдержанности: мод НЕ меняет её голос и ничего не формулирует за неё — он лишь
 * ДОБАВЛЯЕТ повод заметить (аддитивный контекст + лёгкое хранилище намерений). Спросить, как именно
 * и стоит ли вообще — целиком её когниция. Не cron (это softer/intention-based, дополняет scheduler.mod).
 */
import { z } from "zod";

import { createMod } from "../core/mod-builder.js";
import { PromptBuilder } from "../core/prompt-style.js";
import type { ContributionItem } from "../core/types.js";
import { header, readModState } from "../core/types.js";
import { ensureChannelId } from "../graph/constants.js";
import { resolveDisplayName, safeDisplayName } from "../graph/display.js";
import type { WorldModel } from "../graph/world-model.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("commitment");

// -- Константы ---------------------------------------------------------------

/** Максимальная длина описания обещания. */
const MAX_WHAT_LENGTH = 200;
/** Максимальная длина исходного текста «когда» (для парса). */
const MAX_WHEN_LENGTH = 80;

/** Потолок числа живых обещаний (защита от бесконечного накопления LLM). */
const MAX_COMMITMENTS = 40;

/**
 * Grace после мягкого срока: не дёргаем ровно в секунду «пятницы», даём сроку реально пройти
 * (мягкое «когда» — это про «к этому времени», а не «ровно в»). 3 часа.
 */
export const RESURFACE_GRACE_MS = 3 * 60 * 60_000;

/**
 * TTL «созревшего, но так и не спрошенного» — если момент всё не наступал (она молчала / был не тот
 * чат), не висим вечно: спустя это окно тихо отпускаем (decay). 3 суток.
 */
export const RESURFACE_TTL_MS = 3 * 24 * 60 * 60_000;

/**
 * TTL «спрошенного» (asked) — после one-touch держим короткий след, чтобы не задать тот же вопрос
 * повторно на соседних тиках, потом убираем. 12 часов.
 */
export const ASKED_TTL_MS = 12 * 60 * 60_000;

/**
 * Защитный потолок дальности мягкого срока: если парс дал что-то дальше — обрезаем (намерения с
 * горизонтом в месяцы — это не «follow-through», это KB/scheduler). 60 суток.
 */
const MAX_HORIZON_MS = 60 * 24 * 60 * 60_000;

// -- Состояние Mod -----------------------------------------------------------

/** Статус обещания в его коротком жизненном цикле. */
export type CommitmentStatus =
  /** Зафиксировано, мягкий срок ещё не прошёл — просто ждём. */
  | "pending"
  /** Срок прошёл (+grace) — давление на чат поднято, ждём, пока она спросит (TTL-окно). */
  | "ripe"
  /** Уже спросила один раз (one-touch) — короткий след, потом decay. */
  | "asked";

/** Одно зафиксированное намерение с мягким сроком. Только JSON-сериализуемые поля (persist в mod-state). */
export interface Commitment {
  /** Уникальный id (для дедупа и адресной пометки). */
  id: string;
  /** Кто: graph nodeId ('self' = сама Алиса, contact:* = человек) либо сырая метка, если не разрешилось. */
  who: string;
  /** Короткое человекочитаемое «что» (как было сказано). */
  what: string;
  /** Мягкое «когда» в мс (распарсенное); 0 → не удалось распарсить (висит до TTL как pending). */
  softWhenMs: number;
  /** Чат (graph channel nodeId), где это прозвучало — туда же она и вернётся. null → нет привязки. */
  chatId: string | null;
  /** Когда зафиксировано (мс). */
  createdMs: number;
  /** Статус жизненного цикла. */
  status: CommitmentStatus;
  /** Направленное давление на chatId уже поднято (как digest/health-watch .directed). */
  directed?: boolean;
  /** Когда стало ripe (мс) — для TTL «созревшего». */
  ripeMs?: number;
  /** Когда спросила (мс) — для ASKED_TTL. */
  askedMs?: number;
}

interface CommitmentState {
  /** Лёгкий список живых обещаний (восстанавливается из DB как у прочих модов). */
  commitments: Commitment[];
}

// -- Парс мягкого «когда» (ЧИСТАЯ функция) -----------------------------------

const DAY_MS = 24 * 60 * 60_000;

/** Дни недели (рус), индекс = JS Date.getDay() (0=вс). Несколько форм/опечаток. */
const WEEKDAYS_RU: Record<string, number> = {
  воскресень: 0,
  вс: 0,
  понедельник: 1,
  пн: 1,
  вторник: 2,
  вт: 2,
  сред: 3,
  ср: 3,
  четверг: 4,
  чт: 4,
  пятниц: 5,
  пт: 5,
  суббот: 6,
  сб: 6,
};

/** Начало следующего дня (локальная полночь+1) от заданного момента. */
function startOfNextDay(nowMs: number, days: number): number {
  const d = new Date(nowMs);
  d.setHours(0, 0, 0, 0);
  return d.getTime() + days * DAY_MS;
}

/**
 * Разобрать мягкое «когда» в абсолютный мс (приблизительно — это soft when, а не дедлайн).
 * Относительные формы ок: «завтра», «послезавтра», «в пятницу», «на выходных», «через 2 дня»,
 * «на следующей неделе», «вечером», «сегодня». Не разобралось → 0 (caller решает: висеть pending).
 *
 * ЧИСТАЯ и тестируемая: всё от явных аргументов (text + nowMs), без Date.now()/глобалок.
 */
export function parseSoftWhen(rawWhen: string, nowMs: number): number {
  const text = (rawWhen ?? "").toLowerCase().trim();
  if (!text) return 0;

  // «через N дней/недель/часов» — относительное смещение.
  const inMatch = text.match(/через\s+(\d+)\s*(час|дн|нед)/);
  if (inMatch) {
    const n = Number(inMatch[1]);
    const unit = inMatch[2];
    if (unit === "час") return clampHorizon(nowMs, nowMs + n * 60 * 60_000);
    if (unit === "нед") return clampHorizon(nowMs, startOfNextDay(nowMs, 1) + (n * 7 - 1) * DAY_MS);
    return clampHorizon(nowMs, startOfNextDay(nowMs, n)); // дни
  }

  // «послезавтра».
  if (/послезавтра/.test(text)) return clampHorizon(nowMs, startOfNextDay(nowMs, 2));

  // «завтра» (+ опц. «утром/вечером» оставляем как начало дня — soft).
  if (/завтра/.test(text)) return clampHorizon(nowMs, startOfNextDay(nowMs, 1));

  // «на выходных» / «в выходные» — ближайшая суббота (если уже сб/вс — текущие выходные → не назад).
  if (/выходн/.test(text)) {
    return clampHorizon(nowMs, nextWeekday(nowMs, 6, /* includeToday */ true));
  }

  // «на следующей неделе» / «на той неделе» — следующий понедельник.
  // (\w не матчит кириллицу в JS — сопоставляем «след…недел» через .* до «недел».)
  if (/след\S*\s+недел|на\s+той\s+недел/.test(text)) {
    return clampHorizon(nowMs, nextWeekday(nowMs, 1, /* includeToday */ false));
  }

  // День недели: «в пятницу», «к пятнице», «в пт» — ближайший этот день недели (строго вперёд).
  for (const [stem, dow] of Object.entries(WEEKDAYS_RU)) {
    if (text.includes(stem)) {
      return clampHorizon(nowMs, nextWeekday(nowMs, dow, /* includeToday */ false));
    }
  }

  // «сегодня вечером» / «вечером» / «сегодня» — конец текущего дня (soft).
  if (/вечер|сегодня|ночью|к\s+ночи/.test(text)) {
    return clampHorizon(nowMs, startOfNextDay(nowMs, 1) - 1);
  }

  return 0; // не распознали — пусть висит pending (caller решит)
}

/** Ближайший указанный день недели вперёд (или сегодня, если includeToday и сегодня тот день). */
function nextWeekday(nowMs: number, targetDow: number, includeToday: boolean): number {
  const today = new Date(nowMs).getDay();
  let delta = (targetDow - today + 7) % 7;
  if (delta === 0 && !includeToday) delta = 7;
  return startOfNextDay(nowMs, delta);
}

/** Обрезать горизонт: не в прошлое и не дальше MAX_HORIZON_MS. */
function clampHorizon(nowMs: number, whenMs: number): number {
  if (whenMs <= nowMs) return 0;
  if (whenMs - nowMs > MAX_HORIZON_MS) return nowMs + MAX_HORIZON_MS;
  return whenMs;
}

// -- ЧИСТЫЕ функции жизненного цикла (тестируемые) ---------------------------

/**
 * Какие обещания «созрели» к тому, чтобы о них спросить (срок прошёл + grace, ещё не спрошено).
 * ЧИСТАЯ: вход — список + now, выход — подмножество. Без мутаций.
 */
export function dueCommitments(list: Commitment[], nowMs: number): Commitment[] {
  return list.filter(
    (c) =>
      c.status !== "asked" &&
      c.softWhenMs > 0 &&
      nowMs - c.softWhenMs >= RESURFACE_GRACE_MS,
  );
}

/**
 * TTL/decay-чистка: убрать протухшие. ЧИСТАЯ — возвращает НОВЫЙ отфильтрованный список.
 *  - asked старше ASKED_TTL_MS → отпускаем (след сделал своё дело);
 *  - ripe старше RESURFACE_TTL_MS → отпускаем (момент так и не настал, не висим вечно);
 *  - pending с нераспарсенным сроком (softWhenMs=0) старше RESURFACE_TTL_MS → отпускаем.
 */
export function pruneCommitments(list: Commitment[], nowMs: number): Commitment[] {
  return list.filter((c) => {
    if (c.status === "asked") return nowMs - (c.askedMs ?? c.createdMs) < ASKED_TTL_MS;
    if (c.status === "ripe") return nowMs - (c.ripeMs ?? c.createdMs) < RESURFACE_TTL_MS;
    // pending: если срок не распарсился — тоже не висим дольше TTL.
    if (c.softWhenMs <= 0) return nowMs - c.createdMs < RESURFACE_TTL_MS;
    return true; // pending с валидным будущим сроком — ждём.
  });
}

// -- Вспомогательное (направленное давление; зеркало digest/health-watch) ----

/** Поднять направленное давление на чат обещания. true = канал есть в графе. */
function bumpDirected(graph: WorldModel, chatId: string): boolean {
  try {
    if (graph.has(chatId)) {
      const cur = Number(
        (graph.getChannel(chatId) as { pending_directed?: number }).pending_directed ?? 0,
      );
      if (cur <= 0) {
        graph.updateChannel(chatId, { pending_directed: 1, last_directed_ms: Date.now() });
      }
      return true;
    }
  } catch (err) {
    log.warn("directed bump failed", { chatId, err: (err as Error).message });
  }
  return false; // канала ещё нет в графе → повторим на следующем onTickEnd
}

/** Человекочитаемое «кто» для контекст-заметки (без raw ID; 'self' → «ты сама»). */
function whoLabel(graph: WorldModel, who: string): string {
  if (who === "self") return "ты сама";
  return safeDisplayName(graph, who);
}

let _idCounter = 0;
function nextCommitmentId(): string {
  return `cmt_${_idCounter++}_${Date.now()}`;
}

// -- Определение Mod ---------------------------------------------------------

export const commitmentMod = createMod<CommitmentState>("commitment", {
  category: "mechanic",
  description:
    "Follow-through по обещаниям: замечает намерения с мягким сроком и сама ненавязчиво возвращается к ним, когда срок прошёл",
  depends: ["relationships"],
  topics: ["memory"],
  initialState: { commitments: [] },
})
  // CAPTURE: LLM зовёт, когда заметила обещание/намерение с мягким сроком (как note/note_kb).
  .instruction("note_commitment", {
    deriveParams: {
      // Если LLM не указал «кто» — по умолчанию текущий контакт разговора (как note → TARGET_CONTACT).
      who: (cv: Record<string, unknown>) => cv.TARGET_CONTACT,
    },
    params: z.object({
      who: z
        .string()
        .trim()
        .min(1)
        .describe("Кто пообещал: имя контакта / 'self' (сама Алиса)"),
      what: z
        .string()
        .trim()
        .min(1)
        .max(MAX_WHAT_LENGTH)
        .describe("Что именно пообещал/что за событие (коротко, как сказано)"),
      when: z
        .string()
        .trim()
        .min(1)
        .max(MAX_WHEN_LENGTH)
        .describe("Мягкое «когда» как сказано ('в пятницу', 'завтра', 'на выходных', 'через 2 дня')"),
    }),
    perTurnCap: 3,
    description:
      "Запомнить чьё-то намерение с мягким сроком, чтобы потом по-человечески спросить, как оно. Срок относительный — ок.",
    examples: [
      'note_commitment({ who: "self", what: "отправить фикс", when: "в пятницу" })',
      'note_commitment({ who: "Маша", what: "экзамен", when: "завтра" })',
    ],
    affordance: {
      priority: "capability",
      category: "memory",
      whenToUse:
        "When someone (or you) says they'll do X by some soft time, or mentions an upcoming event ('я отправлю в пятницу', 'завтра экзамен', 'позвоню маме на выходных') — capture it to follow up later",
      whenNotToUse:
        "For hard timed reminders/cron (use schedule_task), durable facts (note_kb), or plain observations (note)",
    },
    impl(ctx, args) {
      const rawWho = String(args.who);
      const who = resolveDisplayName(ctx.graph, rawWho) ?? rawWho;
      const what = String(args.what);
      const softWhenMs = parseSoftWhen(String(args.when), ctx.nowMs);

      // Чат, где это прозвучало — текущая цель действия (как source_channel у note).
      const relState = readModState(ctx, "relationships");
      const targetNode = relState?.targetNodeId ?? null;
      const chatId = targetNode ? (ensureChannelId(targetNode) ?? targetNode) : null;

      // Дедуп (нестрого): тот же who + похожее what ещё живо → не плодим.
      const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
      const dup = ctx.state.commitments.find(
        (c) => c.who === who && norm(c.what) === norm(what) && c.status !== "asked",
      );
      if (dup) {
        // Освежаем срок (могли уточнить «когда») и оставляем жить.
        if (softWhenMs > 0) dup.softWhenMs = softWhenMs;
        return { success: true, isDuplicate: true, commitmentId: dup.id, parsedWhen: dup.softWhenMs };
      }

      const id = nextCommitmentId();
      ctx.state.commitments.push({
        id,
        who,
        what,
        softWhenMs,
        chatId,
        createdMs: ctx.nowMs,
        status: "pending",
      });

      // Потолок ёмкости: вытесняем самое старое.
      if (ctx.state.commitments.length > MAX_COMMITMENTS) {
        ctx.state.commitments.sort((a, b) => a.createdMs - b.createdMs);
        ctx.state.commitments.shift();
      }

      log.info("commitment captured", { who, what, parsed: softWhenMs > 0, chatId });
      return { success: true, isDuplicate: false, commitmentId: id, parsedWhen: softWhenMs };
    },
  })
  // contribute() — СТРОГО ЧИСТЫЙ: только читает. Surf-ит ТОЛЬКО созревшие (directed) обещания,
  // привязанные к ТЕКУЩЕМУ чату действия (нет межчат-утечки), и просит спросить её словами.
  .contribute((ctx): ContributionItem[] => {
    const relState = readModState(ctx, "relationships");
    const target = relState?.targetNodeId ?? null;
    if (!target) return [];
    const targetChat = ensureChannelId(target) ?? target;

    const ready = ctx.state.commitments.filter(
      (c) => c.status === "ripe" && c.directed === true && c.chatId === targetChat,
    );
    if (ready.length === 0) return [];

    const lines = ready
      .map((c) => `— ${whoLabel(ctx.graph, c.who)}: «${c.what}» (срок к этому моменту уже прошёл)`)
      .join("\n");
    const raw = [
      "## Кое-что обещанное в прошлый раз",
      "",
      "В прошлый раз в этом чате прозвучало намерение с мягким сроком, и срок уже прошёл. " +
        "Если по-человечески к месту — мягко, своими словами, поинтересуйся, как оно " +
        "(«ну как, отправил тот фикс?», «как экзамен прошёл?»). Без напора и без отчётности:",
      lines,
      "",
      "Спросить достаточно ОДИН раз: не выйдет к месту — просто промолчи, навязываться не нужно.",
    ].join("\n");
    return [header(PromptBuilder.fromRaw(raw), 83)];
  })
  // Жизненный цикл (ВСЕ мутации): pending→ripe по сроку, направленное давление, one-touch, TTL.
  .onTickEnd((ctx) => {
    const now = ctx.nowMs;

    // 1. Созревание: pending, чей мягкий срок прошёл (+grace) → ripe (фиксируем ripeMs для TTL).
    for (const c of dueCommitments(ctx.state.commitments, now)) {
      if (c.status === "pending") {
        c.status = "ripe";
        c.ripeMs = now;
        c.directed = false;
        log.info("commitment ripe → resurface", { id: c.id, who: c.who });
      }
    }

    // 2. Направленное давление на чат каждого созревшего (пока не поднято и есть привязка к чату).
    for (const c of ctx.state.commitments) {
      if (c.status === "ripe" && !c.directed && c.chatId) {
        c.directed = bumpDirected(ctx.graph, c.chatId);
      }
    }

    // 3. ONE-TOUCH: если в её последних действиях есть исходящее в этот чат ПОСЛЕ созревания —
    //    считаем, что спросила (или сознательно промолчала к месту). Помечаем asked, давление спадает
    //    естественно. Так мы не дёргаем повторно (SOUL: «спросить один раз достаточно»).
    //    Сигнал «она действовала в этом чате» берём из graph-атрибута last_alice_action_ms канала.
    for (const c of ctx.state.commitments) {
      if (c.status !== "ripe" || !c.chatId) continue;
      if (!ctx.graph.has(c.chatId)) continue;
      const lastActionMs = Number(
        (ctx.graph.getChannel(c.chatId) as { last_alice_action_ms?: number }).last_alice_action_ms ??
          0,
      );
      if (lastActionMs > 0 && lastActionMs >= (c.ripeMs ?? 0)) {
        c.status = "asked";
        c.askedMs = now;
        log.info("commitment asked (one-touch) → decay", { id: c.id, who: c.who });
      }
    }

    // 4. TTL / decay-чистка протухших (asked-след, не настигшие ripe, нераспарсенные pending).
    ctx.state.commitments = pruneCommitments(ctx.state.commitments, now);
  })
  .build();
