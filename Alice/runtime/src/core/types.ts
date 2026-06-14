/**
 * Базовые типы системы Mod — перенесены из нарративного движка.
 *
 * Нарративный движок использует архитектуру ECS + Mod:
 * - Каждая область ответственности — отдельный Mod, объявляющий инструкции (запись), запросы (чтение), слушатели (реакция на широковещание)
 * - Dispatcher маршрутизирует инструкции → выполняет → широковещает всем listener
 * - Storyteller собирает контекст из contribute() всех Mod → сортирует → рендерит
 *
 * Адаптация для Alice:
 * - WorldGraph → WorldModel (граф компаньона)
 * - Turn → Tick (цикл 60 с)
 * - Сохранены ключевые интерфейсы: ModDefinition, ModContext, ContributionItem
 * - Упрощён HUD (без GUI — не требуется)
 *
 * Источник: narrative-engine/mods/types.ts
 */
import type { z } from "zod";
import type { AffordanceDeclaration } from "../engine/tick/types.js";
import type { WorldModel } from "../graph/world-model.js";
import type { PromptLine } from "./prompt-style.js";

// -- Метаданные Mod -----------------------------------------------------------

export interface ModMeta {
  /** Уникальный идентификатор Mod. */
  name: string;
  /** Категория: core (базовая инфраструктура) | mechanic (опциональный механизм). */
  category: "core" | "mechanic";
  /** Человекочитаемое описание. */
  description?: string;
  /** Список Mod-зависимостей (по именам). */
  depends?: string[];
  /**
   * Принадлежность к темам (поддерживается несколько). Используется для группировки функций запросов при рендеринге по намерению.
   * Если не указано — попадает в группу "other" (для базовой инфраструктуры core обычно не указывается).
   */
  topics?: string[];
}

// -- Контекст Mod -------------------------------------------------------------

/** Контекст выполнения, передаваемый в каждый метод Mod. */
export interface ModContext<TState = unknown> {
  /** Граф компаньона (глобально разделяемый, доступен для чтения и записи). */
  graph: WorldModel;
  /** Приватное состояние текущего Mod (изменяемая ссылка). */
  state: TState;
  /** Текущий тик. */
  tick: number;
  /** ADR-110: Текущее wall-clock время (мс), вычисляется один раз в начале evolveTick и передаётся всем дочерним функциям. */
  nowMs: number;
  /** Белый список целей для действий. null = белый список не включён; пустое множество = нет доступных целей. */
  targetWhitelist?: ReadonlySet<string> | null;
  /** Чтение состояния других Mod (только чтение). */
  getModState: <T = unknown>(modName: string) => T | undefined;
  /** Вызов инструкций другого Mod (межмодульное взаимодействие). Внедряется Dispatcher. */
  dispatch: (instruction: string, args: Record<string, unknown>) => unknown;
}

// -- Система инструкций -------------------------------------------------------

/** Определение параметра. schema — единственный источник истины о типе и обязательности. */
export interface ParamDefinition {
  description: string;
  schema: z.ZodTypeAny;
}

/**
 * Определение инструкции (операция записи, имеет побочные эффекты, инициирует широковещание).
 *
 * Дизайн унаследован от нарративного движка (имя инструкции = имя функции, порядок ключей params = порядок позиционных аргументов).
 * @see narrative-engine/mods/types.ts — InstructionDefinition
 * @see narrative-engine/sandbox/inject.ts — универсальный цикл инъекции
 */
export interface InstructionDefinition {
  /**
   * Сигнатура параметров. Порядок вставки ключей Record = порядок позиционных аргументов при вызове LLM.
   * Слой инъекции автоматически отображает `feel("positive", "reason")` в `{valence: "positive", reason: "reason"}`.
   */
  params: Record<string, ParamDefinition>;
  description: string;
  examples?: string[];
  impl: (ctx: ModContext, args: Record<string, unknown>) => unknown;

