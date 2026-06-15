/**
 * Diary Mod — рабочая память Алисы (внутренний мир).
 *
 * ADR-82 → ADR-225: возврат от append-only лога к буферу рабочей памяти.
 *
 * Базовая модель: diary — это пул слотов мыслей фиксированной ёмкости (7 слотов), а не бесконечно растущий лог.
 * Каждый слот — «живая мысль»: при записи схожего содержания по той же теме происходит слияние-эволюция (consolidate-on-write),
 * а не добавление новой строки. Значимость (salience) затухает со временем, угасшие мысли освобождают слоты новым.
 *
 * Теоретическая база:
 * - Baddeley (2000) Working Memory: ограниченная ёмкость + активное удержание + замещение при интерференции
 * - Cowan (2001): объём рабочей памяти 4±1 элемента
 * - MemGPT (Packer et al. 2023): Core Memory — малая ёмкость, всегда видима, самостоятельно редактируема
 * - Park et al. (2023) Generative Agents: слияние при записи ≈ неявная рефлексия (без дополнительных вызовов LLM)
 * - ACT-R activation decay: salience × 2^(-age/halfLife)
 *
 * Принцип дизайна: LLM может изменять субъективный мир Алисы, но не объективный.
 * Дневник субъективен — Алиса думает, что Дэвид её избегает, хотя Дэвид просто занят.
 * Именно этот «ненадёжный рассказчик» и является источником глубины личности.
 *
 * @see docs/adr/82-diary-inner-world.md — исходный дизайн
 * @see docs/adr/225-diary-working-memory.md — текущий рефакторинг
 */

import { z } from "zod";

import { createMod } from "../core/mod-builder.js";
import { PromptBuilder } from "../core/prompt-style.js";
import type { ContributionItem, ModContext } from "../core/types.js";
import { header, readModState } from "../core/types.js";
import { ensureChannelId, ensureContactId } from "../graph/constants.js";
import { warmEmbeddingOnIngest } from "../llm/embedding-store.js";
import { getEmbeddingConfig } from "../llm/semantic-recall-config.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("diary");

// ═══════════════════════════════════════════════════════════════════════════
// Константы
// ═══════════════════════════════════════════════════════════════════════════

/** Ёмкость рабочей памяти (Cowan's 4±1 + запас). */
const CAPACITY = 7;

/** Максимум 2 записи в дневник за ход (защита от злоупотребления LLM). */
const DIARY_CAP_PER_TURN = 2;

/** Максимальная длина одной записи в символах. */
const MAX_ENTRY_LENGTH = 200;

/** Максимальное число мыслей, отображаемых при инжекте в contribute(). */
const INJECT_LIMIT = 5;

/** Порог слияния (Jaccard similarity по символьным биграммам).
 * Опытно: перефразировка на ту же тему ≈ 0.35-0.45, разные темы ≈ 0.0-0.15. */
const SIMILARITY_THRESHOLD = 0.35;

/** Период полураспада значимости (6 часов). Мысль, не обновлённая 6 часов, теряет половину значимости. */
const SALIENCE_HALF_LIFE_MS = 6 * 3600 * 1000;

/** Начальная значимость. */
const INITIAL_SALIENCE = 1.0;

/** Прирост значимости при каждом слиянии-эволюции. */
const SALIENCE_BUMP = 0.15;

/** Максимальная значимость. */
const MAX_SALIENCE = 2.0;

/** Мысли с эффективной значимостью ниже этого порога не инжектируются в prompt и освобождают слот при очистке. */
const INJECT_FLOOR = 0.05;

/** Окно консолидации (24 часа). Мысли старше этого окна не сливаются с новой записью. */
const CONSOLIDATION_WINDOW_MS = 24 * 3600 * 1000;

// ═══════════════════════════════════════════════════════════════════════════
// Модель данных
// ═══════════════════════════════════════════════════════════════════════════

/** Живая мысль. */
interface Thought {
  /** Текущая версия нарратива. */
  content: string;
  /** ID связанной сущности (null = глобальная мысль). */
  about: string | null;
  /** Значимость [0, MAX_SALIENCE]. Повышается при записи, затухает со временем. */
  salience: number;
  /** Время первого возникновения (epoch ms). */
  createdAt: number;
  /** Время последней эволюции (epoch ms). */
  updatedAt: number;
}

