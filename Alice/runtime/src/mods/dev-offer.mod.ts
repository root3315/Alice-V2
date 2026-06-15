/**
 * Dev-Offer Mod — ОЧЕНЬ сдержанная проактивная детекция «тут нужен код».
 *
 * Идея: когда в РАБОЧЕМ чате (работач, OPS_CHANNEL_ID) проскакивает СИЛЬНЫЙ сигнал
 * code-need — стек-трейс, «это сломано / баг», «ревью бы не помешало» — этот mod
 * подкидывает В КОНТЕКСТ Алисе ОДНУ тихую низкоприоритетную заметку («можешь к месту
 * предложить глянуть код»). Это ровно affordance из worki.code_ask, но не как сама
 * инструкция, а как мягкий контекстный нудж: «есть к чему предложить помощь».
 *
 * ВАЖНО (HARD RULE): mod НИЧЕГО не отправляет и ничего не решает. Он только ДОБАВЛЯЕТ
 * контекст; предлагать или молчать — целиком решает её когниция/сдержанность. Личность,
 * голос, IAUS/анти-монолог не трогаются и НЕ обходятся.
 *
 * ГЕЙТЫ (нужны ВСЕ, иначе молчим):
 *  1. только РАБОЧИЙ чат (OPS_CHANNEL_ID); вне его — mod выключен;
 *  2. per-chat кулдаун >= 30 мин (заметку подкидываем максимум раз в полчаса на чат);
 *  3. уважение существующей сдержанности — НЕ инжектим при срочном directed-обязательстве
 *     (как consolidation) и НЕ инжектим, если Алиса сейчас монологизирует (есть хвост её
 *     собственных подряд идущих сообщений) — это её анти-монолог, его НЕ обходим;
 *  4. только СИЛЬНЫЙ сигнал в свежем ВХОДЯЩЕМ (не её) сообщении, на который она ещё не
 *     ответила (после сигнала нет её исходящих);
 *  5. крен В МОЛЧАНИЕ: при любой неоднозначности — ничего не подкидываем.
 *
 * Зеркалит паттерны consolidation.mod (gate по hasObligation в contribute) и worki.mod
 * (чистый contribute, мутации состояния в onTickEnd; section()/PromptBuilder; .build()).
 */
import { createMod } from "../core/mod-builder.js";
import { PromptBuilder } from "../core/prompt-style.js";
import type { ContributionItem } from "../core/types.js";
import { readModState, section } from "../core/types.js";
import { getRecentMessagesByChat } from "../db/queries.js";
import { hasObligation, OBLIGATION_THRESHOLDS } from "../pressure/signal-decay.js";

// -- Константы ---------------------------------------------------------------

/** Рабочий чат (работач). Не задан → mod полностью выключен (поведение как раньше). */
const OPS_CHANNEL_ID = process.env.OPS_CHANNEL_ID;

/** Per-chat кулдаун: не чаще раза в 30 минут подкидываем заметку (анти-спам). */
const COOLDOWN_MS = 30 * 60_000;

/** Сколько последних сообщений чата смотрим на наличие сигнала. */
const MESSAGE_SCAN_LIMIT = 12;

/** Окно «сигнал ещё свежий»: старше — не реагируем (крен в молчание). 20 минут. */
const SIGNAL_FRESHNESS_MS = 20 * 60_000;

/** Минимальная длина текста-сигнала — короткие реплики игнорируем (шум/ack). */
const MIN_SIGNAL_LEN = 12;

/**
 * СИЛЬНЫЕ сигналы code-need. Узкий, осознанно консервативный список:
 *  - стек-трейсы / трейсбэки / явные исключения с местом падения;
 *  - прямые «это сломано / баг / падает / не работает»;
 *  - явная просьба про ревью кода.
 * Слабые намёки («что-то медленно», «странно как-то») НЕ ловим — крен в молчание.
 */
