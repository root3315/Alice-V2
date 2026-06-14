/**
 * Storyteller — агрегатор LLM-контекста (портирован из narrative engine).
 *
 * Собирает contribute() от всех Mod через Dispatcher → сортирует по bucket/order/priority
 * → Trim (обрезка по token budget) → рендерит в system + user prompt.
 *
 * Заменяет старый briefing.ts (ручная сборка prompt).
 *
 * Правила сортировки:
 * 1. Слои bucket: header → section → footer
 * 2. Внутри bucket по order по возрастанию (меньше — ближе к началу)
 * 3. Внутри (bucket, key) по priority по убыванию (выше — важнее)
 * 4. Элементы с одинаковым key объединяются в группу; заголовок даёт первый элемент с title
 *
 * Шаг Trim (Def 3.9 из статьи: Contribute → Rank → Trim → Inject):
 * после рендера проверяется суммарный объём токенов; при превышении удаляем с наименьшим приоритетом не-header группы.
 *
 * Источник: narrative-engine/mods/storyteller/index.ts
 * @see paper-five-dim/ Definition 7.1 (четырёхшаговый пайплайн Context Assembly)
 */

import { createLogger } from "../utils/logger.js";
import type { ContributionItem } from "./types.js";

const log = createLogger("storyteller");

// -- ADR-114 D1: Изоляция Budget Zone -----------------------------------------

/** Зона бюджета при сборке контекста (context assembly budget zone). */
export type BudgetZone = "anchor" | "situation" | "conversation" | "memory";

/**
 * Соотношения zone по умолчанию.
 * anchor 30%: ядро личности (header bucket, иммунитет к обрезке)
 * situation 15%: восприятие окружения (часы, нагрузка, подсказки стратегии, метки риска)
 * conversation 40%: контекст диалога (messages + scriptGuide + manual + footer + вклад mod, связанных с диалогом)
 * memory 15%: извлечение воспоминаний (профиль контакта, потоки, упорядочение памяти)
 * @see docs/adr/114-context-assembly-rehabilitation.md — D1
 */
export const DEFAULT_ZONE_RATIOS: Record<BudgetZone, number> = {
  anchor: 0.3,
  situation: 0.15,
  conversation: 0.4,
  memory: 0.15,
};

/** Ключи contribution, относящиеся к зоне SITUATION. */
const SITUATION_KEYS = new Set([
  "wall-clock",
  "situation",
  "strategy-hints",
  "risk-flags",
  "self-mood",
  "self-knowledge",
  "scheduler-fired",
]);

/** Ключи contribution, относящиеся к зоне MEMORY. */
const MEMORY_KEYS = new Set([
  "contact-profile",
  "threads",
  "memory-housekeeping",
  "feedback-loop",
  "conversation",
]);

/** ADR-115 T2: Статистика использования zone budget. */
export interface ZoneStats {
  budget: number;
  used: number;
  trimmed: number;
}

/** Классифицирует ContributionItem по BudgetZone на основе bucket и key. */
export function classifyZone(item: ContributionItem): BudgetZone {
  if (item.bucket === "header") return "anchor";
  if (SITUATION_KEYS.has(item.key ?? "")) return "situation";
  if (MEMORY_KEYS.has(item.key ?? "")) return "memory";
  return "conversation";
}

/**
 * Zone-aware рендеринг вкладов — token budget изолирован по zone.
 *
 * Решаемая проблема: в старом едином пуле 30 сообщений из активного чата съедали 8000 токенов,
 * что системно «голодило» вклады mod в зонах SITUATION/MEMORY.
 *
 * @param items - ContributionItem от всех mod
 * @param totalBudget - глобальный token budget (GLOBAL_TOKEN_BUDGET)
 * @param zoneRatios - пользовательские соотношения zone (опционально, перекрывает DEFAULT_ZONE_RATIOS)
 * @param conversationFixedTokens - фиксированные расходы зоны CONVERSATION
 *        (суммарная оценка токенов: scriptGuide + manual + footer + messages)
 * @see docs/adr/114-context-assembly-rehabilitation.md — D1: Изоляция Budget Zone
 */