interface DiaryState {
  /** Счётчик записей за текущий ход (сбрасывается при каждом ACT). */
  turnWriteCount: number;
  /** Слоты рабочей памяти. Фиксированная ёмкость, каждый слот — «живая мысль». */
  thoughts: Thought[];
}

// ═══════════════════════════════════════════════════════════════════════════
// Вычисление схожести
// ═══════════════════════════════════════════════════════════════════════════

/** Множество символьных биграмм с поддержкой CJK. */
function charBigrams(text: string): Set<string> {
  const chars = [...text]; // Unicode-aware spread
  const bg = new Set<string>();
  for (let i = 0; i < chars.length - 1; i++) {
    bg.add(chars[i] + chars[i + 1]);
  }
  return bg;
}

/**
 * Jaccard similarity ∈ [0, 1].
 *
 * Использует символьные биграммы — нативно подходит для CJK (каждый иероглиф — один Unicode char).
 * Сложность O(n), без внешних зависимостей — проверенный метод приближённого обнаружения дублей.
 */
function jaccardSimilarity(a: string, b: string): number {
  const sa = charBigrams(a);
  const sb = charBigrams(b);
  let inter = 0;
  for (const x of sa) {
    if (sb.has(x)) inter++;
  }
  const union = sa.size + sb.size - inter;
  return union === 0 ? 0 : inter / union;
}

// ═══════════════════════════════════════════════════════════════════════════
// Затухание значимости
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Вычисляет актуальную значимость на лету (lazy evaluation, без массовых обновлений БД).
 *
 * Модель: экспоненциальное приближение ACT-R base-level activation.
 * effectiveSalience = salience × 2^(-age / halfLife)
 */
function effectiveSalience(t: Thought, nowMs: number): number {
  const age = nowMs - t.updatedAt;
  if (age <= 0) return t.salience;
  return t.salience * 0.5 ** (age / SALIENCE_HALF_LIFE_MS);
}

// ═══════════════════════════════════════════════════════════════════════════
// Путь записи: слияние или выделение слота
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Ищет среди существующих мыслей подходящую для слияния.
 *
 * Условия: тот же about + в пределах окна консолидации + схожесть содержания выше порога.
 * Возвращает индекс слота, -1 = не найдено.
 */
function findSimilarThought(
  thoughts: Thought[],
  content: string,
  about: string | null,
  nowMs: number,
): number {
  const cutoff = nowMs - CONSOLIDATION_WINDOW_MS;
  for (let i = 0; i < thoughts.length; i++) {
    const t = thoughts[i];
    // about должен совпадать
    if (t.about !== about) continue;
    // Мысли за пределами окна консолидации не сливаем
    if (t.updatedAt < cutoff) continue;
    // Проверка схожести содержания
    if (jaccardSimilarity(content, t.content) >= SIMILARITY_THRESHOLD) {
      return i;
    }
  }
  return -1;
}

/**
 * Записывает мысль: сливает с существующим слотом / выделяет новый / заменяет слот с наименьшей значимостью.
 */
function writeThought(
  state: DiaryState,
  content: string,
  about: string | null,
  nowMs: number,
): { evolved: boolean } {
  // 1. Ищем мысль для слияния
  const idx = findSimilarThought(state.thoughts, content, about, nowMs);
  if (idx >= 0) {
    // Слияние (evolve): заменяем содержание новой версией, повышаем значимость
    const t = state.thoughts[idx];
    t.content = content;
    t.salience = Math.min(t.salience + SALIENCE_BUMP, MAX_SALIENCE);
    t.updatedAt = nowMs;
    log.info("Thought evolved (consolidated)", { about, salience: t.salience });
    return { evolved: true };
  }

  // 2. Есть свободный слот → выделяем
  if (state.thoughts.length < CAPACITY) {
    state.thoughts.push({
      content,
      about,
      salience: INITIAL_SALIENCE,
      createdAt: nowMs,
      updatedAt: nowMs,
    });
    log.info("New thought allocated", { about, slot: state.thoughts.length });
    return { evolved: false };
  }

  // 3. Слоты заполнены → заменяем слот с наименьшей эффективной значимостью
  let minIdx = 0;
  let minSal = effectiveSalience(state.thoughts[0], nowMs);
  for (let i = 1; i < state.thoughts.length; i++) {
    const s = effectiveSalience(state.thoughts[i], nowMs);
    if (s < minSal) {
      minSal = s;
      minIdx = i;
    }
  }
  log.info("Thought replaced (lowest salience)", {
    replaced: state.thoughts[minIdx].content.slice(0, 30),
    replacedSalience: minSal,
    about,
  });
  state.thoughts[minIdx] = {
    content,
    about,
    salience: INITIAL_SALIENCE,
    createdAt: nowMs,
    updatedAt: nowMs,
  };
  return { evolved: false };
}

