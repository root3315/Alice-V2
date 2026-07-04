/**
 * Exploration Mod — автономное read-only «обучение по каналам».
 *
 * ИДЕЯ: Алиса сама замечает, какие ТЕМЫ важны её людям (агрегат interest-тегов контактов и
 * групп + кристаллизованные интересы), находит по сильнейшей теме ПУБЛИЧНЫЕ КАНАЛЫ, тихо
 * подписывается на ОДИН (канал-broadcast → подписчик физически НЕ может постить → read-only
 * by design), почитывает его и складывает заметное в ДОЛГОВЕЧНУЮ память (KB), чтобы помнить
 * и потом вспомнить. Тот же путь ингеста обслуживает РУЧНОЙ случай: владелец создаёт канал
 * «Worki Wiki» и добавляет туда Алису → она читает его и запоминает через ту же воронку.
 *
 * АРХИТЕКТУРА (зеркалит feeds.mod + digest.mod):
 *  - Сам mod СИНХРОННЫЙ и не имеет доступа к Telegram-клиенту (как и все mod'ы). Тяжёлую async
 *    работу (search → channel-only фильтр → preview → join → read → KB-ingest) делает ВНЕШНИЙ
 *    воркер, внедряемый из index.ts через setExplorationWorker(), у которого есть client + graph
 *    (паттерн setWorkiStatusSender). onTickEnd лишь ПРИНИМАЕТ решение (троттл + гейты) и дёргает
 *    воркер fire-and-forget; contribute() — ЧИСТЫЙ (как у digest/health-watch).
 *  - Воркер по завершении кладёт «уведомление владельцу» через setExplorationNotice(); mod
 *    поднимает направленное давление в личку владельца и подкидывает себе в КОНТЕКСТ короткую
 *    заметку — чтобы Алиса САМА своим голосом сказала владельцу «нашла канал «X» по теме «Y» —
 *    буду почитывать оттуда». Никакого хардкод-send, личность не трогаем — только новый повод
 *    заметить + ингест в память (аддитивная любознательность).
 *
 * ЖЁСТКИЕ ОГРАНИЧЕНИЯ:
 *  - ТОЛЬКО КАНАЛЫ. Перед ЛЮБЫМ авто-join воркер проверяет chat.chatType === "channel"
 *    (см. index.ts guard); группы/супергруппы НИКОГДА не джойнятся авто (там Алиса могла бы
 *    писать → риск). read-only присуще каналам.
 *  - Дневной кап join (по умолч. 2/сутки, персист в state) + wall-clock троттл (~4ч) → без спама.
 *  - Видимость владельцу (DM при join). Отключаемо: ALICE_CHANNEL_EXPLORE=0/false.
 *  - Если НЕТ ясного сигнала интереса → НЕ исследуем (никаких случайных join'ов).
 *
 * @see feeds.mod.ts — фоновый async-воркер + синхронное чтение в mod
 * @see digest.mod.ts / health-watch.mod.ts — owner-DM target + направленное давление
 * @see kb.mod.ts — note_kb: долговечное, не затухающее знание (KB-факт на self)
 * @see exploration-guard.ts — L2-защита join/search (cooldown/budget/circuit breaker)
 */
import { createMod } from "../core/mod-builder.js";
import { PromptBuilder } from "../core/prompt-style.js";
import type { ContributionItem } from "../core/types.js";
import { header, readPressureApi } from "../core/types.js";
import { ALICE_SELF, ensureChannelId } from "../graph/constants.js";
import type { WorldModel } from "../graph/world-model.js";
import { createLogger } from "../utils/logger.js";
import { getContactFacts, normalizeFactContent } from "./relationships.mod.js";

const log = createLogger("exploration");

// ── KB-ингест (общая воронка для авто-исследования И ручного Wiki-канала) ─────

/**
 * fact_type-метка долговечного знания (совпадает с kb.mod → один общий retrieval/recall и
 * одинаковая защита от свёртки консолидацией). Канал-знание складывается в ту же базу.
 */
