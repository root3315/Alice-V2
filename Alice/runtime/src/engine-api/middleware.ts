/**
 * Middleware Engine API — логирование запросов + проверка capability.
 *
 * Два режима:
 * - lenient (по умолчанию): разрешает все запросы при отсутствии заголовка X-Alice-Skill.
 * - strict: нет заголовка → 403, неизвестный skill → 403, нет capability → 403.
 *
 * @see docs/adr/202-engine-api.md
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { SkillCapability } from "../skills/manifest.js";
import type { Registry } from "../skills/registry.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("engine-api");

/** Таблица соответствия пути → требуемой capability. */
const ROUTE_CAPABILITIES: Array<{
  test: (method: string, path: string) => boolean;
  required: SkillCapability;
}> = [
  // config — чувствительные ключи (API Key и подобные)
  {
    test: (m, p) => m === "GET" && /^\/config\/(exaApiKey|musicApiBaseUrl|youtubeApiKey)$/.test(p),
    required: "config.secrets",
  },
  // config — нечувствительные ключи
  {
    test: (m, p) => m === "GET" && p.startsWith("/config/"),
    required: "config.read",
  },
  // engine selfcheck
  {
    test: (m, p) => m === "POST" && p === "/engine/selfcheck",
    required: "engine.selfcheck",
  },
  // engine — чтение (tick и т.д.)
  {
    test: (m, p) => m === "GET" && p.startsWith("/engine/"),
    required: "config.read",
  },
  // LLM synthesize
  {
    test: (m, p) => m === "POST" && p === "/llm/synthesize",
    required: "llm.synthesize",
  },
  // LLM summarize
  {
    test: (m, p) => m === "POST" && p === "/llm/summarize",
    required: "llm.summarize",
  },
  // graph — запись
  {
    test: (m, p) => m === "POST" && p.startsWith("/graph/"),
    required: "graph.write",
  },
  // graph — чтение
  {
    test: (m, p) => m === "GET" && p.startsWith("/graph/"),
    required: "graph.read",
  },
  // chat tail
  {
    test: (m, p) => m === "GET" && p.startsWith("/chat/"),
    required: "chat.read",
  },
  // telegram send
  {
    test: (m, p) => m === "POST" && p.startsWith("/telegram/send"),
    required: "telegram.send",
  },
  // neutral transport send
  {
    test: (m, p) => m === "POST" && p.startsWith("/transport/send"),
    required: "transport.send",
  },
  // telegram mark read
  {
    test: (m, p) => m === "POST" && p.startsWith("/telegram/read"),
    required: "telegram.read",
  },
  // neutral transport read
  {
    test: (m, p) => m === "POST" && p.startsWith("/transport/read"),
    required: "transport.read",
  },
  // telegram react
  {
    test: (m, p) => m === "POST" && p.startsWith("/telegram/react"),
    required: "telegram.react",
  },
  // neutral transport react
  {
    test: (m, p) => m === "POST" && p.startsWith("/transport/react"),
    required: "transport.react",
  },
  // telegram join
  {
    test: (m, p) => m === "POST" && p.startsWith("/telegram/join"),
    required: "telegram.join",
  },
  // telegram leave
  {
    test: (m, p) => m === "POST" && p.startsWith("/telegram/leave"),
    required: "telegram.leave",
  },
  // telegram forward
  {
    test: (m, p) => m === "POST" && p.startsWith("/telegram/forward"),
    required: "telegram.forward",
  },
  // album search/send
  {
    test: (m, p) => m === "GET" && p.startsWith("/album/search"),
    required: "chat.read",
  },
  {
    test: (m, p) => m === "POST" && p.startsWith("/album/send"),
    required: "telegram.forward",
  },
  // dispatch
  {
    test: (m, p) => m === "POST" && p.startsWith("/dispatch"),
    required: "dispatch",
  },
  // query
  {
    test: (m, p) => m === "POST" && p.startsWith("/query"),
    required: "query",
  },
  // ADR-217: unified cmd (dispatch + query)
  {
    test: (m, p) => m === "POST" && p.startsWith("/cmd"),
    required: "dispatch",
  },
  // ADR-217: meta (command catalog)
  {
    test: (m, p) => m === "GET" && p.startsWith("/meta"),
    required: "config.read",
  },
];

