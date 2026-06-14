/**
 * Shared shell-native CLI bridge helpers.
 *
 * @see docs/adr/235-cli-human-readable-output.md
 */

import { request } from "node:http";

function getEngineUrl(): URL {
  const raw = process.env.ALICE_ENGINE_URL;
  if (raw) return new URL(raw);
  const port = process.env.ALICE_ENGINE_PORT;
  if (port) return new URL(`http://127.0.0.1:${port}`);
  throw new Error("ALICE_ENGINE_URL or ALICE_ENGINE_PORT not set");
}

export function parseCliValue(raw: string): unknown {
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (raw === "null") return null;

  const n = Number(raw);
  if (raw.trim() !== "" && Number.isFinite(n) && /^-?\d+(?:\.\d+)?$/.test(raw)) {
    return n;
  }

  if (
    (raw.startsWith("{") && raw.endsWith("}")) ||
    (raw.startsWith("[") && raw.endsWith("]")) ||
    (raw.startsWith('"') && raw.endsWith('"'))
  ) {
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }

  return raw;
}

export function parseKeyValueArgs(args: string[]): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  let i = 0;

  while (i < args.length) {
    const arg = args[i];

    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      if (eq > 2) {
        const key = arg.slice(2, eq);
        const value = arg.slice(eq + 1);
        body[key] = parseCliValue(value);
        i++;
        continue;
      }

      // Следующий аргумент — значение (кроме случаев, когда он начинается с --, что означает другой флаг)
      // Одиночный - перед числом (например -1009900000001) — допустимое значение (отрицательный Telegram ID)
      if (i + 1 < args.length && !args[i + 1].startsWith("--")) {
        body[arg.slice(2)] = parseCliValue(args[i + 1]);
        i += 2;
        continue;
      }

      // --flag без значения → true (булев флаг)
      body[arg.slice(2)] = true;
      i++;
      continue;
    }

    throw new Error(`unknown argument "${arg}". Use --key value format.`);
  }

  return body;
}

function collectContextVarsFromEnv(): Record<string, string> {
  const contextVars: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("ALICE_CTX_") || value == null || value === "") continue;
    contextVars[key.slice("ALICE_CTX_".length)] = value;
  }
  return contextVars;
}

function withContextVars(body: Record<string, unknown>): Record<string, unknown> {
  const contextVars = collectContextVarsFromEnv();
  if (Object.keys(contextVars).length === 0) return body;
  return { ...body, __contextVars: contextVars };
}

export async function enginePostJson(
  pathname: string,
  body: Record<string, unknown>,
): Promise<unknown> {
  const url = getEngineUrl();

  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: url.hostname,
        port: Number(url.port),
        path: pathname,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Alice-Skill": process.env.ALICE_SKILL ?? "alice-system",
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf-8");
          try {
            const data = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
            if ((res.statusCode ?? 500) >= 400) {
              reject(new Error(String(data.error ?? `request failed: ${res.statusCode}`)));
              return;
            }
            resolve(data);
          } catch (err) {
            reject(err);
          }
        });
      },
    );
    req.on("error", reject);
    req.write(JSON.stringify(withContextVars(body)));
    req.end();
  });
}

export function renderBridgeResult(result: unknown): string {
  if (result == null) return "null";
  if (typeof result === "string") return result;
  return JSON.stringify(result, null, 2);
}

// ── ADR-235: утилиты человекочитаемого рендеринга ──

/**
 * Извлекает флаг --json из rawArgs.
 * Возвращает отфильтрованные args (без --json) и признак режима JSON.
 */
export function extractJsonFlag(rawArgs: string[]): { json: boolean; args: string[] } {
  const has = rawArgs.includes("--json");
  return {
    json: has,
    args: has ? rawArgs.filter((a) => a !== "--json") : rawArgs,
  };
}