const KB_FACT_TYPE = "kb";
/** Очень высокая stability (как в kb.mod): retrievability у потолка, fading не сворачивает. */
const KB_STABILITY = 100_000;
/** Максимальная длина одной KB-записи (как в kb.mod). */
const MAX_KB_LEN = 500;
/** Module-level счётчик уникальных id KB-узлов из канала. */
let _kbIdCounter = 0;

/**
 * Складывает заметный фрагмент из КАНАЛА в долговечную память (KB) — ТА ЖЕ воронка, что
 * note_kb (kb.mod): fact-узел на self с высокой stability + fact_type "kb". За счёт общего
 * хранилища recall и обычные пути чтения поднимают это знание наравне с прочими фактами.
 *
 * Эту же функцию использует РУЧНОЙ путь: владелец создаёт «Worki Wiki» канал и добавляет Алису →
 * Wiki-скан читает его непрочитанное и ингестит сюда же. Консервативно (дедуп + явный вызов):
 * вызывающий сам решает, что «заметно» (не KB-спамить каждое сообщение).
 *
 * @returns true если новый факт записан; false если дубликат/пусто/нет self-узла.
 */
export function ingestChannelKb(
  graph: WorldModel,
  text: string,
  opts: { topic?: string; sourceChannel?: string; nowMs?: number } = {},
): boolean {
  const body = (text ?? "").trim().slice(0, MAX_KB_LEN);
  if (body.length < 8) return false; // слишком коротко, чтобы быть знанием
  if (!graph.has(ALICE_SELF)) return false;
  const now = opts.nowMs ?? Date.now();
  const topic = (opts.topic ?? "").trim();
  const content = topic ? `[${topic}] ${body}` : body;
  const sourceChannel = opts.sourceChannel
    ? (ensureChannelId(opts.sourceChannel) ?? opts.sourceChannel)
    : undefined;

  // Дедупликация (нестрогая) среди уже сохранённых KB-фактов self.
  const normalized = normalizeFactContent(content);
  const selfFacts = getContactFacts(graph, ALICE_SELF).filter(
    (f) => f.attrs.fact_type === KB_FACT_TYPE,
  );
  const dup = selfFacts.find((f) => normalizeFactContent(f.attrs.content ?? "") === normalized);
  if (dup) {
    graph.updateFact(dup.id, {
      last_access_ms: now,
      stability: KB_STABILITY,
      reinforcement_count: (dup.attrs.reinforcement_count ?? 1) + 1,
    });
    return false;
  }

  const id = `kbch_${_kbIdCounter++}_${now}`;
  graph.addFact(id, {
    content,
    fact_type: KB_FACT_TYPE,
    importance: 0.85,
    stability: KB_STABILITY,
    last_access_ms: now,
    volatility: 0,
    tracked: false,
    created_ms: now,
    novelty: 1.0,
    reinforcement_count: 1,
    source_contact: ALICE_SELF,
    source_channel: sourceChannel,
    source: "perceive", // авто-извлечение из чтения канала (как восприятие, не активная запись LLM)
  });
  graph.addRelation(ALICE_SELF, "knows", id);
  return true;
}

// ── Конфиг-гейт ──────────────────────────────────────────────────────────────

/**
 * Включён по умолчанию, но консервативно. Владелец может отключить:
 * ALICE_CHANNEL_EXPLORE=0 (или "false"/"off"/"no"). Любое другое значение / отсутствие → ВКЛ.
 */
export function isExploreEnabled(): boolean {
  const raw = (process.env.ALICE_CHANNEL_EXPLORE ?? "").trim().toLowerCase();
  return raw !== "0" && raw !== "false" && raw !== "off" && raw !== "no";
}

// ── Параметры поведения (консервативные) ─────────────────────────────────────

