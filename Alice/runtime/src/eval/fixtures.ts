/**
 * ADR-136: Eval Fixtures — фабричные функции mock/fixture для eval-конвейера.
 *
 * eval runner не подключается к реальному Telegram; fixtures предоставляют
 * минимальный контекст для конвейера buildPrompt → callLLM → executeInSandbox.
 *
 * Решения по дизайну:
 * - Dispatcher использует реальную загрузку Mod + SQLite в памяти, тестирует реальный путь конвейера
 * - WorldModel — реальный экземпляр, заполненный минимальными узлами/рёбрами для сценария
 * - ActContext заполняет только поля, фактически используемые buildPrompt, остальное — stub
 * - Все фабрики разделяют единый nowMs, устраняя временной дрейф от рассеянных вызовов Date.now()
 * - contactId сценария использует голый домен ("carol"), префикс слоя графа добавляется здесь
 *
 * @see docs/adr/136-model-eval-suite.md
 */

import { type Config, loadConfig } from "../config.js";
import { createAliceDispatcher, type Dispatcher } from "../core/dispatcher.js";
import { loadAllMods } from "../core/mod-loader.js";
import { closeDb, initDb } from "../db/connection.js";
import type { MessageRecord } from "../engine/act/messages.js";
import type { ActionQueueItem } from "../engine/action-queue.js";
import type { ActContext } from "../engine/react/orchestrator.js";
import { ALICE_SELF } from "../graph/constants.js";
import { WorldModel } from "../graph/world-model.js";
import { type AllPressures, apiAggregate, observableMapping } from "../pressure/aggregate.js";
import type { PressureDims } from "../utils/math.js";
import { PersonalityVector } from "../voices/personality.js";
import type { EvalScenario, PressureValues } from "./types.js";

// ── Преобразование домен → ID графа ─────────────────────────────────────────────────────

/**
 * Голый домен → contact ID слоя графа.
 *
 * Определения сценариев используют язык предметной области ("carol"), реализация графа — префикс "contact:".
 * Эта функция является единственным мостом между двумя слоями.
 */
function toGraphContactId(bareId: string): string {
  return `contact:${bareId}`;
}

/** Голый домен → channel ID слоя графа. */
function toGraphChannelId(bareId: string): string {
  return `channel:${bareId}`;
}

/** Снимок давления по умолчанию для eval. Единственный источник истины. */
const DEFAULT_EVAL_PRESSURES: PressureValues = {
  p1: 2.0,
  p2: 1.0,
  p3: 1.5,
  p4: 0.5,
  p5: 1.0,
  p6: 0.3,
};

/** PressureValues → массив PressureDims. Устраняет 2 места ручного разворачивания. */
function pressuresToDims(p: PressureValues): PressureDims {
  return [p.p1, p.p2, p.p3, p.p4, p.p5, p.p6];
}

/**
 * Создаёт минимально рабочий AllPressures из PressureValues eval-сценария.
 *
 * eval-сценарии используют статические значения давления (минуя реальный конвейер computeAllPressures);
 * эта функция конвертирует p1-p6 в полный объект AllPressures, потребляемый pressure.mod.
 * Все вклады давления приписываются целевому channel entity (модель с одним субъектом).
 *
 * @see computeAllPressures — полный конвейер вычислений для продакшена
 */
function buildEvalPressures(p: PressureValues, targetEntity: string): AllPressures {
  const api = apiAggregate(p.p1, p.p2, p.p3, p.p4, p.p5, p.p6);
  const a = observableMapping(api);

  // Модель с одним субъектом: все вклады давления приписываются целевому channel
  const contributions: Record<string, Record<string, number>> = {
    P1: { [targetEntity]: p.p1 },
    P2: { [targetEntity]: p.p2 },
    P3: { [targetEntity]: p.p3 },
    P4: { [targetEntity]: p.p4 },
    P5: { [targetEntity]: p.p5 },
    P6: { [targetEntity]: p.p6 },
  };

  return {
    P1: p.p1,
    P2: p.p2,
    P3: p.p3,
    P4: p.p4,
    P5: p.p5,
    P6: p.p6,
    P_prospect: 0,
    API: api,
    API_peak: api,
    A: a,
    contributions,
    prospectContributions: {},
    pressureHistory: { P1: [], P2: [], P3: [], P4: [], P5: [], P6: [] },
  };
}

