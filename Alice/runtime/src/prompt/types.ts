/**
 * ADR-220 + ADR-237: Декларативные типы данных User Prompt.
 *
 * Базовый принцип: EntityRef обязан иметь id + displayName, гарантируется на этапе компиляции.
 * Сущности без displayName в prompt не попадают (коренное устранение проблемы "(a group)").
 *
 * Каждое поле Slot снабжено комментарием о цели принятия решения — зачем эта информация нужна LLM.
 */

// ═══════════════════════════════════════════════════════════════════════════
// Тип сцены (ADR-237: закрытое пространство состояний + инкапсуляция в стиле Pydantic)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * ADR-237: Тип цели чата — закрытое пространство состояний, без недопустимых комбинаций.
 *
 * | Тип             | Значение              | Instincts             |
 * |-----------------|----------------------|-----------------------|
 * | private_person  | Приватный чат с человеком | DM_INSTINCTS     |
 * | private_bot     | Приватный чат с ботом | BOT_INSTINCTS        |
 * | group           | Групповой чат         | GROUP_INSTINCTS       |
 * | channel_other   | Чужой канал           | CHANNEL_INSTINCTS     |
 * | channel_owned   | Собственный канал     | OWNED_CHANNEL_INSTINCTS |
 */
export type ChatTargetType =
  | "private_person"
  | "private_bot"
  | "group"
  | "channel_other"
  | "channel_owned";

/**
 * ADR-237: ChannelClass — четырёхзначная классификация.
 *
 * Используется для rate cap, социальной стоимости, gate-поведения и других сценариев, где не нужно различать channel_owned/channel_other.
 */
export type ChannelClass = "private" | "group" | "channel" | "bot";

/**
 * ADR-237: ChatTarget — класс-обёртка определения сцены (стиль Pydantic).
 *
 * Философия проектирования:
 * - Ядро — ChatTargetType (закрытое пространство состояний)
 * - Производные атрибуты открыты через getter (Haskell-style derived)
 * - Логика определения сосредоточена в статических фабричных методах
 * - Неизменяемый (readonly), все getter — чистые функции
 *
 * @example
 * ```ts
 * const target = ChatTarget.from(chatType, isBot, aliceRole);
 * if (target.isPrivate) { ... }
 * const cls = target.channelClass; // производный атрибут
 * ```
 */
export class ChatTarget {
  constructor(readonly type: ChatTargetType) {}

  // ── Производные атрибуты (Haskell-style derived functions) ──

  /** Четырёхзначная классификация (для rate cap / социальной стоимости). */
  get channelClass(): ChannelClass {
    switch (this.type) {
      case "private_person":
        return "private";
      case "private_bot":
        return "bot";
      case "group":
        return "group";
      case "channel_other":
      case "channel_owned":
        return "channel";
      default: {
        const unreachable: never = this.type;
        throw new Error(`unknown chat target type: ${unreachable}`);
      }
    }
  }

  /** Является ли сценой приватного чата (человек или бот). */
  get isPrivate(): boolean {
    return this.type === "private_person" || this.type === "private_bot";
  }

  /** Является ли сценой группового чата. */
  get isGroup(): boolean {
    return this.type === "group";
  }

  /** Является ли сценой канала (чужого или собственного). */
  get isChannel(): boolean {
    return this.type === "channel_other" || this.type === "channel_owned";
  }

  /** Является ли собственным каналом (цель пересылки куратора). */
  get isOwnedChannel(): boolean {
    return this.type === "channel_owned";
  }

  /** Является ли сценой бота (приватный чат с ботом). */
  get isBot(): boolean {
    return this.type === "private_bot";
  }

  // ── Статические фабрики (централизованное определение) ──

