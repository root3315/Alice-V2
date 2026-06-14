/**
 * ADR-136: Model Eval Suite — основные определения типов.
 *
 * Двухслойная система оценки:
 * - Layer 1 (Structural): детерминированная быстрая проверка ветвей/паттернов вызовов функций кодом
 * - Layer 2 (Quality): LLM-as-Judge многомерная оценка качества поведения — недетерминированная, глубокая
 *
 * Принципы дизайна типов:
 * - Входные типы (EvalScenario и др.) полностью readonly — определения сценариев неизменны
 * - Выходные типы (Check, GradeResult и др.) полностью readonly — результаты неизменны после создания
 * - Конфигурационный тип (EvalRunnerConfig) изменяемый — нужен для слияния/переопределения в рантайме
 * - Повторяющиеся структуры вынесены в именованные типы — единый источник истины
 *
 * @see docs/adr/136-model-eval-suite.md
 */
import type { ToolCategory } from "../engine/tick/types.js";

/**
 * Флаги функциональности eval-сценария.
 * Shell prompt feature flags + API availability toggles.
 */
export interface EvalFeatures {
  hasTarget?: boolean;
  isGroup?: boolean;
  hasBots?: boolean;
  targetIsBot?: boolean;
  hasTTS?: boolean;
  hasSystemThreads?: boolean;
  hasPeripheral?: boolean;
  preparedCategories?: ReadonlySet<string>;
  facetTags?: readonly string[];
  /** Включить браузер/поисковый API (→ exaApiKey) */
  hasBrowse?: boolean;
  /** Включить музыкальный API (→ musicApiBaseUrl) */
  hasMusic?: boolean;
  /** Включить видео API (→ youtubeApiKey) */
  hasVideo?: boolean;
}

// ── ADR-137: Условия аблационного эксперимента ──────────────────────────────────────────────
/**
 * Трёхусловная аблация: Full / No-Pressure / Baseline.
 *
 * - full: текущая система (situation lines + voice instinct + gold examples)
 * - no_pressure: gold examples сохранены, situation lines + voice instinct удалены
 * - baseline: 3 правила в стиле airi, без gold examples, без situation lines
 *
 * @see docs/adr/137-pressure-field-ablation.md
 */
export type AblationCondition = "full" | "no_pressure" | "baseline";

// ── Теги сценариев ─────────────────────────────────────────────────────────────

export type ScenarioTag =
  | "private"
  | "group"
  | "empathy"
  | "restraint"
  | "memory"
  | "context"
  | "turn_taking"
  | "observation"
  | "sticker"
  | "app"
  | "calendar"
  | "weather"
  | "browser"
  | "trending"
  | "music"
  | "video"
  | "countdown"
  | "p5_high"
  | "patience"
  | "baseline"
  | "ablation"
  | "proactive"
  | "boundary";

// ── Общие атомарные типы ──────────────────────────────────────────────────────────

/** Снимок шестимерного давления (в виде объекта, для определения сценария). */
export interface PressureValues {
  readonly p1: number;
  readonly p2: number;
  readonly p3: number;
  readonly p4: number;
  readonly p5: number;
  readonly p6: number;
}

/** Тройка агрегированной статистики (pass / total / rate) для сводки по тегам/ветвям. */
export interface AggregatedStat {
  pass: number;
  total: number;
  rate: number;
}

// ── Сообщения для оценки ─────────────────────────────────────────────────────────────

/** Одно сообщение в eval-сценарии. Все поля неизменны после определения. */
export interface EvalMessage {
  /** Роль отправителя: "user" = собеседник, "other" = другие в группе, "alice" = сама Alice (история) */
  readonly role: "user" | "other" | "alice";
  /** Отображаемое имя отправителя (для группового чата) */
  readonly name?: string;
  /** Текст сообщения */
  readonly text: string;
  /** ID сообщения (для проверки replyTo) */
  readonly msgId?: number;
  /** Является ли сообщение directed at Alice */
  readonly directed?: boolean;
  /** Медиа-метка (например "(photo)", "(sticker: 😂)") */
  readonly mediaLabel?: string;
}

// ── Структурные утверждения ────────────────────────────────────────────────────────────

/** Ожидаемый тип ветви ReAct. */
export type ExpectedBranch =
  | "reply"
  | "silence"
  | "observe_then_reply"
  | "observe_then_silence"
  | "waiting_reply"
  | "watching"
  | "action_only";

