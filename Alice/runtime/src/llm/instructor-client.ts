/**
 * instructor-js клиент — структурированный вывод с валидацией + замкнутый цикл retry.
 *
 * ADR-213: основной канал структурированного вывода для tick callLLM.
 * Режим instructor выбирается автоматически по провайдеру:
 * - Gemini (generativelanguage.googleapis.com) → MD_JSON (ограничения формата tool schema)
 * - Остальные (OpenAI / Anthropic / OpenRouter совместимые) → TOOLS (нативный tool calling)
 *
 * Переиспользует baseUrl/apiKey/model из списка endpoints config.providers, не вводит новых настроек.
 *
 * @see docs/adr/213-tool-calling-act-thread.md
 * @see https://js.useinstructor.com/
 */
import Instructor from "@instructor-ai/instructor";
import OpenAI from "openai";
import type { Config } from "../config.js";
import { createLogger } from "../utils/logger.js";
import { getBreakerState } from "./resilience.js";

const log = createLogger("instructor");

// -- Типы -------------------------------------------------------------------

interface InstructorEntry {
  name: string;
  model: string;
  client: ReturnType<typeof Instructor>;
}

export interface AvailableInstructor {
  client: ReturnType<typeof Instructor>;
  model: string;
  name: string;
}

// -- Состояние -------------------------------------------------------------------

let _entries: InstructorEntry[] = [];

// -- Автовыбор режима ----------------------------------------------------------

/** Признак модели Gemini — baseUrl может быть прокси, поэтому надёжнее определять по имени модели. */
// claude/sonnet/haiku: идём через claude-proxy, который НЕ эмулирует нативный
// tool-calling (TOOLS mode). MD_JSON кладёт схему в промпт и парсит JSON из текста —
// это прокси поддерживает (claude отлично отдаёт JSON).
const MD_JSON_MODEL_PATTERNS = [
  "gemini",
  "vertex-gemini",
  "deepseek",
  "reasoner",
  "claude",
  "sonnet",
  "haiku",
  "opus",
];

/** Выбрать режим instructor по имени модели. */
function selectMode(model: string): "TOOLS" | "MD_JSON" {
  const lower = model.toLowerCase();
  if (MD_JSON_MODEL_PATTERNS.some((p) => lower.includes(p))) return "MD_JSON";
  return "TOOLS";
}

// -- Публичный API ---------------------------------------------------------------

/** Инициализировать цепочку instructor-клиентов из Config.providers. Вызывается параллельно с initProviders(). */
export function initInstructorClients(config: Config): void {
  const route = config.llmRouting.firstPass
    .map((name) => config.providers.find((provider) => provider.name === name))
    .filter((provider): provider is Config["providers"][number] => Boolean(provider));
  const entries = route.length > 0 ? route : config.providers;

  _entries = entries.map((pc) => {
    const oai = new OpenAI({
      baseURL: pc.baseUrl,
      apiKey: pc.apiKey,
    });
    const mode = selectMode(pc.model);
    log.info("Instructor client initialized", { name: pc.name, model: pc.model, mode });
    return {
      name: pc.name,
      model: pc.model,
      client: Instructor({ client: oai, mode }),
    };
  });
}

/** Вернуть текущий доступный instructor-клиент (переиспользует состояние circuit breaker из resilience.ts). */
export function getAvailableInstructor(): AvailableInstructor {
  if (_entries.length === 0) {
    throw new Error("No instructor clients initialized — call initInstructorClients() first");
  }
  for (const entry of _entries) {
    if (getBreakerState(entry.name) !== "open") {
      return { client: entry.client, model: entry.model, name: entry.name };
    }
  }
  const first = _entries[0];
  return { client: first.client, model: first.model, name: first.name };
}

/** Сброс (для тестов). */
export function resetInstructorClients(): void {
  _entries = [];
}
