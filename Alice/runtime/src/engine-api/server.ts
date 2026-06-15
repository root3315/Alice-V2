/**
 * Engine API сервер — TCP HTTP интерфейс.
 *
 * Skill CLI скрипты общаются с работающим движком Alice по TCP,
 * читают и записывают конфиг и атрибуты графа. Внутри контейнера доступен через host.docker.internal.
 *
 * @see docs/adr/202-engine-api.md
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { WorldModel } from "../graph/world-model.js";
import { createTelegramTransportAdapter, type TransportAdapter } from "../platform/transport.js";
import { ALICE_ENGINE_PORT } from "../runtime-paths.js";
import { loadRegistry, mergeRegistryWithBuiltIns, type Registry } from "../skills/registry.js";
import { createLogger } from "../utils/logger.js";
import { checkCapability, withRequestLog } from "./middleware.js";
import { handleAlbum } from "./routes/album.js";
import { handleChatTail } from "./routes/chat.js";
import { handleCmd } from "./routes/cmd.js";
import { handleConfigGet } from "./routes/config.js";
import { handleDashboard } from "./routes/dashboard.js";
import { handleDispatchInstruction } from "./routes/dispatch.js";
import { handleEngineSelfcheck, handleEngineTick } from "./routes/engine.js";
import { handleGraphGet, handleGraphSet } from "./routes/graph.js";
import { handleLlmSummarize, handleLlmSynthesize } from "./routes/llm.js";
import { handleMetaCommands } from "./routes/meta.js";
import { handleQuery } from "./routes/query.js";
import { handleResolveName, handleResolveTarget } from "./routes/resolve.js";
import {
  handleSkillInfo,
  handleSkillInstall,
  handleSkillList,
  handleSkillPublish,
  handleSkillRemove,
  handleSkillRollback,
  handleSkillSearch,
  handleSkillUpgrade,
  handleSkillUpgrades,
} from "./routes/skills.js";
import { handleTelegramForward } from "./routes/telegram.js";
import { handleTransport } from "./routes/transport.js";

const log = createLogger("engine-api");

export interface EngineApiDeps {
  config: {
    timezoneOffset: number;
    exaApiKey: string;
    musicApiBaseUrl: string;
    youtubeApiKey: string;
  };
  G: WorldModel;
  /** Получить текущий номер тика (используется конечной точкой запроса движка). */
  getTick?: () => number;
  /** Реестр скиллов (для проверки capability). undefined = мягкий режим Phase 1. */
  registry?: Registry;
  /** true = строгий (нет заголовка / неизвестный скилл → 403), false/undefined = мягкий. */
  strictCapabilities?: boolean;
  /** Optional target allowlist for LLM-facing target resolution. */
  targetWhitelist?: ReadonlySet<string> | null;
  /** Neutral IM transport adapters keyed by platform. */
  transportAdapters?: Record<string, TransportAdapter>;
  /** Колбэк пересылки сообщений Telegram (irc forward: пересылка между чатами + опциональный комментарий). */
  telegramForward?: (params: {
    fromChatId: number;
    msgId: number;
    toChatId: number;
    comment?: string;
  }) => Promise<{ forwardedMsgId: number | null; commentMsgId?: number | null }>;
  /** ADR-260: Telegram group photo album send callback. */
  telegramAlbumSend?: (params: {
    assetId: string;
    targetChatId: number;
    caption?: string;
    replyTo?: number;
  }) => Promise<{ msgId: number | null; sendMode: string; assetId: string }>;
  /** Колбэк отправки текста Telegram (irc say/reply). */
  telegramSend?: (params: {
    chatId: number;
    text: string;
    replyTo?: number;
  }) => Promise<{ msgId: number | null }>;
  /** Колбэк отметки прочитанного Telegram (irc read). */
  telegramMarkRead?: (chatId: number) => Promise<{ ok: true }>;
  /** Колбэк реакции Telegram (irc react). */
  telegramReact?: (params: {
    chatId: number;
    msgId: number;
    emoji: string;
  }) => Promise<{ ok: true }>;
  /** Telegram join callback (`irc join`). */
  telegramJoin?: (chatIdOrLink: string) => Promise<{ ok: true }>;
  /** Telegram leave callback (`irc leave`). */
  telegramLeave?: (chatId: number) => Promise<{ ok: true }>;
  /** Telegram sticker callback (`irc sticker`). */
  telegramSticker?: (params: {
    chatId: number;
    sticker: string;
  }) => Promise<{ msgId: number | null }>;
  /** Telegram download callback (`irc download`). */
  telegramDownload?: (params: {
    chatId: number;
    msgId: number;
    output: string;
  }) => Promise<{ path: string; mime: string; size: number }>;
  /** Telegram upload callback (`irc send-file`). */
  telegramUpload?: (params: {
    chatId: number;
    path: string;
    caption?: string;
    replyTo?: number;
  }) => Promise<{ msgId: number | null }>;
  /** Telegram voice callback (`irc voice`). TTS → OGG/Opus → sendVoice. */
  telegramVoice?: (params: {
    chatId: number;
    text: string;
    emotion?: string;
    replyTo?: number;
  }) => Promise<{ msgId: number | null; deliveredAs?: "voice" | "text"; fallbackReason?: string }>;
  /** Dispatcher syscall bridge. */
  dispatchInstruction?: (
    instruction: string,
    args: Record<string, unknown>,
  ) => Promise<unknown> | unknown;
  /** Dispatcher query bridge. */
  query?: (name: string, args: Record<string, unknown>) => Promise<unknown> | unknown;
  /** Dispatcher command kind resolver for /cmd routing. */
  resolveCommandKind?: (name: string) => "query" | "instruction" | undefined;
  /** Список определений модов (для генерации каталога команд на /meta/commands). */
  getMods?: () => readonly import("../core/types.js").ModDefinition[];
  /** Номер TCP-порта. 0 = автоматическое назначение ОС. */
  port?: number;
}

