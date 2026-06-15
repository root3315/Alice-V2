/**
 * Точка входа Alice Runtime.
 *
 * Последовательность запуска:
 * 1. Загрузка конфигурации
 * 2. Инициализация базы данных
 * 3. Подключение к Telegram
 * 4. Восстановление/построение графа + личности
 * 5. Восстановление состояния Mod + lastActionTick (ADR-33)
 * 6. Предстартовая проверка страховочной сети (связность LLM + самодиагностика Telegram + синхронизация стикеров + синхронизация Skill + dry-run конвейера давлений)
 * 7. Привязка событий → запуск цикла EVOLVE + цикла ACT
 * 8. Graceful shutdown
 */

import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { generateText } from "ai";

import { TRAIT_BELIEF_DECAY } from "./belief/types.js";
import { loadConfig } from "./config.js";
import { checkToolSurfaceCompleteness } from "./core/d3-completeness.js";
import { createAliceDispatcher } from "./core/dispatcher.js";
import { setHealthWatchTarget } from "./mods/health-watch.mod.js";
import { setWorkiStatusSender } from "./mods/worki.mod.js";
import { loadAllMods } from "./core/mod-loader.js";
import { ALICE_HOME } from "./core/shell-executor.js";
import { writeAuditEvent } from "./db/audit.js";
import { closeDb, getDb, initDb } from "./db/connection.js";
import { recoverLastActionTick, runMaintenance } from "./db/maintenance.js";
import {
  flushGraph,
  loadGraphFromDb,
  loadLatestPersonality,
  migrateFromSnapshots,
  savePersonalitySnapshot,
} from "./db/snapshot.js";
import { type ActContext, startActLoop } from "./engine/act/index.js";
import { ActionQueue } from "./engine/action-queue.js";
import { createDeliberationState } from "./engine/deliberation.js";
import { initEpisodeState } from "./engine/episode.js";
import { type EvolveState, POST_WAKEUP_RECOVERY_MS, startEvolveLoop } from "./engine/evolve.js";
import {
  decideStartupMode,
  latestRuntimeSeenMs,
  POST_RESTART_RECOVERY_MIN_OFFLINE_MS,
} from "./engine/startup-mode.js";
import { startEngineApi } from "./engine-api/server.js";
import { ALICE_SELF, telegramChannelId } from "./graph/constants.js";
import { recordForwardShare } from "./graph/dynamic-props.js";
import { buildTensionMap } from "./graph/tension.js";
import type { WorldModel } from "./graph/world-model.js";
import { initProviders, selectProviderForFirstPass } from "./llm/client.js";
import { closeGroupCache, initGroupCache } from "./llm/group-cache.js";
import { closeMediaCache, initMediaCache } from "./llm/media-cache.js";
import { onBreakerStateChange } from "./llm/resilience.js";
import { createOneBotTransportAdapter } from "./platform/onebot.js";
import {
  type OneBotReceiverController,
  startOneBotEventReceiver,
} from "./platform/onebot-receiver.js";
import { AdaptiveKappa, computeAllPressures, createPressureHistory } from "./pressure/aggregate.js";
import { createCuriosityHistory } from "./pressure/p6-curiosity.js";
import {
  ALICE_DB_PATH,
  ALICE_GROUP_CACHE_DB_PATH,
  ALICE_MEDIA_CACHE_DB_PATH,
  ensureParentDir,
} from "./runtime-paths.js";
import { syncEnv } from "./skills/pkg.js";
import { ensureAllArtifacts, loadRegistry } from "./skills/registry.js";
import {
  forwardMessage,
  getMessages,
  joinChat,
  leaveChat,
  markRead,
  sendReaction,
  sendSticker,
  sendText,
  setTyping,
} from "./telegram/actions.js";
import { bindAdminCommands } from "./telegram/admin.js";
import { sendAlbumPhoto } from "./telegram/album-send.js";
import {
  getAvailableKeywords,
  pickAnySticker,
  resolveByEmoji,
  resolveLabel,
  syncInstalledSets,
} from "./telegram/apps/sticker-palette.js";
import { buildInitialGraph } from "./telegram/bootstrap.js";
import { createClient, createDispatcher, destroyClient, startClient } from "./telegram/client.js";
import { isTelegramActionError, TelegramActionError } from "./telegram/errors.js";
import { bindEvents, cacheOutgoingMsg, EventBuffer, warmOutgoingCache } from "./telegram/events.js";
import { cleanupPhantomContacts } from "./telegram/mapper.js";
import { initAdminNotify, notifyAdmin } from "./telegram/notify-admin.js";
import { createLogger } from "./utils/logger.js";
import { TickClock } from "./utils/time.js";
import { computeLoudness } from "./voices/loudness.js";
import { PersonalityVector } from "./voices/personality.js";
import { selectAction } from "./voices/selection.js";

const log = createLogger("alice");
const RUNTIME_HEARTBEAT_INTERVAL_MS = 30 * 1000;

function recordRuntimeHeartbeat(G: WorldModel, nowMs = Date.now()): void {
  if (!G.has(ALICE_SELF)) return;
  G.updateAgent(ALICE_SELF, { runtime_last_seen_ms: nowMs });
  flushGraph(G);
}