/** Wall-clock троттл между попытками исследования (мс). ~4ч (внутри коридора 3–6ч задания). */
export const EXPLORE_THROTTLE_MS = 4 * 60 * 60_000;
/** Прогрев: первую попытку не делаем сразу после старта (мс). */
const WARMUP_MS = 30 * 60_000;
/** Дневной кап join'ов по умолчанию (запрос владельца: 1 канал/сутки). Персистится в state.joinsToday + state.joinDayKey. */
export const DEFAULT_DAILY_JOIN_CAP = 1;
/** Порог давления: при «занятости» (активная переписка) не уходим исследовать. */
const PRESSURE_GATE = 0.5;
/** Сколько держим уведомление «на виду» в её контексте, пока она не расскажет (мс). */
const NOTICE_TTL_MS = 60 * 60_000;
/** Минимальная «сила» интереса (число наблюдений), ниже которой тему НЕ берём в seed. */
export const MIN_INTEREST_STRENGTH = 2;

// ── Чистые типы решения/уведомления ──────────────────────────────────────────

/** Кандидат-тема для исследования (после агрегации сигналов интереса). */
export interface InterestSeed {
  /** Человекочитаемый ярлык темы (как её увидит владелец). */
  topic: string;
  /** Совокупная «сила» (число наблюдений / кристаллизаций) — для выбора сильнейшей. */
  strength: number;
}

/** Источники сигнала интереса (читаются из relationships.mod state — ЧИСТО, без мутаций). */
export interface InterestSources {
  /** Профили контактов: interests[] + crystallizedInterests. */
  contactProfiles?: Record<
    string,
    {
      interests?: string[];
      crystallizedInterests?: Record<string, { confidence?: number }>;
    }
  >;
  /** Профили групп: topic + crystallizedInterests. */
  groupProfiles?: Record<
    string,
    {
      topic?: string | null;
      crystallizedInterests?: Record<string, { confidence?: number }>;
    }
  >;
  /**
   * ЕЁ СОБСТВЕННЫЕ интересы (персона, а не только отражение людей): «живой человек со своими
   * вкусами». Задаются владельцем через ALICE_SELF_INTERESTS (см. selfInterestSeeds) — напр.
   * "Mobile Legends,аниме Фрирен". Вес выше порога → она исследует их сама, без чужого сигнала.
   */
  selfInterests?: string[];
}

/**
 * Её собственные интересы из окружения: ALICE_SELF_INTERESTS="тема1,тема2;тема3".
 * Пусто/не задано → []. Дёшево (парс строки), зовётся на каждом решении об исследовании.
 */
export function selfInterestSeeds(): string[] {
  const raw = (process.env.ALICE_SELF_INTERESTS ?? "").trim();
  if (!raw) return [];
  return raw
    .split(/[,;]+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 2)
    .slice(0, 12);
}

/** Готовое (но ещё не рассказанное) уведомление о найденном канале/группе. */
export interface ExplorationNotice {
  /** Что произошло: подписалась на КАНАЛ (сама) или нашла ГРУППУ (предлагает — сама НЕ вступает). */
  kind: "channel" | "group_proposal";
  /** Имя канала/группы. */
  channelName: string;
  /** Тема, по которой нашла. */
  topic: string;
  /** @username-ссылка (для group_proposal — чтобы вступить после «да» владельца). */
  link: string | null;
  /** Когда сформировано (мс) — для TTL. */
  ts: number;
  /** Направленное давление в личку владельца уже поднято. */
  directed: boolean;
}

interface ExplorationState {
  /** Когда последний раз пытались исследовать (мс) — wall-clock троттл. */
  lastExploreMs: number;
  /** Ключ суток (YYYY-MM-DD по UTC) для дневного капа. */
  joinDayKey: string;
  /** Сколько join'ов авто-исследования сделали в эти сутки. */
  joinsToday: number;
  /** В полёте сейчас попытка исследования (анти-двойной-запуск воркера). */
  inFlight: boolean;
  /** Готовые уведомления, ждущие пока Алиса о них расскажет (TTL-окно). */
  notices: ExplorationNotice[];
}

// ── ЧИСТЫЕ функции решения (тестируемые) ─────────────────────────────────────