// ═══════════════════════════════════════════════════════════════════════════
// Нормализация поля about (переиспользует логику ADR-102)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Нормализует поле about записи дневника до формата ID узла графа.
 *
 * Стандартный формат ID → оставить | ~ID/чистое число → contact:X | остальное → null (в глобальный пул).
 * @see ADR-102
 */
function normalizeAbout(about: string): string | null {
  if (about.startsWith("contact:") || about.startsWith("channel:")) return about;
  const contactId = ensureContactId(about);
  if (contactId) return contactId;
  log.debug("normalizeAbout: non-ID format, falling back to null", { about });
  return null;
}

function thoughtMatchesCurrentTarget(t: Thought, currentTarget: string | null): boolean {
  if (!t.about || !currentTarget) return false;
  if (t.about === currentTarget) return true;
  return ensureChannelId(t.about) === currentTarget || ensureContactId(currentTarget) === t.about;
}

function currentDiaryTarget(ctx: ModContext<DiaryState>): string | null {
  const relState = readModState(ctx, "relationships");
  return relState?.targetNodeId ?? null;
}

// ═══════════════════════════════════════════════════════════════════════════
// Форматирование времени
// ═══════════════════════════════════════════════════════════════════════════

/** ADR-110: форматирует разницу в миллисекундах в человекочитаемую временную метку. */
function formatTimeAgo(ageMs: number): string {
  const seconds = ageMs / 1000;
  if (seconds <= 300) return "только что";
  if (seconds <= 1800) return `${Math.round(seconds / 60)} мин назад`;
  if (seconds <= 3600) return "полчаса назад";
  return `${Math.round(seconds / 3600)} ч назад`;
}

// ═══════════════════════════════════════════════════════════════════════════
// Определение мода
// ═══════════════════════════════════════════════════════════════════════════