/**
 * ADR-139: Фиксированная метка времени для eval — предотвращает сбои тайм-чувствительных сценариев из-за Date.now().
 *
 * Используется 9:30 утра (UTC+8), что гарантирует:
 * - Согласованность приветствий типа "доброе утро" со временем (исключает парадокс приветствия в 20:35)
 * - Предсказуемые результаты из App календаря/часов
 * - Воспроизводимость результатов между запусками (устраняет нестабильные тесты из-за временного дрейфа)
 */
const EVAL_FIXED_TIME_MS = new Date("2026-01-15T09:30:00+08:00").getTime();

// ── Управление DB в памяти ─────────────────────────────────────────────────────────────

/** Счётчик ссылок на DB в памяти, поддерживает вложенную инициализацию/очистку. */
let dbRefCount = 0;

/**
 * Инициализирует SQLite в памяти (идемпотентно).
 * Вызывается перед началом eval; по завершении вызвать teardownEvalDb() для освобождения.
 */
export function setupEvalDb(): void {
  if (dbRefCount === 0) {
    initDb(":memory:");
  }
  dbRefCount++;
}

/** Освобождает SQLite в памяти. Используется в паре с setupEvalDb. */
export function teardownEvalDb(): void {
  dbRefCount--;
  if (dbRefCount <= 0) {
    dbRefCount = 0;
    closeDb();
  }
}

// ── Graph Fixture ────────────────────────────────────────────────────────────

/**
 * Создаёт предзаполненный WorldModel на основе eval-сценария.
 *
 * Минимальная структура графа:
 * - узел self (тип agent)
 * - узел целевого contact
 * - узел целевого channel
 * - связи self → channel (joined) и contact → channel (joined)
 */
export function createEvalGraph(scenario: EvalScenario, nowMs: number): WorldModel {
  const G = new WorldModel();

  // 1. Узел self
  G.addAgent(ALICE_SELF, {
    display_name: "Alice",
    mood_valence: 0,
    mood_set_ms: nowMs,
    created_ms: nowMs - 86_400_000, // Симулируем существование 1 день
  });

  // 2. Целевой контакт (голый домен → ID слоя графа)
  const contactId = toGraphContactId(scenario.target.contactId);
  const channelId = toGraphChannelId(scenario.target.contactId);

  G.addContact(contactId, {
    display_name: scenario.target.displayName,
    tier: scenario.target.tier as import("../graph/entities.js").DunbarTier,
    relation_type: scenario.target.relationType as import("../graph/entities.js").RelationType,
    last_active_ms: nowMs,
    auth_level: 0,
    interaction_count: 10,
    is_bot: false,
  });

  // 3. Целевой канал (личный чат или групповой)
  const isGroup = scenario.chatType === "group";

  G.addChannel(channelId, {
    display_name: isGroup ? `${scenario.target.displayName} 的群` : scenario.target.displayName,
    chat_type: scenario.chatType,
    tier_contact: scenario.target.tier as import("../graph/entities.js").DunbarTier,
    unread: scenario.messages.filter((m) => m.role !== "alice").length,
    pending_directed: scenario.messages.filter((m) => m.role === "user" && m.directed !== false)
      .length,
    last_directed_ms: nowMs,
  });

  // 4. Рёбра связей
  G.addRelation(ALICE_SELF, "joined", channelId);
  G.addRelation(contactId, "joined", channelId);
  G.addRelation(ALICE_SELF, "knows", contactId);

  // 5. Сценарий группового чата: добавляем контакты с ролью other
  if (isGroup) {
    const otherNames = new Set<string>();
    for (const msg of scenario.messages) {
      if (msg.role === "other" && msg.name) {
        otherNames.add(msg.name);
      }
    }
    let otherIdx = 900_000;
    for (const name of otherNames) {
      const otherId = `contact:${otherIdx}`;
      G.addContact(otherId, {
        display_name: name,
        tier: 150,
        relation_type: "acquaintance",
        last_active_ms: nowMs,
        is_bot: false,
      });
      G.addRelation(otherId, "joined", channelId);
      otherIdx++;
    }
  }

  // Устанавливаем tick
  G.tick = 100;

  return G;
}

// ── Dispatcher Fixture ───────────────────────────────────────────────────────

/**
 * Создаёт реальный Dispatcher (реальные Mod + DB в памяти).
 *
 * Использует реальный путь загрузки Mod: eval тестирует реальный конвейер, а не mock.
 * SQLite в памяти изолирует побочные эффекты файловой системы.
 *
 * Перед вызовом необходимо вызвать setupEvalDb().
 */
export function createEvalDispatcher(graph: WorldModel): Dispatcher {
  const mods = loadAllMods();
  return createAliceDispatcher({ graph, mods });
}