/**
 * Определяет требуемую capability по пути запроса.
 */
export function requiredCapability(method: string, pathname: string): SkillCapability | null {
  for (const rule of ROUTE_CAPABILITIES) {
    if (rule.test(method, pathname)) return rule.required;
  }
  return null;
}

export type CapabilityMode = "lenient" | "strict";

/**
 * Проверяет, имеет ли Skill требуемую для запроса capability.
 *
 * - lenient: возвращает true при отсутствии заголовка или registry.
 * - strict: нет заголовка → 403, неизвестный skill → 403, нет capability → 403.
 */
export function checkCapability(
  req: IncomingMessage,
  registry: Registry | undefined,
  mode: CapabilityMode = "lenient",
): { allowed: true } | { allowed: false; skill: string; needed: SkillCapability } {
  const method = req.method ?? "GET";
  const pathname = (req.url ?? "/").split("?")[0];
  const needed = requiredCapability(method, pathname);

  // Маршруты, не требующие capability (например, 404) → пропускаем
  if (!needed) return { allowed: true };

  const skillName = req.headers["x-alice-skill"] as string | undefined;

  if (mode === "strict") {
    // strict: нет заголовка → 403
    if (!skillName) {
      return { allowed: false, skill: "(no header)", needed };
    }
    // strict: отсутствие registry считается ошибкой конфигурации, отклоняем
    if (!registry) {
      return { allowed: false, skill: skillName, needed };
    }
    const entry = registry[skillName];
    // strict: незарегистрированный skill → 403
    if (!entry) {
      log.warn(`unknown skill "${skillName}" accessing ${method} ${pathname} (strict mode)`);
      return { allowed: false, skill: skillName, needed };
    }
    // Проверяем capability
    if (entry.capabilities.includes(needed)) {
      return { allowed: true };
    }
    return { allowed: false, skill: skillName, needed };
  }

  // lenient: при отсутствии заголовка разрешаем всё
  if (!skillName || !registry) return { allowed: true };

  const entry = registry[skillName];
  if (!entry) {
    // Незарегистрированный Skill — в режиме lenient пропускаем (с предупреждением в лог)
    log.warn(`unknown skill "${skillName}" accessing ${method} ${pathname}`);
    return { allowed: true };
  }

  // Проверяем capability
  if (entry.capabilities.includes(needed)) {
    return { allowed: true };
  }

  return { allowed: false, skill: skillName, needed };
}

/**
 * Оборачивает handler, печатая краткий лог до и после запроса.
 * Формат: `METHOD /path → STATUS (duration ms)`
 */
export function withRequestLog(
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>,
): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    const start = performance.now();
    const skill = req.headers["x-alice-skill"] as string | undefined;
    res.on("finish", () => {
      // Дашборд опрашивает /dashboard/* каждые ~5с — успешные опросы не логируем,
      // чтобы не засорять консоль (ошибки >=400 по-прежнему пишем).
      const path = (req.url ?? "/").split("?")[0];
      if (req.method === "GET" && path.startsWith("/dashboard") && res.statusCode < 400) return;
      const duration = (performance.now() - start).toFixed(1);
      const tag = skill ? ` [${skill}]` : "";
      log.info(`${req.method} ${req.url}${tag} → ${res.statusCode} (${duration}ms)`);
    });
    // handler может вернуть Promise (async) или бросить синхронный throw. Async-reject ловился и раньше (ниже);
    // новый try/catch добавляет обработку СИНХРОННОГО throw — именно он ронял процесс (C1).
    const fail = (err: unknown) => {
      log.error("unhandled error in request handler", err);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "internal server error" }));
      }
    };
    try {
      const result = handler(req, res);
      if (result instanceof Promise) result.catch(fail);
    } catch (err) {
      fail(err);
    }
  };
}
