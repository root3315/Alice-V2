/**
 * ADR-220: Строитель User Prompt Snapshot.
 *
 * Единовременно строит типизированный снимок из источников данных движка для потребления рендерерами сцен.
 * DB напрямую не запрашивается — все данные берутся из переданных аргументов.
 *
 * Принцип построения EntityRef: если отсутствует id или displayName — вернуть null, в prompt не попадает.
 * Это коренное устранение проблемы "(a group)".
 */

import { and, desc, eq, lte } from "drizzle-orm";
import { getDb } from "../db/connection.js";
import { messageLog, rhythmProfiles, scheduledTasks } from "../db/schema.js";
import {
  type RhythmConfidence,
  type RhythmEntityType,
  type RhythmProfileProjection,
  renderTimingLine,
  type TimeWindow,
} from "../diagnostics/rhythm-spectrum.js";
import { readEmotionControlPatch, readEmotionState } from "../emotion/graph.js";
import { renderEmotionProjection } from "../emotion/projection.js";
import type { MessageRecord } from "../engine/act/messages.js";
import { computeChannelPresence } from "../engine/act/presence.js";
import {
  buildTimeline,
  type ForwardRegistry,
  MessageTimelineSource,
  ObservationTimelineSource,
  PeripheralTimelineSource,
  type PeripheralVisionConfig,
  renderTimeline,
} from "../engine/act/timeline.js";
import type { ActionQueueItem } from "../engine/action-queue.js";
import {
  ALICE_SELF,
  ensureChannelId,
  ensureContactId,
  extractNumericId,
  PERIPHERAL_TIER_WINDOW_S,
  resolveContactAndChannel,
  tierLabel,
} from "../graph/constants.js";
import { safeDisplayName } from "../graph/display.js";
import {
  isBlockedByContact,
  readForwardRegistry,
  readLastSharedMs,
  readSocialReception,
} from "../graph/dynamic-props.js";
import type { DunbarTier } from "../graph/entities.js";
import { findActiveConversation } from "../graph/queries.js";
import type { WorldModel } from "../graph/world-model.js";
import type { ChatInfo } from "../llm/group-cache.js";
import { getCachedChatInfo } from "../llm/group-cache.js";
import { getCachedBio } from "../telegram/bio-cache.js";
import { humanDuration } from "../utils/time-format.js";
import { getFacetWhisper } from "../voices/palette.js";
import type {
  ContactProfileSlot,
  ContactSlot,
  EntityRef,
  FeedItemSlot,
  GroupSlot,
  JargonSlot,
  OwnedChannelSlot,
  PresenceSlot,
  RecapSegment,
  ThreadSlot,
  UserPromptSnapshot,
} from "./types.js";
import { ChatTarget } from "./types.js";

// ═══════════════════════════════════════════════════════════════════════════
// Параметры построения снимка
// ═══════════════════════════════════════════════════════════════════════════

export interface SnapshotInput {
  G: WorldModel;
  messages: MessageRecord[];
  observations: string[];
  item: ActionQueueItem;
  round: number;
  /** @deprecated ADR-233: Цикл TC взял на себя продолжение раундов, больше не используется */
  episodeRound?: number;
  board: {
    maxSteps: number;
    contextVars: Readonly<Record<string, unknown>>;
  };
  nowMs: number;
  /** Смещение часового пояса пользователя (в часах), например UTC+8 → 8 */
  timezoneOffset: number;
  chatType: string;
  isGroup: boolean;
  isChannel: boolean;

  /** Стратегия C: предварительно собранные профили контактов (из relationships mod state). */
  contactProfiles?: Record<
    string,
    {
      portrait?: string;
      traits?: Record<string, { value: number }>;
      crystallizedInterests?: Record<string, { label: string; confidence: number }>;
      interests?: string[];
    }
  >;

  /** Стратегия C: жаргон группы (из learning mod state). */
  jargonEntries?: Array<{ term: string; meaning: string }>;

  /** Стратегия C: элементы ленты (из feeds mod cache). */
  feedItems?: Array<{ title: string; url: string; snippet: string }>;

  /** Факты обратной связи по действиям (из observer/outcome contribution, явно проецируется prompt-builder). */
  feedbackEntries?: string[];

  /** ADR-262: краткие строки social case, видимые в текущей сцене. */
  socialCaseLines?: string[];

  /** Стратегия D: параметры конфигурации peripheral vision. */
  peripheralConfig?: {
    perChannelCap: number;
    totalCap: number;
    minTextLength: number;
  };
}

function renderEmotionStyleHint(G: WorldModel, nowMs: number): string | undefined {
  const control = readEmotionControlPatch(G, nowMs);
  const lines: string[] = [];

  if (control.styleBudget.allowVulnerability) {
    lines.push("A small bit of warmth can show.");
  }
  if (control.styleBudget.avoidSelfProof) {
    lines.push("There is no need to prove yourself.");
  }
  if (control.actionCaps.proactiveMessages != null) {
    lines.push("If you reach out, keep it to one soft touch and then wait.");
  }

  return lines.length > 0 ? lines.join("\n") : undefined;
}

// ═══════════════════════════════════════════════════════════════════════════
// Строитель EntityRef — null = не попадает в prompt
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Строит EntityRef из узла графа.
 * Возвращает null, если: узел не существует, нет displayName, не удаётся извлечь числовой ID.
 */
export function buildEntityRef(G: WorldModel, nodeId: string): EntityRef | null {
  if (!G.has(nodeId)) return null;

  const numericId = extractNumericId(nodeId);
  if (numericId == null) return null;

  // Попытка получить имя из узла channel
  let displayName: string | undefined;
  const nodeType = G.getNodeType(nodeId);

  if (nodeType === "channel") {
    const attrs = G.getChannel(nodeId);
    displayName = attrs.display_name;
  } else if (nodeType === "contact") {
    const attrs = G.getContact(nodeId);
    displayName = attrs.display_name;
  } else {
    // Универсальный fallback
    displayName =
      (G.getDynamic(nodeId, "display_name") as string | undefined) ??
      (G.getDynamic(nodeId, "title") as string | undefined);
  }

  if (!displayName || String(displayName).trim() === "") return null;

  // Получить chatType
  let chatType: EntityRef["chatType"];
  if (nodeType === "channel") {
    const ct = G.getChannel(nodeId).chat_type;
    if (ct === "private" || ct === "group" || ct === "supergroup" || ct === "channel") {
      chatType = ct;
    }
  }

  return { id: numericId, displayName: String(displayName), chatType };
}

