/**
 * Определения типов Blackboard Tick + Stigmergic Affordance Architecture.
 *
 * Ключевые концепции:
 * - AffordanceDeclaration: метаданные обнаруживаемости каждого инструмента, видимого LLM
 * - Blackboard: общая доска состояний tick-цикла (разделение чтения и записи)
 * - TickResult: полный вывод цикла tick()
 * - UnifiedTool: единое представление Telegram action и Mod instruction/query
 *
 * @see docs/adr/142-action-space-architecture/README.md
 */

// Re-export sandbox types for tick pipeline consumers
import type { ScriptExecutionResult } from "../../core/script-execution.js";
import type { Afterward } from "../../llm/tools.js";

export type { ScriptExecutionResult } from "../../core/script-execution.js";

// ═══════════════════════════════════════════════════════════════════════════
// Affordance объявления
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Приоритет видимости инструмента (поле-дискриминатор discriminated union).
 *
 * - sensor: базовый сенсор — обязательный ввод для поля давления/графа, сигнатура всегда видима
 * - core: ключевые инструменты взаимодействия — всегда видимы (send_message, react, search...)
 * - capability: инструменты возможностей — плоско видимы в shell manual, детали через `<command> --help`
 * - on-demand: инструменты по требованию — по умолчанию не включаются в shell manual, раскрываются только через явные сценарии/feature-гейты
 */
export type AffordancePriority = "sensor" | "core" | "capability" | "on-demand";

/**
 * Категория семейства инструментов — используется для группировки в shell manual, метаданных возможностей и feature-гейтов.
 *
 * Инструменты sensor/core не требуют category (всегда видимы).
 * Инструменты capability обязаны указывать category и отображаются плоско в shell manual.
 * Инструменты on-demand показываются только при явном разрешении через сценарий/feature-гейт.
 */
export type ToolCategory =
  // App инструменты
  | "weather"
  | "music"
  | "video"
  | "news"
  | "trending"
  | "calendar"
  | "timer"
  | "browser"
  | "fun"
  // Запросы знаний
  | "contact_info"
  | "chat_history"
  | "reminders"
  // Творчество/выражение
  | "sticker"
  | "media"
  // Интроспекция/память
  | "diary"
  | "scheduler"
  // Управление
  | "moderation"
  | "group_admin"
  | "account"
  // Семейство расширенных инструкций
  | "social"
  | "threads"
  | "mood"
  | "memory"
  | "skills";

/**
 * Полный список ToolCategory (для валидации перечисления во время выполнения).
 * Изменён на mutable массив — пакет Skill может регистрировать новые category.
 * @see src/skills/hot-loader.ts registerToolCategory()
 */
export const TOOL_CATEGORIES: string[] = [
  "weather",
  "music",
  "video",
  "news",
  "trending",
  "calendar",
  "timer",
  "browser",
  "fun",
  "contact_info",
  "chat_history",
  "reminders",
  "sticker",
  "media",
  "diary",
  "scheduler",
  "moderation",
  "group_admin",
  "account",
  "social",
  "threads",
  "mood",
  "memory",
  "skills",
];

/** Регистрация новой ToolCategory во время выполнения (вызывается при горячей загрузке пакета Skill). */
export function registerToolCategory(category: string): void {
  if (!TOOL_CATEGORIES.includes(category)) {
    TOOL_CATEGORIES.push(category);
  }
}

/** Отмена регистрации ToolCategory во время выполнения. */
export function unregisterToolCategory(category: string): void {
  const idx = TOOL_CATEGORIES.indexOf(category);
  if (idx >= 0) TOOL_CATEGORIES.splice(idx, 1);
}

/**
 * Базовые поля объявления Affordance — общие для всех вариантов priority.
 */
