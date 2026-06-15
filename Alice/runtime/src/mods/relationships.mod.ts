/**
 * Relationships Mod — профили контактов + структурированный портрет + определение языка.
 *
 * Соответствует relation mod + affect mod нарративного движка:
 * - Поддерживает профиль каждого контакта (языковые предпочтения, число взаимодействий, уровень отношений)
 * - M2: структурированный ContactProfile (стиль общения, часы активности, эмоциональный базис, теги интересов)
 * - Вносит контекст контактов в Storyteller (section-корзины)
 *
 * Инструкции: set_language, set_relation_type, note_active_hour, tag_interest, self_note, recall_fact, update_fact, delete_fact, synthesize_portrait, update_group_profile
 * Запросы: contactProfile, languageOf
 *
 * Ссылка: narrative-engine/mods/relation/index.ts
 * Ссылка: narrative-framework-paper §5 (P_ρ relationship priority)
 */
import { and, eq, gt, lte, sql } from "drizzle-orm";
import { z } from "zod";
import { createMod } from "../core/mod-builder.js";
import { PromptBuilder, type PromptLine } from "../core/prompt-style.js";
import type { ContributionItem } from "../core/types.js";
import { readModState, readPressureApi, section } from "../core/types.js";
import { getDb } from "../db/connection.js";
import { getRecentMessagesBySender } from "../db/queries.js";
import { actionLog } from "../db/schema.js";
import {
  emit as emitConsciousness,
  reinforce as reinforceConsciousness,
} from "../engine/consciousness.js";
import { activationRetrieval } from "../graph/activation.js";
import {
  ALICE_SELF,
  EMOTIONAL_HALF_LIFE,
  EMOTIONAL_NOTED_THRESHOLD,
  EMOTIONAL_VIVID_THRESHOLD,
  ensureChannelId,
  ensureContactId,
  extractNumericId,
  FACT_CONSOLIDATION_FACTOR,
  FACT_DECAY_D,
  FACT_FORGET_THRESHOLD,
  FACT_TIME_SCALE,
  factTypeInitialStability,
  resolveContactAndChannel,
  STABILITY_REINFORCE_FACTOR,
  telegramContactId,
  tierLabel,
} from "../graph/constants.js";
import { resolveDisplayName, safeDisplayName } from "../graph/display.js";
import type { DunbarTier, FactAttrs, RelationType } from "../graph/entities.js";
import {
  DIMENSION_DECAY,
  decayDimension,
  deriveRomanticPhase,
  INITIAL_RV,
  RV_DIMENSIONS,
  readRV,
  readVelocity,
} from "../graph/relationship-vector.js";
import type { WorldModel } from "../graph/world-model.js";
import { estimateEventMs } from "../pressure/clock.js";
import { effectiveObligation } from "../pressure/signal-decay.js";
import { ChatTarget } from "../prompt/types.js";
import { retrievability as calcRetrievability } from "../utils/math.js";
import { humanDurationAgo } from "../utils/time-format.js";

/**
 * ADR-151 T3: Сопоставление Tier → тональные рекомендации.
 * Zhao 2025 EMNLP: LLM чрезмерно опирается на негативную вежливость (обращения, косвенность);
 * явное внедрение стратегии вежливости корректирует перекос, давая intimate-контактам
 * позитивную вежливость (непринуждённость, прямота).
 *
 * Калибровка для IM (ADR-151 Wave 1): tier 50+ смещается на одну ступень в сторону непринуждённости.
 * Основание: IM — неформальный канал, emoji/стикеры снижают официальность,
 * даже малознакомые люди в IM редко используют сугубо официальный стиль.
 * @see docs/adr/151-algorithm-audit/priority-ranking.md
 * @see docs/adr/151-algorithm-audit/research-online-calibration.md §4.1
 */
const TIER_TONE_GUIDANCE: Record<number, string> = {
  5: "С {name} говори совсем свободно и тепло, как с самым родным человеком",
  15: "С {name} говори легко и по-дружески, как со старым другом",
  50: "С {name} говори легко и естественно, как с обычным приятелем",
  150: "С {name} будь тёплой и дружелюбной, в меру вежливой",
  500: "С {name} будь вежливой и корректной",
};

// -- Вспомогательные функции для фактов графовых узлов ------------------------

/**
 * ADR-47 G6: Нормализовать содержимое факта для дедупликации.
 * lowercase + trim + collapse whitespace → нестрогое сопоставление.
 */
export function normalizeFactContent(content: string): string {
  return content.toLowerCase().trim().replace(/\s+/g, " ");
}

/** Module-level counter for unique fact node IDs. */
let _factIdCounter = 0;

/** Сгенерировать уникальный ID узла fact. */
function nextFactId(): string {
  return `fact_${_factIdCounter++}_${Date.now()}`;
}

/**
 * Вычислить retrievability по атрибутам узла fact.
 * ADR-110: Принимает nowMs (миллисекунды настенных часов), внутри переводит в секунды для расчёта кривой забывания.
 * ADR-46 F1: Δt делится на FACT_TIME_SCALE, преобразуя забывание из секундного в дневное.
 * Используется функция retrievability из utils/math.ts (передаётся масштабированный gap).
 * @see docs/adr/46-real-data-calibration.md §2 Wave 1
 */
export function factRetrievabilityFromNode(attrs: FactAttrs, nowMs: number): number {
  // ADR-154: FactAttrs унифицированы в last_access_ms (настенные часы, мс)
  const gapS = Math.max(0, (nowMs - attrs.last_access_ms) / 1000);
  const scaledGap = gapS / FACT_TIME_SCALE; // FACT_TIME_SCALE = 86400 (секунд/день)
  // retrievability(t, t0, S, d) — передаётся scaledGap как t, 0 как t0
  return calcRetrievability(scaledGap, 0, attrs.stability, FACT_DECAY_D);
}

/**
 * ADR-156: Вычислить эмоциональную реактивность факта E(t).
 *
 * E(t) = E₀ · exp(-ln2 · Δt / τ_half)
 *
 * Период полураспада 2ч: t=0h→1.0, t=2h→0.5, t=4h→0.25, t=8h→0.06.
 * Факты без поля reactivity возвращают 0 (нейтральные факты, обратная совместимость).
 *
 * @see docs/adr/156-emotional-reactivity-damping.md §E(t)
 */
export function factEmotionalReactivity(attrs: FactAttrs, nowMs: number): number {
  if (attrs.reactivity == null || attrs.reactivity <= 0) return 0;
  const baseMs = attrs.reactivity_ms ?? attrs.created_ms;
  const dt = Math.max(0, nowMs - baseMs);
  return attrs.reactivity * Math.exp((-Math.LN2 * dt) / EMOTIONAL_HALF_LIFE);
}

/**
 * Найти все узлы-факты контакта/агента.
 * Обход соседей по рёбрам "knows" с фильтрацией по типу fact.
 */
export function getContactFacts(
  graph: WorldModel,
  contactId: string,
): Array<{ id: string; attrs: FactAttrs }> {
  const neighbors = graph.getNeighbors(contactId, "knows");
  const facts: Array<{ id: string; attrs: FactAttrs }> = [];
  for (const nid of neighbors) {
    if (graph.getNodeType(nid) === "fact") {
      facts.push({ id: nid, attrs: graph.getFact(nid) });
    }
  }
  return facts;
}

/**
 * ADR-117 D2: Защитный guard — разрешить переданный ID в узел типа contact.
 * LLM может передавать не-contact ID (channel/fact и т.д.); поиск реального контакта ведётся по обратным рёбрам `knows`.
 * @returns ID узла contact или null (если разрешить не удалось).
 */
function resolveContactId(graph: WorldModel, rawId: string): string | null {
  const telegramNativeId = extractNumericId(rawId);
  const nodeId = telegramNativeId != null ? telegramContactId(telegramNativeId) : rawId;
  if (!graph.has(nodeId)) return null;
  if (graph.getNodeType(nodeId) === "contact") return nodeId;
  // Не тип contact → обратный поиск по рёбрам knows
  const predecessors = graph.getPredecessors(nodeId, "knows");
  return predecessors.find((pid) => graph.has(pid) && graph.getNodeType(pid) === "contact") ?? null;
}

// -- ADR-206 W8: Социальная панорама канала -----------------------------------

const PANORAMA_MAX_CONTACTS = 8;
const PANORAMA_MAX_CHARS = 400;
// Расширено до 500: социальная панорама для пересылки в канал требует совпадения интересов,
// а накопление тегов интересов сосредоточено у контактов с tier=500
// (tag_interest для close contacts ещё не набрал силу). PANORAMA_MAX_CONTACTS=8 + логика сортировки
// гарантируют показ только наиболее релевантных людей без «разводнения» от расширения tier.
const PANORAMA_MAX_TIER: DunbarTier = 500;
const PANORAMA_MAX_INTERESTS = 2;

/**
 * ADR-206 W8: Сформировать компактную социальную панораму — помогает Alice выбрать цель пересылки в тик канала.
 *
 * Извлекает close contacts (tier ≤ 50), для каждого рендерит строку-резюме:
 *   display_name (tier_label) — interests | last interaction | share frequency
 *
 * @see docs/adr/206-channel-information-flow/ §12 консолидация ответственности за пересылку
 */
export function buildSocialPanorama(
  G: WorldModel,
  contactProfiles: Record<string, ContactProfile>,
  groupProfiles: Record<string, GroupProfile>,
  nowMs: number,
  targetWhitelist: ReadonlySet<string> | null = null,
): PromptLine[] {
  if (!G.has(ALICE_SELF)) return [];

  const lines: PromptLine[] = [];
  let totalChars = 0;

  // -- Секция контактов --
  const acquaintances = G.getNeighbors(ALICE_SELF, "acquaintance");
  const contactCandidates: Array<{
    name: string;
    tier: number;
    interests: string[];
    lastActiveMs: number;
    lastSharedToMs: number;
    topTrait: string | null;
  }> = [];

  for (const cid of acquaintances) {
    if (!G.has(cid) || G.getNodeType(cid) !== "contact") continue;
    const attrs = G.getContact(cid);
    if (attrs.is_bot) continue;
    const tier = attrs.tier ?? 150;
    if (tier > PANORAMA_MAX_TIER) continue;

    const privateCh = ensureChannelId(cid) ?? cid;
    if (targetWhitelist && !targetWhitelist.has(privateCh)) continue;

    const name = safeDisplayName(G, cid);
    const profile = contactProfiles[cid];

    // ADR-208: Приоритет — кристаллизованные интересы, fallback — старый interests[]
    const crystallized = Object.values(profile?.crystallizedInterests ?? {})
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, PANORAMA_MAX_INTERESTS)
      .map((ci) => ci.label);
    const interests =
      crystallized.length > 0
        ? crystallized
        : (profile?.interests ?? []).slice(0, PANORAMA_MAX_INTERESTS);

    const lastActiveMs = attrs.last_active_ms ?? 0;
    const lastSharedToMs = G.has(privateCh)
      ? Number(G.getDynamic(privateCh, "last_shared_ms") ?? 0)
      : 0;

    // ADR-208 W2: топ-1 черта характера (по убыванию |value|)
    const traitEntries = Object.entries(profile?.traits ?? {});
    const topTrait =
      traitEntries.length > 0
        ? traitEntries.sort((a, b) => Math.abs(b[1].value) - Math.abs(a[1].value))[0][0]
        : null;

    contactCandidates.push({ name, tier, interests, lastActiveMs, lastSharedToMs, topTrait });
  }

  // Приоритет — люди с тегами интересов (ключевой сигнал для пересылки в канал), затем по tier (по возрастанию) и активности (по убыванию)
  contactCandidates.sort((a, b) => {
    const aHas = a.interests.length > 0 ? 0 : 1;
    const bHas = b.interests.length > 0 ? 0 : 1;
    return aHas - bHas || a.tier - b.tier || b.lastActiveMs - a.lastActiveMs;
  });

  for (const c of contactCandidates.slice(0, PANORAMA_MAX_CONTACTS)) {
    const tierInfo = c.topTrait ? `${tierLabel(c.tier)}, ${c.topTrait}` : tierLabel(c.tier);
    const parts: string[] = [`${c.name} (${tierInfo})`];
    if (c.interests.length > 0) parts.push(`— ${c.interests.join(", ")}`);
    if (c.lastActiveMs > 0) {
      parts.push(`| ${formatElapsed(nowMs - c.lastActiveMs)} ago`);
    }
    if (c.lastSharedToMs > 0 && nowMs - c.lastSharedToMs < 3_600_000) {
      parts.push("| shared recently");
    }
    const line = parts.join(" ");
    totalChars += line.length;
    if (totalChars > PANORAMA_MAX_CHARS && lines.length > 0) break;
    lines.push(`- ${line}` as PromptLine);
  }

  // -- ADR-208: Секция групп --
  const PANORAMA_MAX_GROUPS = 4;
  const joinedChannels = G.getNeighbors(ALICE_SELF, "joined");
  const groupCandidates: Array<{ name: string; interests: string[]; topic: string | null }> = [];

  for (const chId of joinedChannels) {
    if (!G.has(chId) || G.getNodeType(chId) !== "channel") continue;
    if (targetWhitelist && !targetWhitelist.has(chId)) continue;
    const chAttrs = G.getChannel(chId);
    const chatType = chAttrs.chat_type ?? "unknown";
    if (chatType !== "group" && chatType !== "supergroup") continue;

    const name = safeDisplayName(G, chId);
    const gp = groupProfiles[chId];
    const crystallized = Object.values(gp?.crystallizedInterests ?? {})
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, PANORAMA_MAX_INTERESTS)
      .map((ci) => ci.label);
    const topic = gp?.topic ?? null;

    groupCandidates.push({ name, interests: crystallized, topic });
  }

  for (const g of groupCandidates.slice(0, PANORAMA_MAX_GROUPS)) {
    const parts: string[] = [`[group] ${g.name}`];
    if (g.interests.length > 0) {
      parts.push(`— ${g.interests.join(", ")}`);
    } else if (g.topic) {
      parts.push(`— ${g.topic.slice(0, 40)}`);
    }
    const line = parts.join(" ");
    totalChars += line.length;
    if (totalChars > PANORAMA_MAX_CHARS && lines.length > 0) break;
    lines.push(`- ${line}` as PromptLine);
  }

  return lines;
}