/**
 * Строит EntityRef для цели приватного чата — если у узла channel нет display_name,
 * пытается получить его из узла contact.
 */
function buildTargetRef(G: WorldModel, target: string): EntityRef | null {
  // Сначала попытка построить напрямую из узла channel
  const ref = buildEntityRef(G, target);
  if (ref) return ref;

  // У channel нет display_name → пробуем получить из узла contact
  const numericId = extractNumericId(target);
  if (numericId == null) return null;

  const contactId = ensureContactId(String(Math.abs(numericId)));
  if (!contactId || !G.has(contactId)) return null;

  const contactAttrs = G.getContact(contactId);
  const displayName = contactAttrs.display_name;
  if (!displayName || String(displayName).trim() === "") return null;

  // Получить chatType из узла channel, если существует
  const channelId = ensureChannelId(target);
  let chatType: EntityRef["chatType"];
  if (channelId && G.has(channelId)) {
    const ct = G.getChannel(channelId).chat_type;
    if (ct === "private" || ct === "group" || ct === "supergroup" || ct === "channel") {
      chatType = ct;
    }
  }

  return { id: numericId, displayName: String(displayName), chatType };
}

// ═══════════════════════════════════════════════════════════════════════════
// Социальная панорама (для канала) — строится из Graph
// ═══════════════════════════════════════════════════════════════════════════

const PANORAMA_MAX_CONTACTS = 8;
const PANORAMA_MAX_GROUPS = 4;
const PANORAMA_MAX_INTERESTS = 2;
const SHARED_RECENTLY_WINDOW_MS = 60 * 60_000;

function buildContactPanorama(
  G: WorldModel,
  nowMs: number,
  contactProfiles?: SnapshotInput["contactProfiles"],
): ContactSlot[] {
  const results: Array<
    ContactSlot & { tier: number; lastActiveMs: number; hasInterests: boolean; reception: number }
  > = [];

  // Обход соседей Alice по рёбрам "knows" (контакты)
  for (const cid of G.getEntitiesByType("contact")) {
    if (cid === ALICE_SELF) continue;
    const attrs = G.getContact(cid);
    if (attrs.is_bot) continue;
    const tier = attrs.tier ?? 150;
    // Расширено до 500 — накопление тегов интересов сосредоточено у дальних контактов
    if (tier > 500) continue;

    const numId = extractNumericId(cid);
    if (numId == null) continue;
    const displayName = attrs.display_name;
    if (!displayName || String(displayName).trim() === "") continue;

    // ADR-156 Fix 1: показывать только контакты с историей диалога (не пересылать незнакомцам)
    const channelId = ensureChannelId(cid);
    if (channelId && G.has(channelId)) {
      const ch = G.getChannel(channelId);
      if (!ch.last_activity_ms && !ch.last_alice_action_ms) continue;
    } else {
      continue; // Нет соответствующего channel = приватного чата никогда не было
    }

    // ADR-156 Fix 3: заблокированные контакты не попадают в панораму
    if (isBlockedByContact(G, cid)) continue;

    // Сбор интересов: приоритет ContactProfile.crystallizedInterests (Mod State),
    // откат к ContactProfile.interests, затем из узлов fact.
    const profile = contactProfiles?.[cid];
    let interests: string[] = [];

    // Стратегия 1: crystallizedInterests (наивысшее качество — кристаллизация из множества наблюдений)
    const crystallized = Object.values(profile?.crystallizedInterests ?? {})
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, PANORAMA_MAX_INTERESTS)
      .map((ci) => ci.label);
    if (crystallized.length > 0) {
      interests = crystallized;
    }
    // Стратегия 2: старый массив interests
    else if (profile?.interests && profile.interests.length > 0) {
      interests = profile.interests.slice(0, PANORAMA_MAX_INTERESTS);
    }
    // Стратегия 3: fallback через узлы fact
    else {
      const factNeighbors = G.getPredecessors(cid, "from");
      for (const factId of factNeighbors) {
        if (!G.has(factId) || G.getNodeType(factId) !== "fact") continue;
        const fact = G.getFact(factId);
        if ((fact.fact_type === "interest" || fact.fact_type === "preference") && fact.content) {
          interests.push(String(fact.content));
          if (interests.length >= PANORAMA_MAX_INTERESTS) break;
        }
      }
    }

    // topTrait: приоритет из profile.traits, откат к узлам fact
    let topTrait: string | undefined;
    const traitEntries = Object.entries(profile?.traits ?? {});
    if (traitEntries.length > 0) {
      topTrait = traitEntries.sort((a, b) => Math.abs(b[1].value) - Math.abs(a[1].value))[0][0];
    } else {
      const factNeighbors = G.getPredecessors(cid, "from");
      for (const factId of factNeighbors) {
        if (!G.has(factId) || G.getNodeType(factId) !== "fact") continue;
        const fact = G.getFact(factId);
        if (fact.fact_type === "preference" && fact.content) {
          topTrait = String(fact.content);
          break;
        }
      }
    }

    // Bio: синхронное чтение из кэша (при промахе не блокирует, вступит в силу на следующем тике)
    const bioEntry = getCachedBio(cid);
    const bio = bioEntry?.bio ?? undefined;

    // Чтение социальной восприимчивости приватного channel контакта (сигнал обратной связи при пересылке)
    const contactReception = channelId ? readSocialReception(G, channelId) : 0;
    const lastSharedMs = channelId ? readLastSharedMs(G, channelId) : 0;
    const sharedRecently =
      lastSharedMs > 0 && nowMs >= lastSharedMs && nowMs - lastSharedMs < SHARED_RECENTLY_WINDOW_MS;

    const ref: EntityRef = { id: numId, displayName: String(displayName) };
    results.push({
      ref,
      tierLabel: tierLabel(tier),
      topTrait,
      interests,
      bio,
      ...(sharedRecently ? { sharedRecently: true } : {}),
      tier,
      lastActiveMs: attrs.last_active_ms ?? 0,
      hasInterests: interests.length > 0,
      reception: contactReception,
    });
  }

  // Сортировка: warm reception в приоритете → наличие интересов → tier по возрастанию → недавняя активность
  // Контакты с cold reception естественно оседают вниз, патч [shared recently] не нужен
  results.sort((a, b) => {
    // reception >= 0 идут первыми, < 0 — последними
    const aWarm = a.reception >= 0 ? 0 : 1;
    const bWarm = b.reception >= 0 ? 0 : 1;
    if (aWarm !== bWarm) return aWarm - bWarm;
    const aHas = a.hasInterests ? 0 : 1;
    const bHas = b.hasInterests ? 0 : 1;
    return aHas - bHas || a.tier - b.tier || b.lastActiveMs - a.lastActiveMs;
  });

  return results
    .slice(0, PANORAMA_MAX_CONTACTS)
    .map(({ ref, tierLabel: tl, topTrait: tt, interests, bio: b, sharedRecently: sr }) => ({
      ref,
      tierLabel: tl,
      topTrait: tt,
      interests,
      ...(b ? { bio: b } : {}),
      ...(sr ? { sharedRecently: true } : {}),
    }));
}