interface AffordanceBase {
  /** Когда использовать этот инструмент (записывается в shell manual / legacy category summary, читается LLM). */
  whenToUse: string;
  /** Когда не использовать этот инструмент. */
  whenNotToUse: string;
  /**
   * Жёсткий гейт — требуемый ключ FeatureFlags.
   * При отключённой фиче инструмент полностью невидим (даже если LLM запросил соответствующую category).
   */
  requires?: keyof FeatureFlags;
}

/** Базовый сенсор — обязательный ввод для поля давления/графа, сигнатура всегда видима. */
export interface SensorAffordance extends AffordanceBase {
  priority: "sensor";
}

/** Ключевой инструмент взаимодействия — всегда видим (send_message, react, search...). */
export interface CoreAffordance extends AffordanceBase {
  priority: "core";
}

/** Инструмент возможностей — плоско видим в shell manual. category обязателен, используется для группировки и метаданных whenToUse. */
export interface CapabilityAffordance extends AffordanceBase {
  priority: "capability";
  category: ToolCategory;
}

/** Инструмент по требованию — показывается только при явном разрешении через сценарий/feature-гейт (moderation, group_admin...). */
export interface OnDemandAffordance extends AffordanceBase {
  priority: "on-demand";
  category?: ToolCategory;
}

/**
 * Объявление Affordance — метаданные обнаруживаемости каждого инструмента, видимого LLM (discriminated union).
 *
 * Уровни видимости SAA (Stigmergic Affordance Architecture):
 * 1. Инструменты sensor/core всегда видимы
 * 2. Инструменты capability попадают в плоский shell manual и дополнительно описываются через метаданные category
 * 3. Инструменты on-demand показываются только при явном разрешении через сценарий/feature-гейт
 *
 * @see docs/adr/142-action-space-architecture/README.md §Architecture
 * @see docs/adr/216-cli-help-unification.md
 * @see docs/adr/223-flat-tool-visibility.md
 */
export type AffordanceDeclaration =
  | SensorAffordance
  | CoreAffordance
  | CapabilityAffordance
  | OnDemandAffordance;

// ═══════════════════════════════════════════════════════════════════════════
// Feature Flags
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Флаги фич времени выполнения — выводятся из конфигурации + окружения.
 * Используются для жёсткого гейта affordance: при отключённой фиче связанные инструменты невидимы.
 */
export interface FeatureFlags {
  hasWeather: boolean;
  hasMusic: boolean;
  hasBrowser: boolean;
  hasTTS: boolean;
  hasStickers: boolean;
  hasBots: boolean;
  hasSystemThreads: boolean;
  hasVideo: boolean;
}

// ═══════════════════════════════════════════════════════════════════════════
// Blackboard
// ═══════════════════════════════════════════════════════════════════════════

/** Бюджетные ограничения. */
export interface TickBudget {
  maxSteps: number;
  usedSteps: number;
}

/**
 * Blackboard — общая доска состояний tick-цикла.
 *
 * Один Blackboard создаётся на каждый engagement и используется для чтения и записи внутри tick-цикла.
 * Неизменяемая часть (pressures/voice/target/features) — начальные значения, установленные при создании.
 * Изменяемая часть (observations/execution/preparedCategories/...) накапливается по шагам tick.
 */
export interface Blackboard {
  // ── Неизменяемые начальные значения ──
  readonly pressures: readonly [number, number, number, number, number, number];
  readonly voice: string;
  readonly target: string | null;
  readonly features: Readonly<FeatureFlags>;
  readonly contextVars: Readonly<Record<string, unknown>>;

  // ── Изменяемые накапливаемые данные (обновляются по шагам tick) ──
  observations: string[];
  execution: ScriptExecutionResult;
  /** Историческое поле: старые записи об активации capability. В обычном prompt заменено плоским shell manual. */
  preparedCategories: Set<ToolCategory>;

  // ── Бюджет ──
  budget: TickBudget;
  /** Классификация последнего сбоя вызова LLM. Используется только в дуге обратной связи для разграничения инфраструктурных сбоев и невалидного вывода модели. */
  failureKind?: import("./callLLM.js").TickFailureKind;
}