// ── Config Fixture ───────────────────────────────────────────────────────────

/**
 * Создаёт минимальный Config для eval (чистая функция).
 *
 * Основан на значениях по умолчанию loadConfig(), переопределяется через spread — не мутирует исходный объект.
 * Отключает все внешние сервисы (TTS/Vision/ASR/Exa); сценарий может включить их через features.
 */
function createEvalConfig(scenario: EvalScenario): Config {
  return {
    ...loadConfig(),
    // Отключаем все внешние зависимости
    ttsBaseUrl: "",
    ttsApiKey: "",
    visionModel: "",
    asrBaseUrl: "",
    exaApiKey: "",
    musicApiBaseUrl: "",
    // Переопределение переключателей функций сценария
    ...(scenario.features.hasTTS && { ttsBaseUrl: "https://eval.local/tts" }),
  };
}

// ── ActionQueueItem Fixture ──────────────────────────────────────────────────

/**
 * Строит ActionQueueItem из eval-сценария.
 *
 * Снимок давления использует значения сценария или разумные значения по умолчанию.
 *
 * ADR-139: voice action выводится из expectedIntent (больше не из expectedBranch).
 * expectedIntent — обязательное поле, устраняет проблему undefined-возврата после сделанного необязательным expectedBranch.
 * Семантика маппинга: engage → diligence (есть непрочитанные сообщения), silence/defer → caution (тихое наблюдение).
 */
export function createEvalQueueItem(scenario: EvalScenario): ActionQueueItem {
  const pressureSnapshot = pressuresToDims(scenario.pressures ?? DEFAULT_EVAL_PRESSURES);

  // ADR-139: Выводим voice из социального интента — устраняем циклическую зависимость от expectedBranch
  // Поддержка допустимого набора: берём первый интент как основу для вывода voice
  // ADR-152 F3: Сценарий молчания в группе использует diligence ("есть сообщения, но не тебе отвечать"),
  // а не caution ("что-то не так"), чтобы caution whisper не побуждал LLM участвовать в обсуждении
  const rawIntent = scenario.structural.expectedIntent;
  const primaryIntent = Array.isArray(rawIntent) ? rawIntent[0] : rawIntent;
  const isGroup = scenario.chatType === "group";
  let action: "diligence" | "curiosity" | "sociability" | "caution";
  switch (primaryIntent) {
    case "engage":
      action = "diligence";
      break;
    case "silence":
    case "defer":
      // Молчание в группе → diligence ("есть сообщения, но не каждое требует твоего ответа") — более естественно
      // Молчание в личном чате → caution ("нужно притормозить") — сохраняет сдержанность
      action = isGroup ? "diligence" : "caution";
      break;
    default:
      action = "diligence";
      break;
  }

  return {
    enqueueTick: 100,
    action,
    target: toGraphChannelId(scenario.target.contactId),
    pressureSnapshot,
    contributions: {},
  };
}

// ── Messages Fixture ─────────────────────────────────────────────────────────

/**
 * Преобразует EvalMessage[] в MessageRecord[], используемые buildPrompt.
 */
export function createEvalMessages(scenario: EvalScenario, nowMs: number): MessageRecord[] {
  const msgs: MessageRecord[] = [];
  let msgIdCounter = 1;

  for (let i = 0; i < scenario.messages.length; i++) {
    const em = scenario.messages[i];
    const id = em.msgId ?? msgIdCounter++;

    // Время возрастает, последнее сообщение ближе всего к текущему моменту
    const offsetMs = (scenario.messages.length - i) * 30_000; // Интервал 30 секунд между сообщениями

    msgs.push({
      id,
      senderName: em.role === "alice" ? "Alice" : (em.name ?? scenario.target.displayName),
      senderId: em.role === "alice" ? undefined : em.role === "user" ? 100_001 : 900_000 + i,
      isOutgoing: em.role === "alice",
      text: em.text,
      date: new Date(nowMs - offsetMs),
      mediaType: em.mediaLabel ? parseMediaLabel(em.mediaLabel) : undefined,
    });
  }

  return msgs;
}