function buildGroupPanorama(G: WorldModel): GroupSlot[] {
  const results: GroupSlot[] = [];

  // Alice связана с группами через рёбра "monitors" (не "joined")
  const monitoredChannels = G.getNeighbors(ALICE_SELF, "monitors");
  for (const chId of monitoredChannels) {
    if (!G.has(chId) || G.getNodeType(chId) !== "channel") continue;
    const attrs = G.getChannel(chId);
    // Только группы, не являющиеся приватными чатами или каналами
    if (attrs.chat_type === "private" || attrs.chat_type === "channel") continue;
    const displayName = attrs.display_name;
    if (!displayName || String(displayName).trim() === "") continue;

    const numericId = extractNumericId(chId);
    if (numericId == null) continue;

    // Поиск активной темы разговора
    const convId = findActiveConversation(G, chId);
    let topic: string | undefined;
    if (convId && G.has(convId)) {
      const convAttrs = G.getConversation(convId);
      if (convAttrs.topic) topic = String(convAttrs.topic);
    }

    // Сбор интересов группы (из связанных узлов fact)
    const interests: string[] = [];
    const factNeighbors = G.getPredecessors(chId, "from");
    for (const factId of factNeighbors) {
      if (!G.has(factId) || G.getNodeType(factId) !== "fact") continue;
      const fact = G.getFact(factId);
      if (fact.fact_type === "interest" && fact.content) {
        interests.push(String(fact.content));
        if (interests.length >= PANORAMA_MAX_INTERESTS) break;
      }
    }

    // Bio: синхронное чтение из кэша
    const bioEntry = getCachedBio(chId);
    const bio = bioEntry?.bio ?? undefined;

    results.push({
      ref: { id: numericId, displayName: String(displayName), chatType: attrs.chat_type },
      topic,
      interests,
      ...(bio ? { bio } : {}),
    });

    if (results.length >= PANORAMA_MAX_GROUPS) break;
  }

  return results;
}

// ═══════════════════════════════════════════════════════════════════════════
// Каналы Alice (ADR-237: цели пересылки куратора)
// ═══════════════════════════════════════════════════════════════════════════

const PANORAMA_MAX_OWNED_CHANNELS = 3;

function buildOwnedChannels(G: WorldModel): OwnedChannelSlot[] {
  const results: OwnedChannelSlot[] = [];

  for (const nodeId of G.getEntitiesByType("channel")) {
    const attrs = G.getChannel(nodeId);
    if (attrs.chat_type !== "channel") continue;

    const role = String(attrs.alice_role ?? "");
    if (role !== "owner" && role !== "admin") continue;

    const displayName = attrs.display_name;
    if (!displayName || String(displayName).trim() === "") continue;

    const numericId = extractNumericId(nodeId);
    if (numericId == null) continue;

    results.push({
      ref: { id: numericId, displayName: String(displayName), chatType: "channel" },
      role: role as "owner" | "admin",
    });

    if (results.length >= PANORAMA_MAX_OWNED_CHANNELS) break;
  }

  return results;
}

// ══════════════════��════════════════════════════════════════════════════════
// Состояние диалога (защита от повторов)
// ═══════════════════════════════════════════════════════════════════════════