  /**
   * Определяет тип сцены по данным Telegram.
   *
   * @param chatType - Telegram chat_type: "private" | "group" | "supergroup" | "channel"
   * @param isBot - является ли собеседник ботом (актуально только для сцены private)
   * @param aliceRole - роль Alice в канале: owner | admin | undefined
   */
  static from(
    chatType: string | undefined,
    isBot: boolean | undefined,
    aliceRole: string | undefined,
  ): ChatTarget {
    // Сцена канала
    if (chatType === "channel") {
      const role = aliceRole?.toLowerCase();
      if (role === "owner" || role === "admin") {
        return new ChatTarget("channel_owned");
      }
      return new ChatTarget("channel_other");
    }

    // Сцена группового чата
    if (ChatTarget.isGroupChat(chatType)) {
      return new ChatTarget("group");
    }

    // Сцена приватного чата: определяем, человек или бот
    if (isBot === true) {
      return new ChatTarget("private_bot");
    }

    return new ChatTarget("private_person");
  }

  // ── Статические утилитарные методы (замена разрозненных проверок chatType) ──

  /**
   * Проверяет, является ли chatType групповым чатом (group или supergroup).
   *
   * Используется в сценариях, требующих только chatType: классификация исторических действий, расчёт нагрузки и т.д.
   * Заменяет разрозненные `chatType === "group" || chatType === "supergroup"`.
   */
  static isGroupChat(chatType: string | undefined): boolean {
    return chatType === "group" || chatType === "supergroup";
  }

  /**
   * Проверяет, является ли chatType каналом.
   */
  static isChannelChat(chatType: string | undefined): boolean {
    return chatType === "channel";
  }

  /**
   * Проверяет, является ли chatType приватным чатом.
   */
  static isPrivateChat(chatType: string | undefined): boolean {
    return chatType === "private";
  }

  // ── Утилитарные методы ──

  /** Проверка равенства типов. */
  equals(other: ChatTargetType | ChatTarget): boolean {
    const otherType = typeof other === "string" ? other : other.type;
    return this.type === otherType;
  }