export function renderContributionsByZone(
  items: ContributionItem[],
  totalBudget: number,
  zoneRatios?: Partial<Record<BudgetZone, number>>,
  conversationFixedTokens?: number,
): { system: string; user: string; zoneStats: Record<BudgetZone, ZoneStats> } {
  if (items.length === 0) {
    const zero: ZoneStats = { budget: 0, used: 0, trimmed: 0 };
    return {
      system: "",
      user: "",
      zoneStats: { anchor: zero, situation: zero, conversation: zero, memory: zero },
    };
  }

  const ratios: Record<BudgetZone, number> = { ...DEFAULT_ZONE_RATIOS, ...zoneRatios };

  // Проверка: сумма долей не-anchor зон должна быть близка к 0.7 (anchor иммунен к обрезке и не участвует в распределении)
  const nonAnchorSum = ratios.situation + ratios.conversation + ratios.memory;
  if (nonAnchorSum > 1.0 || nonAnchorSum < 0.1) {
    log.warn("Zone ratios may be misconfigured", { ratios, nonAnchorSum });
  }

  // 1. Группировка по zone
  const zoneItems: Record<BudgetZone, ContributionItem[]> = {
    anchor: [],
    situation: [],
    conversation: [],
    memory: [],
  };
  for (const item of items) {
    zoneItems[classifyZone(item)].push(item);
  }

  // 2. Зона ANCHOR: header bucket иммунен к обрезке, без верхнего лимита budget
  const anchorRendered = renderContributions(zoneItems.anchor, {
    maxTokens: Number.MAX_SAFE_INTEGER,
  });

  // 3. Каждой не-anchor зоне выделяется независимый budget
  const sitBudget = Math.max(100, Math.floor(totalBudget * ratios.situation));
  const memBudget = Math.max(100, Math.floor(totalBudget * ratios.memory));
  // Из budget зоны CONVERSATION сначала вычитаем фиксированные расходы (scriptGuide + manual + footer + messages)
  const convRawBudget = Math.floor(totalBudget * ratios.conversation);
  const convBudget = Math.max(100, convRawBudget - (conversationFixedTokens ?? 0));

  const sitRendered = renderContributions(zoneItems.situation, { maxTokens: sitBudget });
  const memRendered = renderContributions(zoneItems.memory, { maxTokens: memBudget });
  const convRendered = renderContributions(zoneItems.conversation, { maxTokens: convBudget });

  // ADR-115 T2: использование zone budget (напрямую переиспользуем внутреннюю статистику токенов renderContributions)
  const zoneStats: Record<BudgetZone, ZoneStats> = {
    anchor: {
      budget: Number.MAX_SAFE_INTEGER,
      used: anchorRendered.usedTokens,
      trimmed: anchorRendered.trimmedTokens,
    },
    situation: {
      budget: sitBudget,
      used: sitRendered.usedTokens,
      trimmed: sitRendered.trimmedTokens,
    },
    conversation: {
      budget: convBudget,
      used: convRendered.usedTokens,
      trimmed: convRendered.trimmedTokens,
    },
    memory: { budget: memBudget, used: memRendered.usedTokens, trimmed: memRendered.trimmedTokens },
  };

  log.debug("Zone budgets", {
    anchor: "unlimited",
    situation: sitBudget,
    conversation: convBudget,
    memory: memBudget,
    conversationFixedTokens: conversationFixedTokens ?? 0,
  });

  // 4. Объединяем вывод system/user из всех zone
  // system = anchor (header bucket), user = situation → memory → conversation
  const systemParts = [anchorRendered.system].filter(Boolean);
  const userParts = [sitRendered.user, memRendered.user, convRendered.user].filter(Boolean);

  return {
    system: systemParts.join("\n\n---\n\n"),
    user: userParts.join("\n\n"),
    zoneStats,
  };
}

// Веса порядка bucket'ов
const BUCKET_ORDER: Record<string, number> = { header: 0, section: 1, footer: 2 };