function buildPresence(
  messages: readonly MessageRecord[],
  nowMs: number,
): PresenceSlot | undefined {
  if (messages.length === 0) return undefined;
  const presence = computeChannelPresence(messages);
  if (presence.trailingYours < 1) return undefined;

  let lastOutgoing: MessageRecord | undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].isOutgoing) {
      lastOutgoing = messages[i];
      break;
    }
  }

  if (!lastOutgoing) return undefined;

  const agoS = (nowMs - lastOutgoing.date.getTime()) / 1000;
  const preview =
    lastOutgoing.text.length > 50 ? `${lastOutgoing.text.slice(0, 50)}...` : lastOutgoing.text;

  return {
    trailingYours: presence.trailingYours,
    lastOutgoingPreview: preview,
    lastOutgoingAgo: humanDuration(agoS),
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Треды
// ═══════════════════════════════════════════════════════════════════════════

function sanitizeThreadTitle(title: string): string {
  return title.replace(/(?:channel|contact):[+-]?\d+/g, "(chat)");
}

function buildThreads(contextVars: Readonly<Record<string, unknown>>): ThreadSlot[] {
  const threads = contextVars.ACTIVE_THREADS;
  if (!Array.isArray(threads) || threads.length === 0) return [];
  return threads
    .filter(
      (t): t is { id: string; title: string } =>
        typeof t === "object" && t !== null && "id" in t && "title" in t,
    )
    .map((t) => ({
      threadId: String(t.id),
      title: sanitizeThreadTitle(String(t.title)),
    }));
}

// ══════════════���════════════════════════════════════════════════════════════
// Построение временной шкалы
// ═══════════════════════════════════════════════════════════════════════════

const MAX_TIMELINE_LINES = 30;
const TEN_MINUTES_MS = 10 * 60 * 1000;

function buildTimelineSlot(
  messages: MessageRecord[],
  observations: string[],
  target: string,
  nowMs: number,
  peripheralConfig?: PeripheralVisionConfig | null,
  forwardRegistry?: ForwardRegistry,
  timezoneOffset?: number,
): { lines: string[] } {
  const sinceMs = nowMs - TEN_MINUTES_MS;

  const sources = [
    ...(peripheralConfig ? [new PeripheralTimelineSource(peripheralConfig)] : []),
    new MessageTimelineSource(messages, forwardRegistry),
    ...(observations.length > 0 ? [new ObservationTimelineSource(observations)] : []),
  ];

  const timeline = buildTimeline(sources, target, sinceMs, nowMs);
  if (timeline.length === 0) return { lines: [] };

  const rendered = renderTimeline(timeline, nowMs, timezoneOffset);
  // Фиксированное окно — при превышении лимита обрезаем сверху (сохраняем новейшее)
  if (rendered.length > MAX_TIMELINE_LINES) {
    return { lines: rendered.slice(-MAX_TIMELINE_LINES) };
  }
  return { lines: rendered };
}

// ═══════════════════════════════════════════════════════════════════════════
// Осведомлённость о раунде
// ═══════════════════════════════════════════════════════════════════════════

function buildRoundHint(round: number, maxSteps: number): string | undefined {
  if (round <= 0) return undefined;
  const remaining = maxSteps - round - 1;
  if (remaining === 0) {
    return "Been going back and forth — time to wrap up.";
  }
  return "The conversation is still going.";
}

/**
 * Подсказка episode: когда block продолжается host-ом в том же тике,
 * сообщает LLM, что результаты команд уже в observations и можно продолжать принятие решений.
 */
function buildEpisodeHint(episodeRound: number): string | undefined {
  if (episodeRound <= 0) return undefined;
  return "The command result is in your observations — continue from where you left off.";
}

// ═══════════════════════════════════════════════════════════════════════════
// Стратегия A: чистый вывод из Graph
// ═══════════════════════════════════════════════════════════════════════════

const SEVEN_DAYS_MS = 7 * 24 * 3600_000;
const MAX_TIMING_SIGNALS = 2;

/**
 * Уровень③ Глобальные сигналы осведомлённости.
 *
 * Вывод обходом Graph: дрейфующие контакты, активные группы, каналы, ожидающие ответа.
 * LLM использует эти сигналы для решения о проактивном обращении или наблюдении за группой.
 */
function buildSituationSignals(
  G: WorldModel,
  target: string | null,
  nowMs: number,
  round: number,
): string[] {
  const signals: string[] = [];

  // Дрейфующие контакты: last_active_ms > 7 дней назад
  // Показывать только при round=0 (первый раунд / не engagement) — в ходе engagement дрейф является отвлекающим шумом
  if (round === 0) {
    for (const cid of G.getEntitiesByType("contact")) {
      if (cid === ALICE_SELF) continue;
      const attrs = G.getContact(cid);
      if (attrs.is_bot) continue;
      const name = safeDisplayName(G, cid);
      if (name.startsWith("(")) continue; // Обобщённое обозначение = нет реального имени, пропуск
      const lastActive = attrs.last_active_ms ?? 0;
      if (lastActive > 0 && nowMs - lastActive > SEVEN_DAYS_MS) {
        const days = Math.round((nowMs - lastActive) / (24 * 3600_000));
        signals.push(`${name} hasn't been around in ${days} days`);
      }
      if (signals.length >= 3) break;
    }
  }

  // Активные группы: unread > 5 и не текущий target (исключая приватные чаты и каналы)
  const joined = G.has(ALICE_SELF) ? G.getNeighbors(ALICE_SELF, "monitors") : [];
  for (const chId of joined) {
    if (!G.has(chId) || G.getNodeType(chId) !== "channel") continue;
    if (chId === target) continue;
    const ch = G.getChannel(chId);
    if (ch.chat_type === "private" || ch.chat_type === "channel") continue;
    if ((ch.unread ?? 0) > 5) {
      const name = safeDisplayName(G, chId);
      const numericId = extractNumericId(chId);
      const idPart = numericId != null ? ` @${numericId}` : "";
      signals.push(`${name}${idPart} is lively`);
    }
    if (signals.length >= 5) break;
  }

  // ADR-221 No-Silent-Drop: сигналы с pending_directed > 0 обязательно отображаются.
  // Для не-текущих приватных чатов — только сводка, без имён/@ID, чтобы act prompt текущего target не провоцировал проактивные сообщения в другой чат.
  let otherPrivateDirected = 0;
  for (const chId of joined) {
    if (!G.has(chId) || G.getNodeType(chId) !== "channel") continue;
    if (chId === target) continue;
    const ch = G.getChannel(chId);
    if ((ch.pending_directed ?? 0) <= 0) continue;
    if (ch.chat_type === "private") {
      otherPrivateDirected += 1;
      continue;
    }

    // Цепочка fallback: channel display_name → safeDisplayName. Приватные чаты уже суммированы выше, здесь не раскрываются для текущего target.
    let name = ch.display_name;
    if (!name || String(name).trim() === "") {
      name = safeDisplayName(G, chId);
    }

    // Добавляем числовой ID, чтобы LLM мог корректно вызывать команды irc
    const numericId = extractNumericId(chId);
    const idPart = numericId != null ? ` @${numericId}` : "";

    signals.push(`${name}${idPart} is waiting for your reply`);
    if (signals.length >= 7) break;
  }

  if (otherPrivateDirected > 0 && signals.length < 7) {
    signals.push(
      otherPrivateDirected === 1
        ? "Someone else sent you a DM; handle it in its own turn, not from this chat."
        : `${otherPrivateDirected} other DMs are pending; handle them in their own turns, not from this chat.`,
    );
  }

  return signals;
}

/**
 * Уровень② Настроение собеседника.
 *
 * Выводит contact → mood_valence из target channel.
 * LLM использует метку настроения для корректировки тона (мягче, когда собеседник подавлен).
 */
function buildContactMood(G: WorldModel, target: string): string | undefined {
  const contactId = ensureContactId(target);
  const cid = contactId && G.has(contactId) ? contactId : null;

  // Попытка вывести contact ID из channel ID
  const resolvedCid =
    cid ??
    (() => {
      const numId = extractNumericId(target);
      if (numId == null) return null;
      const altId = ensureContactId(String(Math.abs(numId)));
      return altId && G.has(altId) ? altId : null;
    })();

  if (!resolvedCid) return undefined;
  const attrs = G.getContact(resolvedCid);
  const valence = attrs.mood_valence;
  if (valence == null) return undefined;

  let label: string | undefined;
  if (valence > 0.3) label = "positive";
  else if (valence < -0.3) label = "down";
  else return undefined;

  const shift = attrs.mood_shift;
  if (shift) label += ` (${shift})`;
  return label;
}

/**
 * Уровень③ Флаги риска.
 *
 * Извлекает флаги безопасности/риска из атрибутов target channel в графе.
 * LLM использует флаги риска для регулировки уровня осторожности.
 */
function buildRiskFlags(G: WorldModel, target: string): string[] {
  const flags: string[] = [];
  const channelId = ensureChannelId(target);
  if (!channelId || !G.has(channelId)) return flags;

  const ch = G.getChannel(channelId);
  if (ch.risk_level && ch.risk_level !== "none") {
    const reason = ch.risk_reason ? `: ${ch.risk_reason}` : "";
    flags.push(`Risk level ${ch.risk_level}${reason}`);
  }
  if (ch.safety_flag) {
    flags.push(`Safety: ${ch.safety_flag}`);
  }
  return flags;
}

/**
 * Уровень⑤ Текущая тема разговора (исправление бага — ранее зависел от groupMeta.topic, который недоступен в приватном чате).
 *
 * LLM использует openTopic для поддержания связности диалога.
 */
function buildOpenTopic(G: WorldModel, target: string): string | undefined {
  const channelId = ensureChannelId(target) ?? target;
  if (!G.has(channelId)) return undefined;
  const convId = findActiveConversation(G, channelId);
  if (!convId || !G.has(convId)) return undefined;
  const topic = G.getConversation(convId).topic;
  return topic ? String(topic) : undefined;
}

// ═══════════════════════════════════════════════════════════════════════════
// Стратегия B: запросы к DB
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Уровень① Ретроспектива диалога.
 *
 * Запрашивает 120 последних сообщений из DB messageLog, пропуская 20 новейших (уже в live timeline),
 * разбивает на сегменты по паузе > 10 минут; для каждого — первое/последнее сообщение, диапазон времени и количество.
 * LLM использует ретроспективу для понимания «о чём говорили раньше» и поддержания связности тем.
 */
function buildConversationRecap(target: string | null, nowMs: number): RecapSegment[] {
  if (!target) return [];
  try {
    const db = getDb();
    const rows = db
      .select({
        senderName: messageLog.senderName,
        text: messageLog.text,
        isOutgoing: messageLog.isOutgoing,
        createdAt: messageLog.createdAt,
      })
      .from(messageLog)
      .where(eq(messageLog.chatId, target))
      .orderBy(desc(messageLog.id))
      .limit(120)
      .all()
      .reverse();

    if (rows.length <= 20) return [];

    // Пропускаем 20 новейших (уже есть в live timeline)
    const older = rows.slice(0, rows.length - 20);
    if (older.length === 0) return [];

    // Разбивка на сегменты по паузе > 10 минут
    const TEN_MIN = 10 * 60_000;
    const segments: Array<typeof older> = [];
    let current: typeof older = [older[0]];
    for (let i = 1; i < older.length; i++) {
      const gap = older[i].createdAt.getTime() - older[i - 1].createdAt.getTime();
      if (gap > TEN_MIN) {
        segments.push(current);
        current = [older[i]];
      } else {
        current.push(older[i]);
      }
    }
    segments.push(current);

    return segments.slice(-4).map((seg) => {
      const first = seg[0];
      const last = seg[seg.length - 1];
      const firstAgo = humanDuration((nowMs - first.createdAt.getTime()) / 1000);
      const lastAgo = humanDuration((nowMs - last.createdAt.getTime()) / 1000);
      const firstName = first.isOutgoing ? "Alice" : (first.senderName ?? "someone");
      const lastName = last.isOutgoing ? "Alice" : (last.senderName ?? "someone");
      const firstPreview = first.text ? first.text.slice(0, 60) : "(media)";
      const lastPreview = last.text ? last.text.slice(0, 60) : "(media)";
      return {
        timeRange: `${firstAgo} — ${lastAgo}`,
        messageCount: seg.length,
        first: `${firstName}: ${firstPreview}`,
        last: `${lastName}: ${lastPreview}`,
      };
    });
  } catch {
    return [];
  }
}

// ADR-225: FIFTY_FOUR_DAYS_MS удалена вместе с buildDiary().

// ADR-225: buildDiary() удалена. Единственный путь инъекции дневника = diary.mod.ts contribute().

/**
 * Уровень③ Запланированные задачи.
 *
 * Запрашивает из DB scheduledTasks активные задачи, у которых наступило время выполнения.
 * LLM использует сигналы задач для выполнения просроченных действий.
 */
function buildScheduledEvents(nowMs: number): string[] {
  try {
    const db = getDb();
    const rows = db
      .select({
        action: scheduledTasks.action,
        target: scheduledTasks.target,
      })
      .from(scheduledTasks)
      .where(and(eq(scheduledTasks.active, true), lte(scheduledTasks.targetMs, nowMs)))
      .limit(5)
      .all();

    return rows.map((r) => (r.target ? `${r.action} for ${r.target}` : `Task: ${r.action}`));
  } catch {
    return [];
  }
}

type RhythmProfileRow = typeof rhythmProfiles.$inferSelect;

/**
 * Уровень③ Сигналы ритма текущего объекта.
 *
 * Читает только проекцию текущего target и сжимает математические параметры в одну человекочитаемую фразу.
 * Prompt — наблюдательный уровень: здесь отображается только timing fact, без участия в скоринге и без жёстких блокировок.
 */
function buildTimingSignals(
  G: WorldModel,
  target: string | null,
  targetRef: EntityRef | undefined,
  chatTarget: ChatTarget,
  timezoneOffset: number,
): string[] {
  if (!target) return [];

  try {
    const db = getDb();
    const signals: string[] = [];
    const seenTiming = new Set<string>();

    for (const candidate of rhythmProfileCandidates(G, target, targetRef, chatTarget)) {
      const row = db
        .select()
        .from(rhythmProfiles)
        .where(eq(rhythmProfiles.entityId, candidate.entityId))
        .get();
      if (!row) continue;

      const profile = rhythmProfileFromRow(row);
      if (!profile) continue;
      if (profile.timezoneOffsetHours !== timezoneOffset) continue;

      const line = renderTimingLine(profile, candidate.label);
      if (!line) continue;
      const signature = timingSignalSignature(profile);
      if (seenTiming.has(signature)) continue;
      seenTiming.add(signature);
      signals.push(line);
      if (signals.length >= MAX_TIMING_SIGNALS) break;
    }

    return signals;
  } catch {
    return [];
  }
}

function timingSignalSignature(profile: RhythmProfileProjection): string {
  const active = profile.activeNowScore >= 0.7;
  const quiet = profile.quietNowScore >= 0.7;
  const unusual = profile.unusualActivityScore >= 0.8;
  const peak = profile.peakWindows[0];
  const quietWindow = profile.quietWindows[0];
  return JSON.stringify({
    active,
    quiet,
    unusual,
    peak,
    quietWindow,
  });
}

function rhythmProfileCandidates(
  G: WorldModel,
  target: string,
  targetRef: EntityRef | undefined,
  chatTarget: ChatTarget,
): Array<{ entityId: string; label: string }> {
  const candidates: Array<{ entityId: string; label: string }> = [];
  const seen = new Set<string>();
  const targetLabel = targetRef?.displayName ?? readableTargetName(G, target);

  const push = (entityId: string | null, label: string) => {
    if (!entityId || seen.has(entityId)) return;
    seen.add(entityId);
    candidates.push({ entityId, label });
  };

  if (chatTarget.isPrivate) {
    push(ensureContactId(target), targetLabel);
    push(ensureChannelId(target), `чат с ${targetLabel}`);
    return candidates;
  }

  push(ensureChannelId(target), targetLabel);
  return candidates;
}

function readableTargetName(G: WorldModel, target: string): string {
  const channelId = ensureChannelId(target);
  if (channelId && G.has(channelId)) {
    const name = G.getChannel(channelId).display_name;
    if (name && String(name).trim() !== "") return String(name);
  }

  const contactId = ensureContactId(target);
  if (contactId && G.has(contactId)) {
    const name = G.getContact(contactId).display_name;
    if (name && String(name).trim() !== "") return String(name);
  }

  return "текущий чат";
}

function rhythmProfileFromRow(row: RhythmProfileRow): RhythmProfileProjection | null {
  const entityType = parseRhythmEntityType(row.entityType);
  const confidence = parseRhythmConfidence(row.confidence);
  if (!entityType || !confidence) return null;

  return {
    entityId: row.entityId,
    entityType,
    sourceWindowStartMs: row.sourceWindowStartMs,
    sourceWindowEndMs: row.sourceWindowEndMs,
    sampleCount: row.sampleCount,
    bucketCount: row.bucketCount,
    activeBucketCount: row.activeBucketCount,
    observedSpanHours: row.observedSpanHours,
    observedDays: row.observedDays,
    timezoneOffsetHours: row.timezoneOffsetHours,
    enabledPeriodsHours: parseNumberArray(row.enabledPeriodsJson),
    activeNowScore: row.activeNowScore,
    quietNowScore: row.quietNowScore,
    unusualActivityScore: row.unusualActivityScore,
    peakWindows: parseTimeWindows(row.peakWindowsJson),
    quietWindows: parseTimeWindows(row.quietWindowsJson),
    confidence,
    stale: row.stale,
    diagnostics: emptyRhythmDiagnostics(),
  };
}

function parseRhythmEntityType(value: string): RhythmEntityType | null {
  if (value === "contact" || value === "channel" || value === "self") return value;
  return null;
}

function parseRhythmConfidence(value: string): RhythmConfidence | null {
  if (value === "low" || value === "medium" || value === "high") return value;
  return null;
}

function parseTimeWindows(value: string): TimeWindow[] {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item): TimeWindow[] => {
      if (!item || typeof item !== "object") return [];
      const startHour = Number((item as { startHour?: unknown }).startHour);
      const endHour = Number((item as { endHour?: unknown }).endHour);
      if (!Number.isInteger(startHour) || !Number.isInteger(endHour)) return [];
      if (startHour < 0 || startHour > 23 || endHour < 0 || endHour > 24) return [];
      return [{ startHour, endHour }];
    });
  } catch {
    return [];
  }
}