/** Нормализует ярлык темы для дедупликации (lowercase, схлопывание пробелов/подчёркиваний). */
function normTopic(s: string): string {
  return s
    .toLowerCase()
    .replace(/[\s_]+/g, " ")
    .trim();
}

/**
 * Агрегирует сигналы интереса из профилей контактов и групп в список тем-кандидатов,
 * отсортированный по убыванию силы. ЧИСТАЯ: только читает, ничего не мутирует.
 *
 * Сила = число подтверждений: каждое упоминание interest-тега у контакта/группы +1; каждая
 * кристаллизация (confidence) добавляет вес. Темы слабее MIN_INTEREST_STRENGTH отсеиваются —
 * если нет ясного сигнала, список пуст → исследовать НЕ будем (никаких случайных join'ов).
 */
export function aggregateInterests(src: InterestSources): InterestSeed[] {
  const acc = new Map<string, { topic: string; strength: number }>();

  const bump = (label: string | null | undefined, weight: number): void => {
    if (!label) return;
    const display = label.trim();
    if (display.length < 2) return;
    const key = normTopic(display);
    if (!key) return;
    const cur = acc.get(key);
    if (cur) cur.strength += weight;
    else acc.set(key, { topic: display, strength: weight });
  };

  // Её собственные вкусы — сильный самостоятельный сигнал (выше MIN_INTEREST_STRENGTH),
  // чтобы она исследовала СВОИ темы даже без чужих упоминаний — как человек с интересами.
  for (const tag of src.selfInterests ?? []) bump(tag, 3);

  for (const profile of Object.values(src.contactProfiles ?? {})) {
    for (const tag of profile.interests ?? []) bump(tag, 1);
    for (const [label, ci] of Object.entries(profile.crystallizedInterests ?? {})) {
      // Кристаллизованный интерес — уже несколько согласованных наблюдений → вес выше.
      bump(label, 2 + Math.max(0, Math.round((ci?.confidence ?? 0) * 2)));
    }
  }
  for (const profile of Object.values(src.groupProfiles ?? {})) {
    bump(profile.topic, 1);
    for (const [label, ci] of Object.entries(profile.crystallizedInterests ?? {})) {
      bump(label, 2 + Math.max(0, Math.round((ci?.confidence ?? 0) * 2)));
    }
  }

  return [...acc.values()]
    .filter((s) => s.strength >= MIN_INTEREST_STRENGTH)
    .sort((a, b) => b.strength - a.strength);
}

/** Сильнейшая тема-сид (или null, если ясного сигнала нет → не исследуем). ЧИСТАЯ. */
export function pickStrongestInterest(src: InterestSources): InterestSeed | null {
  return aggregateInterests(src)[0] ?? null;
}

/** Минимальное описание кандидата для channel-only фильтра (то, что доступно ДО join). */
export interface CandidateChat {
  /** Тип чата как сообщил Telegram. ТОЛЬКО "channel" допускается к авто-join. */
  chatType: string;
  /** Graph nodeId (channel:telegram:<id>) — для проверки «уже состою». */
  graphId: string;
}

/**
 * ЧИСТЫЙ фильтр кандидата перед авто-join. Допускает РОВНО когда:
 *  1. chatType === "channel" (НЕ group/supergroup/private — там Алиса могла бы постить → риск);
 *  2. Алиса ещё НЕ состоит в этом канале (нет узла в графе ИЛИ узел недостижим/не подписка).
 * Это код-уровневый guard channels-only + not-already-member.
 */
export function isJoinableChannelCandidate(
  c: CandidateChat,
  isMember: (graphId: string) => boolean,
): boolean {
  if (c.chatType !== "channel") return false; // ЖЁСТКО: только каналы
  if (isMember(c.graphId)) return false; // уже состоит → не джойним повторно
  return true;
}