/** Структура группы. */
interface Group {
  bucket: string;
  key: string;
  title?: string;
  order: number;
  items: Array<{ priority: number; lines: string[] }>;
}

/** Отрендеренная группа (с оценкой токенов). */
interface RenderedGroup {
  bucket: string;
  key: string;
  text: string;
  tokens: number;
  minPriority: number; // минимальный priority в группе (используется при сортировке для trim)
}

/**
 * Оценивает количество токенов в тексте.
 * Считает CJK- и ASCII-символы отдельно, затем суммирует с весами.
 * CJK: ~1.5 символа/токен, ASCII: ~4 символа/токен.
 */
export function estimateTokens(text: string): number {
  let cjk = 0;
  let ascii = 0;
  for (const ch of text) {
    ch.charCodeAt(0) > 0x2e80 ? cjk++ : ascii++;
  }
  return Math.ceil(cjk / 1.5 + ascii / 4);
}

/** Возвращаемое значение renderContributions. */
export interface RenderResult {
  system: string;
  user: string;
  /** ADR-115 T2: оценка количества обрезанных токенов. */
  trimmedTokens: number;
  /** ADR-115 T2: оценка количества токенов в итоговом выводе (system + user). */
  usedTokens: number;
}

const EMPTY_RENDER: RenderResult = { system: "", user: "", trimmedTokens: 0, usedTokens: 0 };

/**
 * Рендерит ContributionItem[] в текст prompt.
 * Возвращает RenderResult: bucket header → system prompt, section+footer → user prompt.
 *
 * @param maxTokens - верхний лимит token budget (по умолчанию 3000). При превышении удаляем не-header группы с наименьшим приоритетом.
 */