/**
 * Социальное намерение — первопринципный уровень классификации ветвей.
 *
 * 9 ветвей кодируют два независимых измерения: Intent × Process.
 * Intent — это outcome (что делать), Process — path (как получить информацию).
 * Оценка ориентирована на Intent как главную ось, Process — опциональное ограничение.
 *
 * - engage: участие в диалоге (reply / observe_then_reply / action_only)
 * - silence: намеренное молчание (silence / observe_then_silence)
 * - defer: отложить ответ (expect_reply / stay)
 *
 * @see docs/adr/138-social-intent-truth-model.md
 */
export type SocialIntent = "engage" | "silence" | "defer";

/** Layer 1: структурные утверждения — паттерны поведения, определяемые кодом. */
export interface StructuralAssertions {
  /**
   * Ожидаемое социальное намерение (primary check).
   *
   * Одно значение = жёсткое ограничение (именно это намерение).
   * Массив = допустимое множество (любое из них, дружественно к эмерджентности).
   *
   * Принцип дизайна: в социальных сценариях зачастую нет единственно верной реакции.
   * Тестируем через допустимое множество, а не одно значение — проверяем ключевой путь, не фиксируем эмерджентность.
   *
   * @see docs/adr/138-social-intent-truth-model.md
   */
  readonly expectedIntent: SocialIntent | readonly SocialIntent[];

  /**
   * Ожидаемая точная ветвь (secondary check, опционально).
   *
   * Используется только при необходимости строгого совпадения процесса (например, App должен observe).
   * При отсутствии проверяется только Intent.
   */
  readonly expectedBranch?: ExpectedBranch;

  /** Ожидаемое количество раундов ReAct (process tier, только диагностика). number = точно, [min, max] = диапазон. */
  readonly expectedRounds?: number | readonly [min: number, max: number];

  /** Максимальное число шагов (включительно). Превышение = провал по бюджету. При отсутствии не проверяется. */
  readonly maxSteps?: number;

  /** Утверждения о вызовах функций */
  readonly actions?: {
    /** Обязательно вызванные функции */
    readonly must?: readonly string[];
    /** Запрещённые функции */
    readonly must_not?: readonly string[];
    /** Хотя бы одна из перечисленных */
    readonly any_of?: readonly string[];
  };

  /** Утверждения о Mod-инструкциях */
  readonly instructions?: {
    readonly must?: readonly string[];
    readonly must_not?: readonly string[];
  };

  /** Запросы, которые должны выполниться в раунде observe */
  readonly queries?: {
    readonly must?: readonly string[];
  };

  /** Направленность reply (для группы: true = reply(text, msgId), false = say(text)) */
  readonly replyDirected?: boolean;

  /** Ожидаемые семейства инструментов LLM. Имя поля сохранено исторически; реальный механизм обнаружения — shell manual + `<command> --help`. */
  readonly expectedNeeds?: readonly ToolCategory[];
}

// ── Rubric оценки качества ──────────────────────────────────────────────────────

/** Измерения оценки Layer 2. */
export type QualityDimension =
  | "companionship"
  | "emotional_fit"
  | "personality"
  | "boundary"
  | "initiative"
  | "naturalness";

/** Layer 2: конфигурация оценки качества. */
export interface QualityRubric {
  /** Список измерений оценки */
  readonly dimensions: readonly QualityDimension[];
  /** Порог прохождения (среднее по измерениям), по умолчанию 3.0 */
  readonly passThreshold?: number;
}

// ── Полное определение сценария ─────────────────────────────────────────────────────────────

/** Полное определение eval-сценария. */
export interface EvalScenario {
  /** Уникальный идентификатор (например "branch.reply.direct") */
  readonly id: string;

  /** Человекочитаемое описание сценария */
  readonly title: string;

  /** Классификационные теги */
  readonly tags: readonly ScenarioTag[];

  // ── Входные данные ──

  /** Временная шкала сообщений диалога */
  readonly messages: readonly EvalMessage[];

  /** Информация о цели */
  readonly target: {
    readonly contactId: string;
    readonly displayName: string;
    readonly tier: number;
    readonly relationType: string;
  };

  /** Тип чата */
  readonly chatType: "private" | "group";

  /** Флаги функциональности (особенности shell prompt + доступность API) */
  readonly features: EvalFeatures;

  /** Снимок давления (опционально) */
  readonly pressures?: PressureValues;

  /** Дополнительные переопределения контекстных переменных */
  readonly contextOverrides?: Readonly<Record<string, string>>;

  // ── Layer 1 ──

  /** Структурные утверждения */
  readonly structural: StructuralAssertions;

  // ── Layer 2 (опционально) ──

  /** Конфигурация оценки качества */
  readonly quality?: QualityRubric;

  /** Ссылка на публикацию (например "Table5.B1", "ADR-63.V1") */
  readonly paperRef?: string;
}

// ── Результаты оценки ─────────────────────────────────────────────────────────────