  /**
   * Контекстная инъекция: если LLM не передал параметр, он автоматически заполняется из sandbox contextVars.
   * key = имя параметра, value = функция, выводящая значение по умолчанию из contextVars.
   */
  deriveParams?: Record<
    string,
    (contextVars: Record<string, unknown>, args?: Record<string, unknown>) => unknown
  >;

  /**
   * Лимит вызовов за раунд. Число = отдельная квота; { limit, group } = общая квота.
   * Пример: intend использует { limit: 2, group: "thread_create" }.
   */
  perTurnCap?: number | { limit: number; group: string };

  /**
   * ADR-142: Объявление Affordance — метаданные обнаруживаемости для инструментов, видимых LLM.
   * @see docs/adr/142-action-space-architecture/README.md
   */
  affordance?: AffordanceDeclaration;
}

/** Определение запроса (операция чтения, без побочных эффектов, не широковещает). */
export interface QueryDefinition {
  params: Record<string, ParamDefinition>;
  description: string;
  /** Строка типа TypeScript для возвращаемого значения (используется для генерации объявлений .d.ts). */
  returns?: string;
  /** Краткое описание возвращаемого значения, читаемое LLM. Рендерится как JSDoc @returns. */
  returnHint?: string;
  impl: (ctx: ModContext, args: Record<string, unknown>) => unknown;
  /** Контекстная инъекция: если LLM не передал параметр, он автоматически вводится из sandbox contextVars. */
  deriveParams?: Record<
    string,
    (contextVars: Record<string, unknown>, args?: Record<string, unknown>) => unknown
  >;
  /**
   * Форматирование возвращаемого значения impl в читаемый для LLM текст.
   * Если не указано — fallback на JSON.stringify.
   */
  format?: (result: unknown) => string[];

  /**
   * ADR-142: Объявление Affordance — метаданные обнаруживаемости для запросов, видимых LLM.
   * @see docs/adr/142-action-space-architecture/README.md
   */
  affordance?: AffordanceDeclaration;
}

/** Обработчик слушателя (реакция на широковещание инструкций другого Mod). */
export type ListenHandler = (
  ctx: ModContext,
  args: Record<string, unknown>,
  result: unknown,
) => void;

// -- Система вкладов (сборка контекста Storyteller) ---------------------------

/** Тип корзины вклада (соответствует области LLM prompt). */
export type BucketType = "header" | "section" | "footer";

/**
 * Единичный элемент вклада.
 * Storyteller собирает вклады всех Mod → сортирует по bucket/order/priority → рендерит в prompt.
 *
 * ⚠ Принцип честности: текст в lines — это внутренний мир Alice. Она не знает о существовании движка.
 * Запрещены системные термины (tick/voice/pressure/mod), сырые числа (проценты/счётчики/ID),
 * мета-инструкции ("Decide what to do"). Писать только наблюдаемые факты и человекочитаемые семантические метки.
 * @see docs/adr/209-tui-native-prompt.md — принцип честности
 */
export interface ContributionItem {
  /** Большая категория (header — первый, section — средний, footer — последний). */
  bucket: BucketType;
  /** Ключ группировки (элементы с одинаковым key в одном bucket объединяются). */
  key?: string;
  /** Заголовок группы (действует первый элемент с title в рамках (bucket, key)). */
  title?: string;
  /** Сортировка между группами (меньшее значение — выше, по умолчанию 50). */
  order?: number;
  /** Приоритет внутри группы (большее значение — важнее, по умолчанию 50). */
  priority?: number;
  /** Строки содержимого вклада (должны быть сформированы через PromptBuilder). */
  lines: PromptLine[];
}

// -- Определение Mod ----------------------------------------------------------

/**
 * Интерфейс определения Mod — версия для Alice.
 *
 * Каждый Mod реализует этот интерфейс и объявляет:
 * - meta: метаданные (имя, категория, зависимости)
 * - initialState: начальное приватное состояние
 * - instructions: операции записи (имя инструкции = имя функции LLM, инициируют широковещание)
 * - queries: операции чтения (без широковещания)
 * - listen: прослушивание инструкций других Mod
 * - contribute: вклад LLM-контекста для Storyteller
 * - onTickStart / onTickEnd: хуки жизненного цикла
 */