export const diaryMod = createMod<DiaryState>("diary", {
  category: "mechanic",
  description:
    "Рабочая память Алисы — эмоциональные воспоминания + желания + инерция настроения (слоты мыслей фиксированной ёмкости)",
  topics: ["diary"],
  initialState: { turnWriteCount: 0, thoughts: [] },
})
  .instruction("diary", {
    params: z.object({
      // Схема НЕ режет жёстко: impl сам аккуратно обрезает >MAX_ENTRY_LENGTH и
      // нормализует about. coerce → number/прочее не валят валидацию (была частая
      // ошибка "content max 200" / "about expected string, received number").
      content: z.coerce
        .string()
        .trim()
        .min(1)
        .describe("Текст записи (свободная форма; длинное аккуратно обрежется)"),
      about: z.coerce
        .string()
        .optional()
        .describe("@id связанной сущности (необязательно, например @7785440246)"),
    }),
    description: "Сделать личную запись в дневнике",
    affordance: {
      priority: "capability",
      category: "memory",
      whenToUse: "Recording personal reflections or significant events",
      whenNotToUse: "Routine interactions with nothing notable",
    },
    impl(ctx, args) {
      // Per-turn cap
      if (ctx.state.turnWriteCount >= DIARY_CAP_PER_TURN) {
        return { success: false, error: `max ${DIARY_CAP_PER_TURN} diary() per turn` };
      }

      const content = String(args.content);
      const trimmed =
        content.length > MAX_ENTRY_LENGTH ? content.slice(0, MAX_ENTRY_LENGTH) : content;

      // Нормализация поля about
      let about = args.about != null ? String(args.about) : null;
      if (about) {
        const resolved = normalizeAbout(about);
        if (!resolved) {
          about = null;
          log.debug("diary about could not be resolved; storing as global", {
            original: args.about,
            resolved: about,
          });
        } else {
          about = resolved;
        }
      } else {
        about = currentDiaryTarget(ctx);
      }
      // ADR-91 Layer 1: diary about Bot → очищаем about
      if (about && ctx.graph.has(about) && ctx.graph.getDynamic(about, "is_bot") === true) {
        about = null;
      }

      // Запись: слияние или выделение слота
      const { evolved } = writeThought(ctx.state, trimmed, about, ctx.nowMs);
      ctx.state.turnWriteCount++;

      // Семантическая память (ADDITIVE): фоновый прогрев эмбеддинга мысли.
      // No-op при отключённых эмбеддингах; никогда не блокирует/не бросает.
      warmEmbeddingOnIngest(trimmed, getEmbeddingConfig(), ctx.nowMs);

      return { success: true, evolved };
    },
  })
  // Сбрасываем счётчик per-turn в начале каждого тика
  .onTickStart((ctx) => {
    ctx.state.turnWriteCount = 0;
  })
  // В конце каждого тика удаляем угасшие мысли (освобождаем слоты)
  .onTickEnd((ctx) => {
    const nowMs = ctx.nowMs;
    const before = ctx.state.thoughts.length;
    ctx.state.thoughts = ctx.state.thoughts.filter(
      (t) => effectiveSalience(t, nowMs) >= INJECT_FLOOR,
    );
    const removed = before - ctx.state.thoughts.length;
    if (removed > 0) {
      log.info("Faded thoughts pruned", { removed, remaining: ctx.state.thoughts.length });
    }
  })
  // Единственный путь инжекта: секция "твои недавние мысли" в system prompt
  .contribute((ctx): ContributionItem[] => {
    const { thoughts } = ctx.state;
    if (thoughts.length === 0) return [];

    const nowMs = ctx.nowMs;

    // Читаем текущую цель диалога (для target-aware сортировки)
    const relState = readModState(ctx, "relationships");
    const currentTarget = relState?.targetNodeId ?? null;

    // Вычисляем эффективную значимость, оставляем только мысли, связанные с текущей целью.
    const active = thoughts
      .map((t) => ({ ...t, eSal: effectiveSalience(t, nowMs) }))
      .filter((t) => t.eSal >= INJECT_FLOOR)
      // ПРИМ.: global-мысли (about=null) намеренно НЕ попадают в per-target prompt (тест diary:308).
      // Аудит (H4) предлагал их инжектить (ADR-82), но это смена когниции — вынесено на решение владельца.
      .filter((t) => thoughtMatchesCurrentTarget(t, currentTarget))
      .sort((a, b) => {
        return b.eSal - a.eSal;
      });

    const toInject = active.slice(0, INJECT_LIMIT);
    if (toInject.length === 0) return [];

    // Сортируем по времени (сначала старые — порядок чтения)
    toInject.sort((a, b) => a.updatedAt - b.updatedAt);

    const m = new PromptBuilder();
    m.heading("Твои недавние мысли (о них знаешь только ты)");
    m.blank();

    const items: string[] = [];
    for (const t of toInject) {
      const timeLabel = formatTimeAgo(nowMs - t.updatedAt);
      const aboutName =
        t.about && ctx.graph.has(t.about)
          ? String(ctx.graph.getDynamic(t.about, "display_name") ?? t.about)
          : t.about;
      const aboutLabel = aboutName ? ` про ${aboutName}` : "";
      items.push(`${timeLabel}${aboutLabel}: ${t.content}`);
    }
    m.list(items);

    // priority 75: ниже SOUL_CORE (100) и voice-guidance (90),
    // выше Instincts (80). Дневник — продолжение личности, должен иметь приоритет над правилами.
    return [header(m.build(), 75)];
  })
  .build();

// Экспортируем вспомогательные функции для тестов
export { charBigrams, effectiveSalience, jaccardSimilarity };
export type { DiaryState, Thought };