/**
 * Простой маршрутизатор запросов.
 *
 * Пути без префикса версии — внутрипроцессный TCP IPC, не публичный REST API.
 * - GET  /config/:key
 * - GET  /chat/:chatId/tail
 * - GET  /engine/tick
 * - POST /engine/selfcheck
 * - POST /llm/synthesize
 * - POST /llm/summarize
 * - GET  /graph/:entity/:attr
 * - POST /graph/:entity/:attr
 * - POST /telegram/forward
 * - POST /transport/send
 * - POST /transport/read
 * - POST /transport/react
 * - GET  /skills/search?query=...
 * - GET  /skills/list
 * - GET  /skills/info/:name
 * - POST /skills/install
 * - POST /skills/remove
 * - POST /skills/upgrade
 * - POST /skills/rollback
 * - POST /dispatch/:instruction
 * - POST /query/:name
 * - POST /cmd/:name             (ADR-217: unified dispatch/query)
 * - GET  /meta/commands          (ADR-217: command catalog)
 */
export function routeRequest(
  req: IncomingMessage,
  res: ServerResponse,
  deps: EngineApiDeps,
): void | Promise<void> {
  // Strict mode must observe newly installed/removed skills immediately.
  const registry = deps.strictCapabilities
    ? mergeRegistryWithBuiltIns(loadRegistry())
    : deps.registry
      ? mergeRegistryWithBuiltIns(deps.registry)
      : mergeRegistryWithBuiltIns({});

  // Проверка capability
  const capMode = deps.strictCapabilities ? "strict" : "lenient";
  const capCheck = checkCapability(req, registry, capMode);
  if (!capCheck.allowed) {
    res.writeHead(403, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        error: `skill "${capCheck.skill}" lacks capability "${capCheck.needed}"`,
      }),
    );
    return;
  }

  const method = req.method ?? "GET";
  const url = req.url ?? "/";

  const pathname = url.split("?")[0];
  // /config/timezoneOffset → ["config", "timezoneOffset"]
  const segments = pathname.split("/").filter(Boolean);

  // --- dashboard (read-only stats UI; /dashboard — 1 сегмент, обрабатываем ДО гейта length<2) ---
  // GET — страница + /dashboard/data JSON. POST /dashboard/control — небольшой control-plane
  // (cancel/dismiss/selfcheck/feeds-pause), сознательно БЕЗ авторизации (решение владельца).
  if (segments[0] === "dashboard" && (method === "GET" || method === "POST")) {
    return handleDashboard(segments[1], method, req, res, deps);
  }

  if (segments.length < 2) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
    return;
  }

  const resource = segments[0];

  // --- config ---
  if (resource === "config" && method === "GET" && segments.length === 2) {
    handleConfigGet(segments[1], req, res, deps);
    return;
  }

  // --- engine ---
  if (resource === "engine") {
    if (method === "GET" && segments[1] === "tick" && segments.length === 2) {
      handleEngineTick(req, res, deps);
      return;
    }
    if (method === "POST" && segments[1] === "selfcheck" && segments.length === 2) {
      return handleEngineSelfcheck(req, res, deps);
    }
  }

  // --- chat ---
  if (resource === "chat" && method === "GET" && segments.length === 3 && segments[2] === "tail") {
    handleChatTail(segments[1], req, res, deps);
    return;
  }

  // --- llm ---
  if (resource === "llm" && method === "POST" && segments.length === 2) {
    if (segments[1] === "synthesize") {
      return handleLlmSynthesize(req, res);
    }
    if (segments[1] === "summarize") {
      return handleLlmSummarize(req, res);
    }
  }

  // --- graph ---
  // /graph/contact:telegram:123/display_name → ["graph", "contact:telegram:123", "display_name"]
  if (resource === "graph" && segments.length === 3) {
    const entity = segments[1];
    const attr = segments[2];
    if (method === "GET") {
      handleGraphGet(entity, attr, req, res, deps);
      return;
    }
    if (method === "POST") {
      return handleGraphSet(entity, attr, req, res, deps);
    }
  }

  // --- telegram ---
  if (resource === "telegram" && method === "POST" && segments.length === 2) {
    return handleTelegramForward(segments[1], req, res, deps);
  }

  // --- transport ---
  if (resource === "transport" && method === "POST" && segments.length === 2) {
    const transportDeps: EngineApiDeps = deps.transportAdapters?.telegram
      ? deps
      : {
          ...deps,
          transportAdapters: {
            ...deps.transportAdapters,
            telegram: createTelegramTransportAdapter({
              send: deps.telegramSend,
              markRead: deps.telegramMarkRead,
              react: deps.telegramReact,
            }),
          },
        };
    return handleTransport(segments[1], req, res, transportDeps);
  }

  // --- album ---
  if (resource === "album" && segments.length === 2) {
    return handleAlbum(segments[1], req, res, deps);
  }

  // --- skills ---
  if (resource === "skills") {
    if (method === "GET" && segments[1] === "search") {
      return handleSkillSearch(req, res);
    }
    if (method === "GET" && segments[1] === "list") {
      handleSkillList(req, res);
      return;
    }
    if (method === "GET" && segments[1] === "info" && segments.length === 3) {
      return handleSkillInfo(segments[2], req, res);
    }
    if (method === "POST" && segments[1] === "install") {
      return handleSkillInstall(req, res);
    }
    if (method === "POST" && segments[1] === "remove") {
      return handleSkillRemove(req, res);
    }
    if (method === "POST" && segments[1] === "upgrade") {
      return handleSkillUpgrade(req, res);
    }
    if (method === "POST" && segments[1] === "rollback") {
      return handleSkillRollback(req, res);
    }
    if (method === "POST" && segments[1] === "publish") {
      return handleSkillPublish(req, res);
    }
    if (method === "GET" && segments[1] === "upgrades") {
      return handleSkillUpgrades(req, res);
    }
  }

  // --- dispatch ---
  if (resource === "dispatch" && method === "POST" && segments.length === 2) {
    return handleDispatchInstruction(segments[1], req, res, deps);
  }

  if (resource === "query" && method === "POST" && segments.length === 2) {
    return handleQuery(segments[1], req, res, deps);
  }

  // --- cmd (ADR-217: unified dispatch/query) ---
  if (resource === "cmd" && method === "POST" && segments.length === 2) {
    return handleCmd(segments[1], req, res, deps);
  }

  // --- meta ---
  if (
    resource === "meta" &&
    method === "GET" &&
    segments.length === 2 &&
    segments[1] === "commands"
  ) {
    return handleMetaCommands(res, deps);
  }

  // --- resolve (ADR-237 name, ADR-265 target refs) ---
  if (
    resource === "resolve" &&
    method === "POST" &&
    segments.length === 2 &&
    segments[1] === "name"
  ) {
    return handleResolveName(req, res, deps);
  }
  if (
    resource === "resolve" &&
    method === "POST" &&
    segments.length === 2 &&
    segments[1] === "target"
  ) {
    return handleResolveTarget(req, res, deps);
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "not found" }));
}

/**
 * Запустить Engine API сервер (TCP).
 *
 * @returns { cleanup, port } — cleanup закрывает сервер; port — фактический порт прослушивания
 */
export async function startEngineApi(
  deps: EngineApiDeps,
): Promise<{ cleanup: () => Promise<void>; port: number }> {
  const requestedPort = deps.port ?? ALICE_ENGINE_PORT;
  const server: Server = createServer(withRequestLog((req, res) => routeRequest(req, res, deps)));

  await new Promise<void>((resolve, reject) => {
    server.on("error", reject);
    server.listen(requestedPort, "0.0.0.0", () => resolve());
  });

  const actualPort = (server.address() as AddressInfo).port;
  log.info(`listening on 0.0.0.0:${actualPort}`);

  return {
    port: actualPort,
    cleanup: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
      log.info("server stopped");
    },
  };
}