const STRONG_SIGNALS: RegExp[] = [
  // Стек-трейсы / трейсбэки (Node/Python/JVM/общее)
  /\bstack\s?trace\b/i,
  /\btraceback\b/i,
  /трейс(?:бэк)?/i,
  /\b(?:at\s+[\w.$<>]+\s*\([^)]*:\d+:\d+\))/i, // at fn (file.ts:12:3)
  /\b\w[\w./-]+\.(?:ts|tsx|js|jsx|py|java|go|rs|rb):\d+(?::\d+)?\b/i, // file.ts:42:7
  /\b(?:Error|Exception|TypeError|ReferenceError|SyntaxError|RuntimeError|NullPointerException|panic):/,
  /\bunhandled\s+(?:rejection|exception)\b/i,
  /\bexit\s+code\s+[1-9]\d*\b/i,

  // Прямые «сломано / баг» (рус + англ), как в affordance worki.code_ask
  /это\s+сломан/i,
  /\bсломал(?:ось|и|о|ся)\b/i,
  /\b(?:баг|багу|бага|баги)\b/i,
  /\bbug\b/i,
  /\bпадает\b|\bупал[оа]?\b|\bкрашит/i,
  /\bне\s+(?:работает|пашет|собирается|компилит)/i,
  /\bпочему\s+не\s+работает/i,
  /\bregression\b|\bрегресси/i,
  /\bcrash(?:e[ds]|ing)?\b/i,

  // Просьба про ревью кода
  /ревью\s+(?:бы|кода|не\s+помешал)/i,
  /\bcode\s?review\b/i,
  /глянь.*\bкод\b|\bкод\b.*глянь/i,
  /посмотр(?:и|еть).*\bкод\b/i,
];

// -- Состояние Mod -----------------------------------------------------------

interface DevOfferState {
  /** Время последней подкинутой заметки по чату (графовый id канала → ms). */
  lastOfferMsByChat: Record<string, number>;
}

// -- Вспомогательное ---------------------------------------------------------

/** Есть ли в тексте СИЛЬНЫЙ сигнал code-need? */
function hasStrongSignal(text: string): boolean {
  if (text.length < MIN_SIGNAL_LEN) return false;
  return STRONG_SIGNALS.some((re) => re.test(text));
}

/**
 * Решает по последним сообщениям рабочего чата, есть ли СВЕЖИЙ сигнал, на который она
 * ещё НЕ ответила, и при этом она сейчас НЕ монологизирует (нет хвоста её исходящих).
 * Чистое чтение БД, без мутаций.
 */
function detectFreshUnansweredSignal(
  chatId: string,
  nowMs: number,
): { found: boolean; trailingYours: number } {
  let rows: ReturnType<typeof getRecentMessagesByChat>;
  try {
    rows = getRecentMessagesByChat(chatId, MESSAGE_SCAN_LIMIT);
  } catch {
    // БД недоступна — молча деградируем (крен в молчание).
    return { found: false, trailingYours: 0 };
  }
  if (rows.length === 0) return { found: false, trailingYours: 0 };

  // Анти-монолог: сколько её собственных сообщений подряд в хвосте. Это её сдержанность —
  // если она уже наговорила, НЕ подталкиваем к ещё одной реплике.
  let trailingYours = 0;
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i].isOutgoing) trailingYours++;
    else break;
  }

  // Идём с конца: ищем последний СИЛЬНЫЙ сигнал во ВХОДЯЩЕМ сообщении. Если до него (ближе
  // к хвосту) есть её исходящее — значит она уже отреагировала на этот участок, не лезем.
  let sawOutgoingAfter = false;
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    if (r.isOutgoing) {
      sawOutgoingAfter = true;
      continue;
    }
    if (sawOutgoingAfter) continue; // на это уже была её реакция
    const ageMs = nowMs - r.createdAt.getTime();
    if (ageMs > SIGNAL_FRESHNESS_MS) break; // глубже только старее → крен в молчание
    if (hasStrongSignal(r.text ?? "")) {
      return { found: true, trailingYours };
    }
  }
  return { found: false, trailingYours };
}

// -- Определение Mod ---------------------------------------------------------