/** Перевести разницу времени в миллисекундах в естественный язык. */
function formatElapsed(ms: number): string {
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

// -- Состояние Mod ------------------------------------------------------------

/**
 * ADR-208: Кристаллизованный интерес — унимодальная достоверность [0,1], осадок из домена interest: в BeliefStore.
 * В отличие от биполярного [-1,1] CrystallizedTrait: интерес только «есть/нет», обратной стороны нет.
 * @see docs/adr/208-cognitive-label-interest-domain.md
 */
export interface CrystallizedInterest {
  /** Нормализованный тег (lowercase, через подчёркивание). */
  label: string;
  /** Достоверность [0,1], производная от μ BeliefStore. */
  confidence: number;
  /** Тик, в котором произошла кристаллизация. */
  crystallizedAt: number;
  /** Время кристаллизации (настенные часы, мс). */
  crystallizedAtMs: number;
  /** Тик последнего усиления через tag_interest. */
  lastReinforced: number;
  /** Время последнего усиления через tag_interest (настенные часы, мс). */
  lastReinforcedMs: number;
}

/**
 * ADR-89: Кристаллизованная черта — устойчивая черта характера, осаждённая из BeliefStore после многократных согласованных наблюдений.
 * @see docs/adr/89-impression-formation-system.md §Wave 2
 */
export interface CrystallizedTrait {
  /** Значение черты [-1, 1], положительное/отрицательное соответствует полюсам биполярного измерения. */
  value: number;
  /** Тик, в котором произошла кристаллизация. */
  crystallizedAt: number;
  /** ADR-110: Время кристаллизации (настенные часы, мс). Обязательно для новых данных, может отсутствовать в старых. */
  crystallizedAtMs?: number;
  /** Тик последнего усиления через self_sense. */
  lastReinforced: number;
  /** ADR-110: Время последнего усиления через self_sense (настенные часы, мс). Обязательно для новых данных, может отсутствовать в старых. */
  lastReinforcedMs?: number;
}

/** M2: Структурированный профиль контакта. */
export interface ContactProfile {
  // ADR-198 F10: communicationStyle удалён (пересекается с portrait)
  // ADR-198 F10: moodBaseline удалён (числовой показатель нарушает семантическую доступность)
  /** EMA-гистограмма часов активности (24 слота, нормализованная активность). */
  activeHours: number[];
  /** Теги интересов (извлекаются LLM через tag_interest, не более 10). */
  interests: string[];
  /** Тик последнего обновления. */
  lastUpdatedTick: number;
  /** ADR-110: Время последнего обновления (настенные часы, мс). Обязательно для новых данных, может отсутствовать в старых. */
  lastUpdatedMs?: number;
  // ADR-198 F9: поле trust удалено. Доверие теперь единообразно управляется через rv_trust (атрибут графа).
  // Остаточные значения trust в старом state становятся мёртвыми данными и больше не читаются.
  /** Пиковый час активности на момент последней оценки tier (для обнаружения изменений паттерна). */
  previousPeakHour: number | null;
  /** Описание последнего обнаруженного изменения расписания (если есть). */
  scheduleShift: string | null;
  /** ADR-64 VI-3: Сводный нарратив впечатлений (генерируется LLM через synthesize_portrait). */
  portrait: string | null;
  /** ADR-64 VI-3: Тик последнего обновления впечатления. */
  portraitTick: number | null;
  /** ADR-110: Время последнего обновления впечатления (настенные часы, мс). Обязательно для новых данных, может отсутствовать в старых. */
  portraitMs?: number | null;
  /** ADR-89: Кристаллизованные черты (dimension → CrystallizedTrait). Осаждаются из BeliefStore после многократных согласованных наблюдений. */
  traits: Record<string, CrystallizedTrait>;
  /** ADR-208: Кристаллизованные интересы (label → CrystallizedInterest). Осаждаются из домена interest: в BeliefStore. Могут отсутствовать в старых данных. */
  crystallizedInterests?: Record<string, CrystallizedInterest>;
}

/**
 * ADR-64 VI-4: Профиль группы.
 * Отслеживает тематику группы, социальную атмосферу, роль Alice и ключевых участников.
 */
export interface GroupProfile {
  /** Тема/направление обсуждений группы (генерируется LLM). */
  topic: string | null;
  /** Описание социальной атмосферы группы. */
  atmosphere: string | null;
  /** Роль Alice в группе. */
  aliceRole: string | null;
  /** Описание ключевых участников. */
  memberHighlights: string | null;
  /** Тик последнего обновления. */
  portraitTick: number | null;
  /** ADR-110: Время последнего обновления (настенные часы, мс). Обязательно для новых данных, может отсутствовать в старых. */
  portraitMs?: number | null;
  /** ADR-208: Кристаллизованные интересы/теги тем (label → CrystallizedInterest). Могут отсутствовать в старых данных. */
  crystallizedInterests?: Record<string, CrystallizedInterest>;
}

/** Создать пустой профиль. */
function emptyProfile(tick: number, nowMs?: number): ContactProfile {
  return {
    activeHours: new Array(24).fill(0),
    interests: [],
    lastUpdatedTick: tick,
    lastUpdatedMs: nowMs ?? Date.now(),
    previousPeakHour: null,
    scheduleShift: null,
    portrait: null,
    portraitTick: null,
    portraitMs: null,
    traits: {},
    crystallizedInterests: {},
  };
}

function mergeContactProfile(target: ContactProfile, source: ContactProfile): void {
  for (let h = 0; h < 24; h++) {
    target.activeHours[h] = Math.max(target.activeHours[h] ?? 0, source.activeHours[h] ?? 0);
  }
  target.interests = Array.from(new Set([...target.interests, ...source.interests])).slice(0, 10);
  target.lastUpdatedTick = Math.max(target.lastUpdatedTick ?? 0, source.lastUpdatedTick ?? 0);
  target.lastUpdatedMs = Math.max(target.lastUpdatedMs ?? 0, source.lastUpdatedMs ?? 0);
  target.previousPeakHour ??= source.previousPeakHour;
  target.scheduleShift ??= source.scheduleShift;
  target.portrait ??= source.portrait;
  target.portraitTick ??= source.portraitTick;
  target.portraitMs ??= source.portraitMs;
  target.traits = { ...source.traits, ...target.traits };
  target.crystallizedInterests = {
    ...(source.crystallizedInterests ?? {}),
    ...(target.crystallizedInterests ?? {}),
  };
}

function normalizeContactProfileKeys(
  graph: WorldModel,
  state: Pick<RelationshipsState, "contactProfiles">,
): void {
  for (const [rawKey, profile] of Object.entries({ ...state.contactProfiles })) {
    const telegramNativeId = extractNumericId(rawKey);
    const contactId =
      resolveDisplayName(graph, rawKey) ??
      (telegramNativeId != null ? telegramContactId(telegramNativeId) : ensureContactId(rawKey));
    if (!contactId || contactId === rawKey || !graph.has(contactId)) continue;
    if (graph.getNodeType(contactId) !== "contact") continue;

    if (state.contactProfiles[contactId]) {
      mergeContactProfile(state.contactProfiles[contactId], profile);
    } else {
      state.contactProfiles[contactId] = profile;
    }
    delete state.contactProfiles[rawKey];
  }
}

/** ADR-64 VI-4: Создать пустой профиль группы. */
function emptyGroupProfile(): GroupProfile {
  return {
    topic: null,
    atmosphere: null,
    aliceRole: null,
    memberHighlights: null,
    portraitTick: null,
    portraitMs: null,
    crystallizedInterests: {},
  };
}

/**
 * Коэффициент EMA-обновления часов активности.
 * EMA α = 0.1: эффективное окно 10 выборок — подходит для медленно меняющихся сигналов (частотный базис, паттерны активности).
 * Стандарт теории связи: α = 2/(N+1), N=19 → α ≈ 0.1.
 */
const ACTIVE_HOURS_ALPHA = 0.1;
/**
 * Коэффициент EMA-обновления эмоционального базиса.
 * ADR-198: MOOD_BASELINE_ALPHA удалён (поле moodBaseline удалено).
 */

/** Ёмкость фактов узла self (превышает 20 фактов обычного контакта). */
const SELF_FACTS_LIMIT = 50;
/** Ёмкость фактов обычного контакта. */
const CONTACT_FACTS_LIMIT = 20;

// ADR-41: Выборочный контекст — инжекция top-N предотвращает эхо-камеру запись–чтение
/**
 * Лимит memorized facts целевого контакта, инжектируемых в contribute().
 * ADR-46 C5 (экспертный консенсус ADR-41 п.5): 10 → 7.
 * Когнитивная наука: закон Миллера 7±2 + эффект lost-in-the-middle у LLM.
 * @see docs/adr/41-write-read-loop-self-evolution.md §экспертный круглый стол, консенсус 5
 */
const MAX_INJECTED_FACTS = 7;
/**
 * Лимит self memorized facts, инжектируемых в contribute().
 * ADR-46 C5: 15 → 10 (квота для собственных знаний по-прежнему выше, чем для контактов, но компактнее).
 */
const MAX_INJECTED_SELF_FACTS = 10;

// -- M4: Движок эволюции Tier -------------------------------------------------

/**
 * Лесенка уровней Данбара. Tier движется только по ступеням, без пропусков.
 * 500(known) → 150(acquaintance) → 50(friend) → 15(close friend) → 5(intimate)
 */
export const DUNBAR_TIERS = [500, 150, 50, 15, 5] as const;

/** Интервал оценки эволюции Tier (тики). */
export const TIER_EVAL_INTERVAL = 100;
/**
 * Порог последовательного повышения tier.
 * Калибровка: квартильная схема — 0.7 = повышение в top 30%, 0.3 = понижение в bottom 30%.
 * Асимметричное повышение/понижение по Granovetter (1973), теория слабых связей:
 * повышение требует сильного сигнала (top 30%), понижение — устойчивого слабого (5 раз подряд bottom 30%).
 * Асимметрия защищает от ошибочного понижения во время сна.
 */
export const TIER_UPGRADE_THRESHOLD = 0.7;
/**
 * Порог последовательного понижения tier.
 * @see TIER_UPGRADE_THRESHOLD — описание калибровки порогов
 */
export const TIER_DOWNGRADE_THRESHOLD = 0.3;
/** Требуемое число последовательных повышений для апгрейда. */
export const TIER_CONSECUTIVE_REQUIRED = 3;
/**
 * Требуемое число последовательных понижений для даунгрейда (асимметрично, более консервативно).
 * Отношения строятся медленнее, чем разрушаются — апгрейд за 3 раза (5 ч), даунгрейд за 5 (~8.3 ч).
 * Защита от ошибочного понижения intimate → close_friend при 5-часовом молчании во время сна/офлайна Alice.
 * @see Gilbert & Karahalios (2009) — асимметрия оценки силы связей
 */
export const TIER_DOWNGRADE_CONSECUTIVE = 5;

/**
 * ADR-110: Окно оценки Frequency (секунды).
 * ADR-45 калибровка по реальным данным: D1=5.6/день, D2=2.3/день.
 * FREQUENCY_WINDOW_S=86400 (1 день = 86400 секунд).
 * Отвязан от TIER_EVAL_INTERVAL (частота оценки): оценивается раз в 100 тиков, но смотрит на полный день данных.
 * @see docs/adr/45-real-data-validation.md §5 F5
 * @see docs/adr/46-real-data-calibration.md
 */
const FREQUENCY_WINDOW_S = 86400;

// -- ADR-89: Параметры кристаллизации впечатлений --------------------------

/** Условие кристаллизации: σ² ниже этого значения (дисперсия сходится после многократных согласованных наблюдений). */
const CRYSTALLIZE_SIGMA2 = 0.05;
/** Условие кристаллизации: не менее N наблюдений через self_sense. */
const CRYSTALLIZE_MIN_OBS = 3;
/** Условие кристаллизации: |μ| превышает это значение (нейтральные черты исключаются). */
const CRYSTALLIZE_MU_THRESHOLD = 0.2;
/** ADR-110: Период полураспада медленного затухания кристаллизованной черты (секунды): 604800 с = 7 дней. */
const CRYSTALLIZED_TRAIT_HALFLIFE_S = 604800;
/** Порог исчезновения кристаллизованной черты: удаляется при |value| ниже этого значения. */
const CRYSTALLIZED_TRAIT_EPSILON = 0.05;

// -- ADR-208: Параметры кристаллизации интересов ----------------------------
// @see docs/adr/208-cognitive-label-interest-domain.md

/** Условие кристаллизации интереса: σ² ниже этого значения (чуть мягче 0.05 для черт, среднее с 0.08 для jargon). */
const INTEREST_CRYSTALLIZE_SIGMA2 = 0.06;
/** Условие кристаллизации интереса: не менее N наблюдений через tag_interest (согласовано с 2 для jargon). */
const INTEREST_CRYSTALLIZE_MIN_OBS = 2;
/** Условие кристаллизации интереса: μ превышает это значение (унимодальная, значима только в положительном направлении). */
const INTEREST_CRYSTALLIZE_MU_THRESHOLD = 0.3;
/** Период полураспада медленного затухания кристаллизованного интереса (секунды): 30 дней. Интересы стабильнее личностных черт. */
const CRYSTALLIZED_INTEREST_HALFLIFE_S = 2_592_000;
/** Порог исчезновения кристаллизованного интереса: удаляется при confidence ниже этого значения. */
const CRYSTALLIZED_INTEREST_EPSILON = 0.05;
/** ADR-121 Layer 3: Consolidation Hint — порог количества фактов (подсказка срабатывает при ≤ этого значения). */
const CONSOLIDATION_MAX_FACTS = 2;
/** ADR-121 Layer 3: Consolidation Hint — минимальное число взаимодействий (подсказка срабатывает при > этого значения). */
const CONSOLIDATION_MIN_INTERACTIONS = 5;

/**
 * Ожидаемая дневная частота взаимодействий для каждого tier (за FREQUENCY_WINDOW_S секунд = 1 день).
 * ADR-45 калибровка по реальным данным: D1 = 5.6 сообщений/день, D2 = 2.3/день.
 * @see docs/adr/45-real-data-validation.md §5 F5
 * @see docs/adr/46-real-data-calibration.md
 * @see Gilbert & Karahalios (2009) — частота взаимодействий — сильнейший предиктор силы связи
 */
const EXPECTED_FREQUENCY: Record<number, number> = {
  5: 6, // intimate: ~6 interactions/day (типичный близкий приватный чат)
  15: 3, // close friend: ~3/day
  50: 1, // friend: ~1/day
  150: 0.3, // acquaintance: ~раз в 3 дня
  500: 0.1, // known: ~раз в 10 дней
};

/** Трекер эволюции Tier (per-contact). */
interface TierTracker {
  /** Число последовательных высоких оценок. */
  consecutiveHigh: number;
  /** Число последовательных низких оценок. */
  consecutiveLow: number;
  /** Тик последней оценки. */
  lastEvalTick: number;
  /** ADR-110: Время последней оценки (настенные часы, мс). */
  lastEvalMs?: number;
}

/**
 * Вычислить балл эволюции Tier.
 * ADR-47 G9: TierScore = 0.35 × Frequency + 0.25 × Quality + 0.25 × Depth + 0.15 × Trust
 *
 * Калибровка весов: Gilbert & Karahalios (2009) "Predicting tie strength with social media"
 * — частота взаимодействий — сильнейший предиктор силы связи (β=0.35), глубина и качество общения — вторые (по 0.25),
 *   доверие — независимое измерение с наибольшей субъективностью (0.15). Погрешность ≤ 0.039.
 * @see https://doi.org/10.1145/1518701.1518736
 *
 * @param interactionCount - Число взаимодействий за последние 100 тиков
 * @param tier - Текущий tier
 * @param avgQuality - Средняя оценка качества последних действий [-1, 1]
 * @param factCount - Количество фактов
 * @param maxFacts - Лимит фактов
 * @param threadInvolvement - Число активных Thread с участием
 * @param maxThreads - Лимит Thread
 * @param trust - Уровень доверия [0, 1], по умолчанию 0.5
 * @param aliceInitiated - Число инициированных Alice диалогов (накопленное)
 * @param contactInitiated - Число инициированных контактом диалогов (накопленное)
 */
export function tierScore(
  interactionCount: number,
  tier: number,
  avgQuality: number,
  factCount: number,
  maxFacts: number,
  threadInvolvement: number,
  maxThreads: number,
  trust = 0.5,
  aliceInitiated = 0,
  contactInitiated = 0,
): number {
  const expected = EXPECTED_FREQUENCY[tier] ?? 2;
  const frequency = Math.min(1, interactionCount / expected);
  const quality = (avgQuality + 1) / 2; // Нормализация в [0, 1]
  const depth =
    (maxFacts > 0 ? factCount / maxFacts : 0) +
    (maxThreads > 0 ? threadInvolvement / maxThreads : 0);
  const normalizedDepth = Math.min(1, depth / 2); // Нормализация суммы двух составляющих depth

  // Коэффициент взаимности: не позволяет Alice в одностороннем порядке поднять tier высокой активностью.
  // reciprocity = min(1, sqrt(contactInitiated / aliceInitiated))
  // - Баланс двух сторон → 1.0 (нет влияния)
  // - Alice инициирует в 4× чаще → sqrt(1/4) = 0.5 (частотный балл вдвое меньше)
  // - Контакт инициирует чаще → 1.0 (бонус не накапливается)
  // - Суммарно < 5 взаимодействий → не активируется (защита от шума холодного старта)
  // Демпфирование sqrt не слишком строгое (соотношение 2:1 нормально в здоровых отношениях).
  // @see docs/adr/151-algorithm-audit/research-online-calibration.md
  const totalInitiated = aliceInitiated + contactInitiated;
  let reciprocity = 1.0;
  if (totalInitiated >= 5 && aliceInitiated > 0) {
    reciprocity = Math.min(1, Math.sqrt(contactInitiated / aliceInitiated));
  }

  // FIX: reciprocity демпфирует ТОЛЬКО частотный вклад (как и задумано в комментарии выше —
  // «частотный балл вдвое меньше»), а не весь score. Прежняя версия (rawScore * reciprocity)
  // при односторонней переписке (Alice инициирует чаще, чем ей отвечают) рушила trust/quality/depth
  // и ошибочно демотила даже самые близкие связи: владелец с rv_trust=1.0, alice_init=32 vs
  // contact_init=2 → reciprocity=sqrt(2/32)=0.25 → весь score ≤ 0.3 → downgrade до tier 500.
  const rawScore =
    0.35 * (frequency * reciprocity) + 0.25 * quality + 0.25 * normalizedDepth + 0.15 * trust;
  return rawScore;
}

/**
 * Получить следующий более близкий tier (направление повышения).
 * Возвращает null, если уже на самом близком уровне (5).
 */
export function nextCloserTier(currentTier: number): DunbarTier | null {
  const idx = (DUNBAR_TIERS as readonly number[]).indexOf(currentTier);
  if (idx < 0) {
    // Не на стандартной лесенке — найти ближайший более низкий tier (DUNBAR_TIERS по убыванию, первый < currentTier — ближайший)
    for (const t of DUNBAR_TIERS) {
      if (t < currentTier) return t;
    }
    return null;
  }
  return idx < DUNBAR_TIERS.length - 1 ? DUNBAR_TIERS[idx + 1] : null;
}

/**
 * Получить следующий более далёкий tier (направление понижения).
 * Возвращает null, если уже на самом далёком уровне (500).
 */
export function nextFartherTier(currentTier: number): DunbarTier | null {
  const idx = (DUNBAR_TIERS as readonly number[]).indexOf(currentTier);
  if (idx < 0) {
    // Не на стандартной лесенке — найти ближайший более высокий tier (DUNBAR_TIERS по убыванию, первый > currentTier с конца — ближайший)
    for (let i = DUNBAR_TIERS.length - 1; i >= 0; i--) {
      if (DUNBAR_TIERS[i] > currentTier) return DUNBAR_TIERS[i];
    }
    return null;
  }
  return idx > 0 ? DUNBAR_TIERS[idx - 1] : null;
}

interface RelationshipsState {
  /** Текущая цель действия. */
  targetNodeId: string | null;
  /** M2: Структурированный профиль контакта (contactId → profile). */
  contactProfiles: Record<string, ContactProfile>;
  /** M4: Трекер эволюции Tier (contactId → tracker). */
  tierTrackers: Record<string, TierTracker>;
  /** ADR-64 VI-4: Профиль группы (channelId → profile). */
  groupProfiles: Record<string, GroupProfile>;
  /** ADR-208: Счётчик наблюдений в домене interest (ключ = "entityId::interest:label"). */
  interestObsCounts: Record<string, number>;
}

// -- Определение Mod ----------------------------------------------------------

export const relationshipsMod = createMod<RelationshipsState>("relationships", {
  category: "mechanic",
  description: "Профили контактов + определение предпочитаемого языка",
  depends: ["memory"],
  topics: ["social"],
  initialState: {
    targetNodeId: null,
    contactProfiles: {},
    tierTrackers: {},
    groupProfiles: {},
    interestObsCounts: {},
  },
})
  .instruction("set_language", {
    params: z.object({
      contactId: z.string().min(1).describe("ID контакта"),
      language: z.string().min(2).max(10).describe("Код языка (ru, en, etc.)"),
    }),
    description: "Задать предпочитаемый язык контакта",
    examples: ['set_language({ contactId: "u123", language: "zh-CN" })'],
    affordance: {
      whenToUse: "Set a contact's preferred language after detecting it from their messages",
      whenNotToUse: "When language preference is already correct",
      priority: "sensor",
    },
    impl(ctx, args) {
      const contactId = String(args.contactId);
      const lang = String(args.language);
      if (!ctx.graph.has(contactId)) {
        return { success: false, error: `contact not found: ${contactId}` };
      }
      const previous = ctx.graph.getContact(contactId).language_preference;
      ctx.graph.updateContact(contactId, { language_preference: lang });
      return { success: true, contactId, language: lang, previous: previous ?? null };
    },
  })
  /**
   * ADR-43 P1: задать тип отношений с контактом (ортогонально tier).
   * Выводится и вызывается LLM в ходе разговора.
   * Ограничение безопасности: romantic можно задать только при tier ≤ 50.
   * @see docs/adr/43-m1.5-feedback-loop-relation-type.md §P1
   */
  .instruction("set_relation_type", {
    params: z.object({
      contactId: z.string().min(1).describe("ID контакта"),
      relationType: z
        .enum([
          "romantic",
          "close_friend",
          "friend",
          "family",
          "colleague",
          "acquaintance",
          "unknown",
        ])
        .describe(
          "Тип отношений: romantic | close_friend | friend | family | colleague | acquaintance | unknown",
        ),
      reason: z.string().optional().describe("Причина изменения (для журнала аудита)"),
    }),
    description: "Задать тип отношений с контактом (измерение, независимое от tier близости)",
    examples: [
      'set_relation_type({ contactId: "u123", relationType: "friend", reason: "long conversations" })',
    ],
    affordance: {
      whenToUse: "Classify the relationship type when it becomes clear",
      whenNotToUse: "When relationship type hasn't changed",
      priority: "capability",
      category: "social",
    },
    impl(ctx, args) {
      const contactId = String(args.contactId);
      // Zod z.enum([...]) уже проверил допустимые значения
      const relationType = String(args.relationType);

      if (!ctx.graph.has(contactId)) {
        return { success: false, error: `contact not found: ${contactId}` };
      }

      const attrs = ctx.graph.getContact(contactId);
      const currentTier = attrs.tier ?? 150;
      const previous = attrs.relation_type ?? "unknown";

      // Защитное ограничение: romantic требует уровня не ниже friend (tier ≤ 50)
      if (relationType === "romantic" && currentTier > 50) {
        return {
          success: false,
          error: `romantic requires tier ≤ 50 (current: ${currentTier})`,
          suggestion: "Build more familiarity first",
        };
      }

      // Zod z.enum уже проверил, что relationType является допустимым значением RelationType — безопасный cast
      ctx.graph.updateContact(contactId, {
        relation_type: relationType as RelationType,
        relation_type_set_ms: ctx.nowMs,
      });

      // ADR-123: Обновить убеждение tier через структурный канал (автоматически пишет changelog)
      // SET_RELATION_TYPE — явное суждение LLM, используется structural channel (перезапись, σ² → ε)
      // @see paper-pomdp/ Def 3.2
      ctx.graph.beliefs.update(contactId, "tier", currentTier, "structural", ctx.nowMs);

      return {
        success: true,
        contactId,
        previous,
        relationType,
        reason: args.reason ? String(args.reason) : null,
      };
    },
  })
  /**
   * ADR-198 F11: записать активный период контакта.
   * Поля moodBaseline + communicationStyle из прежнего update_contact_profile удалены:
   * - moodBaseline: передача числового значения нарушает семантическую доступность
   * - communicationStyle: полностью перекрывается portrait
   */
  .instruction("note_active_hour", {
    params: z.object({
      contactId: z.string().min(1).describe("ID контакта"),
      hour: z.number().int().min(0).max(23).describe("Наблюдаемый сейчас час активности (0-23)"),
    }),
    description: "Записать текущий час активности контакта (EMA-обновление 24-часовой гистограммы активности)",
    affordance: {
      whenToUse: "Note when a contact is actively chatting to track their active hours pattern",
      whenNotToUse: "When you've already noted their activity this session",
      priority: "capability",
      category: "social",
    },
    impl(ctx, args) {
      const rawContactId = String(args.contactId);
      const telegramNativeId = extractNumericId(rawContactId);
      const contactId =
        resolveDisplayName(ctx.graph, rawContactId) ??
        (telegramNativeId != null
          ? telegramContactId(telegramNativeId)
          : ensureContactId(rawContactId));
      const hour = Number(args.hour);

      if (
        !contactId ||
        !ctx.graph.has(contactId) ||
        ctx.graph.getNodeType(contactId) !== "contact"
      ) {
        return { success: false, error: `contact not found: ${rawContactId}` };
      }

      if (!ctx.state.contactProfiles[contactId]) {
        ctx.state.contactProfiles[contactId] = emptyProfile(ctx.tick, ctx.nowMs);
      }
      const profile = ctx.state.contactProfiles[contactId];
      profile.lastUpdatedTick = ctx.tick;
      profile.lastUpdatedMs = ctx.nowMs;

      // EMA-обновление соответствующего часового слота
      for (let h = 0; h < 24; h++) {
        profile.activeHours[h] *= 1 - ACTIVE_HOURS_ALPHA;
      }
      profile.activeHours[hour] += ACTIVE_HOURS_ALPHA;

      return { success: true, contactId, hour, profile };
    },
  })
  /**
   * ADR-208: пометить интерес/тематический тег контакта или группы.
   * Записывается в BeliefStore interest: домен → кристаллизуется после нескольких наблюдений → постоянный тег + медленный распад за 30 дней.
   * @see docs/adr/208-cognitive-label-interest-domain.md
   */
  .instruction("tag_interest", {
    params: z.object({
      who: z.string().min(1).describe("Имя контакта или название группы"),
      interest: z.string().trim().min(1).max(50).describe("Метка интереса/темы (коротко, например 'AI', 'фотография')"),
    }),
    deriveParams: {
      who: (cv: Record<string, unknown>) => cv.TARGET_CONTACT ?? cv.TARGET_CHAT,
    },
    description: "Tag someone's or a group's interest (reinforced through repeated observation)",
    affordance: {
      whenToUse:
        "Tag a contact's or group's interest when they discuss something they enjoy or focus on",
      whenNotToUse: "When the interest is too vague",
      priority: "capability",
      category: "social",
    },
    impl(ctx, args) {
      const rawWho = String(args.who);
      const entityId = resolveDisplayName(ctx.graph, rawWho) ?? rawWho;

      if (!ctx.graph.has(entityId)) {
        return { success: false, error: `entity not found: ${rawWho}` };
      }
      const nodeType = ctx.graph.getNodeType(entityId);
      if (nodeType !== "contact" && nodeType !== "channel") {
        return { success: false, error: "tag_interest only applies to contacts or channels" };
      }

      // ADR-50: Нормализация тега (выполняется на стороне кода)
      const label = String(args.interest).toLowerCase().trim().replace(/\s+/g, "_");

      // EMA-слияние в BeliefStore (канал semantic, observation=1.0 = одно положительное наблюдение)
      const belief = ctx.graph.beliefs.update(
        entityId,
        `interest:${label}`,
        1.0,
        "semantic",
        ctx.nowMs,
      );

      // Счётчик наблюдений (для условий кристаллизации)
      if (!ctx.state.interestObsCounts) ctx.state.interestObsCounts = {};
      const countKey = `${entityId}::interest:${label}`;
      ctx.state.interestObsCounts[countKey] = (ctx.state.interestObsCounts[countKey] ?? 0) + 1;
      const obsCount = ctx.state.interestObsCounts[countKey];

      // Найти хранилище кристаллизованных интересов
      let crystallized: Record<string, CrystallizedInterest>;
      if (nodeType === "contact") {
        if (!ctx.state.contactProfiles[entityId]) {
          ctx.state.contactProfiles[entityId] = emptyProfile(ctx.tick, ctx.nowMs);
        }
        const profile = ctx.state.contactProfiles[entityId];
        profile.lastUpdatedTick = ctx.tick;
        profile.lastUpdatedMs = ctx.nowMs;
        if (!profile.crystallizedInterests) profile.crystallizedInterests = {};
        crystallized = profile.crystallizedInterests;
      } else {
        if (!ctx.state.groupProfiles) ctx.state.groupProfiles = {};
        if (!ctx.state.groupProfiles[entityId]) {
          ctx.state.groupProfiles[entityId] = emptyGroupProfile();
        }
        if (!ctx.state.groupProfiles[entityId].crystallizedInterests) {
          ctx.state.groupProfiles[entityId].crystallizedInterests = {};
        }
        crystallized = ctx.state.groupProfiles[entityId].crystallizedInterests;
      }

      const existing = crystallized[label];
      if (existing) {
        // Уже кристаллизован → усиление (обновить lastReinforced + confidence)
        existing.lastReinforced = ctx.tick;
        existing.lastReinforcedMs = ctx.nowMs;
        existing.confidence = Math.min(1, belief.mu);
        return {
          success: true,
          entityId,
          label,
          crystallized: true,
          reinforced: true,
          observations: obsCount,
        };
      }

      // Проверка кристаллизации: σ² < threshold && obs >= N && μ > threshold
      if (
        belief.sigma2 < INTEREST_CRYSTALLIZE_SIGMA2 &&
        obsCount >= INTEREST_CRYSTALLIZE_MIN_OBS &&
        belief.mu > INTEREST_CRYSTALLIZE_MU_THRESHOLD
      ) {
        crystallized[label] = {
          label,
          confidence: Math.min(1, belief.mu),
          crystallizedAt: ctx.tick,
          crystallizedAtMs: ctx.nowMs,
          lastReinforced: ctx.tick,
          lastReinforcedMs: ctx.nowMs,
        };
        return {
          success: true,
          entityId,
          label,
          crystallized: true,
          reinforced: false,
          observations: obsCount,
        };
      }

      return { success: true, entityId, label, crystallized: false, observations: obsCount };
    },
  })
  /**
   * M3: записать факт с кривой забывания → узел fact в графе.
   * Факты хранятся как узлы fact, связанные с contact/agent рёбрами "knows".
   * Поддерживает обход по кривой забывания P2.
   */
  .instruction("note", {
    deriveParams: {
      // TARGET_CONTACT уже в правильном формате contact:xxx (разобран buildContextVars).
      // Старая логика преобразования из TARGET_CHAT (channel:xxx) давала неверный формат.
      // @see docs/adr/115-evolve-observability/alice-injection-audit.md §2.4
      contactId: (cv: Record<string, unknown>) => cv.TARGET_CONTACT,
    },
    perTurnCap: 3,
    params: z.object({
      contactId: z.string().min(1).describe("ID контакта ('self' = сама Алиса)"),
      fact: z.string().trim().min(1).max(500).describe("Описание факта"),
      type: z
        .enum(["interest", "preference", "skill", "growth", "observation", "general"])
        .optional()
        .describe("Тип факта (interest/preference/skill/growth/observation/general)"),
    }),
    description: "Записать факт с кривой забывания (хранится как узел fact в графе)",
    examples: ['self_note({ fact: "likes cats", type: "preference" })'],
    affordance: {
      priority: "sensor",
      whenToUse: "Learning new facts about contacts worth remembering",
      whenNotToUse: "No new personal information shared",
    },
    impl(ctx, args) {
      // ADR-204 C10: LLM может передать display_name — код разрешает его в nodeId
      const rawId = String(args.contactId);
      const contactId = resolveDisplayName(ctx.graph, rawId) ?? rawId;
      // Zod z.string().trim().min(1).max(500) гарантирует непустую trimmed строку
      const content = String(args.fact);

      const factType = args.type ? String(args.type) : "general";

      // ADR-47 G6: Нормализация для дедупликации (нестрогое: без учёта регистра + пробелов)
      const normalized = normalizeFactContent(content);
      const existingFacts = getContactFacts(ctx.graph, contactId);
      const existing = existingFacts.find(
        (f) => normalizeFactContent(f.attrs.content ?? "") === normalized,
      );
      if (existing) {
        // Повторное упоминание → пассивное усиление: stability × 1.2, last_access обновляется.
        // Высокостабильные факты (preference S=40) становятся ещё стабильнее при повторении (S→48→57.6…),
        // низкостабильные (observation S=1) тоже удлиняют период полураспада (S→1.2→1.44…).
        ctx.graph.updateFact(existing.id, {
          last_access_ms: ctx.nowMs,
          stability: existing.attrs.stability * STABILITY_REINFORCE_FACTOR,
          reinforcement_count: (existing.attrs.reinforcement_count ?? 1) + 1,
        });
        return {
          success: true,
          contactId,
          isDuplicate: true,
          reinforced: true,
          factCount: existingFacts.length,
        };
      }

      // Создать узел fact + ребро knows
      const iid = nextFactId();
      // ADR-69 T2.4: поле source различает создание LLM и автоматическое создание через perceive
      // ADR-104: source_channel выводится из текущей цели действия
      const sourceChannel = ctx.state.targetNodeId ?? undefined;
      // ADR-156: факты типа observation несут эмоциональную реактивность (свежее наблюдение обычно окрашено эмоционально).
      // Остальные типы (interest/preference/skill/general) считаются нейтральными фактами, reactivity не задаётся.
      const isEmotionalFact = factType === "observation";
      // Непрерывный спектр стабильности: начальная stability определяется fact_type.
      // preference/skill (S₀=40) → период полураспада ~3 года; observation (S₀=1) → ~27 дней.
      const initialStability = factTypeInitialStability(factType);
      ctx.graph.addFact(iid, {
        content,
        fact_type: factType,
        importance: 0.5,
        stability: initialStability,
        last_access_ms: ctx.nowMs,
        volatility: 0,
        tracked: false,
        created_ms: ctx.nowMs,
        novelty: 1.0,
        reinforcement_count: 1,
        source_contact: contactId,
        source_channel: sourceChannel,
        source: "llm",
        ...(isEmotionalFact && { reactivity: 1.0, reactivity_ms: ctx.nowMs }),
      });
      ctx.graph.addRelation(contactId, "knows", iid);

      // Контроль ёмкости: self — 50 записей, остальные — 20. При превышении вытесняется узел с наименьшим R.
      // В непрерывном спектре стабильности R значим для всех fact_type: высокостабильные факты
      // имеют более высокий R и защищены от вытеснения; низкостабильные + старые — более низкий R, вытесняются первыми.
      const allFacts = getContactFacts(ctx.graph, contactId);
      const limit = contactId === ALICE_SELF ? SELF_FACTS_LIMIT : CONTACT_FACTS_LIMIT;
      while (allFacts.length > limit) {
        let worstIdx = 0;
        let worstR = Number.MAX_VALUE;
        for (let i = 0; i < allFacts.length; i++) {
          const r = factRetrievabilityFromNode(allFacts[i].attrs, ctx.nowMs);
          if (r < worstR) {
            worstR = r;
            worstIdx = i;
          }
        }
        ctx.graph.removeEntity(allFacts[worstIdx].id);
        allFacts.splice(worstIdx, 1);
      }

      // ADR-204: Усиление потока сознания — reinforce связанных событий памяти
      try {
        reinforceConsciousness(getDb(), [contactId], 0.1);
      } catch {
        /* non-critical */
      }

      return { success: true, contactId, isDuplicate: false, factCount: allFacts.length };
    },
  })
  /**
   * M3: обратиться к факту — обновить last_access и stability (механизм консолидации).
   * Вызывается, когда LLM ссылается на факт в своём ответе.
   */
  .instruction("recall_fact", {
    params: z.object({
      contactId: z.string().min(1).describe("ID контакта"),
      fact: z.string().min(1).describe("Содержание упомянутого факта"),
    }),
    description: "Отметить, что факт был упомянут — закрепляет память (stability × 1.5)",
    affordance: {
      whenToUse: "Reinforce a memory when you reference it in conversation",
      whenNotToUse: "When the fact wasn't actually used",
      priority: "on-demand",
      category: "memory",
    },
    impl(ctx, args) {
      const contactId = String(args.contactId);
      const content = String(args.fact).trim();
      const facts = getContactFacts(ctx.graph, contactId);
      if (facts.length === 0) return { success: false, error: "no facts for contact" };

      // G6: Нормализованное сопоставление
      const normalized = normalizeFactContent(content);
      const fact = facts.find((f) => normalizeFactContent(f.attrs.content ?? "") === normalized);
      if (!fact) return { success: false, error: "fact not found" };

      const oldStability = fact.attrs.stability;
      const newStability = oldStability * FACT_CONSOLIDATION_FACTOR;
      ctx.graph.updateFact(fact.id, {
        last_access_ms: ctx.nowMs,
        stability: newStability,
      });

      return {
        success: true,
        contactId,
        content,
        oldStability,
        newStability,
        retrievability: factRetrievabilityFromNode(
          { ...fact.attrs, last_access_ms: ctx.nowMs, stability: newStability },
          ctx.nowMs,
        ),
      };
    },
  })
  /**
   * ADR-47 G2: изменить содержимое записанного факта.
   * Сохраняет stability и created, обновляет содержимое и last_access.
   * Если новое содержимое совпадает с другим фактом, выполняет слияние (берёт максимальный stability, суммирует reinforcement_count).
   */
  .instruction("update_fact", {
    params: z.object({
      contactId: z.string().min(1).describe("ID контакта ('self' = сама Алиса)"),
      oldContent: z.string().min(1).describe("Содержание факта, который нужно изменить (нормализованное сопоставление)"),
      newContent: z.string().trim().min(1).max(500).describe("Новое содержание факта"),
    }),
    description: "Изменить содержание уже записанного факта. Сохраняет stability, обновляет содержание и last_access.",
    affordance: {
      whenToUse: "Correct or update a previously remembered fact",
      whenNotToUse: "When the existing fact is still accurate",
      priority: "capability",
      category: "memory",
    },
    impl(ctx, args) {
      const contactId = String(args.contactId);
      const oldNorm = normalizeFactContent(String(args.oldContent));
      // Zod .trim().min(1).max(500) гарантирует непустую trimmed строку
      const newContent = String(args.newContent);

      const facts = getContactFacts(ctx.graph, contactId);
      if (facts.length === 0) return { success: false, error: "no facts for contact" };

      const target = facts.find((f) => normalizeFactContent(f.attrs.content ?? "") === oldNorm);
      if (!target) return { success: false, error: "fact not found" };

      // Проверить, не дублирует ли новое содержимое другой факт
      const newNorm = normalizeFactContent(newContent);
      const dup = facts.find(
        (f) => f.id !== target.id && normalizeFactContent(f.attrs.content ?? "") === newNorm,
      );
      if (dup) {
        // Слияние: удалить target, обновить dup
        const mergedStability = Math.max(dup.attrs.stability, target.attrs.stability);
        const mergedRc =
          (dup.attrs.reinforcement_count ?? 1) + (target.attrs.reinforcement_count ?? 1);
        ctx.graph.updateFact(dup.id, {
          stability: mergedStability,
          last_access_ms: ctx.nowMs,
          reinforcement_count: mergedRc,
        });
        ctx.graph.removeEntity(target.id);
        return { success: true, merged: true, factCount: facts.length - 1 };
      }

      ctx.graph.updateFact(target.id, {
        content: newContent,
        last_access_ms: ctx.nowMs,
      });
      return { success: true, contactId, factCount: facts.length };
    },
  })
  /**
   * ADR-47 G2: удалить записанный факт.
   * Используется для очистки устаревшей или ошибочной информации. Нормализованное сопоставление.
   */
  .instruction("delete_fact", {
    params: z.object({
      contactId: z.string().min(1).describe("ID контакта"),
      content: z.string().min(1).describe("Содержание факта, который нужно удалить (нормализованное сопоставление)"),
    }),
    description: "Удалить записанный факт. Для очистки устаревшей или ошибочной информации.",
    affordance: {
      whenToUse: "Remove a fact that's no longer true or relevant",
      whenNotToUse: "When the fact is still valid",
      priority: "on-demand",
      category: "memory",
    },
    impl(ctx, args) {
      const contactId = String(args.contactId);
      const norm = normalizeFactContent(String(args.content));

      const facts = getContactFacts(ctx.graph, contactId);
      if (facts.length === 0) return { success: false, error: "no facts for contact" };

      const target = facts.find((f) => normalizeFactContent(f.attrs.content ?? "") === norm);
      if (!target) return { success: false, error: "fact not found" };

      const deleted = target.attrs.content ?? "";
      ctx.graph.removeEntity(target.id);
      return { success: true, deleted, factCount: facts.length - 1 };
    },
  })
  /** Установить текущую цель действия (вызывается из act.ts). */
  .instruction("SET_CONTACT_TARGET", {
    params: z.object({
      nodeId: z.string().optional().describe("ID целевого узла"),
    }),
    description: "Установить текущую цель действия (контакт)",
    impl(ctx, args) {
      ctx.state.targetNodeId = args.nodeId ? String(args.nodeId) : null;
      return ctx.state.targetNodeId;
    },
  })
  // ADR-198 F8: update_trust удалён. Доверие теперь единообразно управляется через rv_trust (атрибут графа),
  // накапливается неявно через rate_outcome / self_sense.
  /**
   * ADR-64 VI-3: сформировать нарративное сводное впечатление о контакте.
   * Вызывается LLM в Reflection, синтезирует разрозненные facts + profile в связное впечатление из 2-3 предложений.
   */
  .instruction("synthesize_portrait", {
    params: z.object({
      contactId: z.string().min(1).describe("ID контакта"),
      portrait: z.string().trim().min(1).max(2000).describe("Сводное впечатление (2-3 предложения естественным языком)"),
    }),
    description: "Сформировать сводное впечатление о контакте (Living Portrait)",
    affordance: {
      whenToUse: "Write or update a living portrait summarizing your impression of someone",
      whenNotToUse: "When portrait is still fresh and accurate",
      priority: "on-demand",
      category: "social",
    },
    impl(ctx, args) {
      const contactId = String(args.contactId);
      // Zod .trim().min(1).max(2000) гарантирует непустую trimmed строку
      const portrait = String(args.portrait);

      if (!ctx.state.contactProfiles[contactId]) {
        ctx.state.contactProfiles[contactId] = emptyProfile(ctx.tick, ctx.nowMs);
      }
      const profile = ctx.state.contactProfiles[contactId];
      profile.portrait = portrait;
      profile.portraitTick = ctx.tick;
      profile.portraitMs = ctx.nowMs;
      profile.lastUpdatedTick = ctx.tick;
      profile.lastUpdatedMs = ctx.nowMs;

      return { success: true, contactId, portraitTick: ctx.tick };
    },
  })
  /**
   * ADR-64 VI-4: обновить portrait группы.
   * Вызывается LLM в Reflection, фиксирует тему, атмосферу, роль Алисы и ключевых участников группы.
   */
  .instruction("update_group_profile", {
    params: z.object({
      channelId: z.string().min(1).describe("ID канала"),
      topic: z.string().trim().optional().describe("Тема/направление обсуждений группы"),
      atmosphere: z.string().trim().optional().describe("Социальная атмосфера группы"),
      aliceRole: z.string().trim().optional().describe("Роль Алисы в этой группе"),
      memberHighlights: z.string().trim().optional().describe("Описание ключевых участников"),
    }),
    description: "Обновить профиль группы (тема, атмосфера, роль, участники)",
    affordance: {
      whenToUse: "Describe or update a group's topic, atmosphere, and your role in it",
      whenNotToUse: "When group profile is still fresh",
      priority: "on-demand",
      category: "social",
    },
    impl(ctx, args) {
      const channelId = String(args.channelId);

      if (!ctx.state.groupProfiles) ctx.state.groupProfiles = {};
      if (!ctx.state.groupProfiles[channelId]) {
        ctx.state.groupProfiles[channelId] = emptyGroupProfile();
      }
      const gp = ctx.state.groupProfiles[channelId];

      // Zod .trim().optional() уже выполнил trim
      if (args.topic != null) gp.topic = String(args.topic) || null;
      if (args.atmosphere != null) gp.atmosphere = String(args.atmosphere) || null;
      if (args.aliceRole != null) gp.aliceRole = String(args.aliceRole) || null;
      if (args.memberHighlights != null)
        gp.memberHighlights = String(args.memberHighlights) || null;
      gp.portraitTick = ctx.tick;
      gp.portraitMs = ctx.nowMs;

      return { success: true, channelId, profile: gp };
    },
  })
  .query("contact_profile", {
    params: z.object({
      contactId: z.string().min(1).optional().describe("ID контакта (если опущен — текущий контакт)"),
    }),
    deriveParams: {
      contactId: (cv: Record<string, unknown>) => cv.TARGET_CONTACT,
    },
    description: "Получить профиль контакта (включая структурированный profile)",
    affordance: {
      priority: "capability",
      category: "social",
      whenToUse: "Need contact profile, facts, or relationship info",
      whenNotToUse: "Already know the person well from context",
    },
    returns:
      "{ contactId: string; displayName: string; tier: number; memorizedFacts: Array<{ content: string; fact_type: string; retrievability: number }> } | null",
    returnHint: "{displayName, tier, lang, facts: [{content, type, clarity}]}",
    impl(ctx, args) {
      normalizeContactProfileKeys(ctx.graph, ctx.state);
      const contactId = resolveContactId(ctx.graph, String(args.contactId));
      if (!contactId) return null;

      const attrs = ctx.graph.getContact(contactId);

      // M3: Вернуть memorized facts + retrievability из узлов графа
      const facts = getContactFacts(ctx.graph, contactId);
      const memorizedWithR = facts.map((f) => ({
        content: f.attrs.content ?? "",
        fact_type: f.attrs.fact_type ?? "general",
        stability: f.attrs.stability,
        last_access_ms: f.attrs.last_access_ms,
        created_ms: f.attrs.created_ms,
        reinforcement_count: f.attrs.reinforcement_count ?? 1,
        retrievability: factRetrievabilityFromNode(f.attrs, ctx.nowMs),
        // ADR-156: Эмоциональная реактивность E(t) для модуляции отображения в prompt
        emotionalReactivity: factEmotionalReactivity(f.attrs, ctx.nowMs),
      }));

      // ADR-198 F7c: Предварительно вычислить метку trust в impl (format не получает ctx)
      const rvTrust = readRV(attrs).trust;
      const trustLabel =
        rvTrust >= 0.8
          ? "deeply trusted"
          : rvTrust >= 0.6
            ? "trusted"
            : rvTrust >= 0.4
              ? "somewhat trusted"
              : rvTrust >= 0.25
                ? "cautious"
                : "guarded";

      return {
        contactId,
        displayName: safeDisplayName(ctx.graph, contactId),
        language: attrs.language_preference ?? null,
        interactionCount: attrs.interaction_count ?? 0,
        tier: attrs.tier ?? 50,
        memorizedFacts: memorizedWithR,
        profile: ctx.state.contactProfiles[contactId] ?? null,
        trustLabel,
      };
    },
    format(result) {
      const r = result as Record<string, unknown>;
      const interactions = Number(r.interactionCount ?? 0);
      const interactionDesc =
        interactions >= 100
          ? "many conversations"
          : interactions >= 30
            ? "several conversations"
            : interactions >= 10
              ? "some conversations"
              : "few conversations";
      const meta = [
        tierLabel(Number(r.tier ?? 50)),
        r.language ? `speaks ${r.language}` : null,
        interactionDesc,
      ]
        .filter(Boolean)
        .join(", ");
      const m = new PromptBuilder();
      m.line(`${r.displayName} — ${meta}`);

      const facts = r.memorizedFacts as Array<Record<string, unknown>> | undefined;
      if (facts?.length) {
        m.line("Facts:");
        for (const f of facts) {
          const rv = Number(f.retrievability);
          const ev = Number(f.emotionalReactivity ?? 0);
          // ADR-156: Модуляция метки clarity через эмоциональную реактивность.
          // E > VIVID_THRESHOLD → использовать эмоционально-ориентированные метки (vivid/noted)
          // E ≤ NOTED_THRESHOLD → откат к информационной метке clarity (без эмоционального подтекста)
          // Эффект: один и тот же факт через 2ч меняется с (vivid) на (noted), через 4ч — только информация
          let clarity: string;
          if (ev > EMOTIONAL_VIVID_THRESHOLD) {
            clarity = "vivid";
          } else if (ev > EMOTIONAL_NOTED_THRESHOLD) {
            clarity = "noted";
          } else {
            // Чисто информационная метка clarity, без эмоционального подтекста
            clarity = rv > 0.7 ? "clear" : rv > 0.4 ? "fading" : rv > 0.15 ? "dim" : "distant";
          }
          m.list([`[${f.fact_type}] ${f.content} (${clarity})`]);
        }
      }

      const profile = r.profile as Record<string, unknown> | null;
      if (profile) {
        if (profile.portrait) m.kv("Portrait", String(profile.portrait));
        // ADR-208: Приоритет — кристаллизованные интересы
        const ci208 = Object.values(
          (profile.crystallizedInterests as Record<string, CrystallizedInterest> | undefined) ?? {},
        )
          .sort((a, b) => b.confidence - a.confidence)
          .slice(0, 5);
        if (ci208.length > 0) {
          m.kv("Interests", ci208.map((i) => i.label).join(", "));
        } else {
          const interests = profile.interests as string[] | undefined;
          if (interests?.length) m.kv("Interests", interests.join(", "));
        }
      }
      // ADR-198 F7c: метка trust предварительно вычислена в impl (на основе rv_trust), profile.trust больше не читается
      if (r.trustLabel) m.kv("Trust", String(r.trustLabel));
      return m.build();
    },
  })
  .query("language_of", {
    params: z.object({
      contactId: z.string().min(1).optional().describe("ID контакта (если опущен — текущий контакт)"),
    }),
    deriveParams: {
      contactId: (cv: Record<string, unknown>) => cv.TARGET_CONTACT,
    },
    description: "Получить предпочитаемый язык контакта",
    affordance: {
      whenToUse: "Check what language a contact prefers",
      whenNotToUse: "When you already know their language",
      priority: "core",
    },
    returns: "string | null",
    impl(ctx, args) {
      const contactId = resolveContactId(ctx.graph, String(args.contactId));
      if (!contactId) return null;
      return ctx.graph.getContact(contactId).language_preference ?? null;
    },
  })
  /**
   * ADR-47 G5: вернуть час пиковой активности контакта с наибольшим tier.
   * Определяется как argmax из ContactProfile.activeHours (EMA-массив из 24 слотов).
   * Используется в evolve.ts для обучающегося ритма.
   * @see docs/adr/47-gap-closure.md §G5
   */
  .query("best_time", {
    params: z.object({}),
    description: "Вернуть час пиковой активности самого близкого (по tier) контакта",
    affordance: {
      whenToUse: "Find out when your closest contact is usually active",
      whenNotToUse: "When timing doesn't matter for the current action",
      priority: "capability",
      category: "contact_info",
    },
    returns: "{ peakHour: number | undefined }",
    impl(ctx) {
      normalizeContactProfileKeys(ctx.graph, ctx.state);
      let bestTier = Number.POSITIVE_INFINITY;
      let bestProfile: ContactProfile | undefined;
      for (const [contactId, profile] of Object.entries(ctx.state.contactProfiles)) {
        if (!profile.activeHours || profile.activeHours.length !== 24) continue;
        const tier = ctx.graph.has(contactId) ? (ctx.graph.getContact(contactId).tier ?? 500) : 500;
        if (tier < bestTier) {
          bestTier = tier;
          bestProfile = profile;
        }
      }
      if (!bestProfile?.activeHours) return { peakHour: undefined };
      // Проверить, есть ли хотя бы одно ненулевое значение (все нули = нет данных)
      const maxVal = Math.max(...bestProfile.activeHours);
      if (maxVal <= 0) return { peakHour: undefined };
      let peakHour = 14; // по умолчанию
      let peakVal = -1;
      for (let h = 0; h < 24; h++) {
        if (bestProfile.activeHours[h] > peakVal) {
          peakVal = bestProfile.activeHours[h];
          peakHour = h;
        }
      }
      return { peakHour };
    },
  })
  .contribute((ctx): ContributionItem[] => {
    normalizeContactProfileKeys(ctx.graph, ctx.state);
    const target = ctx.state.targetNodeId;
    const items: ContributionItem[] = [];

    // 1. Инжекция Self-knowledge (инжектируется всегда, независимо от наличия цели)
    const mSelf = new PromptBuilder();

    // ADR-41: memorized self facts — инжекция top-N предотвращает эхо-камеру запись–чтение
    // Непрерывный спектр стабильности: единая сортировка по R (R уже учитывает разницу стабильности fact_type).
    const selfFacts = getContactFacts(ctx.graph, ALICE_SELF);
    if (selfFacts.length > 0) {
      // Фильтровать извлекаемые факты по R, сортировать по R, выбрать top-N
      const retrievableSelf = selfFacts
        .filter((f) => factRetrievabilityFromNode(f.attrs, ctx.nowMs) >= FACT_FORGET_THRESHOLD)
        .sort(
          (a, b) =>
            factRetrievabilityFromNode(b.attrs, ctx.nowMs) -
            factRetrievabilityFromNode(a.attrs, ctx.nowMs),
        );
      // ADR-196 F7: Анонимные строки Activity не рендерятся — "Activity: 3 messages in (a group)" несёт нулевую информацию для решений
      const ANON_MARKERS = ["(a group)", "(a private chat)", "(someone)", "(unknown)"];
      const isAnonymousActivity = (content: string) =>
        content.startsWith("Activity:") && ANON_MARKERS.some((m) => content.includes(m));
      const topSelf = retrievableSelf
        .filter((f) => !isAnonymousActivity(f.attrs.content ?? ""))
        .slice(0, MAX_INJECTED_SELF_FACTS);
      // ADR-66 F15: Снятие меток — принцип CowAgent «используй память естественно, как будто сам знал».
      // RC2 fix: временная метка даёт LLM понять, когда была сделана self-note
      mSelf.list(
        topSelf.map((f) => {
          const content = f.attrs.content ?? "";
          const createdMs = f.attrs.created_ms ?? 0;
          const agoS = createdMs > 0 ? (ctx.nowMs - createdMs) / 1000 : 0;
          if (agoS > 0) {
            return `${content} — ${humanDurationAgo(agoS)}`;
          }
          return content;
        }),
      );
      const selfRemaining = retrievableSelf.length - topSelf.length;
      if (selfRemaining > 0) {
        mSelf.line(`(${selfRemaining} more self-notes — they'll come to mind when relevant)`);
      }
    }

    const selfLines = mSelf.build();
    if (selfLines.length > 0) {
      items.push(section("self-knowledge", selfLines, "Self-notes", 18, 72));
    }

    if (!target) return items;

    // 2. Профиль целевого контакта (расширенный: полная инжекция фактов)
    const { contactId, channelId } = resolveContactAndChannel(target, (id) => ctx.graph.has(id));

    // ADR-206: Профиль контакта не рендерится для target-канала (канал — не социальный партнёр)
    const targetChatType =
      channelId && ctx.graph.has(channelId) ? ctx.graph.getChannel(channelId).chat_type : undefined;
    if (targetChatType === "channel") {
      // ADR-206 W8: Инжектировать компактную социальную панораму — помогает Alice выбрать цель пересылки в тик канала
      // @see docs/adr/206-channel-information-flow/ §12 консолидация ответственности за пересылку
      const panorama = buildSocialPanorama(
        ctx.graph,
        ctx.state.contactProfiles,
        ctx.state.groupProfiles ?? {},
        ctx.nowMs,
        ctx.targetWhitelist ?? null,
      );
      if (panorama.length > 0) {
        items.push(section("social-panorama", panorama, "People you might share with", 24, 65));
      }
      return items;
    }

    if (contactId && ctx.graph.has(contactId)) {
      const attrs = ctx.graph.getContact(contactId);

      // ADR-91 Layer 3: Функциональный рендеринг для бота-контакта (без портрета личности и formality)
      if (attrs.is_bot === true) {
        const displayName = safeDisplayName(ctx.graph, contactId);
        const botLines = [
          PromptBuilder.of(
            `${displayName} is a bot. Use commands to interact — no social conversation needed.`,
          ),
        ];
        items.push(section("contact-profile", botLines, undefined, 25, 75));
        return items;
      }

      const mContact = new PromptBuilder();

      // --- P1-A: Нарративный прозаический портрет (ADR-55) ---
      // @see docs/adr/55-prompt-style-research — нарративный движок №95 + CowAgent естественная память
      const displayName = safeDisplayName(ctx.graph, contactId);
      const tier = attrs.tier ?? 50;
      // ADR-43: Комбинированный показ tier + relationType
      const relationType = attrs.relation_type ?? "unknown";
      const tierDesc = tierLabel(tier);
      const relationDesc = relationType !== "unknown" ? `${tierDesc} (${relationType})` : tierDesc;

      const profile = ctx.state.contactProfiles[contactId];
      // ADR-198 F7b: Мигрировано на rv_trust (атрибут графа), заменяет profile.trust (старый скаляр)
      const trustVal = readRV(attrs).trust;

      // ADR-66 F14: Основная идентификация переведена на естественный язык без числа tier и метки trust.
      // Органичная структура: LLM чувствует близость отношений, не зная внутренних оценок системы.
      // ADR-198: Нижняя граница изменена с <= 0.3 на < 0.25 (rv_trust начальное значение = 0.3, чтобы новые контакты не отображались как "still getting to know")
      const trustPhrase =
        trustVal >= 0.7
          ? " you trust deeply"
          : trustVal < 0.25
            ? " you're still getting to know"
            : "";
      const interactionCount = attrs.interaction_count ?? 0;
      const historyPhrase =
        interactionCount > 50
          ? " Long history together."
          : interactionCount > 10
            ? " Plenty of conversation history."
            : "";
      mContact.line(`Talking to ${displayName} — ${relationDesc}${trustPhrase}.${historyPhrase}`);

      // ADR-151 T3: Динамическая вежливость — инжекция тональных рекомендаций по tier
      const toneTemplate = TIER_TONE_GUIDANCE[tier];
      if (toneTemplate) {
        mContact.line(`tone: ${toneTemplate.replace("{name}", displayName)}`);
      }

      // Вторая строка: язык (ADR-198: communicationStyle удалён, пересекается с portrait)
      if (attrs.language_preference) {
        mContact.line(`They communicate in ${attrs.language_preference}.`);
      }

      // Третья строка: интересы (ADR-208: приоритет — кристаллизованные, fallback — старый interests[])
      if (profile) {
        const ci = Object.values(profile.crystallizedInterests ?? {})
          .sort((a, b) => b.confidence - a.confidence)
          .slice(0, 5);
        if (ci.length > 0) {
          mContact.line(`Noticed interests: ${ci.map((i) => i.label).join(", ")}.`);
        } else if (profile.interests.length > 0) {
          mContact.line(`Into ${profile.interests.join(", ")}.`);
        }
      }

      // Четвёртая строка: часы активности + изменение расписания (ADR-198: рендеринг moodBaseline удалён)
      if (profile) {
        const peakHour = profile.activeHours.indexOf(Math.max(...profile.activeHours));
        const peakVal = profile.activeHours[peakHour];
        if (peakVal > 0) {
          mContact.line(`They are most active around ${peakHour}:00.`);
        }
        if (profile.scheduleShift) {
          mContact.line(`Schedule change detected: ${profile.scheduleShift}.`);
        }
      }

      // --- ADR-89: Рендеринг кристаллизованных черт ---
      // Отображать кристаллизованные черты характера перед Portrait, до 5 штук, по убыванию |value|.
      // @see docs/adr/89-impression-formation-system.md §Wave 2C
      if (profile && Object.keys(profile.traits).length > 0) {
        const sorted = Object.entries(profile.traits)
          .sort(([, a], [, b]) => Math.abs(b.value) - Math.abs(a.value))
          .slice(0, 5);
        const traitLabels = sorted.map(([dim, t]) => {
          const prefix = Math.abs(t.value) < 0.4 ? "a bit " : "";
          return `${prefix}${t.value > 0 ? dim : `not very ${dim}`}`;
        });
        mContact.line(`Character traits noticed: ${traitLabels.join(", ")}`);
      }

      // --- ADR-64 VI-3: Living Portrait ---
      if (profile?.portrait) {
        mContact.kv("Portrait", profile.portrait);
      }

      // --- P1-B: Подсказки для ссылок на память (ADR-55) ---
      // @see docs/adr/55-prompt-style-research — №126 "дефект как подсказка"
      // Непрерывный спектр стабильности: единая сортировка по R (R уже учитывает разницу стабильности fact_type).
      const contactFacts = getContactFacts(ctx.graph, contactId);
      if (contactFacts.length > 0) {
        const retrievableFacts = contactFacts
          .filter((f) => factRetrievabilityFromNode(f.attrs, ctx.nowMs) >= FACT_FORGET_THRESHOLD)
          .sort(
            (a, b) =>
              factRetrievabilityFromNode(b.attrs, ctx.nowMs) -
              factRetrievabilityFromNode(a.attrs, ctx.nowMs),
          );
        const fadingFacts = contactFacts.filter(
          (f) => factRetrievabilityFromNode(f.attrs, ctx.nowMs) < FACT_FORGET_THRESHOLD,
        );

        if (retrievableFacts.length > 0) {
          const topFacts = retrievableFacts.slice(0, MAX_INJECTED_FACTS);
          // ADR-66 F4: Показ отдельными пунктами во избежание lost-in-the-middle.
          // Принцип CowAgent: «Используй память естественно, как будто сам знал».
          // ADR-69: Атрибуционный рендеринг — "Your notes" + "you noted this" замыкает причинно-следственную петлю восприятия
          mContact.line("notes:");
          for (const f of topFacts) {
            // ADR-121 Layer 1: Атрибуция источника — показать канал-источник факта
            // RC2 fix: временная метка даёт LLM понять, когда был записан факт, предотвращает повторные remember()
            const createdMs = f.attrs.created_ms ?? 0;
            const agoS = createdMs > 0 ? (ctx.nowMs - createdMs) / 1000 : 0;
            const agoLabel = agoS > 0 ? humanDurationAgo(agoS) : "";
            let suffix = agoLabel ? `noted ${agoLabel}` : "you noted this";
            if (f.attrs.source_channel && ctx.graph.has(f.attrs.source_channel)) {
              const chName = ctx.graph.getChannel(f.attrs.source_channel).display_name;
              if (chName)
                suffix = agoLabel ? `noticed in ${chName}, ${agoLabel}` : `noticed in ${chName}`;
            }
            mContact.line(`- ${f.attrs.content} — ${suffix}`);
          }
          const remaining = retrievableFacts.length - topFacts.length;
          if (remaining > 0) {
            mContact.line(`(${remaining} more notes — they'll come to mind when relevant)`);
          }
        } else if (fadingFacts.length > 0) {
          mContact.line(
            `${fadingFacts.length} older memories are getting fuzzy — consider recalling important ones.`,
          );
        }
      }

      // ADR-66: При отсутствии фактов использовать фактическое описание, а не инструкцию.
      if (contactFacts.length === 0) {
        mContact.line("Not much known about them yet.");
      }

      items.push(section("contact-profile", mContact.build(), undefined, 25, 75));

      // ADR-180: Самодиагностика эскалации consecutive_caution_acts удалена — IAUS свернул Caution
      // в общий U_conflict_avoidance Consideration, тип действия "caution" больше не генерируется.

      // -- Formative Memories: Инжекция контекста первого взаимодействия --
      // При первом реальном диалоге Alice с новым контактом собирает его исторические
      // сообщения из message_log общих групповых чатов и инжектирует их в contribute(),
      // чтобы LLM естественно сформировал начальное впечатление.
      // @see docs/adr/86-voyager-concordia-cross-analysis.md §C5 Formative Memories
      if (contactFacts.length === 0 && interactionCount <= 2) {
        try {
          const senderMessages = getRecentMessagesBySender(contactId, 15);
          if (senderMessages.length > 0) {
            const mFirstImpression = new PromptBuilder();
            mFirstImpression.line(
              `You've seen ${displayName} in shared chats. Here's what they said recently:`,
            );
            for (const msg of senderMessages) {
              if (!msg.text) continue;
              // ADR-172: Использовать safeDisplayName — никогда не возвращает raw graph ID
              const chatLabel = safeDisplayName(ctx.graph, msg.chatId);
              const truncated = msg.text.length > 150 ? `${msg.text.slice(0, 147)}...` : msg.text;
              mFirstImpression.line(`[${chatLabel}] "${truncated}"`);
            }
            mFirstImpression.line(
              "This is your first real conversation with them. Pay attention — use self note for facts and self sense for personality traits you notice.",
            );
            items.push(section("first-impression", mFirstImpression.build(), undefined, 26, 70));
          }
        } catch {
          // Пропустить, если DB недоступна (тестовое окружение и т.д.)
        }
      }

      // -- ADR-121 Layer 3: Consolidation Hint — направляет LLM консолидировать кросс-групповые эпизоды --
      // Условие срабатывания: мало фактов + достаточно взаимодействий + есть общие каналы не в приватном чате
      // @see docs/adr/121-social-peripheral-vision/README.md §3.4 Layer 3
      if (
        contactFacts.length <= CONSOLIDATION_MAX_FACTS &&
        interactionCount > CONSOLIDATION_MIN_INTERACTIONS
      ) {
        const sharedChannels = ctx.graph.getNeighbors(contactId, "joined").filter((chId) => {
          if (!ctx.graph.has(chId)) return false;
          const chAttrs = ctx.graph.getChannel(chId);
          return chAttrs.chat_type !== "private";
        });
        if (sharedChannels.length > 0) {
          items.push(
            section(
              "consolidation-hint",
              [
                PromptBuilder.of(
                  `You've seen ${displayName} around but have few notes. Use self note to capture what matters.`,
                ),
              ],
              undefined,
              27,
              55,
            ),
          );
        }
      }

      // Spreading Activation: ассоциативная память — факты, топологически связанные с целью, но не напрямую
      // @see paper/ §3.4 "Pressure Propagation via Weighted Laplacian"
      const seedEntities = [contactId, ...(channelId ? [channelId] : [])].filter((id) =>
        ctx.graph.has(id),
      );
      const activationHits = activationRetrieval(ctx.graph, seedEntities, ctx.nowMs);
      if (activationHits.length > 0) {
        // Исключить уже отображённые в contactFacts
        const directFactIds = new Set(contactFacts.map((f) => f.id));
        const associatedFacts = activationHits
          .filter((h) => !directFactIds.has(h.entityId) && ctx.graph.has(h.entityId))
          .slice(0, 3);
        if (associatedFacts.length > 0) {
          const mAssoc = new PromptBuilder();
          for (const hit of associatedFacts) {
            const content = ctx.graph.getDynamic(hit.entityId, "content");
            if (content) mAssoc.line(`- ${content}`);
          }
          const assocLines = mAssoc.build();
          if (assocLines.length > 0) {
            items.push(
              section(
                "associated-memories",
                assocLines,
                "Related things that come to mind:",
                26,
                40,
              ),
            );
          }
        }
      }

      // ADR-43: Напоминание о выводе relationType
      // ADR-81: Управление по давлению — подсказка классификации отношений при низком давлении
      // @see docs/adr/81-reflection-separation.md §Вклад Mod переведён с голосового управления на управление давлением
      const modApi = readPressureApi(ctx);
      if (relationType === "unknown" && tier <= 50 && modApi < 0.6) {
        items.push(
          section(
            "relation-type-hint",
            [
              PromptBuilder.of(
                `You've talked to ${displayName} quite a bit but haven't categorized the relationship yet.`,
              ),
            ],
            undefined,
            27,
            60,
          ),
        );
      }

      // Сигнал траектории отношений — тренд частоты взаимодействий (warming / stable / cooling)
      try {
        const db = getDb();
        const trajectoryChId = ensureChannelId(contactId) ?? contactId;
        // ADR-110: Число взаимодействий за последние 50 минут (3_000_000 мс)
        const recentCount = db
          .select({ count: sql<number>`count(*)` })
          .from(actionLog)
          .where(
            and(
              eq(actionLog.chatId, trajectoryChId),
              gt(actionLog.createdAt, new Date(ctx.nowMs - 3_000_000)),
            ),
          )
          .get();
        // ADR-110: Число взаимодействий за предшествующие 50 минут
        const olderCount = db
          .select({ count: sql<number>`count(*)` })
          .from(actionLog)
          .where(
            and(
              eq(actionLog.chatId, trajectoryChId),
              gt(actionLog.createdAt, new Date(ctx.nowMs - 6_000_000)),
              lte(actionLog.createdAt, new Date(ctx.nowMs - 3_000_000)),
            ),
          )
          .get();
        const recent = recentCount?.count ?? 0;
        const older = olderCount?.count ?? 0;
        if (recent + older > 0) {
          let trajectory: string;
          if (older === 0 && recent > 0) {
            trajectory = "warming (new activity)";
          } else if (older > 0 && recent === 0) {
            trajectory = "cooling (no recent activity)";
          } else if (older > 0) {
            const ratio = recent / older;
            if (ratio > 1.3) {
              trajectory = "warming (more frequent interactions lately)";
            } else if (ratio < 0.7) {
              trajectory = "cooling (less frequent interactions lately)";
            } else {
              trajectory = "stable";
            }
          } else {
            trajectory = "stable";
          }
          items.push(
            section(
              "relationship-trajectory",
              [PromptBuilder.of(`Relationship trajectory: ${trajectory}`)],
              undefined,
              26,
              65,
            ),
          );
        }
      } catch {
        // DB недоступна — пропустить
      }

      // ADR-64 VI-3: Подсказка к синтезу portrait
      // ADR-81: Управление по давлению — подсказка обновления portrait при низком давлении
      if (profile && modApi < 0.6) {
        const memorizedCount = contactFacts.length;
        // ADR-110: 12 часов = 43200 секунд
        const portraitStale =
          profile.portraitMs != null
            ? (ctx.nowMs - profile.portraitMs) / 1000 > 43200
            : memorizedCount >= 3;
        if (portraitStale) {
          items.push(
            section(
              "portrait-hint",
              [PromptBuilder.of(`Impression of ${displayName} hasn't been updated in a while.`)],
              undefined,
              28,
              60,
            ),
          );
        }
      }
    }

    // 3. Атрибуты целевого канала
    if (target && ctx.graph.has(target) && ctx.graph.getNodeType(target) === "channel") {
      const attrs = ctx.graph.getChannel(target);
      const mChannel = new PromptBuilder();
      const chatType = attrs.chat_type ?? "unknown";
      const unread = attrs.unread ?? 0;
      // ADR-124: Использовать effectiveObligation вместо pending_directed
      // @see docs/adr/126-obligation-field-decay.md §D6
      const directed = effectiveObligation(ctx.graph, target, ctx.nowMs);
      const channelName = safeDisplayName(ctx.graph, target);
      mChannel.kv("Channel", `${channelName} (${chatType})`);
      if (unread > 0) mChannel.kv("Unread", String(unread));
      if (directed > 0.1) mChannel.line("Directed here — reply needed");

      // ADR-64 VI-4: Отображение профиля группы
      const isGroup = ChatTarget.isGroupChat(chatType);
      const gp = ctx.state.groupProfiles?.[target];
      if (isGroup && gp) {
        if (gp.topic) mChannel.kv("Topic", gp.topic);
        if (gp.atmosphere) mChannel.kv("Atmosphere", gp.atmosphere);
        if (gp.aliceRole) mChannel.kv("Role here", gp.aliceRole);
        if (gp.memberHighlights) mChannel.kv("Key members", gp.memberHighlights);
        // ADR-208: Кристаллизованные интересы группы
        const gInterests = Object.values(gp.crystallizedInterests ?? {})
          .sort((a, b) => b.confidence - a.confidence)
          .slice(0, 4);
        if (gInterests.length > 0) {
          mChannel.kv("Topics noticed", gInterests.map((ci) => ci.label).join(", "));
        }
        // ADR-66 F6: Напоминание об устаревании GroupProfile (аналог 12ч portrait для ContactProfile)
        // ADR-81: Управление по давлению — подсказка обновления профиля группы при низком давлении
        // ADR-110: 12 часов = 43200 секунд
        if (
          gp.portraitMs != null &&
          (ctx.nowMs - gp.portraitMs) / 1000 > 43200 &&
          readPressureApi(ctx) < 0.6
        ) {
          mChannel.line("This group profile hasn't been updated in a while.");
        }
      } else if (isGroup && !gp) {
        // ADR-81: Управление по давлению — подсказка создать профиль группы при низком давлении
        if (readPressureApi(ctx) < 0.6) {
          mChannel.line("No group profile yet — a description of this group's vibe would help.");
        }
      }

      // ADR-78 P1: передать LLM тип контента последних сообщений, помогая reading the room
      // @see .claude/sessions/review-naturalness-h7l9At/prompt-diagnosis.md §D
      const lastContentType = attrs.last_content_type;
      if (lastContentType && lastContentType !== "text") {
        mChannel.kv(
          "Last message type",
          `${lastContentType} — you can only see (${lastContentType}) tag, not the actual content`,
        );
      }

      items.push(section("channel-info", mChannel.build(), undefined, 22, 80));
    }

    return items;
  })
  /**
   * M4: Движок эволюции Tier.
   *
   * Теоретическая основа — модель уровней Данбара (Dunbar 1992, 2010):
   * Социальные круги человека образуют вложенную структуру ~5/15/50/150/500.
   * Система Tier Alice отображает эту структуру; значение tier автоматически эволюционирует через трёхмерный балл:
   *   TierScore = 0.35 × Frequency + 0.25 × Quality + 0.25 × Depth + 0.15 × Trust
   *
   * Правила повышения/понижения (защита от единичных всплесков):
   * - N=3 раза подряд score > 0.7 → апгрейд (стать ближе)
   * - N=3 раза подряд score < 0.3 → даунгрейд (стать дальше)
   * - Движение только по лесенке Данбара [500, 150, 50, 15, 5], без пропусков
   */
  .onTickEnd((ctx) => {
    normalizeContactProfileKeys(ctx.graph, ctx.state);

    // Оценивать раз в TIER_EVAL_INTERVAL тиков
    if (ctx.tick % TIER_EVAL_INTERVAL !== 0 || ctx.tick === 0) return;

    // Получить outcomeHistory от observer (для вычисления измерения Quality)
    const obsState = readModState(ctx, "observer");
    const outcomeHistory = obsState?.outcomeHistory ?? [];

    for (const contactId of ctx.graph.getEntitiesByType("contact")) {
      const attrs = ctx.graph.getContact(contactId);

      // ADR-91 Layer 3: Бот не участвует в эволюции tier и кристаллизации, зафиксирован на tier=500
      if (attrs.is_bot === true) {
        if ((attrs.tier ?? 150) !== 500) {
          ctx.graph.updateContact(contactId, { tier: 500 });
        }
        continue; // Пропустить дальнейшую оценку tier + обнаружение активных паттернов + сканирование кристаллизации
      }

      // ADR-178: rv_* затухает независимо по каждому измерению
      const rvPatch: Record<string, number | string> = {};
      let rvChanged = false;
      for (const dim of RV_DIMENSIONS) {
        const valueKey = `rv_${dim}` as keyof typeof attrs;
        const msKey = `rv_${dim}_ms` as keyof typeof attrs;
        const value = (attrs[valueKey] as number | undefined) ?? INITIAL_RV[dim];
        const lastMs = (attrs[msKey] as number | undefined) ?? ctx.nowMs;
        const elapsedMs = ctx.nowMs - lastMs;
        if (elapsedMs <= 0) continue;
        const decayed = decayDimension(value, DIMENSION_DECAY[dim], elapsedMs);
        if (Math.abs(decayed - value) > 0.001) {
          rvPatch[`rv_${dim}`] = decayed;
          rvPatch[`rv_${dim}_ms`] = ctx.nowMs;
          rvChanged = true;
        }
      }
      if (rvChanged) {
        // biome-ignore lint/suspicious/noExplicitAny: dynamic rv_${dim} keys cannot be statically typed as ContactAttrs
        ctx.graph.updateContact(contactId, rvPatch as any);
        // Пересчитать производные величины
        const updatedAttrs = ctx.graph.getContact(contactId);
        const v = readRV(updatedAttrs);
        const vel = readVelocity(updatedAttrs);
        ctx.graph.updateContact(contactId, {
          romantic_phase: deriveRomanticPhase(v, vel),
        });
      }

      const currentTier = attrs.tier ?? 150;

      // Инициализировать трекер
      if (!ctx.state.tierTrackers[contactId]) {
        ctx.state.tierTrackers[contactId] = {
          consecutiveHigh: 0,
          consecutiveLow: 0,
          lastEvalTick: 0,
          lastEvalMs: 0,
        };
      }
      const tracker = ctx.state.tierTrackers[contactId];
      tracker.lastEvalTick = ctx.tick;
      tracker.lastEvalMs = ctx.nowMs;

      // -- Трёхмерная оценка --

      // 1. Frequency: число взаимодействий за последние FREQUENCY_WINDOW тиков (1 день)
      // Приоритет — DB action_log, fallback — атрибут графа interaction_count
      // P1-mods-1 fix: использовать оконный счётчик, а не накопленный.
      // P2-1 fix: окно расширено с 100 тиков (1.67ч) до 1440 тиков (1 день),
      // согласовано с дневными значениями EXPECTED_FREQUENCY, чтобы избежать высокой случайности балла frequency.
      // @see docs/adr/45-real-data-validation.md §3 Critical-1
      let interactionCount = 0;
      try {
        const db = getDb();
        const chatIdVariant = ensureChannelId(contactId) ?? contactId;
        // ADR-110: Использовать createdAt вместо запроса по окну тиков
        const row = db
          .select({ count: sql<number>`count(*)` })
          .from(actionLog)
          .where(
            and(
              eq(actionLog.chatId, chatIdVariant),
              gt(actionLog.createdAt, new Date(ctx.nowMs - FREQUENCY_WINDOW_S * 1000)),
            ),
          )
          .get();
        interactionCount = row?.count ?? 0;
      } catch {
        // При недоступности DB frequency = 0 (консервативная стратегия, не влияет на другие измерения)
      }

      // 2. Quality: Среднее значение последних 10 оценок outcome, связанных с этим контактом
      const contactChatId = ensureChannelId(contactId) ?? contactId;
      const relevantOutcomes = outcomeHistory.filter(
        (r) => r.target === contactId || r.target === contactChatId,
      );
      const recentOutcomes = relevantOutcomes.slice(-10);
      const avgQuality =
        recentOutcomes.length > 0
          ? recentOutcomes.reduce((s, r) => s + r.quality, 0) / recentOutcomes.length
          : 0;

      // 3. Depth: количество фактов + участие в Thread
      const factCount = getContactFacts(ctx.graph, contactId).length;
      const maxFacts = CONTACT_FACTS_LIMIT;

      let threadInvolvement = 0;
      for (const tid of ctx.graph.getEntitiesByType("thread")) {
        const tAttrs = ctx.graph.getThread(tid);
        if (tAttrs.status === "open") {
          const neighbors = ctx.graph.getNeighbors(tid, "involves");
          if (neighbors.includes(contactId)) {
            threadInvolvement++;
          }
        }
      }

      // ADR-198 F7a: Мигрировано на rv_trust (атрибут графа), заменяет profile.trust (старый скаляр)
      const contactTrust = readRV(attrs).trust;

      // Входные данные коэффициента взаимности: читать счётчики инициации диалога из узла contact
      const aliceInit = Number(attrs.alice_initiated_count ?? 0);
      const contactInit = Number(attrs.contact_initiated_count ?? 0);

      const score = tierScore(
        interactionCount,
        currentTier,
        avgQuality,
        factCount,
        maxFacts,
        threadInvolvement,
        15, // maxThreads (верхний предел управления)
        contactTrust,
        aliceInit,
        contactInit,
      );

      // -- Определение последовательного порога --
      if (score >= TIER_UPGRADE_THRESHOLD) {
        tracker.consecutiveHigh++;
        tracker.consecutiveLow = 0;
      } else if (score <= TIER_DOWNGRADE_THRESHOLD) {
        tracker.consecutiveLow++;
        tracker.consecutiveHigh = 0;
      } else {
        // Средняя зона: сбросить оба счётчика
        tracker.consecutiveHigh = 0;
        tracker.consecutiveLow = 0;
      }

      // -- Trust-floor: высоко-доверенная связь не киснет в дальних слоях --
      // Лечит «застрявший» демоут (middle-zone балл сам tier не повышает) и не даёт ронять близких.
      // Пол по доверию: rv_trust ≥0.9 → tier 15 (close friend), ≥0.7 → tier 50 (friend); иначе пола нет.
      // DUNBAR_TIERS=[500,150,50,15,5]: больший индекс = ближе.
      const trustFloorIdx =
        contactTrust >= 0.9
          ? DUNBAR_TIERS.indexOf(15)
          : contactTrust >= 0.7
            ? DUNBAR_TIERS.indexOf(50)
            : 0;
      const curIdx = DUNBAR_TIERS.indexOf(currentTier);
      if (trustFloorIdx > curIdx) {
        // current дальше, чем допускает доверие → подтягиваем к полу
        const floorTier = DUNBAR_TIERS[trustFloorIdx];
        ctx.graph.updateContact(contactId, {
          tier: floorTier,
          tier_changed_ms: ctx.nowMs,
          tier_direction: "upgrade",
        });
        ctx.graph.beliefs.update(contactId, "tier", floorTier, "structural", ctx.nowMs);
        try {
          emitConsciousness(getDb(), ctx.tick, ctx.nowMs, {
            kind: "evolve:tier",
            entityIds: [contactId],
            summary: `${attrs.display_name ?? contactId} lifted to tier ${floorTier} (trust floor)`,
          });
        } catch {
          /* non-critical */
        }
        tracker.consecutiveHigh = 0;
        tracker.consecutiveLow = 0;
        continue;
      }

      // -- Повышение/понижение tier --
      if (tracker.consecutiveHigh >= TIER_CONSECUTIVE_REQUIRED) {
        const nextTier = nextCloserTier(currentTier);
        if (nextTier !== null) {
          ctx.graph.updateContact(contactId, {
            tier: nextTier,
            tier_changed_ms: ctx.nowMs,
            tier_direction: "upgrade",
          });
          // ADR-123: изменение tier — структурное наблюдение (автоматически записывается в changelog)
          ctx.graph.beliefs.update(contactId, "tier", nextTier, "structural", ctx.nowMs);
          // ADR-204: поток сознания — событие повышения tier
          try {
            const name = attrs.display_name ?? contactId;
            emitConsciousness(getDb(), ctx.tick, ctx.nowMs, {
              kind: "evolve:tier",
              entityIds: [contactId],
              summary: `${name} upgraded to tier ${nextTier}`,
            });
          } catch {
            /* non-critical */
          }
        }
        tracker.consecutiveHigh = 0;
        tracker.consecutiveLow = 0;
      } else if (tracker.consecutiveLow >= TIER_DOWNGRADE_CONSECUTIVE) {
        const nextTier = nextFartherTier(currentTier);
        // Trust-floor: не демотим ниже пола по доверию (близкую связь не роняем в «знакомые»).
        if (nextTier !== null && DUNBAR_TIERS.indexOf(nextTier) >= trustFloorIdx) {
          ctx.graph.updateContact(contactId, {
            tier: nextTier,
            tier_changed_ms: ctx.nowMs,
            tier_direction: "downgrade",
          });
          // ADR-123: изменение tier — структурное наблюдение (автоматически записывается в changelog)
          ctx.graph.beliefs.update(contactId, "tier", nextTier, "structural", ctx.nowMs);
          // ADR-204: поток сознания — событие понижения tier
          try {
            const name = attrs.display_name ?? contactId;
            emitConsciousness(getDb(), ctx.tick, ctx.nowMs, {
              kind: "evolve:tier",
              entityIds: [contactId],
              summary: `${name} downgraded to tier ${nextTier}`,
            });
          } catch {
            /* non-critical */
          }
        }
        tracker.consecutiveLow = 0;
        tracker.consecutiveHigh = 0;
      }

      // -- Обнаружение изменения паттерна активности (сценарий 5: усиление долгосрочного сопровождения) --
      // В цикле оценки tier сравниваем текущий пиковый час активности с последним записанным,
      // выявляем значительные изменения расписания (смещение >= 3 ч), например "ты снова стал засиживаться допоздна".
      const traitBeliefs = ctx.graph.beliefs.getByEntityAttrPrefix(contactId, "trait:");
      let profile = ctx.state.contactProfiles[contactId];
      if (!profile && traitBeliefs.length > 0) {
        ctx.state.contactProfiles[contactId] = emptyProfile(ctx.tick, ctx.nowMs);
        profile = ctx.state.contactProfiles[contactId];
      }
      if (profile && profile.activeHours.length === 24) {
        const maxActivity = Math.max(...profile.activeHours);
        if (maxActivity > 0) {
          const currentPeakHour = profile.activeHours.indexOf(maxActivity);
          if (profile.previousPeakHour !== null) {
            const shift = Math.abs(currentPeakHour - profile.previousPeakHour);
            // Учитываем круговое расстояние через полночь (напр. 23→1 = 2ч, а не 22ч)
            const circularShift = Math.min(shift, 24 - shift);
            if (circularShift >= 3) {
              const hourPeriod = (h: number) =>
                h < 6 ? "late night" : h < 12 ? "morning" : h < 18 ? "afternoon" : "evening";
              const direction =
                currentPeakHour > 12 && profile.previousPeakHour <= 12
                  ? "shifted later (possible night owl pattern)"
                  : currentPeakHour <= 12 && profile.previousPeakHour > 12
                    ? "shifted earlier (possible early bird pattern)"
                    : `shifted from ${hourPeriod(profile.previousPeakHour)} to ${hourPeriod(currentPeakHour)}`;
              profile.scheduleShift = direction;
            } else {
              profile.scheduleShift = null; // изменение незначительно, очищаем
            }
          }
          profile.previousPeakHour = currentPeakHour;
        }
      }

      // -- ADR-89 §Wave 2B: кристаллизация впечатлений + §Wave 3B: медленный распад кристаллизаций --
      // Каждые TIER_EVAL_INTERVAL одновременно сканируем trait beliefs данного контакта.
      // @see docs/adr/89-impression-formation-system.md §Wave 2B/3B
      if (profile) {
        const obsState2 = readModState(ctx, "observer");
        const impressionCounts = obsState2?.impressionCounts ?? {};

        for (const [attr, belief] of traitBeliefs) {
          // attr имеет вид "trait:warmth"
          const dimension = attr.slice("trait:".length);
          const countKey = `${contactId}::${attr}`;
          const obsCount = impressionCounts[countKey] ?? 0;
          const existing = profile.traits[dimension];

          if (existing) {
            // ADR-110: медленный распад кристаллизации: период полураспада 604800 с = 7 дней, возврат к 0 (нейтральному)
            const lastMs =
              existing.lastReinforcedMs ??
              estimateEventMs({ tick: existing.lastReinforced }, ctx.nowMs, ctx.tick);
            const elapsedS = (ctx.nowMs - lastMs) / 1000;
            if (elapsedS > 0) {
              existing.value *= 2 ** -(elapsedS / CRYSTALLIZED_TRAIT_HALFLIFE_S);
            }
            // |value| слишком мал → удалить (черта естественно угасла)
            if (Math.abs(existing.value) < CRYSTALLIZED_TRAIT_EPSILON) {
              delete profile.traits[dimension];
              continue;
            }
            // μ меняет знак → декристаллизация (когнитивное обновление: раньше казался тёплым, теперь — холодным)
            if (existing.value > 0 !== belief.mu > 0 && belief.sigma2 < CRYSTALLIZE_SIGMA2) {
              delete profile.traits[dimension];
              continue;
            }
            // self_sense продолжает обновляться → обновить lastReinforced
            const lastReinforcedMs =
              existing.lastReinforcedMs ??
              estimateEventMs({ tick: existing.lastReinforced }, ctx.nowMs, ctx.tick);
            if (belief.tObs > lastReinforcedMs) {
              existing.lastReinforced = ctx.tick;
              existing.lastReinforcedMs = ctx.nowMs;
              existing.value = Math.max(-1, Math.min(1, belief.mu));
            }
          } else {
            // Не кристаллизована → проверить три условия кристаллизации
            if (
              belief.sigma2 < CRYSTALLIZE_SIGMA2 &&
              obsCount >= CRYSTALLIZE_MIN_OBS &&
              Math.abs(belief.mu) > CRYSTALLIZE_MU_THRESHOLD
            ) {
              profile.traits[dimension] = {
                value: Math.max(-1, Math.min(1, belief.mu)),
                crystallizedAt: ctx.tick,
                crystallizedAtMs: ctx.nowMs,
                lastReinforced: ctx.tick,
                lastReinforcedMs: ctx.nowMs,
              };
            }
          }
        }
      }

      // -- ADR-208: медленный распад кристаллизации интересов (contact) --
      // Сканируем с той же частотой, что и распад trait (каждые TIER_EVAL_INTERVAL тиков).
      if (profile?.crystallizedInterests) {
        for (const [label, entry] of Object.entries(profile.crystallizedInterests)) {
          const elapsedS = (ctx.nowMs - entry.lastReinforcedMs) / 1000;
          if (elapsedS > 0) {
            entry.confidence *= 2 ** -(elapsedS / CRYSTALLIZED_INTEREST_HALFLIFE_S);
          }
          if (entry.confidence < CRYSTALLIZED_INTEREST_EPSILON) {
            delete profile.crystallizedInterests[label];
            if (ctx.state.interestObsCounts) {
              delete ctx.state.interestObsCounts[`${contactId}::interest:${label}`];
            }
          }
        }
      }
    }

    // -- ADR-208: медленный распад кристаллизации интересов (group) --
    for (const [channelId, gp] of Object.entries(ctx.state.groupProfiles ?? {})) {
      if (!gp.crystallizedInterests) continue;
      for (const [label, entry] of Object.entries(gp.crystallizedInterests)) {
        const elapsedS = (ctx.nowMs - entry.lastReinforcedMs) / 1000;
        if (elapsedS > 0) {
          entry.confidence *= 2 ** -(elapsedS / CRYSTALLIZED_INTEREST_HALFLIFE_S);
        }
        if (entry.confidence < CRYSTALLIZED_INTEREST_EPSILON) {
          delete gp.crystallizedInterests[label];
          if (ctx.state.interestObsCounts) {
            delete ctx.state.interestObsCounts[`${channelId}::interest:${label}`];
          }
        }
      }
    }
  })
  .build();