/** Текущий ключ суток (UTC) для дневного капа. */
export function dayKey(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

/**
 * ЧИСТЫЙ гейт дневного капа join'ов. true = ещё можно сегодня джойнить.
 * Если день сменился относительно state.joinDayKey — счётчик считается обнулённым.
 */
export function canJoinToday(
  state: Pick<ExplorationState, "joinDayKey" | "joinsToday">,
  nowMs: number,
  cap = DEFAULT_DAILY_JOIN_CAP,
): boolean {
  const today = dayKey(nowMs);
  const used = state.joinDayKey === today ? state.joinsToday : 0;
  return used < cap;
}

// ── Внедряемый async-воркер (из index.ts; есть client + graph) ───────────────

/**
 * Аргументы запуска исследования: сильнейшая тема + дневной кап (для ре-проверки в воркере)
 * + callback регистрации факта join (mod двигает счётчик капа атомарно при успехе).
 */
export interface ExploreRequest {
  topic: string;
  /** Сколько join'ов уже потрачено сегодня (для повторной защиты внутри воркера). */
  joinsUsedToday: number;
  dailyCap: number;
}

/** Результат воркера: подписалась на канал ИЛИ нашла группу-кандидата (предложение, БЕЗ join). */
export type ExplorationResult =
  | { channelName: string }
  | { groupProposal: { title: string; link: string | null } }
  | null;

/** Сигнатура воркера: search→channel-only→join→read→KB-ingest; группы — только как предложение. */
export type ExplorationWorker = (req: ExploreRequest) => Promise<ExplorationResult>;

let _worker: ExplorationWorker | null = null;

/** Внедрить async-воркер исследования (вызывается из index.ts при старте, как setWorkiStatusSender). */
export function setExplorationWorker(fn: ExplorationWorker | null): void {
  _worker = fn;
}

/** Канал лички владельца — ставится из index.ts. null → уведомления не шлём. */
let _ownerDm: string | null = null;

/** Задать личку владельца как адресата уведомлений об исследовании (вызывается из index.ts). */
export function setExplorationTarget(ownerDmGraphId: string): void {
  _ownerDm = ownerDmGraphId || null;
  log.info("exploration target set", { ownerDm: _ownerDm });
}

/**
 * Воркер сообщает результат: подписалась на канал / нашла группу-кандидата. mod подхватит на
 * следующем onTickEnd (поставит направленное давление + подкинет заметку владельцу).
 */
let _pendingFromWorker: {
  kind: "channel" | "group_proposal";
  name: string;
  topic: string;
  link: string | null;
} | null = null;

export function setExplorationNotice(channelName: string, topic: string): void {
  _pendingFromWorker = { kind: "channel", name: channelName, topic, link: null };
  log.info("exploration notice queued", { channelName, topic });
}

/** Нашла ГРУППУ по теме — предложить владельцу (сама НЕ вступает; join только после его «да»). */
export function setExplorationGroupProposal(
  title: string,
  link: string | null,
  topic: string,
): void {
  _pendingFromWorker = { kind: "group_proposal", name: title, topic, link };
  log.info("exploration group proposal queued", { title, link, topic });
}

/**
 * Owner-панель /explore: форс-запуск ближайшей попытки исследования — снимает wall-clock троттл,
 * warmup и гейт занятости (дневной кап и channels-only остаются в силе).
 */
let _forceExplore = false;
export function requestExploreNow(): void {
  _forceExplore = true;
  log.info("exploration: force requested (owner /explore)");
}

/**
 * Флаг «async-воркер завершился» (успех ИЛИ неуспех) — выставляется из .finally() воркера ВНЕ
 * tick. Состояние mod нельзя безопасно мутировать из async-замыкания (snapshot/restore, чистота),
 * поэтому сигнал идёт через module-level флаг; onTickEnd читает-и-сбрасывает его и снимает inFlight.
 */
let _workerDone = false;

/** Сброс внедрённых синглтонов (для тестов). */
export function _resetExploration(): void {
  _worker = null;
  _ownerDm = null;
  _pendingFromWorker = null;
  _workerDone = false;
  _forceExplore = false;
}

// ── Вспомогательное (направленное давление в личку владельца) ─────────────────

/** Поднять направленное давление на личку владельца (как в digest/health-watch). true = канал есть. */
function bumpDirected(graph: WorldModel, target: string): boolean {
  try {
    if (graph.has(target)) {
      const cur = Number(
        (graph.getChannel(target) as { pending_directed?: number }).pending_directed ?? 0,
      );
      if (cur <= 0) {
        graph.updateChannel(target, { pending_directed: 1, last_directed_ms: Date.now() });
      }
      return true;
    }
  } catch (err) {
    log.warn("directed bump failed", { target, err: (err as Error).message });
  }
  return false;
}

// ── Определение Mod ───────────────────────────────────────────────────────────

export const explorationMod = createMod<ExplorationState>("exploration", {
  category: "mechanic",
  description:
    "Автономное read-only обучение по каналам: находит публичные каналы по сильнейшим темам её людей, тихо подписывается (read-only) и складывает заметное в долговечную память",
  topics: ["exploration"],
  initialState: {
    lastExploreMs: 0,
    joinDayKey: "",
    joinsToday: 0,
    inFlight: false,
    notices: [],
  },
})
  // contribute — ЧИСТЫЙ: только читает готовые (directed) уведомления и отдаёт заметку владельцу.
  // Два вида: kind="channel" (сама подписалась на канал) и kind="group_proposal" (нашла ГРУППУ —
  // сама НЕ вступает, спрашивает разрешения у владельца; join только после его «да»).
  .contribute((ctx): ContributionItem[] => {
    if (!_ownerDm) return [];
    const ready = ctx.state.notices.filter((n) => n.directed);
    if (ready.length === 0) return [];

    const blocks: string[] = ["## Нашла кое-что (только для лички владельца)", ""];
    const channels = ready.filter((n) => n.kind === "channel");
    const groups = ready.filter((n) => n.kind === "group_proposal");

    if (channels.length > 0) {
      blocks.push(
        "Подписалась на канал(ы), чтобы быть в теме — скажи владельцу своими словами, коротко:",
        channels
          .map((n) => `— канал «${n.channelName}» по теме «${n.topic}» — буду почитывать`)
          .join("\n"),
        "",
      );
    }
    if (groups.length > 0) {
      blocks.push(
        "Нашла ГРУППУ по своим интересам, но сама в группы не вступаю (это его аккаунт) — " +
          "спроси у владельца своими словами, хочет ли он, чтобы ты туда зашла (дай ссылку). " +
          "Если он потом скажет «зайди» — вступишь через свою команду join:",
        groups
          .map((n) => `— группа «${n.channelName}»${n.link ? ` (${n.link})` : ""} по теме «${n.topic}»`)
          .join("\n"),
        "",
      );
    }
    blocks.push("Не обязаловка: если сейчас не к месту — промолчи. В любом ДРУГОМ чате — молчи.");
    return [header(PromptBuilder.fromRaw(blocks.join("\n")), 82)];
  })
  // Жизненный цикл (мутации): троттл + гейты → запуск воркера; приём уведомлений; давление; TTL.
  .onTickEnd((ctx) => {
    const now = ctx.nowMs;

    // 0a. Воркер завершился (вне tick) → снимаем in-flight, чтобы можно было повторить после троттла.
    if (_workerDone) {
      _workerDone = false;
      ctx.state.inFlight = false;
    }

    // 0b. Приём уведомления от воркера (ставим как pending, даже если фича в этот момент выкл —
    //    результат уже получен, пусть расскажет; новые попытки гейтируются ниже).
    if (_pendingFromWorker) {
      ctx.state.notices.push({
        kind: _pendingFromWorker.kind,
        channelName: _pendingFromWorker.name,
        topic: _pendingFromWorker.topic,
        link: _pendingFromWorker.link,
        ts: now,
        directed: false,
      });
      // Дневной кап двигаем ТОЛЬКО за реальный join канала (предложение группы — не join).
      if (_pendingFromWorker.kind === "channel") {
        const today = dayKey(now);
        if (ctx.state.joinDayKey !== today) {
          ctx.state.joinDayKey = today;
          ctx.state.joinsToday = 0;
        }
        ctx.state.joinsToday += 1;
        log.info("exploration: подписка зафиксирована", { joinsToday: ctx.state.joinsToday });
      }
      ctx.state.inFlight = false;
      _pendingFromWorker = null;
    }

    // 1. Направленное давление в личку владельца + TTL-чистка (каждый тик, дёшево).
    if (_ownerDm) {
      ctx.state.notices = ctx.state.notices.filter((n) => now - n.ts < NOTICE_TTL_MS);
      for (const n of ctx.state.notices) {
        if (!n.directed) n.directed = bumpDirected(ctx.graph, _ownerDm);
      }
    }

    // 2. Решение об исследовании — все гейты (иначе молчим, никаких случайных join'ов).
    if (!isExploreEnabled()) return; // конфиг-гейт
    if (!_worker) return; // воркер не внедрён → mod спит
    if (ctx.state.inFlight) return; // уже идёт попытка

    // Форс от владельца (/explore) снимает троттл/warmup/гейт занятости (кап и channels-only — нет).
    const forced = _forceExplore;
    _forceExplore = false;

    // wall-clock троттл (первая попытка — после warmup). При форсе — пропускаем.
    const baseline =
      ctx.state.lastExploreMs > 0 ? ctx.state.lastExploreMs : now - EXPLORE_THROTTLE_MS + WARMUP_MS;
    if (!forced && now - baseline < EXPLORE_THROTTLE_MS) return;

    // Гейт «занятости»: при активной переписке не уходим исследовать (как feeds/channel). Форс — мимо.
    if (!forced && readPressureApi(ctx) > PRESSURE_GATE) return;

    // Дневной кап (и при форсе — уважаем, чтобы не спамить join'ами).
    if (!canJoinToday(ctx.state, now, DEFAULT_DAILY_JOIN_CAP)) return;

    // Ясный сигнал интереса (иначе — НЕ исследуем). Источники: профили её людей/групп
    // (relationships) + ЕЁ СОБСТВЕННЫЕ интересы (ALICE_SELF_INTERESTS) — свои работают
    // и без чужого сигнала (она человек со своими вкусами).
    const relState = ctx.getModState<InterestSources>("relationships");
    const seed = pickStrongestInterest({ ...(relState ?? {}), selfInterests: selfInterestSeeds() });
    if (!seed) return;

    // Все гейты пройдены → отмечаем троттл и запускаем воркер fire-and-forget.
    ctx.state.lastExploreMs = now;
    ctx.state.inFlight = true;
    const today = dayKey(now);
    const used = ctx.state.joinDayKey === today ? ctx.state.joinsToday : 0;
    const worker = _worker;
    log.info("exploration: пробую найти канал по теме", {
      topic: seed.topic,
      strength: seed.strength,
    });
    void Promise.resolve(
      worker({ topic: seed.topic, joinsUsedToday: used, dailyCap: DEFAULT_DAILY_JOIN_CAP }),
    )
      .then((res) => {
        // Результат воркера: подписалась на КАНАЛ (сама) ИЛИ нашла ГРУППУ (предложение владельцу).
        // null (нет кандидата / кап / не сджойнили) → молча, без уведомления.
        if (res && "channelName" in res) {
          setExplorationNotice(res.channelName, seed.topic);
        } else if (res && "groupProposal" in res) {
          setExplorationGroupProposal(res.groupProposal.title, res.groupProposal.link, seed.topic);
        }
      })
      .catch((err) => {
        log.warn("exploration worker failed", { err: (err as Error).message });
      })
      .finally(() => {
        // in-flight снимается на следующем onTickEnd (через module-level флаг — async-замыкание
        // не должно мутировать state mod напрямую).
        _workerDone = true;
      });
  })
  .build();
