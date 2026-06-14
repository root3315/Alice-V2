/**
 * Система типов Telegram-действий — размеченное объединение + контекст выполнения.
 *
 * TelegramActionDef — размеченное объединение WriteAction | QueryAction:
 * - WriteAction: финальное пакетное выполнение, без CQRS-полей
 * - QueryAction: немедленное выполнение, результат инжектируется в observation следующего тика
 *
 * Дискриминатор: `returnsResult` — true для QueryAction, undefined/absent для WriteAction.
 * Компилятор принудительно требует все четыре CQRS-поля вместе или ни одного.
 *
 * @see docs/adr/51-m5-interaction-primitives-implementation.md
 * @see docs/adr/105-react-cqrs-read-during-next.md
 */

import type { TelegramClient } from "@mtcute/node";
import type { z } from "zod";
import type { Dispatcher } from "../core/dispatcher.js";
import type { AffordanceDeclaration } from "../engine/tick/types.js";
import type { ChannelNodeId, TelegramId } from "../graph/entities.js";
import type { WorldModel } from "../graph/world-model.js";

// ═══════════════════════════════════════════════════════════════════════════
// Определения параметров
// ═══════════════════════════════════════════════════════════════════════════

/** Тип параметра — определяет поведение coerce при инжекции в sandbox. */
export type ActionParamType = "string" | "number" | "array";

/** Определение одного параметра (обслуживает как coerce при инжекции, так и генерацию объявлений). */
export interface ActionParamDef {
  type: ActionParamType;
  /** Если обязательный параметр отсутствует, coerce подставляет значение по умолчанию (string→"", number→0). */
  required: boolean;
  /** Описание для человека (записывается в руководство LLM). */
  description: string;
  /** Опциональная Zod-схема — при наличии переопределяет автовыводимую логику coerce для type/required. */
  schema?: z.ZodTypeAny;
  /**
   * Автоматический инжект из контекста — значение является ключом в contextVars.
   *
   * После установки параметр полностью невидим для LLM:
   * - не записывается в объявление руководства (declaration.ts пропускает)
   * - не занимает позиционный слот (sandbox пропускает при инжекции, LLM не передаёт)
   * - при выполнении заполняется автоматически из contextVars[inject]
   *
   * Это структурная реализация модели четырёхстороннего разделения: не ограничиваем LLM от ввода неверного значения,
   * а делаем так, чтобы LLM вообще не мог указать значение — make invalid states unrepresentable.
   *
   * @example chatId with inject: "TARGET_CHAT"
   *   → LLM writes react(msgId, emoji) instead of react(chatId, msgId, emoji)
   *   → sandbox auto-fills chatId from contextVars.TARGET_CHAT
   */
  inject?: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// Контекст выполнения
// ═══════════════════════════════════════════════════════════════════════════

/** Контекст выполнения функции impl (создаётся и инжектируется action-executor). */
export interface ActionImplContext {
  client: TelegramClient;
  G: WorldModel;
  dispatcher: Dispatcher;
  tick: number;
  /** Переменные контекста текущего тика (например, TARGET_CHAT), пробрасываются в exec/system commands. */
  contextVars?: Readonly<Record<string, unknown>>;
  log: {
    info(msg: string, data?: Record<string, unknown>): void;
    warn(msg: string, data?: Record<string, unknown>): void;
  };
  /** chatId (number / channel:xxx / contact:xxx / строка с цифрами) → числовой Telegram ID. */
  parseChatId(chatId: string | number | TelegramId): TelegramId;
  /** chatId → ID узла графа (формат channel:xxx). */
  ensureGraphId(chatId: string | number | TelegramId): ChannelNodeId;

  // ── Инжектируемая конфигурация (вместо глобальных переменных уровня модуля) ──