async function main() {
  log.info("Alice Runtime starting...");

  // 1. Конфигурация
  const config = loadConfig();

  // 2. База данных
  ensureParentDir(ALICE_DB_PATH);
  ensureParentDir(ALICE_MEDIA_CACHE_DB_PATH);
  ensureParentDir(ALICE_GROUP_CACHE_DB_PATH);
  initDb(ALICE_DB_PATH);
  initMediaCache(ALICE_MEDIA_CACHE_DB_PATH);
  initGroupCache(ALICE_GROUP_CACHE_DB_PATH);
  log.info("Database initialized");

  // 3. Подключение к Telegram
  const client = createClient(config);
  const dp = createDispatcher(client);
  await startClient(client, config.telegramPhone);
  const self = await client.getMe();
  const selfId = String(self.id);
  log.info("Logged in", { selfId, username: self.username });

  // worki live-прогресс: worki шлёт статус-строки напрямую через клиент (её стилем, надёжно).
  // Возвращаем Promise<boolean> — успех/провал доставки. worki продвигает троттл/антидубль/
  // счётчик статус-строк ТОЛЬКО при успехе (раньше .catch(()=>{}) глотал сбой, а worki считал
  // отправку удавшейся → строка терялась молча, троттл всё равно тикал).
  setWorkiStatusSender(async (chatId, text, topicId) => {
    try {
      await sendText(client, chatId, text, { topicId });
      return true;
    } catch (err) {
      log.warn("worki status send failed", {
        chatId,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  });

  // Инцидент-алёрт: Алиса сама пишет о своих сбоях (error-аномалиях) в ЛИЧКУ владельца.
  if (config.telegramAdmin) setHealthWatchTarget(telegramChannelId(config.telegramAdmin));

  // ADR-33 Phase 2: одноразовая миграция со старых graph_snapshots на graph_nodes/graph_edges
  migrateFromSnapshots();

  // 4. Восстановление или построение графа
  let G = loadGraphFromDb();
  if (G) {
    log.info("Graph restored from DB", { tick: G.tick, nodes: G.size });
    // ADR-206: очистка исторических фантомных контактов (зеркала contact, созданные каналом при отправке сообщений от своего имени)
    const phantomCount = cleanupPhantomContacts(G);
    if (phantomCount > 0) {
      log.info("Cleaned up phantom contacts", { count: phantomCount });
    }
  } else {
    log.info("No graph data found, building initial graph...");
    G = await buildInitialGraph(client);
    flushGraph(G);
    log.info("Initial graph saved", { nodes: G.size, edges: G.edgeCount });
  }

  // Self-узел обязателен: на нём держатся feel/agent-команды и runtime-heartbeat.
  // Наблюдалось его исчезновение из загруженного графа → "entity not found: self"
  // → script_failed (errorCount 3). buildInitialGraph на рестарте не вызывается,
  // поэтому восстанавливаем здесь, после любой ветки загрузки.
  if (!G.has(ALICE_SELF)) {
    log.warn("self node missing from loaded graph — recreating");
    G.addAgent(ALICE_SELF, { display_name: "Alice" });
    flushGraph(G);
  }

  // ADR-123 D2: регистрация параметров затухания доменов (до evolve, после всех путей graph)
  // @see docs/adr/123-crystallization-substrate-generalization.md §D2
  G.beliefs.registerDomainDecay("trait:", TRAIT_BELIEF_DECAY);
  // ADR-123 §D3/D4: параметры затухания доменов jargon и expression
  G.beliefs.registerDomainDecay("jargon:", {
    halfLife: 720,
    muPrior: 0,
    sigma2Inf: 1.0,
    theta: 0.001,
  });
  G.beliefs.registerDomainDecay("expression:", {
    halfLife: 1440,
    muPrior: 0,
    sigma2Inf: 1.0,
    theta: 0.001,
  });
  // ADR-208: домен interest — повторно используются параметры затухания до кристаллизации из trait (полупериод 8ч, быстрое затухание в ожидании кристаллизации)
  // @see docs/adr/208-cognitive-label-interest-domain.md
  G.beliefs.registerDomainDecay("interest:", TRAIT_BELIEF_DECAY);

  // Восстановление или создание личности
  // M7: единый объект-ссылка — все потребители обращаются через personalityRef.current,
  // onPersonalityUpdate обновляет только одно место, синхронизация нескольких полей больше не нужна.
  const personalityRef = {
    current: loadLatestPersonality() ?? new PersonalityVector(config.piHome),
  };
  log.info("Personality loaded", personalityRef.current.toString());

  // Синхронизация данных личности в узел графа (для аудита дрейфа в strategy.mod)
  if (G.has(ALICE_SELF)) {
    G.updateAgent(ALICE_SELF, {
      personality_weights: JSON.stringify(personalityRef.current.weights),
      pi_home: JSON.stringify(config.piHome),
    });
  }

  // 5. Инициализация runtime-компонентов
  // Система Mod: загрузка всех Mod → создание Dispatcher
  const mods = loadAllMods();
  const dispatcher = createAliceDispatcher({
    graph: G,
    mods,
    targetWhitelist: config.focusWhitelist,
  });
  log.info("Mod system initialized", {
    mods: mods.map((m) => m.meta.name),
    instructions: dispatcher.getInstructionNames(),
    queries: dispatcher.getQueryNames(),
  });

  // D3 Axiom 3: проверка полноты инструментальной поверхности (стартовая диагностика, не блокирует)
  // @see paper/ §Axiom 3 "Tool Surface Completeness"
  checkToolSurfaceCompleteness(dispatcher);

  // ADR-33: восстановление состояния Mod (memorizedFacts/outcomeHistory/strategy-кэш не теряются после перезапуска)
  const modStatesRestored = dispatcher.loadModStatesFromDb();
  if (modStatesRestored) {
    log.info("Mod states restored from DB");
  }

  // ADR-33: восстановление lastActionTick (предотвращает немедленный автозапуск по простою после перезапуска)
  const lastActionTick = recoverLastActionTick();

  const clock = new TickClock({
    dtMin: config.dtMin,
    dtMax: config.dtMax,
    kappaT: config.kappaT,
    startTick: G.tick,
  });
  const buffer = new EventBuffer();
  const queue = new ActionQueue();
  let oneBotReceiver: OneBotReceiverController | null = null;
  const recentEventCounts: number[] = [];
  const recentActions: EvolveState["recentActions"] = [];

  // Привязка команд администратора (group=-1, выполняется до обработчика EventBuffer)
  const adminCtx = {
    config,
    client,
    clock,
    G,
    get personality() {
      return personalityRef.current;
    },
    queue,
    dispatcher,
    mods,
  };
  bindAdminCommands(dp, adminCtx);

  // ADR-90 W1: предварительный прогрев кэша исходящих сообщений при запуске — восстановление обнаружения reply directed после перезапуска
  const warmedCount = warmOutgoingCache();
  log.info("Outgoing message cache warmed from DB", { count: warmedCount });

  // Привязка Telegram-событий → EventBuffer
  const selfUsername = self.username ?? undefined;
  bindEvents(
    dp,
    G,
    buffer,
    () => selfId,
    () => clock.tick,
    () => selfUsername,
    client,
    () => config.focusWhitelist,
    () => config.telegramAdmin,
  );
  if (config.qqOneBotEventWsUrl) {
    oneBotReceiver = startOneBotEventReceiver({
      url: config.qqOneBotEventWsUrl,
      accessToken: config.qqOneBotAccessToken,
      selfId,
      selfDisplayName: self.username ?? "Alice",
      getTick: () => clock.tick,
      buffer,
      reconnectMinMs: config.qqOneBotReconnectMinMs,
      reconnectMaxMs: config.qqOneBotReconnectMaxMs,
    });
    log.info("OneBot event receiver started");
  }

  // Состояние EVOLVE
  // ADR-33/110: lastActionTick → lastActionMs.
  // Пытаемся прочитать last_alice_action_ms из любого узла графа (прямое чтение настенного времени);
  // при отсутствии — fallback на оценку по разности tick; если нет ни того ни другого — Date.now().
  const startupNowMs = Date.now();
  let estimatedLastActionMs = startupNowMs;
  if (lastActionTick > 0) {
    // Поиск наиболее свежего last_alice_action_ms в графе (любой узел channel/contact)
    let bestMs = 0;
    for (const nid of [...G.getEntitiesByType("channel"), ...G.getEntitiesByType("contact")]) {
      const ms = Number(G.getDynamic(nid, "last_alice_action_ms") ?? 0);
      if (ms > bestMs) bestMs = ms;
    }
    estimatedLastActionMs =
      bestMs > 0 ? bestMs : startupNowMs - (G.tick - lastActionTick) * config.dtMax;
  }

  const lastRuntimeSeenMs =
    G.has(ALICE_SELF) && G.getAgent(ALICE_SELF).runtime_last_seen_ms != null
      ? G.getAgent(ALICE_SELF).runtime_last_seen_ms
      : 0;
  const lastRuntimeShutdownMs =
    G.has(ALICE_SELF) && G.getAgent(ALICE_SELF).runtime_shutdown_ms != null
      ? G.getAgent(ALICE_SELF).runtime_shutdown_ms
      : 0;
  const runtimeSeenMs = latestRuntimeSeenMs({
    lastSeenMs: lastRuntimeSeenMs,
    shutdownMs: lastRuntimeShutdownMs,
  });
  const startupMode = decideStartupMode({
    runtimeOfflineMs: runtimeSeenMs > 0 ? startupNowMs - runtimeSeenMs : 0,
    actionSilenceMs: startupNowMs - estimatedLastActionMs,
    wakeupOfflineThresholdS: config.wakeupOfflineThresholdS,
    postRestartRecoveryMinOfflineMs: POST_RESTART_RECOVERY_MIN_OFFLINE_MS,
  });
  const { initialMode, shouldUsePostRestartRecovery } = startupMode;
  if (initialMode === "wakeup") {
    log.info("Entering wakeup mode — long runtime offline detected", {
      runtimeOfflineS: Math.round(startupMode.runtimeOfflineS),
      actionSilenceS: Math.round(startupMode.actionSilenceS),
      thresholdS: config.wakeupOfflineThresholdS,
    });
  } else if (shouldUsePostRestartRecovery) {
    log.info("Entering post-restart recovery window", {
      recoveryMs: POST_WAKEUP_RECOVERY_MS,
      runtimeOfflineS: Math.round(startupMode.runtimeOfflineS),
      actionSilenceS: Math.round(startupMode.actionSilenceS),
    });
  } else {
    log.info("Entering patrol mode after short restart", {
      runtimeOfflineS: Math.round(startupMode.runtimeOfflineS),
      actionSilenceS: Math.round(startupMode.actionSilenceS),
      recoveryMinOfflineS: POST_RESTART_RECOVERY_MIN_OFFLINE_MS / 1000,
    });
  }
  recordRuntimeHeartbeat(G, startupNowMs);

  const evolveState: EvolveState = {
    G,
    get personality() {
      return personalityRef.current;
    },
    clock,
    buffer,
    queue,
    config,
    curiosityHistory: createCuriosityHistory(),
    recentEventCounts,
    recentActions,
    dispatcher,
    lastActionMs: estimatedLastActionMs,
    pressureHistory: createPressureHistory(),
    deliberation: createDeliberationState(),
    attentionDebtMap: new Map(),
    lastSelectedTarget: null,
    lastSelectedCandidate: null,
    // Agent Mode FSM — ADR-190: начальный режим определяется длительностью офлайна
    mode: initialMode,
    focusTarget: undefined,
    modeEnteredMs: startupNowMs,
    adaptiveKappa: new AdaptiveKappa(config.kappa),
    channelRateEma: new Map(),
    // ADR-191: источник данных spike-сигналов (продукт perceiveTick)
    lastChannelCounts: new Map(),
    // ADR-147 D2: начальное значение EMA счётчика событий (холодный старт)
    eventCountEma: 10,
    // ADR-147 D12: счётчик последовательных flood-тиков
    floodTickCount: 0,
    // ADR-190: состояние Wakeup
    wakeupTicksElapsed: 0,
    wakeupEngagedTargets: new Set(),
    // Runtime restart also resets queue/engagement context; use the same recovery control loop.
    wakeupRecoveryUntilMs: shouldUsePostRestartRecovery
      ? startupNowMs + POST_WAKEUP_RECOVERY_MS
      : undefined,
    lastAPI: 0,
    lastAPIPeak: 0,
    lastFlushMs: startupNowMs,
    currentDt: 0,
    // ADR-190: начальное состояние экспоненциального отступа при сбое LLM
    llmBackoff: { consecutiveFailures: 0, lastFailureMs: 0 },
    // ADR-215: граф когнитивных эпизодов
    episodeState: initEpisodeState(),
  };

  // Контекст ACT
  const actCtx: ActContext = {
    client,
    G,
    config,
    queue,
    get personality() {
      return personalityRef.current;
    },
    dispatcher,
    buffer, // ADR-107: ссылка на EventBuffer
    getCurrentTick: () => clock.tick,
    getCurrentPressures: () => {
      const p = computeAllPressures(G, clock.tick, {
        kappa: config.kappa,
        threadAgeScale: config.threadAgeScale,
        mu: config.mu,
        d: config.d,

        deltaDeadline: config.delta,
      });
      return [p.P1, p.P2, p.P3, p.P4, p.P5, p.P6];
    },
    // ADR-173: отложенная запись — recentActions пишется после подтверждения реального Telegram-действия на этапе act
    recordAction: (action: string, target: string | null) => {
      const nowMs = Date.now();
      recentActions.push({ tick: clock.tick, action, ms: nowMs, target });
      // Очистка окна (согласуется с логикой старого enqueueAndRecord)
      const windowStartMs = nowMs - config.actionRateWindow * 1000;
      while (recentActions.length > 0 && recentActions[0].ms <= windowStartMs) {
        recentActions.shift();
      }
    },
    // ADR-190: уведомление о результате LLM-вызова — управляет экспоненциальным отступом на уровне планировщика evolve
    reportLLMOutcome: (success: boolean) => {
      if (success) {
        evolveState.llmBackoff.consecutiveFailures = 0;
      } else {
        evolveState.llmBackoff.consecutiveFailures++;
        evolveState.llmBackoff.lastFailureMs = Date.now();
      }
    },
    onPersonalityUpdate: (pv) => {
      // M7: единая точка обновления — все потребители автоматически получают актуальное значение через getter
      personalityRef.current = pv;
      // Синхронизация в узел графа (для чтения аудита дрейфа личности в strategy.mod)
      if (G.has(ALICE_SELF)) {
        G.updateAgent(ALICE_SELF, { personality_weights: JSON.stringify(pv.weights) });
      }
      // Снимок личности сохраняется централизованно таймером snapshotAndMaintain (интервал по настенному времени);
      // tick % snapshotIntervalS здесь больше не используется (несоответствие семантики счётчика tick и секунд).
      // @see F8 fix: ADR-113 незакрытый пункт
    },
  };

  // ── ADR-54 страховочная сеть: предстартовая проверка ──────────────────────────────────────────────

  // S2: мониторинг подключения mtcute — регистрация обработчиков error/connectionState
  // mtcute переподключается внутренне, здесь ведётся журнал для диагностики
  // @see docs/adr/54-pre-mortem-safety-net.md §S2
  client.onError.add((err: Error) => {
    log.error("mtcute connection error", { error: err.message });
    writeAuditEvent(clock.tick, "error", "mtcute", "Connection error", {
      error: err.message,
    });
  });
  // ADR-147 D4: отслеживание состояния переподключения mtcute — точная маркировка периода накопленных обновлений
  // `updating` = догоняем накопленные updates, `connected` = догонка завершена.
  // Первое подключение: onUsable → connected (фазы updating нет, recoveringStartMs=0, не срабатывает)
  // Восстановление после переподключения: connected → onCatchingUp(true) → updating → ... → onCatchingUp(false) → connected
  // @see docs/adr/147-flood-backlog-recovery.md §D4
  let recoveringStartMs = 0;
  client.onConnectionState.add((state: string) => {
    log.info("mtcute connection state changed", { state });
    if (state === "updating") {
      recoveringStartMs = Date.now();
      buffer.isRecovering = true;
      log.warn("mtcute entering recovery mode — catching up backlog");
      writeAuditEvent(clock.tick, "warn", "mtcute", "Entering recovery mode (catching up)");
    } else if (state === "connected" && recoveringStartMs > 0) {
      const durationMs = Date.now() - recoveringStartMs;
      buffer.isRecovering = false;
      recoveringStartMs = 0;
      log.info("mtcute recovery complete", { durationMs });
      writeAuditEvent(clock.tick, "warn", "mtcute", `Recovery complete in ${durationMs}ms`);
    }
    if (state === "offline" || state === "closed") {
      writeAuditEvent(clock.tick, "warn", "mtcute", `Connection state: ${state}`);
    }
  });

  // D5: инициализация цепочки fallback провайдеров (ADR-123 §D5)
  initProviders(config);

  // ADR-263: теневой судья Ax group reception — только параллельная диагностика, не перехватывает evidence/control.
  const { initGroupReceptionShadowJudge } = await import("./mods/observer/group-reception.js");
  initGroupReceptionShadowJudge(config);

  // S-EA: запуск Engine API (TCP)
  // Скрипты Skill CLI читают атрибуты config / graph через TCP.
  // @see docs/adr/202-engine-api.md
  let engineApiCleanup: (() => Promise<void>) | null = null;
  let enginePort = 0;
  // deps — мутируемая ссылка; после завершения S8 syncEnv в неё инжектируется registry и включается strict-режим
  const engineApiDeps: Parameters<typeof startEngineApi>[0] = {
    config: {
      timezoneOffset: config.timezoneOffset,
      exaApiKey: config.exaApiKey ?? "",
      musicApiBaseUrl: config.musicApiBaseUrl ?? "",
      youtubeApiKey: config.youtubeApiKey ?? "",
    },
    G,
    targetWhitelist: config.focusWhitelist,
    getTick: () => clock.tick,
    transportAdapters: config.qqOneBotApiBaseUrl
      ? {
          qq: createOneBotTransportAdapter({
            apiBaseUrl: config.qqOneBotApiBaseUrl,
            accessToken: config.qqOneBotAccessToken,
            timeoutMs: config.qqOneBotTimeoutMs,
          }),
        }
      : undefined,
    telegramSend: async ({ chatId, text, replyTo }) => {
      const rawChatId = typeof chatId === "number" ? chatId : Number(chatId);
      // Typing indicator + естественная задержка (выравнивание с поведением action-executor).
      // irc say/reply отправляется через Engine API, минуя конвейер typing action-executor;
      // здесь требуется компенсация, иначе собеседник не увидит "печатает".
      try {
        await setTyping(client, rawChatId);
        const charCount = [...text].length;
        const delayMs = Math.min(Math.max(charCount * 80, 800), 8000);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      } catch {
        // ошибка typing не блокирует отправку
      }
      // Forum: отвечаем в топик канала (current_topic_id), если он известен; иначе обычная отправка.
      const graphId = telegramChannelId(rawChatId);
      const topicId =
        graphId && G.has(graphId) ? G.getChannel(graphId).current_topic_id : undefined;
      const msgId = await sendText(client, rawChatId, text, { replyToMsgId: replyTo, topicId });
      // Явная отмена таймера typing (mtcute автоматически обновляет каждые 5с; без отмены остаётся активным)
      setTyping(client, rawChatId, true).catch(() => {});
      if (msgId != null && graphId) {
        cacheOutgoingMsg(graphId, msgId);
      }
      if (graphId && G.has(graphId)) {
        G.setDynamic(graphId, "last_outgoing_text", [...text].slice(0, 150).join(""));
        dispatcher.dispatch("SEND_MESSAGE", { chatId: graphId, text, msgId });
        dispatcher.dispatch("DECLARE_ACTION", { target: graphId });
      }
      return { msgId: msgId ?? null };
    },
    telegramMarkRead: async (chatId) => {
      const rawChatId = typeof chatId === "number" ? chatId : Number(chatId);
      await markRead(client, rawChatId);
      const graphId = telegramChannelId(rawChatId);
      if (graphId && G.has(graphId)) {
        G.setDynamic(graphId, "unread", 0);
        G.setDynamic(graphId, "mentions_alice", false);
        G.setDynamic(graphId, "recently_cleared_ms", Date.now());
      }
      return { ok: true as const };
    },
    telegramReact: async ({ chatId, msgId, emoji }) => {
      const rawChatId = typeof chatId === "number" ? chatId : Number(chatId);
      await sendReaction(client, rawChatId, msgId, emoji);
      const graphId = telegramChannelId(rawChatId);
      if (graphId) {
        dispatcher.dispatch("DECLARE_ACTION", { target: graphId, isMessage: false });
      }
      return { ok: true as const };
    },
    telegramJoin: async (chatIdOrLink) => {
      await joinChat(client, chatIdOrLink);
      return { ok: true as const };
    },
    telegramLeave: async (chatId) => {
      const rawChatId = typeof chatId === "number" ? chatId : Number(chatId);
      await leaveChat(client, rawChatId);
      return { ok: true as const };
    },
    telegramSticker: async ({ chatId, sticker: keyword }) => {
      const rawChatId = typeof chatId === "number" ? chatId : Number(chatId);
      // Typing indicator (стикеры тоже требуют краткого "печатает" для естественности)
      try {
        await setTyping(client, rawChatId);
        await new Promise((resolve) => setTimeout(resolve, 600));
      } catch {
        // ошибка typing не блокирует отправку
      }
      const graphId = telegramChannelId(rawChatId);
      const db = getDb();
      // Многоуровневый поиск: ключевое слово измерения → emoji → raw fileId
      let fileId: string | null = resolveLabel(db, keyword, graphId ?? undefined);
      if (!fileId) fileId = resolveByEmoji(db, keyword, graphId ?? undefined);
      if (!fileId && keyword.startsWith("CAACAgI")) fileId = keyword;
      // Финальный фолбэк: набор не классифицирован под этот keyword → шлём любой
      // стикер из палитры, лишь бы не падать (лучше нейтральный стикер, чем ошибка).
      if (!fileId) fileId = pickAnySticker(db);
      if (!fileId) {
        const available = getAvailableKeywords(db);
        throw new TelegramActionError(
          "invalid_sticker_keyword",
          `No sticker matches "${keyword}". Valid: ${available}`,
        );
      }
      const msgId = await sendSticker(client, rawChatId, fileId);
      setTyping(client, rawChatId, true).catch(() => {});
      if (msgId != null && graphId) {
        cacheOutgoingMsg(graphId, msgId);
        dispatcher.dispatch("DECLARE_ACTION", { target: graphId });
      }
      return { msgId: msgId ?? null };
    },
    // TTS голосовое сообщение: textToSpeech → sendVoice → fallback sendText
    telegramVoice: async ({ chatId, text, emotion, replyTo }) => {
      const rawChatId = typeof chatId === "number" ? chatId : Number(chatId);
      const graphId = telegramChannelId(rawChatId);
      const { isTTSEnabled, textToSpeech } = await import("./llm/tts.js");
      const { sendVoice } = await import("./telegram/actions.js");
      const ttsConfig = {
        ttsBaseUrl: config.ttsBaseUrl,
        ttsApiKey: config.ttsApiKey,
        ttsModel: config.ttsModel,
        ttsVoice: config.ttsVoice,
        ttsGroupId: config.ttsGroupId,
      };
      if (!isTTSEnabled(ttsConfig)) {
        throw new Error("TTS not configured (set TTS_BASE_URL and TTS_API_KEY in .env)");
      }
      // Проверка эмоции
      const VALID_EMOTIONS = new Set([
        "happy",
        "sad",
        "angry",
        "fearful",
        "disgusted",
        "surprised",
        "calm",
        "fluent",
        "whisper",
      ]);
      const validEmotion =
        emotion && VALID_EMOTIONS.has(emotion)
          ? (emotion as import("./llm/tts.js").TTSEmotion)
          : undefined;
      // Typing indicator
      try {
        await setTyping(client, rawChatId);
      } catch {
        /* сбой typing не блокирует отправку */
      }
      const audioBuffer = await textToSpeech(text.slice(0, 1000), ttsConfig, validEmotion);
      let sentMsgId: number | undefined;
      let deliveredAs: "voice" | "text" = "voice";
      let fallbackReason: string | undefined;
      if (audioBuffer) {
        try {
          sentMsgId = await sendVoice(client, rawChatId, audioBuffer, { replyToMsgId: replyTo });
        } catch (error) {
          if (!isTelegramActionError(error) || error.code !== "voice_messages_forbidden") {
            throw error;
          }
          log.warn("Voice messages forbidden, falling back to text", { chatId: rawChatId });
          sentMsgId =
            (await sendText(client, rawChatId, text, { replyToMsgId: replyTo })) ?? undefined;
          deliveredAs = "text";
          fallbackReason = "voice_messages_forbidden";
        }
      } else {
        // Сбой синтеза TTS → откат к текстовому сообщению
        log.warn("TTS synthesis failed, falling back to text", { chatId: rawChatId });
        sentMsgId =
          (await sendText(client, rawChatId, text, { replyToMsgId: replyTo })) ?? undefined;
        deliveredAs = "text";
        fallbackReason = "tts_synthesis_failed";
      }
      setTyping(client, rawChatId, true).catch(() => {});
      if (sentMsgId != null && graphId) {
        cacheOutgoingMsg(graphId, sentMsgId);
        dispatcher.dispatch("SEND_MESSAGE", {
          chatId: graphId,
          text,
          mediaType: deliveredAs === "voice" ? "voice" : undefined,
        });
        dispatcher.dispatch("DECLARE_ACTION", { target: graphId });
      }
      return { msgId: sentMsgId ?? null, deliveredAs, fallbackReason };
    },
    // ADR-206 W8: переадресация между чатами + необязательный дополнительный комментарий
    telegramForward: async ({ fromChatId, msgId, toChatId, comment }) => {
      const fwdMsgId = await forwardMessage(client, fromChatId, msgId, toChatId);
      const toGraphId = telegramChannelId(toChatId);
      if (fwdMsgId != null && toGraphId) {
        cacheOutgoingMsg(toGraphId, fwdMsgId);
        dispatcher.dispatch("DECLARE_ACTION", { target: toGraphId });
      }
      // Дополнительный комментарий: после успешного переадресования отправляется как reply
      let commentMsgId: number | null = null;
      if (comment?.trim() && fwdMsgId != null) {
        commentMsgId =
          (await sendText(client, toChatId, comment, { replyToMsgId: fwdMsgId })) ?? null;
        if (commentMsgId != null && toGraphId) {
          cacheOutgoingMsg(toGraphId, commentMsgId);
        }
      }
      const fromGraphId = telegramChannelId(fromChatId);
      if (fwdMsgId != null && fromGraphId && toGraphId) {
        const targetName =
          G.has(toGraphId) && G.getDynamic(toGraphId, "display_name")
            ? String(G.getDynamic(toGraphId, "display_name"))
            : String(toChatId);
        recordForwardShare(G, {
          fromGraphId,
          msgId,
          toGraphId,
          targetName,
        });
      }
      return { forwardedMsgId: fwdMsgId ?? null, commentMsgId };
    },
    telegramAlbumSend: async ({ assetId, targetChatId, caption, replyTo }) => {
      return sendAlbumPhoto(client, {
        assetId,
        targetChatId,
        caption,
        replyTo,
        onSent: (msgId) => {
          const graphId = telegramChannelId(targetChatId);
          if (graphId) {
            cacheOutgoingMsg(graphId, msgId);
            dispatcher.dispatch("DECLARE_ACTION", { target: graphId });
          }
        },
      });
    },
    // ADR-204 W2: callback загрузки Telegram-файла
    telegramDownload: async ({ chatId, msgId, output }) => {
      // Ограничение безопасности: путь output должен находиться под ALICE_HOME
      const resolved = resolve(output);
      if (!resolved.startsWith(ALICE_HOME)) {
        throw new Error(`output path must be under ALICE_HOME (${ALICE_HOME})`);
      }
      const rawChatId = typeof chatId === "number" ? chatId : Number(chatId);
      const msgs = await getMessages(client, rawChatId, [msgId]);
      const msg = msgs[0];
      if (!msg) throw new Error(`message ${msgId} not found in chat ${chatId}`);
      const media = msg.media;
      if (!media) throw new Error(`message ${msgId} has no media`);
      // Исключаем неподдерживаемые для скачивания типы media (Dice, Contact, Location и т.п.)
      const downloadable =
        "type" in media
          ? [
              "photo",
              "audio",
              "voice",
              "sticker",
              "document",
              "video",
              "videoNote",
              "animation",
            ].includes(media.type)
          : false;
      if (!downloadable) throw new Error(`message ${msgId} media type is not downloadable`);
      const buffer = Buffer.from(
        await client.downloadAsBuffer(media as Parameters<typeof client.downloadAsBuffer>[0]),
      );
      // Убеждаемся, что целевой каталог существует
      const { mkdirSync } = await import("node:fs");
      mkdirSync(dirname(resolved), { recursive: true });
      writeFileSync(resolved, buffer);
      // Определяем MIME type (из типа mtcute media или расширения файла)
      const mime =
        "mimeType" in media
          ? String(media.mimeType ?? "application/octet-stream")
          : "application/octet-stream";
      return { path: resolved, mime, size: buffer.length };
    },
    // ADR-204 W2: callback загрузки файла в Telegram
    telegramUpload: async ({ chatId, path: filePath, caption, replyTo }) => {
      // Ограничение безопасности: path должен находиться под ALICE_HOME
      const resolved = resolve(filePath);
      if (!resolved.startsWith(ALICE_HOME)) {
        throw new Error(`file path must be under ALICE_HOME (${ALICE_HOME})`);
      }
      const { readFileSync, existsSync } = await import("node:fs");
      if (!existsSync(resolved)) throw new Error(`file not found: ${resolved}`);
      const rawChatId = typeof chatId === "number" ? chatId : Number(chatId);
      const fileBuffer = readFileSync(resolved);
      const fileName = resolved.split("/").pop() ?? "file";
      // Строим медиа через InputMedia.auto
      const { InputMedia } = await import("@mtcute/node");
      const inputMedia = InputMedia.auto(fileBuffer, { fileName });
      const sent = await client.sendMedia(rawChatId, inputMedia, {
        caption,
        replyTo,
      });
      const graphId = telegramChannelId(rawChatId);
      if (sent?.id != null && graphId) {
        cacheOutgoingMsg(graphId, sent.id);
        dispatcher.dispatch("DECLARE_ACTION", { target: graphId });
      }
      return { msgId: sent?.id ?? null };
    },
    dispatchInstruction: (instruction, args) => dispatcher.dispatch(instruction, args),
    query: (name, args) => dispatcher.query(name, args),
    resolveCommandKind: (name) => {
      if (dispatcher.getQueryDef(name)) return "query";
      if (dispatcher.getInstructionDef(name)) return "instruction";
      return undefined;
    },
    getMods: () => dispatcher.mods,
    // После завершения S8 переходим в strict-режим (инжектируем registry + переключаем флаг)
    strictCapabilities: false,
  };
  try {
    const engineResult = await startEngineApi(engineApiDeps);
    engineApiCleanup = engineResult.cleanup;
    enginePort = engineResult.port;
    // инжектируем порт в переменную модуля shell-executor
    const { setEnginePort } = await import("./core/shell-executor.js");
    setEnginePort(enginePort);
    log.info("Engine API started", { port: enginePort });
  } catch (e) {
    log.warn("Engine API failed to start (non-fatal)", {
      error: e instanceof Error ? e.message : String(e),
    });
  }

  // ADR-129: размыкатель → уведомление Admin
  initAdminNotify({ client });
  onBreakerStateChange((providerName, event) => {
    if (event === "open") {
      notifyAdmin(
        `breaker:${providerName}`,
        `LLM provider "${providerName}" — предохранитель OPEN, Alice временно не может говорить`,
      );
    } else if (event === "closed") {
      notifyAdmin(`breaker-recovery:${providerName}`, `LLM provider "${providerName}" снова работает`);
    }
  });

  // S1: предстартовая проверка связности LLM — при сбое повторяем 3 раза перед exit; мгновенный таймаут сети не должен убивать процесс
  // @see docs/adr/54-pre-mortem-safety-net.md §S1
  {
    const S1_MAX_ATTEMPTS = 3;
    const S1_TIMEOUT_MS = 15_000;
    let s1Passed = false;
    for (let attempt = 1; attempt <= S1_MAX_ATTEMPTS; attempt++) {
      try {
        const { provider, model } = selectProviderForFirstPass();
        await generateText({
          model: provider(model),
          prompt: "ping",
          maxOutputTokens: 1,
          maxRetries: 0,
          abortSignal: AbortSignal.timeout(S1_TIMEOUT_MS),
        });
        log.info("LLM connectivity check passed", { attempt });
        s1Passed = true;
        break;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (attempt < S1_MAX_ATTEMPTS) {
          const delayMs = 2_000 * 2 ** (attempt - 1); // 2s, 4s
          log.warn("LLM connectivity check failed, retrying", { attempt, delayMs, error: msg });
          await new Promise((r) => setTimeout(r, delayMs));
        } else {
          log.fatal("LLM connectivity check failed after all attempts", {
            attempts: S1_MAX_ATTEMPTS,
            error: err,
          });
          writeAuditEvent(-1, "fatal", "startup", "LLM connectivity check failed", { error: msg });
        }
      }
    }
    if (!s1Passed) process.exit(1);
  }

  // S5: самодиагностическое сообщение при запуске — отправляется в Telegram Избранное, проверяет доступность mtcute + Telegram API
  // @see docs/adr/54-pre-mortem-safety-net.md §S5
  try {
    const startupMsg = `[Alice] Runtime started — ${new Date().toISOString()} — tick #${clock.tick}`;
    await client.sendText("me", startupMsg);
    log.info("Startup self-check message sent to Saved Messages");
  } catch (err) {
    log.error("Failed to send startup self-check message", { error: err });
    // exit не вызываем — подключение к Telegram проверено через getMe(), сбой sendText может быть временным
  }

  // S7: синхронизация стикер-палитры — инкрементальная синхронизация установленных стикер-паков в palette
  // Идемпотентно: добавление новых стикеров + очистка устаревших + обновление fileId. VLM-стикеры не затрагиваются.
  try {
    const stats = await syncInstalledSets(client, getDb());
    if (stats.added > 0 || stats.removed > 0) {
      log.info("Sticker palette synced", stats);
    }
  } catch (e) {
    log.warn("Sticker palette sync failed (non-fatal)", { error: e });
  }

  // S8: синхронизация пакетов Skill — сходимость к желаемому состоянию, объявленному в alice-env.yaml
  // @see docs/adr/201-os-for-llm.md
  try {
    // fileURLToPath (не .pathname): на Windows URL.pathname даёт "/C:/..." с
    // ведущим слешем → existsSync=false → syncEnv бросает "env file not found".
    const envPath = fileURLToPath(new URL("../skills/alice-env.yaml", import.meta.url));
    const skillSync = await syncEnv(envPath, { enginePort });
    if (skillSync.installed.length > 0 || skillSync.upgraded.length > 0) {
      log.info("Skills synced", skillSync);
    }
    // После завершения синхронизации Skill инжектируем registry + включаем strict-режим
    // deps — ссылочный тип; каждый последующий запрос route() будет читать актуальные значения
    engineApiDeps.registry = loadRegistry();
    const artifactsResult = ensureAllArtifacts();
    if (artifactsResult.synced > 0 || artifactsResult.fixed > 0) {
      log.info("Skill artifacts verified", {
        synced: artifactsResult.synced,
        fixed: artifactsResult.fixed,
        broken: artifactsResult.broken.length > 0 ? artifactsResult.broken : undefined,
      });
    }
    if (artifactsResult.broken.length > 0) {
      log.warn("Some skills have broken artifacts and could not be fixed", {
        broken: artifactsResult.broken,
      });
    }
    engineApiDeps.strictCapabilities = true;
    log.info("Engine API capability check: strict mode enabled");
  } catch (e) {
    log.warn("Skill sync failed (non-fatal, capability check stays lenient)", {
      error: e instanceof Error ? e.message : String(e),
    });
  }

  // S6: dry-run конвейера давлений — прогон pressures → tensionMap → loudness → selectAction
  // Не продвигает tick, не пишет в DB, не ставит в очередь; только проверяет, что конвейер не вызывает исключений / NaN
  // @see docs/adr/54-pre-mortem-safety-net.md §S6
  try {
    const dryPressures = computeAllPressures(G, clock.tick, {
      kappa: config.kappa,
      threadAgeScale: config.threadAgeScale,
      mu: config.mu,
      d: config.d,
      deltaDeadline: config.delta,
    });
    const dryTensionMap = buildTensionMap(
      dryPressures.contributions,
      dryPressures.prospectContributions,
    );
    const { loudness: dryLoudness } = computeLoudness(
      dryTensionMap,
      personalityRef.current,
      G,
      clock.tick,
      {
        recentEventCounts,
        targetWhitelist: config.focusWhitelist,
      },
    );
    const [, dryAction] = selectAction(dryLoudness);

    // Проверяем отсутствие NaN
    const pValues = [
      dryPressures.P1,
      dryPressures.P2,
      dryPressures.P3,
      dryPressures.P4,
      dryPressures.P5,
      dryPressures.P6,
      dryPressures.API,
      dryPressures.API_peak,
    ];
    const hasNaN = pValues.some((v) => Number.isNaN(v)) || dryLoudness.some((v) => Number.isNaN(v));
    if (hasNaN) {
      log.fatal("Pressure pipeline dry-run produced NaN", {
        pressures: pValues.map((v) => v.toFixed(4)),
        loudness: dryLoudness.map((v) => v.toFixed(4)),
      });
      writeAuditEvent(-1, "fatal", "startup", "Pressure pipeline NaN", {
        pressures: pValues,
        loudness: Array.from(dryLoudness),
      });
      process.exit(1);
    }

    log.info("Pressure pipeline dry-run passed", {
      API: dryPressures.API.toFixed(3),
      P1: dryPressures.P1.toFixed(3),
      P6: dryPressures.P6.toFixed(3),
      entities: dryTensionMap.size,
      selectedVoice: dryAction,
    });
  } catch (err) {
    log.fatal("Pressure pipeline dry-run failed", { error: err });
    writeAuditEvent(-1, "fatal", "startup", "Pressure pipeline exception", {
      error: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  }

  // S7: предварительный прогрев Docker sandbox session — создаём контейнер до первого tick, устраняя задержку холодного старта
  // Критично: если sandbox не запускается = все shell-команды недоступны, runtime бессмысленен
  try {
    const { warmupSandboxSession } = await import("./skills/container-runner.js");
    await warmupSandboxSession(enginePort);
    log.info("Docker sandbox session pre-warmed");
  } catch (err) {
    log.fatal("Docker sandbox session warmup failed — cannot execute shell commands", {
      error: err instanceof Error ? err.message : String(err),
    });
    writeAuditEvent(clock.tick, "error", "safety-net", "S7: Docker sandbox warmup failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  }

  // ── Предстартовые проверки страховочной сети завершены ─────────────────────────────────────────────────────────

  // 6. Запуск трёх потоков
  const evolveController = startEvolveLoop(evolveState);
  // C2: ACT-цикл с fatal-guard (симметрично EVOLVE). Ошибки забора задач уже ловятся внутри
  // startReActLoop (release lock + skip); этот guard — на НЕОЖИДАННЫЙ краш: логируем fatal и
  // гасим EVOLVE тоже, чтобы не остаться «думающей, но не действующей» — супервайзер перезапустит.
  // .catch на самом промисе → await actPromise при shutdown не выбросит.
  const actPromise = startActLoop(actCtx).catch((err) => {
    log.fatal("ACT loop crashed unexpectedly", {
      error: err instanceof Error ? err.message : String(err),
    });
    evolveController.abort(err instanceof Error ? err.message : String(err));
  });
  log.info("EVOLVE + ACT loops started", {
    dtMin: config.dtMin,
    dtMax: config.dtMax,
    kappaT: config.kappaT,
    startTick: clock.tick,
  });

  const runtimeHeartbeat = setInterval(() => {
    try {
      recordRuntimeHeartbeat(G);
    } catch (e) {
      log.warn("Runtime heartbeat failed", { error: e });
    }
  }, RUNTIME_HEARTBEAT_INTERVAL_MS);

  // ADR-33: периодическое сохранение состояния Mod + обслуживание (выровнено со снимками графа)
  // Используем настенные секунды snapshotIntervalS в качестве интервала setInterval
  let stickerSyncCounter = 0;
  const snapshotAndMaintain = setInterval(() => {
    try {
      const tick = clock.tick;
      dispatcher.saveModStatesToDb(tick);
      // F8 fix: снимок личности сохраняется таймером настенного времени, не зависит от счётчика tick
      savePersonalitySnapshot(tick, personalityRef.current);
      // Очистка журналов при каждом интервале снимка
      if (tick > 0) {
        const alerts = runMaintenance(tick, G, {
          rhythmProfileRebuild: {
            intervalMs: config.rhythmProfileRebuildIntervalS * 1000,
            timezoneOffset: config.timezoneOffset,
          },
        });
        if (alerts.length > 0) {
          dispatcher.dispatch("UPDATE_ANOMALIES", { anomalies: alerts });
        }
      }
      // ADR-168 Wave 2: синхронизация стикеров (каждые 5 интервалов снимка = snapshotIntervalS × 5 секунд)
      stickerSyncCounter++;
      if (stickerSyncCounter >= 5) {
        stickerSyncCounter = 0;
        syncInstalledSets(client, getDb()).catch((e) => {
          log.warn("Periodic sticker sync failed (non-fatal)", { error: e });
        });
      }
    } catch (e) {
      log.error("snapshotAndMaintain failed", e);
    }
  }, config.snapshotIntervalS * 1000);

  // 7. Завершение работы
  let shutdownInProgress = false;
  const shutdown = async () => {
    if (shutdownInProgress) return;
    shutdownInProgress = true;
    log.info("Shutting down...");

    // Останавливаем периодические задачи
    clearInterval(runtimeHeartbeat);
    clearInterval(snapshotAndMaintain);
    oneBotReceiver?.close();

    // Закрываем Engine API
    if (engineApiCleanup) {
      try {
        await engineApiCleanup();
      } catch (e) {
        log.warn("Engine API cleanup error (ignored)", { error: e });
      }
    }

    // Останавливаем EVOLVE
    evolveController.abort();

    // Останавливаем ACT
    queue.close();
    await actPromise;

    // Сохраняем финальное состояние
    if (G.has(ALICE_SELF)) {
      const shutdownMs = Date.now();
      G.updateAgent(ALICE_SELF, {
        runtime_last_seen_ms: shutdownMs,
        runtime_shutdown_ms: shutdownMs,
      });
    }
    flushGraph(G);
    savePersonalitySnapshot(clock.tick, personalityRef.current);
    dispatcher.saveModStatesToDb(clock.tick);
    log.info("Final snapshot saved", { tick: clock.tick });

    // Очистка
    await destroyClient();
    closeGroupCache();
    closeMediaCache();
    closeDb();
    log.info("Shutdown complete");
    // P1-3: даём буфер I/O-коллбэкам (TCP FIN, сохранение MTProto-сессии и т.д.),
    // чтобы process.exit(0) не обрезал асинхронную очистку.
    const SHUTDOWN_IO_BUFFER_MS = 2000;
    setTimeout(() => process.exit(0), SHUTDOWN_IO_BUFFER_MS);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("unhandledRejection", (reason) => {
    log.error("Unhandled rejection", {
      error: reason instanceof Error ? reason.message : String(reason),
    });
  });
}

main().catch((err) => {
  log.fatal("Fatal error", err);
  process.exit(1);
});