/** Уровень проверки. goal/budget влияет на pass/fail, process — только диагностика. */
export type CheckTier = "goal" | "budget" | "process";

/** Результат одной проверки. */
export interface Check {
  readonly name: string;
  readonly pass: boolean;
  readonly expected: string;
  readonly actual: string;
  /** Уровень проверки. goal/budget влияет на pass/fail, process — только для отладки. */
  readonly tier: CheckTier;
}

/** Результат оценки Layer 1. */
export interface StructuralGradeResult {
  readonly pass: boolean;
  readonly checks: readonly Check[];
  /** Доля прошедших проверок 0-1 */
  readonly score: number;
}

/** Оценка одного измерения Layer 2. */
export interface DimensionScore {
  readonly dimension: QualityDimension;
  readonly score: number; // 1-5
  readonly reasoning: string;
}

/** Результат оценки Layer 2. */
export interface QualityGradeResult {
  readonly dimensions: readonly DimensionScore[];
  readonly overall: number;
  readonly pass: boolean;
}

/** Полный результат одного запуска одного сценария. */
export interface EvalRunResult {
  readonly scenarioId: string;
  readonly runIndex: number;
  /** Исходный скрипт на выходе LLM */
  readonly script: string | null;
  /** Количество шагов Tick (ранее rounds) */
  readonly steps: number;
  /** Оценка Layer 1 */
  readonly structural: StructuralGradeResult;
  /** Оценка Layer 2 (опционально) */
  readonly quality?: QualityGradeResult;
  /** Время выполнения (мс) */
  readonly duration: number;
  /** Сообщения об ошибках */
  readonly errors: readonly string[];
  /** Историческое поле: старые категории активации capability (накопленное объединение). Обычный prompt заменён плоским shell manual. */
  readonly needs?: readonly string[];
}

/** Агрегированный результат нескольких запусков одного сценария. */
export interface ScenarioAggregateResult {
  readonly scenarioId: string;
  readonly title: string;
  readonly tags: readonly ScenarioTag[];
  readonly expectedIntent: SocialIntent | readonly SocialIntent[];
  readonly expectedBranch?: ExpectedBranch;
  readonly runs: readonly EvalRunResult[];
  /** pass@k: хотя бы 1 из k запусков прошёл Layer 1 */
  readonly passAtK: boolean;
  /** pass^k: все k запусков прошли Layer 1 */
  readonly passAllK: boolean;
  /** Доля прохождения Layer 1 */
  readonly passRate: number;
  /** Средние оценки измерений Layer 2 (при наличии) */
  readonly qualityMeans?: Readonly<Record<QualityDimension, number>>;
  /** Пропущен ли запуск из кэша (LLM фактически не вызывался). */
  readonly cached?: boolean;
}

/** Полный отчёт об оценке. */
export interface EvalReport {
  /** Идентификатор модели */
  readonly model: string;
  /** Время оценки */
  readonly timestamp: string;
  /** Общее количество сценариев */
  readonly totalScenarios: number;
  /** Количество запусков на сценарий */
  readonly runsPerScenario: number;
  /** Агрегированные результаты по каждому сценарию */
  readonly scenarios: readonly ScenarioAggregateResult[];
  /** Доля прохождения, агрегированная по тегам */
  readonly tagStats: Record<string, AggregatedStat>;
  /** Доля прохождения, агрегированная по социальному намерению (ADR-138) */
  readonly intentStats: Record<string, AggregatedStat>;
  /** Глобальные средние оценки измерений Layer 2 + CI (при наличии) */
  readonly qualityStats?: Readonly<
    Record<QualityDimension, { mean: number; ci95: readonly [number, number] }>
  >;
}

// ── Конфигурация runner ──────────────────────────────────────────────────────────

/** Конфигурация eval runner. */
export interface EvalRunnerConfig {
  /** Количество запусков на сценарий (по умолчанию 1) */
  runs: number;
  /** Переопределение temperature LLM (по умолчанию 0) */
  temperature: number;
  /** Запускать ли Layer 2 (по умолчанию false) */
  includeQuality: boolean;
  /** Фильтрация сценариев (по тегу) */
  filterTags?: readonly ScenarioTag[];
  /** Фильтрация сценариев (по префиксу ID) */
  filterPrefix?: string;
  /** Таймаут одного вызова LLM (мс) */
  timeout: number;
  /** Имя LLM-провайдера (опционально, для отчёта) */
  providerName?: string;
}

export const DEFAULT_EVAL_CONFIG = {
  runs: 1,
  temperature: 0,
  includeQuality: false,
  timeout: 180_000,
} as const satisfies EvalRunnerConfig;