/** Обрезает длинный текст для предварительного просмотра в подтверждающих сообщениях. */
export function truncate(text: string, max = 60): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}...`;
}

/** Формирует строку успешного подтверждения. `✓ Sent: "hello"` */
export function renderConfirm(action: string, detail?: string): string {
  return detail ? `✓ ${action}: ${detail}` : `✓ ${action}`;
}

/** Формирует строку ошибки. `✗ Rate limited` */
export function renderError(msg: string): string {
  return `✗ ${msg}`;
}

/**
 * Форматирует пары ключ-значение в многострочный текст. Пропускает null/undefined значения.
 * ```
 * Channel: tech-discuss
 * Members: 42
 * ```
 */
export function renderKeyValue(pairs: Array<[string, unknown]>): string {
  return pairs
    .filter(([, v]) => v != null && v !== "")
    .map(([k, v]) => {
      const text = typeof v === "object" ? JSON.stringify(v) : String(v);
      return `${k}: ${text}`;
    })
    .join("\n");
}

/**
 * Формирует краткое представление объекта — приоритет у идентифицирующих полей title/name/id,
 * остальные поля рендерятся компактно, чтобы не тратить лишние токены на полный JSON.
 */
function summarizeObject(obj: Record<string, unknown>): string {
  // Приоритет идентифицирующих полей
  const label =
    obj.title ?? obj.name ?? obj.display_name ?? obj.displayName ?? obj.description ?? obj.id;
  if (label != null) {
    const id = obj.id != null && label !== obj.id ? `[#${obj.id}] ` : "";
    // Собираем не-идентифицирующие, не-null скалярные поля как дополнение
    const extras: string[] = [];
    for (const [k, v] of Object.entries(obj)) {
      if (["id", "title", "name", "display_name", "displayName", "description"].includes(k))
        continue;
      if (v == null || v === "") continue;
      if (typeof v === "object") continue; // пропускаем вложенные объекты
      extras.push(`${k}: ${String(v)}`);
    }
    const suffix = extras.length > 0 ? ` (${extras.slice(0, 3).join(", ")})` : "";
    return `${id}${String(label)}${suffix}`;
  }
  // Нет идентифицирующих полей — деградируем до компактного JSON
  return JSON.stringify(obj);
}

/**
 * Преобразует unknown-объект в человекочитаемый текст (ADR-235, универсальный fallback).
 * - null → `✓ Done`
 * - string → исходный текст
 * - array → нумерованный список (toString или JSON для каждого элемента)
 * - object → key: value многострочно
 */
export function renderHuman(result: unknown): string {
  if (result == null) return "✓ Done";
  if (typeof result === "string") return result;
  if (typeof result === "number" || typeof result === "boolean") return String(result);

  if (Array.isArray(result)) {
    if (result.length === 0) return "(empty)";
    return result
      .map((item, i) => {
        const text =
          typeof item === "string"
            ? item
            : typeof item === "object" && item !== null
              ? summarizeObject(item as Record<string, unknown>)
              : String(item);
        return `${i + 1}. ${text}`;
      })
      .join("\n");
  }

  // object → ключ-значение
  const entries = Object.entries(result as Record<string, unknown>);
  if (entries.length === 0) return "✓ Done";
  return renderKeyValue(entries);
}

/** Вывод в режиме JSON (сохраняет возможность отладки). */
export function renderJson(result: unknown): string {
  return JSON.stringify(result, null, 2);
}

/**
 * Форматирует выходное содержимое (упрощённая версия ADR-239).
 * Возвращает человекочитаемый текст. Режим JSON обрабатывается в makeRunner.
 */
export function formatOutput(humanText: string): string {
  return humanText;
}

/**
 * Единая функция выхода с ошибкой (ADR-235).
 * Выводит `✗ <msg>` в stderr, устанавливает exit code и завершает процесс.
 * @param cliName имя CLI (например "irc", "alice-pkg") — используется как префикс ошибки
 * @param msg сообщение об ошибке
 */
export function die(cliName: string, msg: string): never {
  process.stderr.write(`✗ ${cliName}: ${msg}\n`);
  process.exitCode = 1;
  // eslint-disable-next-line unicorn/no-process-exit
  process.exit(1);
}