export function renderContributions(
  items: ContributionItem[],
  options?: { maxTokens?: number },
): RenderResult {
  if (items.length === 0) return EMPTY_RENDER;

  const maxTokens = options?.maxTokens ?? 3000;

  // Группировка
  const groupMap = new Map<string, Group>();
  for (const item of items) {
    const groupKey = `${item.bucket}::${item.key ?? "__default__"}`;
    let group = groupMap.get(groupKey);
    if (!group) {
      group = {
        bucket: item.bucket,
        key: item.key ?? "__default__",
        title: item.title,
        order: item.order ?? 50,
        items: [],
      };
      groupMap.set(groupKey, group);
    }
    // Берём минимальный order
    if ((item.order ?? 50) < group.order) group.order = item.order ?? 50;
    // Действует первый элемент с title
    if (!group.title && item.title) group.title = item.title;
    group.items.push({
      priority: item.priority ?? 50,
      lines: item.lines,
    });
  }

  // Сортировка групп: bucket → order → key
  const groups = [...groupMap.values()].sort((a, b) => {
    const bucketDiff = (BUCKET_ORDER[a.bucket] ?? 1) - (BUCKET_ORDER[b.bucket] ?? 1);
    if (bucketDiff !== 0) return bucketDiff;
    return a.order - b.order;
  });

  // Рендерим все группы
  const renderedGroups: RenderedGroup[] = [];

  for (const group of groups) {
    // Внутри группы по priority по убыванию
    group.items.sort((a, b) => b.priority - a.priority);

    const lines: string[] = [];
    if (group.title) {
      // ADR-141: Автоматически нормализуем заголовок секции до формата ## Title
      lines.push(group.title.startsWith("## ") ? group.title : `## ${group.title}`);
    }
    for (let i = 0; i < group.items.length; i++) {
      // Между несколькими item с одинаковым key вставляем пустую строку (вклады от разных mod)
      if (i > 0) lines.push("");
      lines.push(...group.items[i].lines);
    }

    if (lines.length === 0) continue;

    const text = lines.join("\n");
    const minPriority = Math.min(...group.items.map((i) => i.priority));
    renderedGroups.push({
      bucket: group.bucket,
      key: group.key,
      text,
      tokens: estimateTokens(text),
      minPriority,
    });
  }

  // ── ADR-209: Двухфазная обрезка (уровень item → уровень group) ──
  // Фаза 1: обрезка на уровне item — внутри group удаляем item по priority от меньшего к большему, сохраняя заголовок и сводку
  // Фаза 2: обрезка на уровне group — если лимит ещё превышен, удаляем group целиком (оставляя строку-сводку)
  let totalTokens = renderedGroups.reduce((sum, g) => sum + g.tokens, 0);
  let trimmedTokens = 0;

  // Фаза 1: обрезка на уровне item
  if (totalTokens > maxTokens) {
    for (const group of groups) {
      if (totalTokens <= maxTokens) break;
      if (group.bucket === "header") continue;
      if (group.items.length <= 1) continue; // Группы с одним item оставляем для фазы 2

      // Начинаем удалять с item с наименьшим priority
      const sortedByPriorityAsc = [...group.items].sort((a, b) => a.priority - b.priority);
      let removed = 0;
      for (const item of sortedByPriorityAsc) {
        if (totalTokens <= maxTokens) break;
        if (group.items.length - removed <= 1) break; // Сохраняем хотя бы 1 item
        const itemTokens = estimateTokens(item.lines.join("\n"));
        // Удаляем данный item из group.items
        const idx = group.items.indexOf(item);
        if (idx >= 0) {
          group.items.splice(idx, 1);
          removed++;
          totalTokens -= itemTokens;
          trimmedTokens += itemTokens;
          log.debug("Trimmed item", {
            key: group.key,
            priority: item.priority,
            tokens: itemTokens,
          });
        }
      }

      if (removed > 0) {
        // Повторно рендерим эту group (с добавлением строки-сводки)
        const rgIdx = renderedGroups.findIndex(
          (g) => g.key === group.key && g.bucket === group.bucket,
        );
        if (rgIdx >= 0) {
          const newLines: string[] = [];
          if (group.title) {
            newLines.push(group.title.startsWith("## ") ? group.title : `## ${group.title}`);
          }
          for (let i = 0; i < group.items.length; i++) {
            if (i > 0) newLines.push("");
            newLines.push(...group.items[i].lines);
          }
          newLines.push(`(${removed} more omitted)`);
          const newText = newLines.join("\n");
          const newTokens = estimateTokens(newText);
          // Корректируем дельту токенов (после повторного рендера может не совпадать с накопленным вычетом)
          totalTokens = totalTokens - renderedGroups[rgIdx].tokens + newTokens;
          renderedGroups[rgIdx].text = newText;
          renderedGroups[rgIdx].tokens = newTokens;
          renderedGroups[rgIdx].minPriority =
            group.items.length > 0 ? Math.min(...group.items.map((i) => i.priority)) : Infinity;
        }
      }
    }
  }

  // Фаза 2: обрезка на уровне group (страховочный этап — логика совпадает с исходной)
  while (totalTokens > maxTokens) {
    let trimIdx = -1;
    let lowestPriority = Infinity;
    for (let i = 0; i < renderedGroups.length; i++) {
      if (renderedGroups[i].bucket !== "header" && renderedGroups[i].minPriority < lowestPriority) {
        lowestPriority = renderedGroups[i].minPriority;
        trimIdx = i;
      }
    }
    if (trimIdx < 0) break;
    const trimmed = renderedGroups.splice(trimIdx, 1)[0];
    totalTokens -= trimmed.tokens;
    trimmedTokens += trimmed.tokens;
    log.debug("Trimmed contribution group", {
      key: trimmed.key,
      bucket: trimmed.bucket,
      tokens: trimmed.tokens,
      priority: trimmed.minPriority,
    });
  }

  // Формируем итоговый результат
  const systemParts: string[] = [];
  const userParts: string[] = [];

  for (const g of renderedGroups) {
    if (g.bucket === "header") {
      systemParts.push(g.text);
    } else {
      userParts.push(g.text);
    }
  }

  return {
    system: systemParts.join("\n\n---\n\n"),
    user: userParts.join("\n\n"),
    trimmedTokens,
    usedTokens: totalTokens,
  };
}