  /** Конфигурация TTS (используется send_voice). При отсутствии настроек все поля — пустые строки. */
  ttsConfig: TtsConfig;
  /** Exa API key (используется google / visit). Пустая строка означает отсутствие настройки. */
  exaApiKey: string;
  /** ADR-132 Wave 3: base URL музыкального API (NeteaseCloudMusicApi). Пусто = отключено. */
  musicApiBaseUrl: string;
  /** ADR-132 Wave 4: ключ YouTube Data API v3. Пусто = только Bilibili. */
  youtubeApiKey: string;
  /** Смещение часового пояса в часах (используется App Toolkit). По умолчанию 8 (UTC+8). */
  timezoneOffset: number;
}

/** Конфигурация синтеза речи TTS. */
export interface TtsConfig {
  ttsBaseUrl: string;
  ttsApiKey: string;
  ttsModel: string;
  ttsVoice: string;
  ttsGroupId?: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// Возвращаемые значения
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Структурированный результат, возвращаемый из impl.
 * Действия отправки используют его для возврата msgId и obligationsConsumed;
 * прочие действия могут по-прежнему возвращать boolean (executor адаптируется автоматически).
 *
 * @see docs/adr/ Pillar 4: Closed Feedback Arc
 */
export interface ActionImplResult {
  success: boolean;
  /** Telegram message ID (возвращается при успешном send_message). */
  msgId?: number;
  /** Количество погашенных directed-обязательств этим действием (по умолчанию 0). */
  obligationsConsumed?: number;
  /** Диагностическая информация (при ошибке попадает в observation корректирующего тика, помогает LLM обучаться). */
  error?: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// Категории действий
// ═══════════════════════════════════════════════════════════════════════════

/** Категория действия — используется в strategy.mod для условного инжекта capability hints. */
export type ActionCategory =
  | "messaging"
  | "reaction"
  | "media"
  | "sticker"
  | "moderation"
  | "group"
  | "bot"
  | "search"
  | "account"
  | "knowledge"
  | "app"
  | "skills";

// ═══════════════════════════════════════════════════════════════════════════
// Размеченное объединение: TelegramActionDef = WriteAction | QueryAction
// ═══════════════════════════════════════════════════════════════════════════

/** Базовые поля, общие для всех действий. */
interface TelegramActionBase {
  /** Имя действия (= имя функции в sandbox = ключ поиска в executor). */
  name: string;
  /** Строки описания (записываются в руководство LLM, каждая строка автоматически получает отступ 2 пробела). */
  description: string[];
  /** Список параметров в порядке позиций. */
  params: [name: string, def: ActionParamDef][];
  /**
   * Категория действия (используется в strategy.mod для генерации capability hints по категориям).
   * При отсутствии — по умолчанию "messaging".
   */
  category?: ActionCategory;
  /**
   * Стратегическая подсказка (инструкция по использованию, видимая LLM в соответствующем контексте).
   * strategy.mod автоматически генерирует ссылку из этого поля, без хардкода имён функций.
   * При отсутствии дополнительная подсказка не генерируется (руководство само содержит базовое описание).
   */
  usageHint?: string;
  /**
   * Реализация выполнения. Получает контекст и параметры после coerce.
   * Возвращает boolean (простой успех/неудача) или ActionImplResult (с msgId / obligationsConsumed).
   * @see narrative-engine/mods/types.ts InstructionDefinition.impl
   */
  impl(ctx: ActionImplContext, args: Record<string, unknown>): Promise<boolean | ActionImplResult>;

  /**
   * ADR-142: объявление Affordance — метаданные обнаруживаемости инструмента.
   * @see docs/adr/142-action-space-architecture/README.md
   */
  affordance?: AffordanceDeclaration;
}

/** Write-действие — финальное пакетное выполнение, без CQRS-полей результата. */
export interface WriteActionFields {
  returnsResult?: undefined;
  resultSource?: undefined;
  resultAttrKey?: undefined;
  formatResult?: undefined;
  returnDoc?: undefined;
}

/**
 * Runtime-поля CQRS — минимальный контракт, удовлетворяемый фабрикой resultContract.
 * Здесь определяется runtime-поведение store() и formatResult().
 */
export interface QueryRuntimeFields {
  /** ADR-105 CQRS: помечает операцию чтения. */
  returnsResult: true;
  /** CQRS: узел хранения результата — "self" (сама Alice) или "target" (текущий целевой чат). */
  resultSource: "self" | "target";
  /** CQRS: имя атрибута графа — результат хранится в этом атрибуте. */
  resultAttrKey: string;
  /**
   * CQRS: форматирует текст observation. Использует Zod safeParse для runtime-валидации типов.
   * null означает пустые/невалидные данные — observation не генерируется.
   */
  formatResult: (data: unknown) => string[] | null;
}

/**
 * Полные поля query-действия — runtime CQRS + метаданные руководства.
 * Компилятор принудительно требует returnDoc при регистрации action.
 */
export interface QueryActionFields extends QueryRuntimeFields {
  /**
   * Описание семантики возвращаемого значения (только для операций чтения, потребляется CQRS formatQueryObservations).
   * Описывает место хранения результата и способ его получения; записывается в строку @returns руководства LLM.
   */
  returnDoc: string;
}

/** Write-действие (финальное пакетное выполнение). */
export type TelegramWriteAction = TelegramActionBase & WriteActionFields;

/** Query-действие (CQRS немедленное выполнение + инжект в observation). */
export type TelegramQueryAction = TelegramActionBase & QueryActionFields;

/**
 * Полное определение одного Telegram-действия (метаданные + реализация).
 * Размеченное объединение: returnsResult === true → QueryAction, иначе → WriteAction.
 */
export type TelegramActionDef = TelegramWriteAction | TelegramQueryAction;

// ═══════════════════════════════════════════════════════════════════════════
// Type guards
// ═══════════════════════════════════════════════════════════════════════════

/** Проверяет, является ли действие CQRS query-действием. Заменяет ручную проверку `def?.returnsResult`. */
export function isQueryAction(def: TelegramActionDef): def is TelegramQueryAction {
  return def.returnsResult === true;
}
