/**
 * ADR-172: Information Visibility Layer — граница когнитивной приватности.
 *
 * Вставляет слой фильтрации между collectContributions() и renderContributionsByZone(),
 * отсеивая межчатовую информацию по аудитории текущего промпта (target chat).
 *
 * Принципы проектирования (предложение 126):
 * - Что инжектируется → то и проявляется в поведении
 * - Не давать LLM видеть лишнее надёжнее, чем говорить ему «не говори»
 *
 * Расширение Def 7.1 статьи: Contribute → Rank → 【Filter】 → Trim → Inject
 *
 * @see docs/adr/172-information-visibility-layer.md
 */

import { resolveContactAndChannel } from "../graph/constants.js";
import { readDisplayName, readTitle } from "../graph/dynamic-props.js";
import type { WorldModel } from "../graph/world-model.js";
import { ChatTarget } from "../prompt/types.js";
import type { ContributionItem } from "./types.js";

// ═══════════════════════════════════════════════════════════════════════════
// Контекст аудитории
// ═══════════════════════════════════════════════════════════════════════════

/** Контекст аудитории текущего промпта — определяет, какая информация видима. */
export interface AudienceContext {
  /** ID узла графа для target chat (например "channel:123"). null = цели нет. */
  targetChat: string | null;
  /** Тип чата. */
  chatType: "private" | "group" | "supergroup" | null;
  /** ID узла графа для target contact (присутствует в личных чатах). */
  targetContact: string | null;
  /** Dunbar tier цели (null для групповых чатов или при неизвестном значении). */
  targetTier: number | null;
}

/**
 * Выводит AudienceContext из данных, уже доступных в prompt-builder.
 * Дополнительные источники не нужны — target, chatType, G уже есть в buildTickPrompt.
 */