export interface ModDefinition<TState = unknown> {
  meta: ModMeta;
  initialState: TState;

  /** Операции записи (имя инструкции = имя функции LLM), имеют побочные эффекты, инициируют широковещание. */
  instructions?: Record<string, InstructionDefinition>;

  /** Операции чтения, без побочных эффектов. */
  queries?: Record<string, QueryDefinition>;

  /** Прослушивание широковещания инструкций других Mod. key = имя инструкции. */
  listen?: Record<string, ListenHandler>;

  /** Вызывается в начале тика (очистка временного состояния и т.д.). */
  onTickStart?: (ctx: ModContext<TState>) => void;

  /** Вызывается в конце тика (вычисление агрегатов, пассивные эффекты и т.д.). */
  onTickEnd?: (ctx: ModContext<TState>) => void;

  /** Хук событий потока сознания (опционально). Точка входа для будущей мета-когниции C2.
   * @see docs/adr/204-consciousness-stream/ */
  onEvent?: (
    ctx: ModContext<TState>,
    event: { kind: string; entityIds: string[]; summary: string; salience: number },
  ) => void;

  /**
   * Вклад LLM-контекста для Storyteller.
   * Возвращает ContributionItem[], которые Storyteller сортирует и рендерит.
   */
  contribute?: (ctx: ModContext<TState>) => ContributionItem[];
}

// -- Типобезопасные межмодульные аксессоры ------------------------------------

/**
 * Реестр типов состояний Mod — каждый Mod раскрывает только публичную часть, доступную для межмодульного чтения.
 * Единственный контролируемый cast через `as` на входе; на всех сайтах вызова `as` отсутствует.
 */
export interface ModStateRegistry {
  relationships: { targetNodeId: string | null };
  observer: {
    outcomeHistory: Array<{ target: string; quality: number; reason: string; tick: number }>;
    impressionCounts?: Record<string, number>;
  };
  pressure: {
    latest: {
      P1: number;
      P2: number;
      P3: number;
      P4: number;
      P5: number;
      P6: number;
      API: number;
    } | null;
  };
  soul: { activeVoice: string | null };
}

/**
 * Типобезопасное межмодульное чтение состояния.
 * Внутри один контролируемый `as` (передача обобщённого параметра), на всех сайтах вызова `as` отсутствует.
 */
export function readModState<K extends keyof ModStateRegistry>(
  ctx: ModContext,
  modName: K,
): ModStateRegistry[K] | undefined {
  return ctx.getModState<ModStateRegistry[K]>(modName);
}

/**
 * Безопасное чтение текущего значения API из Mod давления.
 * Основано на readModState, ручные утверждения типов отсутствуют.
 * @see docs/adr/81-reflection-separation.md §Вклады Mod: переход с управления по голосу на управление по давлению
 */
export function readPressureApi(ctx: ModContext): number {
  const state = readModState(ctx, "pressure");
  return state?.latest?.API ?? 0;
}

// -- Фабричные функции вкладов (удобный API) ----------------------------------

export function header(
  lines: PromptLine | PromptLine[],
  priority = 50,
  key?: string,
): ContributionItem {
  return {
    bucket: "header",
    key,
    priority,
    lines: Array.isArray(lines) ? lines : [lines],
  };
}

export function section(
  key: string,
  lines: PromptLine[],
  title?: string,
  order = 50,
  priority = 50,
): ContributionItem {
  return { bucket: "section", key, title, order, priority, lines };
}

export function footer(lines: PromptLine | PromptLine[], priority = 50): ContributionItem {
  return {
    bucket: "footer",
    priority,
    lines: Array.isArray(lines) ? lines : [lines],
  };
}