  /** Для логирования/отладки. */
  toString(): string {
    return `ChatTarget(${this.type})`;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Обратная совместимость (сохранена функциональная форма на переходный период, внутри делегирует ChatTarget)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * @deprecated Используйте свойство ChatTarget.channelClass
 */
export function toChannelClass(type: ChatTargetType): ChannelClass {
  return new ChatTarget(type).channelClass;
}

// ═══════════════════════════════════════════════════════════════════════════
// EntityRef — совместное существование id + displayName гарантируется на этапе компиляции
// ═══════════════════════════════════════════════════════════════════════════

export interface EntityRef {
  /** Telegram numeric ID (используется в командах irc forward --to @id и т.п.). */
  id: number;
  /** Читаемое имя (LLM понимает «с кем разговаривает»). */
  displayName: string;
  /** Тип чата (влияет на паттерн поведения). */
  chatType?: "private" | "group" | "supergroup" | "channel";
}

// ═══════════════════════════════════════════════════════════════════════════
// Message Slot — каждое сообщение
// ═══════════════════════════════════════════════════════════════════════════

/** Элемент временной шкалы (отрендеренные строки в IRC-стиле). */
export interface TimelineSlot {
  /** Список отрендеренных строк. */
  lines: readonly string[];
}

// ═══════════════════════════════════════════════════════════════════════════
// Contact Slot — контакт в социальной панораме канала
// ═══════════════════════════════════════════════════════════════════════════

export interface ContactSlot {
  /** ref.id используется для irc forward --to @id. */
  ref: EntityRef;
  /** Семантическая метка tier (LLM оценивает степень близости отношений). */
  tierLabel: string;
  /** Выраженная черта характера (LLM оценивает личность человека). */
  topTrait?: string;
  /** Список интересов (LLM решает «кому понравится этот контент»). */
  interests: readonly string[];
  /** Telegram-подпись пользователя (LLM понимает самоописание человека). */
  bio?: string;
  /** Был ли контент передан этому контакту в последний час. */
  sharedRecently?: boolean;
}

// ═══════════════════════════════════════════════════════════════════════════
// Group Slot — группа в социальной панораме канала
// ═══════════════════════════════════════════════════════════════════════════

export interface GroupSlot {
  /** ref.id используется как цель пересылки. */
  ref: EntityRef;
  /** Тема группы (LLM оценивает соответствие контента). */
  topic?: string;
  /** Список интересов группы. */
  interests: readonly string[];
  /** Описание группы (LLM понимает позиционирование группы). */
  bio?: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// OwnedChannelSlot — канал, принадлежащий/управляемый Alice (цель пересылки)
// ═══════════════════════════════════════════════════════════════════════════

/** Канал Alice (ADR-237: цель пересылки куратора). */
export interface OwnedChannelSlot {
  /** ref.id используется для irc forward --to @id. */
  ref: EntityRef;
  /** Идентификатор роли. */
  role: "owner" | "admin";
}

// ═══════════════════════════════════════════════════════════════════════════
// Thread Slot — активный тред
// ═══════════════════════════════════════════════════════════════════════════

export interface ThreadSlot {
  /** ID треда (LLM нужен для вызова topic_advance #id). */
  threadId: string;
  /** Заголовок треда (LLM понимает «о чём идёт разговор»). */
  title: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// Feedback Slot — обратная связь по действиям
// ═══════════════════════════════════════════════════════════════════════════

export interface FeedbackSlot {
  /** Текст обратной связи (LLM понимает результаты предыдущего раунда действий). */
  text: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// Presence Slot — состояние диалога (защита от повторов)
// ═══════════════════════════════════════════════════════════════════════════

export interface PresenceSlot {
  /** Количество последовательных сообщений Alice в конце. */
  trailingYours: number;
  /** Превью последнего исходящего сообщения. */
  lastOutgoingPreview?: string;
  /** Читаемое время с последнего исходящего сообщения. */
  lastOutgoingAgo?: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// RecapSegment — сегмент ретроспективы диалога. Уровень①, сцена реального времени.
// ═══════════════════════════════════════════════════════════════════════════

/** Посегментная сводка истории диалога (LLM понимает «о чём говорили раньше»). */
export interface RecapSegment {
  /** Описание временного диапазона (например "2h ago — 1h ago"). */
  timeRange: string;
  /** Количество сообщений в сегменте. */
  messageCount: number;
  /** Превью первого сообщения. */
  first: string;
  /** Превью последнего сообщения. */
  last: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// ContactProfileSlot — детальный профиль контакта. Уровень②, контекст отношений.
// ═══════════════════════════════════════════════════════════════════════════

/** Детальный профиль контакта (только приватный чат: portrait + traits + interests). */
export interface ContactProfileSlot {
  /** Обобщённое впечатление, сгенерированное LLM. */
  portrait?: string;
  /** Кристаллизованные теги черт характера. */
  traits: readonly string[];
  /** Кристаллизованные интересы. */
  interests: readonly string[];
  /** Telegram-подпись пользователя (из bio_cache). */
  bio?: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// JargonSlot — жаргон группы. Уровень②, контекст отношений.
// ═══════════════════════════════════════════════════════════════════════════

/** Жаргон группы (LLM адаптируется к культуре группового чата). */
export interface JargonSlot {
  /** Термин. */
  term: string;
  /** Значение. */
  meaning: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// FeedItemSlot — элемент ленты. Уровень①, сцена реального времени (канал).
// ═══════════════════════════════════════════════════════════════════════════

/** Элемент ленты (источник интернет-контента). */
export interface FeedItemSlot {
  /** Заголовок. */
  title: string;
  /** Ссылка. */
  url: string;
  /** Аннотация. */
  snippet: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// UserPromptSnapshot — полный снимок
// ═══════════════════════════════════════════════════════════════════════════

export interface UserPromptSnapshot {
  // ── Сцена (ADR-237: закрытое пространство состояний) ──
  /** ADR-237: Тип цели чата — единственный источник истины для определения сцены. */
  chatTargetType: ChatTargetType;

  // ── Время ──
  /** Время по настенным часам (мс). */
  nowMs: number;
  /** Смещение часового пояса пользователя (в часах), например UTC+8 → 8. */
  timezoneOffset: number;

  /** ADR-268: Проекция на естественный язык текущего эмоционального эпизода Alice. */
  emotionProjection?: string;
  /** ADR-268: Подсказка естественного выражения, полученная из текущей модуляции эмоционального контроля. */
  emotionStyleHint?: string;

  // ── Цель ──
  /** Целевая сущность текущего диалога (приватный чат=собеседник, группа=группа, канал=канал). */
  target?: EntityRef;

  // ── Метаинформация группы (только сцена group) ──
  groupMeta?: {
    topic?: string;
    /** Адресовано ли сообщение Alice (@Alice или ответ на её сообщение). */
    directed: boolean;
    /** Описание активности группы (кол-во участников и т.д.). */
    membersInfo?: string;
    /** Ограничения группового чата (can't send stickers, etc.). */
    restrictions?: string;
    /** Описание группы (из bio_cache). */
    bio?: string;
  };

  // ── Социальная панорама канала (только сцена channel) ──
  contacts: readonly ContactSlot[];
  groups: readonly GroupSlot[];
  /** ADR-237: Каналы Alice (цели пересылки куратора). */
  ownedChannels: readonly OwnedChannelSlot[];

  // ── Поток сообщений (единая временная шкала) ──
  timeline: TimelineSlot;

  // ── Состояние диалога (защита от повторов) ──
  presence?: PresenceSlot;

  // ── Треды ──
  threads: readonly ThreadSlot[];

  // ── Social case ──
  /** Alice-centered social case brief lines for the current prompt surface. */
  socialCaseLines: readonly string[];

  // ── Обратная связь по действиям ──
  feedback: readonly FeedbackSlot[];

  // ── Внутренний шёпот (из facet) ──
  whisper: string;

  // ── Осведомлённость о раунде ──
  roundHint?: string;
  /** ADR-232: Подсказка TC episode (при продолжении host-ом сообщает LLM, что результаты уже в observations). */
  episodeHint?: string;

  // ── Описание отношений с собеседником (только сцена private) ──
  relationshipDesc?: string;

  // ── Уровень① Расширение сцены реального времени ──
  /** Посегментная сводка истории диалога (LLM понимает «о чём говорили раньше»). Уровень①. */
  conversationRecap: readonly RecapSegment[];

  // ── Уровень② Расширение контекста отношений ──
  /** Детальный профиль контакта (только приватный чат: portrait + traits). Уровень②. */
  contactProfile?: ContactProfileSlot;
  /** Настроение собеседника (семантическая метка, влияет на выбор тона Alice). Уровень②. */
  contactMood?: string;
  /** Жаргон группы (LLM адаптируется к культуре группового чата). Уровень②. */
  jargon: readonly JargonSlot[];

  // ── Уровень③ Расширение стратегической панорамы ──
  /** Глобальные сигналы осведомлённости (кто ждёт, кто дрейфует, какая группа активна). Уровень③. */
  situationSignals: readonly string[];
  /** Сигналы ритма текущего объекта (семантическая проекция, без harmonic-параметров). Уровень③. */
  timingSignals?: readonly string[];
  /** Сработавшие запланированные задачи. Уровень③. */
  scheduledEvents: readonly string[];
  /** Флаги риска. Уровень③. */
  riskFlags: readonly string[];

  // ── Уровень④ Расширение внутреннего мира ──
  // diary перенесён в diary.mod.ts contribute() (единственный путь инъекции).
  // @see ADR-225: Устранение двойной инъекции.
  /** Причинно-следственный остаток episode (связность между engagement-ами). Уровень④. */
  episodeCarryOver?: string;

  // ── Уровень④ Социальная восприимчивость (ADR-156) ──
  /** Социальная восприимчивость группы ∈ [-1, 1]. warm>0, cold<0, hostile<-0.5. Только сцена group. */
  socialReception?: number;

  // ── Уровень⑤ Расширение ограничений действий ──
  /** Флаг деградировавшего действия (ограничивает вывод при нехватке бюджета нагрузки). Уровень⑤. */
  isDegraded: boolean;
  /** Текущая тема диалога (используется для "You were talking about: X"). Уровень⑤. */
  openTopic?: string;

  // ── Специфично для канала ──
  /** Элементы ленты (источники интернет-контента). */
  feedItems: readonly FeedItemSlot[];
}