// ═══════════════════════════════════════════════════════════════════════════
// Результат Tick
// ═══════════════════════════════════════════════════════════════════════════

/** Причина немедленного продолжения хостом внутри того же tick. */
export type IntraTickContinuationReason = "local_observation_followup" | "error_recovery" | "none";
export type ActualContinuationReason = Exclude<IntraTickContinuationReason, "none">;

/** ADR-235 + ADR-247: метаданные наблюдаемости на уровне tick. */
export interface TickTcMeta {
  toolCallCount: number;
  budgetExhausted: boolean;
  afterward: Afterward;
  /** Имя endpoint/provider, выбранного при входе в tick; используется только для диагностики транспорта и circuit-breaker. */
  provider?: string;
  /** Стабильный ID модели, выбранной при входе в tick; является источником истины для ротации моделей и диагностики качества. */
  model?: string;
  /** Агрегированные блоки $ cmd\noutput (обрезаны до 4 КБ). */
  commandLog: string;
  /**
   * Последовательность причин продолжений, инициированных хостом внутри одного tick.
   * Записываются только реальные продолжения, "none" не записывается.
   */
  hostContinuationTrace?: ActualContinuationReason[];
}

/** Причина выхода из tick-цикла. */
export type TickOutcome =
  | "terminal"
  | "waiting_reply"
  | "watching"
  | "empty"
  | "resting"
  | "fed_up"
  | "cooling_down"
  /** Зарезервировано: бюджет продолжений внутри episode исчерпан. В текущей реализации по-прежнему сворачивается в terminal. */
  | "tc_budget_exhausted";

/**
 * Полный вывод цикла tick() — финальный результат после drain Blackboard.
 * Заменяет устаревший SubcycleResult.
 */
export interface TickResult {
  outcome: TickOutcome;
  observations: string[];
  execution: ScriptExecutionResult;
  stepsUsed: number;
  /** Историческое поле: старые записи об активации capability. В обычном prompt заменено плоским shell manual. */
  preparedCategories: ToolCategory[];
  duration: number;
  /** ADR-215: когнитивный остаток последнего шага вывода LLM (из TickStepSchema.residue). */
  llmResidue?: import("../../llm/schemas.js").LLMResidue;
  /** Количество продолжений block внутри episode (дополнительные раунды, инициированные хостом, например локальный follow-up / самокоррекция). */
  episodeRounds: number;
  /** ADR-235: метаданные наблюдаемости TC-цикла. */
  tcMeta?: TickTcMeta;
  /** Классификация сбоя вызова LLM по границе инфраструктура/модель. */
  failureKind?: import("./callLLM.js").TickFailureKind;
}

/**
 * Вывод LLM за один шаг — структура после разбора TickStepSchema.
 * Выводится из Zod schema, что гарантирует соответствие типов.
 */
export type { TickStep as TickStepOutput } from "../../llm/schemas.js";

// ═══════════════════════════════════════════════════════════════════════════
// Унифицированное представление инструментов
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Унифицированный интерфейс инструментов — приводит Telegram action и Mod instruction/query к единому представлению.
 */
export interface UnifiedTool {
  /** Имя инструмента (= имя функции в sandbox). */
  name: string;
  /** Объявление affordance (обязательно — только инструменты с объявленным affordance попадают в унифицированное представление). */
  affordance: AffordanceDeclaration;
}

/**
 * Утилитарная функция типов — утверждает, что инструмент имеет объявление affordance.
 * Безопасно сужает инструмент с опциональным affordance до AffordanceDeclaration.
 */
export function hasAffordance<T extends { affordance?: AffordanceDeclaration }>(
  tool: T,
): tool is T & { affordance: AffordanceDeclaration } {
  return tool.affordance != null;
}