export function buildAudienceContext(
  G: WorldModel,
  targetChat: string | null,
  chatType: string,
): AudienceContext {
  const resolved = targetChat ? resolveContactAndChannel(targetChat, (id) => G.has(id)) : null;

  const contactId = resolved?.contactId ?? null;
  const tier = contactId && G.has(contactId) ? (G.getContact(contactId).tier ?? 50) : null;

  return {
    targetChat,
    chatType: ChatTarget.isGroupChat(chatType) ? (chatType as "group" | "supergroup") : "private",
    targetContact: contactId,
    targetTier: tier,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Классификация Section Key
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Ключи без межчатового содержимого — пропускаются напрямую, без фильтрации.
 *
 * Эти секции либо универсальны (часы), либо уже привязаны к текущей цели через contribute()
 * (например conversation, channel-info и др.).
 */
const ALWAYS_VISIBLE = new Set([
  // Время/настроение — универсальны
  "wall-clock",
  "self-mood",
  "self-knowledge",
  // Информация о текущем канале — привязана к target через contribute
  "channel-info",
  "channel-activity",
  "safety-warning",
  "escalation-check",
  // История разговора — привязана к target через timeline
  "conversation",
  "conversation-recap",
  "action-echo",
  // Обучение — генерируется per-group
  "group-jargon",
  "learned-expressions",
  // Фиды — инжектируются per-channel
  "feeds-channel",
]);

/**
 * Чисто служебные ключи — в групповых чатах удаляются целиком.
 *
 * Эти секции — внутренние задачи обслуживания Алисы (сортировка памяти, чистка затухания),
 * не несут ценности для принятия решений в группе и содержат межчатовые списки контактов.
 *
 * Примечание: социальная информация (профили/настроения/обратная связь) перенесена в ENTITY_SCOPED —
 * социальное восприятие участников группы ценно для групповых решений (например, знать, что у друга плохое настроение → быть осторожнее).
 * @see ADR-172 оригинальный дизайн + последующие правки
 */
const GROUP_REDACTED = new Set([
  "consolidation-hint", // Подсказка сортировки памяти (служебное)
  "memory-housekeeping", // Обслуживание памяти (служебное)
]);

/**
 * Ключи с многоэнтитийной информацией — требуют построчной фильтрации.
 *
 * Эти секции агрегируют информацию из нескольких каналов/контактов (например situation-строки перечисляют статус всех каналов),
 * их нельзя удалять целиком (строки, связанные с текущей целью, должны остаться); нужна построчная проверка.
 *
 * В группах сохраняются строки, связанные с участниками группы: через рёбра joined получаем display_name участников,
 * строки с именами участников → оставляем, с именами сторонних → удаляем.
 */
const ENTITY_SCOPED = new Set([
  "situation", // Семантизация давления — упоминает все каналы/контакты
  "strategy-hints", // Подсказки стратегии — межчатовые данные об отношениях/внимании/кризисах
  "threads", // Нарративные нити — содержат обязательства и биты из разных чатов
  "thread-review-hint", // Подсказка проверки нитей
  "scheduler-fired", // Сработавшие запланированные задачи — могут указывать на другие чаты
  "scheduler-upcoming", // Предстоящие запланированные задачи
  "risk-flags", // Флаги рисков — ссылаются на другие каналы
  "outcome-history", // Обратная связь по действиям — ссылается на другие target
  // Социальное восприятие — перенесено из GROUP_REDACTED: информация об участниках группы ценна для групповых решений
  "contact-profile", // Профиль контакта (характер/предпочтения участника помогают взаимодействовать уместно)
  "first-impression", // Первое впечатление (история участника помогает в групповом общении)
  "contact-mood", // Настроение контакта (знать настроение участника → скорректировать тон)
  "feedback-loop", // Поведенческая обратная связь (рефлексия качества взаимодействия в группе)
  "strategy-reflection", // Стратегическая рефлексия (осознание паттернов взаимодействия с участниками)
]);

// ═══════════════════════════════════════════════════════════════════════════
// Реализация фильтрации
// ═══════════════════════════════════════════════════════════════════════════

/** Определяет, видим ли блок строк thread для текущей аудитории. */
function isThreadBlockVisible(
  headerLine: string,
  audience: AudienceContext,
  G: WorldModel,
): boolean {
  // Личные чаты — нити не фильтруются, Alice может обсуждать все нити с близкими контактами
  if (audience.chatType === "private") return true;

  // В группах: системные нити не видны
  if (headerLine.includes("[system]")) return false;

  // В группах: проверяем, входит ли текущая группа в involves нити
  const threadIdMatch = headerLine.match(/^\[#(\d+)\]/);
  if (!threadIdMatch) return true; // Не удалось разобрать — пропускаем консервативно
  const threadNodeId = `thread_${threadIdMatch[1]}`;
  if (!G.has(threadNodeId)) return true; // Нет в графе — пропускаем консервативно

  const involves = G.getNeighbors(threadNodeId, "involves");
  return involves.some((id) => id === audience.targetChat || id === audience.targetContact);
}

/**
 * Построчная фильтрация секций ENTITY_SCOPED.
 *
 * Для ключа "threads" особая обработка: фильтрация по блокам thread (непрерывные строки, начиная с заголовка [#N]).
 * Для остальных ключей (situation, strategy-hints и др.): построчная фильтрация по видимости имени сущности.
 */
function filterEntityScopedSection(
  item: ContributionItem,
  audience: AudienceContext,
  G: WorldModel,
): ContributionItem | null {
  const key = item.key ?? "";

  // ── threads / thread-review-hint: фильтрация по блокам thread ──
  if (key === "threads" || key === "thread-review-hint") {
    return filterThreadSection(item, audience, G);
  }

  // ── Прочие entity-scoped ключи: построчная фильтрация ──
  // Личные чаты не фильтруются (разрешена полная видимость)
  if (audience.chatType === "private") return item;

  // Группы: оставляем только строки, связанные с текущей группой
  const targetNames = collectTargetNames(audience, G);
  const filteredLines = item.lines.filter((line) => {
    const text = String(line);
    // Если строка упоминает display_name текущей цели → оставляем
    for (const name of targetNames) {
      if (text.includes(name)) return true;
    }
    // Общая информационная строка (например "Several things happening at once.") → оставляем
    if (!containsEntityReference(text, G)) return true;
    // Упоминает другие сущности → удаляем
    return false;
  });

  if (filteredLines.length === 0) return null;
  return { ...item, lines: filteredLines };
}

/** Фильтрует секцию threads по блокам thread. */
function filterThreadSection(
  item: ContributionItem,
  audience: AudienceContext,
  G: WorldModel,
): ContributionItem | null {
  const filteredLines = [];
  let currentBlockVisible = true;

  for (const line of item.lines) {
    const text = String(line);

    // Определяем строку-заголовок thread: [#42] "title" ...
    if (text.match(/^\[#\d+\]/)) {
      currentBlockVisible = isThreadBlockVisible(text, audience, G);
    }

    if (currentBlockVisible) {
      filteredLines.push(line);
    }
  }

  if (filteredLines.length === 0) return null;
  return { ...item, lines: filteredLines };
}

/**
 * Собирает все возможные display_name, связанные с текущей целью.
 * Используется для построчного текстового поиска — если имя встречается в строке, строка относится к текущей цели.
 *
 * Для групп дополнительно включает display_name участников — социальное восприятие участников
 * ценно для групповых решений (знать, что у участника плохое настроение → говорить осторожнее).
 */
function collectTargetNames(audience: AudienceContext, G: WorldModel): string[] {
  const names: string[] = [];
  if (audience.targetChat && G.has(audience.targetChat)) {
    const dn = readDisplayName(G, audience.targetChat);
    if (dn) names.push(dn);
    const title = readTitle(G, audience.targetChat);
    if (title) names.push(title);

    // Участники группы: получаем контакты, появлявшиеся в группе, через рёбра joined
    const isGroup = audience.chatType === "group" || audience.chatType === "supergroup";
    if (isGroup) {
      for (const memberId of G.getNeighbors(audience.targetChat, "joined")) {
        if (G.has(memberId)) {
          const memberDn = readDisplayName(G, memberId);
          if (memberDn) names.push(memberDn);
        }
      }
    }
  }
  if (audience.targetContact && G.has(audience.targetContact)) {
    const dn = readDisplayName(G, audience.targetContact);
    if (dn) names.push(dn);
  }
  return names;
}

/**
 * Эвристическое определение: содержит ли строка текста ссылку на сущность из графа.
 *
 * Проверяет, встречается ли известный display_name в тексте.
 * Строки без ссылок на сущности (например "Several things happening at once.") считаются безопасной общей информацией.
 */
function containsEntityReference(text: string, G: WorldModel): boolean {
  // Проверяем display_name всех channel и contact
  for (const nodeId of G.getEntitiesByType("channel")) {
    const dn = readDisplayName(G, nodeId);
    if (dn && text.includes(dn)) return true;
  }
  for (const nodeId of G.getEntitiesByType("contact")) {
    const dn = readDisplayName(G, nodeId);
    if (dn && text.includes(dn)) return true;
  }
  return false;
}

// ═══════════════════════════════════════════════════════════════════════════
// Главная точка входа
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Применяет фильтр видимости к списку вкладов mod.
 *
 * Вставляется в конвейер Contribute → Rank → 【Filter】 → Trim → Inject.
 * Фильтрует/удаляет содержимое, которое не должно появляться в текущем промпте,
 * исходя из chatType и target в audience.
 *
 * Личные чаты практически не фильтруются (Alice и пользователь могут обсуждать любые темы).
 * Групповые чаты фильтруются (критерий: ценность для принятия решений в группе):
 * - GROUP_REDACTED ключи удаляются целиком (чисто служебные, без ценности для решений)
 * - ENTITY_SCOPED ключи фильтруются построчно: сохраняются строки о членах группы + текущей группе
 * - ALWAYS_VISIBLE ключи и header/footer пропускаются напрямую
 * - Неклассифицированные ключи пропускаются по умолчанию (консервативная сторона — вклады новых mod видны)
 */
export function applyVisibilityFilter(
  items: ContributionItem[],
  audience: AudienceContext,
  G: WorldModel,
): ContributionItem[] {
  // Личные чаты не фильтруются — Alice и пользователь могут обсуждать любые темы
  if (audience.chatType === "private" || audience.chatType === null) {
    return items;
  }

  // Фильтрация группового чата
  const result: ContributionItem[] = [];
  for (const item of items) {
    // header и footer всегда пропускаются (личность, руководство по командам, сноски)
    if (item.bucket === "header" || item.bucket === "footer") {
      result.push(item);
      continue;
    }

    const key = item.key ?? "";

    // group-dynamics-* ключи генерируются динамически по channelId, по природе своей scoped
    if (key.startsWith("group-dynamics-")) {
      result.push(item);
      continue;
    }

    if (ALWAYS_VISIBLE.has(key)) {
      result.push(item);
      continue;
    }

    if (GROUP_REDACTED.has(key)) {
      // В группе удаляем секцию целиком
      continue;
    }

    if (ENTITY_SCOPED.has(key)) {
      const filtered = filterEntityScopedSection(item, audience, G);
      if (filtered) result.push(filtered);
      continue;
    }

    // Неклассифицированный ключ — пропускаем по умолчанию (консервативная стратегия, чтобы случайно не потерять вклады новых mod)
    result.push(item);
  }

  return result;
}