function parseNumberArray(value: string): number[] {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item): number[] => {
      const n = Number(item);
      return Number.isFinite(n) ? [n] : [];
    });
  } catch {
    return [];
  }
}

function emptyRhythmDiagnostics(): RhythmProfileProjection["diagnostics"] {
  return {
    r2: 0,
    dailyStrength: 0,
    halfDailyStrength: 0,
    weeklyStrength: 0,
    activeBucketCount: 0,
    observedSpanHours: 0,
    observedDays: 0,
    timezoneOffsetHours: 0,
    enabledPeriodsHours: [],
    coefficients: { intercept: 0, terms: [] },
    hourlyScores: [],
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Стратегия C: предварительный сбор из Mod State
// ═══════════════════════════════════════════════════════════════════════════

const MAX_PROFILE_TRAITS = 3;
const MAX_PROFILE_INTERESTS = 3;

/**
 * Уровень② Детальный профиль контакта.
 *
 * Извлекает portrait, traits, interests из предварительно собранного relationships mod state.
 * LLM использует профиль для персонализации диалога (знание характера и интересов собеседника).
 */
function buildContactProfile(
  target: string,
  contactProfiles?: SnapshotInput["contactProfiles"],
): ContactProfileSlot | undefined {
  if (!contactProfiles) return undefined;

  const numId = extractNumericId(target);
  const contactId = ensureContactId(target);
  const altContactId = numId != null ? ensureContactId(String(Math.abs(numId))) : null;

  const profile =
    (contactId ? contactProfiles[contactId] : undefined) ??
    (altContactId ? contactProfiles[altContactId] : undefined) ??
    (target ? contactProfiles[target] : undefined);

  if (!profile) return undefined;

  const traits: string[] = [];
  if (profile.traits) {
    const sorted = Object.entries(profile.traits).sort(
      (a, b) => Math.abs(b[1].value) - Math.abs(a[1].value),
    );
    for (const [key] of sorted.slice(0, MAX_PROFILE_TRAITS)) {
      traits.push(key);
    }
  }

  const interests: string[] = [];
  if (profile.crystallizedInterests) {
    const sorted = Object.entries(profile.crystallizedInterests).sort(
      (a, b) => b[1].confidence - a[1].confidence,
    );
    for (const [, val] of sorted.slice(0, MAX_PROFILE_INTERESTS)) {
      interests.push(val.label);
    }
  } else if (profile.interests) {
    interests.push(...profile.interests.slice(0, MAX_PROFILE_INTERESTS));
  }

  // Bio: синхронное чтение из кэша (Telegram-подпись контакта)
  const resolvedCid = contactId ?? altContactId;
  const bioEntry = resolvedCid ? getCachedBio(resolvedCid) : null;
  const bio = bioEntry?.bio ?? undefined;

  if (!profile.portrait && traits.length === 0 && interests.length === 0 && !bio) return undefined;

  return {
    portrait: profile.portrait,
    traits,
    interests,
    ...(bio ? { bio } : {}),
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Стратегия D: конфигурация Peripheral Vision
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Уровень③ Конфигурация социального периферийного зрения.
 *
 * Активируется только в приватном чате + распознанный контакт + tier < 500.
 * Выводит общие каналы контакта из Graph и строит PeripheralVisionConfig.
 */
function buildPeripheralConfig(
  G: WorldModel,
  target: string,
  peripheralParams?: SnapshotInput["peripheralConfig"],
): PeripheralVisionConfig | null {
  if (!peripheralParams) return null;

  const { contactId } = resolveContactAndChannel(target, (id) => G.has(id));
  if (!contactId || !G.has(contactId)) return null;

  const tier = (G.getContact(contactId).tier ?? 50) as DunbarTier;
  const windowS = PERIPHERAL_TIER_WINDOW_S[tier] ?? 0;
  if (windowS <= 0) return null;

  const sharedChats = new Map<string, string>();
  for (const chId of G.getNeighbors(contactId, "joined")) {
    if (!G.has(chId)) continue;
    const ch = G.getChannel(chId);
    if (ch.chat_type !== "private") {
      const name = ch.display_name;
      sharedChats.set(chId, name ? String(name) : "(a shared group)");
    }
  }
  if (sharedChats.size === 0) return null;

  return {
    contactId,
    contactName: G.getContact(contactId).display_name
      ? String(G.getContact(contactId).display_name)
      : "(someone)",
    currentChat: target,
    sharedChats,
    windowS,
    ...peripheralParams,
  };
}

// ════���══════════════════════════════════════════════════════════════════════
// Метаинформация группы
// ═══════════════════════════════════════════════════════════════════════════

function buildGroupMeta(G: WorldModel, target: string): UserPromptSnapshot["groupMeta"] {
  const numId = extractNumericId(target);
  let membersInfo: string | undefined;
  let restrictions: string | undefined;

  if (numId) {
    const ci: ChatInfo | undefined = getCachedChatInfo(numId);
    if (ci?.membersCount) {
      membersInfo = `~${ci.membersCount} members`;
    }
    if (ci?.restrictions.length && !ci.isAliceAdmin) {
      restrictions = `Can't ${ci.restrictions.join(" or ")} here.`;
    }
  }

  // Поиск темы активного разговора
  const channelId = ensureChannelId(target);
  let topic: string | undefined;
  if (channelId && G.has(channelId)) {
    const convId = findActiveConversation(G, channelId);
    if (convId && G.has(convId)) {
      const convAttrs = G.getConversation(convId);
      if (convAttrs.topic) topic = String(convAttrs.topic);
    }
  }

  // directed: берётся из pending_directed канала
  let directed = false;
  if (channelId && G.has(channelId)) {
    const ch = G.getChannel(channelId);
    directed = (ch.pending_directed ?? 0) > 0;
  }

  // Bio: описание группы (из bio_cache)
  const channelBioEntry = channelId ? getCachedBio(channelId) : null;
  const bio = channelBioEntry?.bio ?? undefined;

  return { topic, directed, membersInfo, restrictions, bio };
}

// ═══════════════════════════════════════════════════════════════════════════
// Описание отношений (приватный чат)
// ═══════════════════════════════════════════════════════════════════════════

function buildRelationshipDesc(G: WorldModel, target: string): string | undefined {
  const contactId = ensureContactId(target);
  if (!contactId || !G.has(contactId)) {
    // Попытка вывести из channel ID
    const numId = extractNumericId(target);
    if (numId == null) return undefined;
    const altContactId = ensureContactId(String(Math.abs(numId)));
    if (!altContactId || !G.has(altContactId)) return undefined;
    const attrs = G.getContact(altContactId);
    const relType = attrs.relation_type;
    const tier = attrs.tier ?? 150;
    if (relType && relType !== "unknown") {
      return `${tierLabel(tier)}, ${relType}`;
    }
    return tierLabel(tier);
  }

  const attrs = G.getContact(contactId);
  const relType = attrs.relation_type;
  const tier = attrs.tier ?? 150;
  if (relType && relType !== "unknown") {
    return `${tierLabel(tier)}, ${relType}`;
  }
  return tierLabel(tier);
}

// ═══════════════════════════════════════════════════════════════════════════
// buildUserPromptSnapshot — публичный API
// ═══════════════════════════════════════════════════════════════════════════

export function buildUserPromptSnapshot(input: SnapshotInput): UserPromptSnapshot {
  const {
    G,
    messages,
    observations,
    item,
    round,
    episodeRound = 0,
    board,
    nowMs,
    isGroup: inputIsGroup,
    isChannel: inputIsChannel,
  } = input;

  // ── ADR-237: Определение сцены (закрытое пространство состояний) ──
  // Логика определения инкапсулирована в классе ChatTarget, производные атрибуты доступны через getter
  const chatTarget = (() => {
    // Сцена канала
    if (inputIsChannel && item.target) {
      const channelId = ensureChannelId(item.target);
      if (channelId && G.has(channelId)) {
        const attrs = G.getChannel(channelId);
        const role = String(attrs.alice_role ?? "");
        return ChatTarget.from("channel", false, role);
      }
      return ChatTarget.from("channel", false, undefined);
    }

    // Сцена группового чата
    if (inputIsGroup) {
      return ChatTarget.from("group", false, undefined);
    }

    // Сцена приватного чата: определяем, человек или бот
    let isBot = false;
    if (item.target) {
      const contactId = ensureContactId(item.target);
      if (contactId && G.has(contactId) && G.getContact(contactId).is_bot === true) {
        isBot = true;
      } else {
        // Обратный вывод contact ID из channel ID
        const numId = extractNumericId(item.target);
        if (numId != null) {
          const altContactId = ensureContactId(String(Math.abs(numId)));
          if (altContactId && G.has(altContactId) && G.getContact(altContactId).is_bot === true) {
            isBot = true;
          }
        }
      }
    }
    return ChatTarget.from("private", isBot, undefined);
  })();

  // Булевы атрибуты, производные от ChatTarget (заменяют isGroup/isChannel из input)
  const isGroup = chatTarget.isGroup;
  const isChannel = chatTarget.isChannel;

  // Экспортируем type в snapshot (рендерерам всё ещё нужен)
  const chatTargetType = chatTarget.type;

  // ── Целевой EntityRef ──
  const target = item.target ? (buildTargetRef(G, item.target) ?? undefined) : undefined;

  // ── ADR-268: self affect natural projection ──
  const emotionProjection = renderEmotionProjection(readEmotionState(G, nowMs)) ?? undefined;
  const emotionStyleHint = renderEmotionStyleHint(G, nowMs);

  // ── Внутренний шёпот ──
  const whisper = getFacetWhisper(item.facetId, item.action, isGroup);

  // ── Стратегия D: Peripheral Vision (только приватный чат) ──
  const peripheralConfig =
    !isGroup && !isChannel && item.target
      ? buildPeripheralConfig(G, item.target, input.peripheralConfig)
      : null;

  // ── Временная шкала ──
  // Замкнутый контур обратной связи BT: в сцене канала инжектируется forwardRegistry, чтобы timeline помечал пересланные сообщения
  const fwdRegistry: ForwardRegistry | undefined =
    isChannel && item.target ? readForwardRegistry(G, item.target) : undefined;
  const timeline = buildTimelineSlot(
    messages,
    observations,
    item.target ?? "",
    nowMs,
    peripheralConfig,
    fwdRegistry,
    input.timezoneOffset,
  );

  // ─── Треды ──
  const threads = isChannel ? [] : buildThreads(board.contextVars);

  // ── ADR-262 social case replay ──
  const socialCaseLines = input.socialCaseLines ?? [];

  // ── Социальная панорама канала ──
  const contacts = isChannel ? buildContactPanorama(G, nowMs, input.contactProfiles) : [];
  const groups = isChannel ? buildGroupPanorama(G) : [];
  // ADR-237: Каналы Alice (как цели пересылки или сцены публикации)
  const ownedChannels = isChannel ? buildOwnedChannels(G) : [];

  // ── Состояние диалога (не-канал) ──
  const presence = isChannel ? undefined : buildPresence(messages, nowMs);

  // ── Метаинформация группы ──
  const groupMeta = isGroup && item.target ? buildGroupMeta(G, item.target) : undefined;

  // ── Осведомлённость о раунде ──
  const roundHint = buildRoundHint(round, board.maxSteps);
  // ADR-232: Подсказка TC episode (когда host инициирует продолжение block)
  const episodeHint = buildEpisodeHint(episodeRound);

  // ── Описание отношений (приватный чат) ──
  const relationshipDesc =
    chatTarget.isPrivate && item.target ? buildRelationshipDesc(G, item.target) : undefined;

  // ── Обратная связь по действиям (кросс-чатовые данные из observations обрабатываются timeline source) ──
  const feedback: UserPromptSnapshot["feedback"] = (input.feedbackEntries ?? []).map((text) => ({
    text,
  }));

  // ── Уровень① Ретроспектива диалога ──
  const conversationRecap = isChannel ? [] : buildConversationRecap(item.target ?? null, nowMs);

  // ── Уровень② Профиль контакта (только приватный чат) ──
  const contactProfile =
    chatTarget.isPrivate && item.target
      ? buildContactProfile(item.target, input.contactProfiles)
      : undefined;

  // ── Уровень② Настроение контакта ──
  const contactMood = !isChannel && item.target ? buildContactMood(G, item.target) : undefined;

  // ── Уровень② Жаргон группы ──
  const jargon: JargonSlot[] = input.jargonEntries ?? [];

  // ── Уровень③ Глобальные сигналы осведомлённости ──
  const situationSignals = buildSituationSignals(G, item.target ?? null, nowMs, round);

  // ── Уровень③ Сигналы ритма текущего объекта ──
  const timingSignals = buildTimingSignals(
    G,
    item.target ?? null,
    target,
    chatTarget,
    input.timezoneOffset,
  );

  // ── Уровень③ Запланированные задачи ──
  const scheduledEvents = buildScheduledEvents(nowMs);

  // ── Уровень③ Флаги риска ──
  const riskFlags = item.target ? buildRiskFlags(G, item.target) : [];

  // ── Уровень④ Дневник ──
  // ADR-225: diary перенесён в diary.mod.ts contribute() (единственный путь инъекции).
  // Здесь diary snapshot больше не строится, двойная инъекция устранена.

  // ── Уровень④ Социальная восприимчивость (ADR-156) ──
  const socialReception =
    chatTarget.isGroup && item.target
      ? readSocialReception(G, ensureChannelId(item.target) ?? item.target) || undefined
      : undefined;

  // ── Уровень⑤ Деградировавшее действие ──
  const isDegraded = item.reason?.includes("degraded_action") ?? false;

  // ── Уровень⑤ Текущая тема ──
  const openTopic = item.target ? buildOpenTopic(G, item.target) : undefined;

  // ── Элементы ленты канала ──
  const feedItems: FeedItemSlot[] = input.feedItems ?? [];

  return {
    chatTargetType,
    nowMs,
    timezoneOffset: input.timezoneOffset,
    emotionProjection,
    emotionStyleHint,
    target,
    groupMeta,
    contacts,
    groups,
    ownedChannels,
    timeline: { lines: timeline.lines },
    presence,
    threads,
    socialCaseLines,
    feedback,
    whisper,
    roundHint,
    episodeHint,
    relationshipDesc,
    conversationRecap,
    contactProfile,
    contactMood,
    jargon,
    situationSignals,
    timingSignals,
    scheduledEvents,
    riskFlags,
    socialReception,
    episodeCarryOver: undefined,
    isDegraded,
    openTopic,
    feedItems,
  };
}