export const devOfferMod = createMod<DevOfferState>("dev_offer", {
  category: "mechanic",
  description:
    "Очень сдержанный нудж: при сильном code-need сигнале в рабочем чате тихо предложить контекст «можешь предложить глянуть код» (решает её когниция)",
  topics: ["worki"],
  initialState: { lastOfferMsByChat: {} },
})
  // contribute() — ЧИСТЫЙ: только читает и (если все гейты прошли) отдаёт ОДНУ тихую заметку.
  // Мутация кулдауна — в onTickEnd (как у worki/consolidation: contribute без побочных эффектов).
  .contribute((ctx): ContributionItem[] => {
    // Гейт 1: фича включена только при заданном рабочем чате.
    if (!OPS_CHANNEL_ID) return [];

    // Гейт 1 (scope): подсказываем ТОЛЬКО когда тик идёт в рабочем чате. targetNodeId из
    // relationships mod = текущая цель действия; вне работача — молчим (нет межчат-утечки).
    const relState = readModState(ctx, "relationships");
    const target = relState?.targetNodeId ?? null;
    if (target !== OPS_CHANNEL_ID) return [];

    // Гейт 3a: уважаем существующую сдержанность — при срочном directed-обязательстве
    // (её ждут с ответом) не лезем с housekeeping-нуджами (как consolidation, ADR-124).
    if (hasObligation(ctx.graph, OPS_CHANNEL_ID, ctx.nowMs, OBLIGATION_THRESHOLDS.signal)) {
      return [];
    }

    // Гейт 2: per-chat кулдаун (>= 30 мин). Заметку подкидываем максимум раз в полчаса.
    const lastOfferMs = ctx.state.lastOfferMsByChat?.[OPS_CHANNEL_ID] ?? 0;
    if (ctx.nowMs - lastOfferMs < COOLDOWN_MS) return [];

    // Гейт 4: только СИЛЬНЫЙ свежий сигнал во входящем, на который она ещё не ответила.
    const { found, trailingYours } = detectFreshUnansweredSignal(OPS_CHANNEL_ID, ctx.nowMs);
    if (!found) return [];

    // Гейт 3b: анти-монолог — если она уже наговорила подряд, НЕ подталкиваем (её restraint).
    if (trailingYours >= 2) return [];

    // Все гейты пройдены → ОДНА тихая низкоприоритетная заметка. Никаких инструкций/чисел/
    // системных терминов (принцип честности): просто наблюдаемый факт + мягкая возможность.
    const m = new PromptBuilder();
    m.line("Кто-то в рабочем чате, похоже, уткнулся в код — баг/трейс/просьба глянуть.");
    m.line(
      "Если по-человечески к месту — можешь сама предложить глянуть код (без напора; не хочешь — промолчи).",
    );
    // order высок (поздно), priority низок (легко вытесняется важным) — это фоновый нудж, не директива.
    return [section("dev-offer", m.build(), undefined, 80, 20)];
  })
  // Мутация кулдауна — здесь (а не в contribute): отмечаем факт показа заметки по wall-clock.
  // Зеркало того, что contribute сделал бы заметку при тех же условиях; держим логику в синхроне.
  .onTickEnd((ctx) => {
    if (!OPS_CHANNEL_ID) return;

    const relState = readModState(ctx, "relationships");
    if ((relState?.targetNodeId ?? null) !== OPS_CHANNEL_ID) return;

    if (hasObligation(ctx.graph, OPS_CHANNEL_ID, ctx.nowMs, OBLIGATION_THRESHOLDS.signal)) return;

    if (!ctx.state.lastOfferMsByChat) ctx.state.lastOfferMsByChat = {};
    const lastOfferMs = ctx.state.lastOfferMsByChat[OPS_CHANNEL_ID] ?? 0;
    if (ctx.nowMs - lastOfferMs < COOLDOWN_MS) return;

    const { found, trailingYours } = detectFreshUnansweredSignal(OPS_CHANNEL_ID, ctx.nowMs);
    if (!found || trailingYours >= 2) return;

    // Стартуем кулдаун: следующая заметка по этому чату — не раньше чем через 30 мин.
    ctx.state.lastOfferMsByChat[OPS_CHANNEL_ID] = ctx.nowMs;
  })
  .build();
