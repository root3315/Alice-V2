/**
 * Engine API — самочтение исходника Алисы (`irc self-source`).
 *
 * Алиса задумалась «я не открываю себя как файл». Это даёт ей READ-ONLY доступ к собственному коду:
 * ядро личности (SOUL.md), исходники (src/**.ts), доки (docs/**). Только чтение — никакой записи,
 * никакого самоизменения. Секреты/данные жёстко исключены (.env, *.db, сессии, токены, config.toml).
 *
 * POST /self/source { "path": "SOUL.md" }      → { path, content, truncated, bytes }
 * POST /self/source { "list": "src/mods" }      → { dir, entries: string[] }   (для навигации)
 * Любой запрет/ненайдено → 200 + { error } (чтобы CLI получил тело, а не throw).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

// routes → engine-api → src → runtime
const RUNTIME_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const MAX_CONTENT = 16000; // символов на файл — она читает по кусочкам, не дамп целиком

function readBody(req: IncomingMessage): Promise<{ path?: unknown; list?: unknown }> {
  return new Promise((res, rej) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (c: Buffer) => {
      total += c.length;
      if (total > 1_000_000) {
        rej(new Error("body too large"));
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf-8");
        res(raw.length > 0 ? JSON.parse(raw) : {});
      } catch (e) {
        rej(e);
      }
    });
    req.on("error", rej);
  });
}

/** БЕЗОПАСНОСТЬ: какие файлы Алисе можно читать. Read-only, без секретов/данных. Экспорт для тестов. */
export function isAllowedSelfPath(rel: string): boolean {
  const norm = rel.replace(/\\/g, "/").replace(/^\/+/, "").trim();
  if (!norm || norm.includes("..")) return false;
  // Жёсткий блок: секреты, данные, бинарники, git, конфиг с ключами, логи, песочница.
  if (
    /(^|\/)\.env|\.db($|-)|\.sqlite|\.session|\.token|secret|node_modules(\/|$)|(^|\/)\.git(\/|$)|config\.toml$|\.key$|\.pem$|prompt-logs(\/|$)|\.log$|tts-models(\/|$)/i.test(
      norm,
    )
  ) {
    return false;
  }
  // Разрешено: ядро личности, исходники TS, доки, README.
  if (norm === "SOUL.md" || /^SOUL\.[\w-]+\.md$/.test(norm)) return true;
  if (norm.startsWith("src/") && norm.endsWith(".ts")) return true;
  if (norm.startsWith("docs/")) return true;
  if (/^README/i.test(norm)) return true;
  return false;
}

/** Каталог можно листать для навигации (корень / src / docs). Экспорт для тестов. */
export function isListableDir(rel: string): boolean {
  const norm = rel.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "").trim();
  if (norm.includes("..")) return false;
  if (norm === "" || norm === ".") return true;
  if (norm === "src" || norm.startsWith("src/")) return true;
  if (norm === "docs" || norm.startsWith("docs/")) return true;
  return false;
}

function within(rel: string): boolean {
  const r = resolve(RUNTIME_ROOT, rel);
  return r === RUNTIME_ROOT || r.startsWith(RUNTIME_ROOT + sep);
}

function ok(res: ServerResponse, payload: unknown): void {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

export async function handleSelfSource(
  method: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (method !== "POST") {
    res.writeHead(405, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "POST only" }));
    return;
  }
  let body: { path?: unknown; list?: unknown };
  try {
    body = await readBody(req);
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "bad body" }));
    return;
  }

  const listArg =
    typeof body.list === "string" ? body.list : body.list === true ? "" : null;
  const pathArg = typeof body.path === "string" ? body.path : null;

  // ── LIST (навигация по каталогу) ──
  if (listArg !== null) {
    const relDir = listArg.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
    if (!isListableDir(relDir) || !within(relDir)) {
      ok(res, { error: "этот каталог нельзя листать (доступны только корень, src/**, docs/**)" });
      return;
    }
    try {
      const abs = resolve(RUNTIME_ROOT, relDir);
      const entries = readdirSync(abs, { withFileTypes: true })
        .filter((e) => {
          const childRel = (relDir ? `${relDir}/` : "") + e.name;
          return e.isDirectory() ? isListableDir(childRel) : isAllowedSelfPath(childRel);
        })
        .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
        .sort();
      ok(res, { dir: relDir || ".", entries });
    } catch {
      ok(res, { error: "каталог не найден" });
    }
    return;
  }

  // ── READ (чтение файла) ──
  if (!pathArg) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: 'body must be { "path": string } or { "list": string }' }));
    return;
  }
  const rel = pathArg.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!isAllowedSelfPath(rel) || !within(rel)) {
    ok(res, {
      error:
        "этот файл читать нельзя — секреты и данные закрыты. Доступны: SOUL.md, src/**.ts, docs/**",
    });
    return;
  }
  try {
    const abs = resolve(RUNTIME_ROOT, rel);
    const st = statSync(abs);
    if (!st.isFile()) {
      ok(res, { error: "это каталог, а не файл — используй list" });
      return;
    }
    const full = readFileSync(abs, "utf-8");
    const truncated = full.length > MAX_CONTENT;
    ok(res, {
      path: rel,
      content: truncated ? full.slice(0, MAX_CONTENT) : full,
      truncated,
      bytes: st.size,
    });
  } catch {
    ok(res, { error: "файл не найден" });
  }
}