/** Извлекает тип медиа из mediaLabel. "(photo)" → "photo", "(sticker: 😂)" → "sticker" */
function parseMediaLabel(label: string): string {
  const match = label.match(/^\((\w+)/);
  return match?.[1] ?? "unknown";
}

// ── ActContext Fixture ────────────────────────────────────────────────────────

/**
 * Собирает минимальный ActContext, необходимый buildPrompt.
 *
 * Поля, фактически используемые buildPrompt:
 * - ctx.G (WorldModel)
 * - ctx.config (Config — budgetZones, ttsBaseUrl, exaApiKey, peripheral и др.)
 * - ctx.dispatcher (generateManual, collectContributions)
 *
 * Неиспользуемые поля (stub):
 * - ctx.client, ctx.queue, ctx.buffer, ctx.personality
 * - ctx.getCurrentTick, ctx.getCurrentPressures, ctx.onPersonalityUpdate
 */
export function createEvalContext(
  scenario: EvalScenario,
  graph: WorldModel,
  dispatcher: Dispatcher,
): ActContext {
  const config = createEvalConfig(scenario);
  const pressures = pressuresToDims(scenario.pressures ?? DEFAULT_EVAL_PRESSURES);

  return {
    G: graph,
    config,
    dispatcher,
    // buildPrompt не использует эти поля, предоставляем типобезопасный stub
    client: null as never,
    queue: null as never,
    buffer: null as never,
    personality: new PersonalityVector([0.25, 0.25, 0.25, 0.25]),
    getCurrentTick: () => graph.tick,
    getCurrentPressures: () => pressures,
    onPersonalityUpdate: () => {},
    recordAction: () => {},
    reportLLMOutcome: () => {},
  };
}

// ── Универсальный Fixture ───────────────────────────────────────────────────────────

/**
 * Создаёт полный набор eval fixture за один вызов.
 *
 * Возвращает все параметры, нужные buildPrompt, + dispatcher (для выполнения скриптов).
 * Перед вызовом необходимо вызвать setupEvalDb().
 *
 * Дизайн: единый nowMs пронизывает все дочерние фабрики, гарантируя внутреннюю согласованность времени fixture.
 *
 * @example
 * ```typescript
 * setupEvalDb();
 * try {
 *   const fx = createEvalFixture(scenario);
 *   const { system, user } = buildPrompt(
 *     fx.ctx, fx.item, fx.tick, fx.messages, fx.contextVars,
 *   );
 *   const result = await callLLM(fx.item, fx.tick, system, user);
 * } finally {
 *   teardownEvalDb();
 * }
 * ```
 */
export interface EvalFixture {
  readonly ctx: ActContext;
  readonly graph: WorldModel;
  readonly dispatcher: Dispatcher;
  readonly item: ActionQueueItem;
  readonly tick: number;
  readonly messages: MessageRecord[];
  readonly contextVars: Record<string, unknown>;
  /** Фиксированное настенное время (мс) — выровнено с временными метками сообщений, устраняет временной дрейф Date.now(). */
  readonly nowMs: number;
}

export function createEvalFixture(scenario: EvalScenario): EvalFixture {
  // ADR-139: Используем фиксированную метку времени, устраняем недетерминизм тайм-чувствительных сценариев
  const nowMs = EVAL_FIXED_TIME_MS;

  const graph = createEvalGraph(scenario, nowMs);
  const dispatcher = createEvalDispatcher(graph);
  const ctx = createEvalContext(scenario, graph, dispatcher);
  const item = createEvalQueueItem(scenario);
  const messages = createEvalMessages(scenario, nowMs);
  const tick = graph.tick;

  const contactId = toGraphContactId(scenario.target.contactId);

  const contextVars: Record<string, unknown> = {
    TARGET_CHAT: item.target,
    CHAT_NAME: scenario.target.displayName,
    TARGET_CONTACT: contactId,
    ...scenario.contextOverrides,
  };

  // Инициализируем dispatcher tick (запускает mod onTickStart)
  dispatcher.startTick(tick, nowMs);

  // Part 3a: Инициализируем давление и цель — это побуждает contribute() генерировать описание контекста.
  // Без этой инициализации state.latest в pressure.mod равен null,
  // и contribute() возвращает "No recent pressure data" вместо реальных контекстных строк.
  const pressureValues = scenario.pressures ?? DEFAULT_EVAL_PRESSURES;
  // item.target в eval всегда не null (createEvalQueueItem жёстко кодирует channel ID)
  // biome-ignore lint/style/noNonNullAssertion: target гарантированно присутствует в контексте eval
  const allPressures = buildEvalPressures(pressureValues, item.target!);
  dispatcher.dispatch("UPDATE_PRESSURES", {
    pressures: allPressures,
    focalEntities: [item.target],
  });
  dispatcher.dispatch("SET_CONTACT_TARGET", { nodeId: contactId });

  return {
    ctx,
    graph,
    dispatcher,
    item,
    tick,
    messages,
    contextVars,
    nowMs,
  };
}
