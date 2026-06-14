/**
 * Engine API маршруты — управление Skill-пакетами.
 *
 * alice-pkg CLI управляет установкой/удалением/поиском Skill через эти эндпоинты.
 * Все изменяющие операции (install/remove/upgrade/rollback) выполняются внутри процесса движка,
 * гарантируя атомарность горячей загрузки и обновления реестра.
 *
 * @see docs/adr/201-ai-native-os.md
 * @see docs/adr/202-engine-api.md
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { getEnginePort } from "../../core/shell-executor.js";
import { ManifestSchema, type SkillManifest } from "../../skills/manifest.js";
import {
  installSkill,
  listSkills,
  removeSkill,
  rollbackSkill,
  upgradeSkill,
} from "../../skills/pkg.js";
import { loadRegistry } from "../../skills/registry.js";
import {
  downloadAndExtractRemoteSkill,
  getRemoteSkillInfo,
  publishToRemoteStore,
  type RemoteSkillSummary,
  searchRemoteStore,
} from "../../skills/remote-store.js";
import { checkForUpgrades } from "../../skills/upgrade-checker.js";

/** Каталог источника skills по умолчанию (обнаружение локальных manifest). */
const SKILLS_ROOT = resolve(import.meta.dirname ?? ".", "../../../skills");

/**
 * Сканирует все manifest.yaml в директории skills/.
 * Пропускает внутренние директории (_lib, store, system-bin, man).
 */
function discoverManifests(): Array<{ manifest: SkillManifest; path: string }> {
  if (!existsSync(SKILLS_ROOT)) return [];

  const results: Array<{ manifest: SkillManifest; path: string }> = [];
  const skipDirs = new Set(["_lib", "store", "system-bin", "man"]);

  for (const entry of readdirSync(SKILLS_ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith("_") || skipDirs.has(entry.name)) continue;

    const manifestPath = resolve(SKILLS_ROOT, entry.name, "manifest.yaml");
    if (!existsSync(manifestPath)) continue;

    try {
      const raw = readFileSync(manifestPath, "utf-8");
      const manifest = ManifestSchema.parse(parseYaml(raw));
      results.push({ manifest, path: manifestPath });
    } catch {
      // Пропускаем невалидный manifest
    }
  }

  return results;
}

/** Нечёткое совпадение: query встречается в name/description/whenToUse. */
function matchesQuery(manifest: SkillManifest, query: string): boolean {
  const q = query.toLowerCase();
  const searchable = [
    manifest.name,
    manifest.description,
    ...manifest.actions.map((a) => a.whenToUse),
    ...manifest.actions.flatMap((a) => a.description),
  ];
  return searchable.some((s) => s.toLowerCase().includes(q));
}

/** Читает JSON body. */
function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let data = "";
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > 1024 * 1024) {
        req.destroy();
        reject(new Error("body too large"));
        return;
      }
      data += chunk.toString();
    });
    req.on("end", () => {
      try {
        resolve(data ? (JSON.parse(data) as Record<string, unknown>) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

/**
 * GET /skills/search?query=...
 *
 * Поиск в Skill Store. Сначала локально, затем удалённо (если настроено), результаты объединяются без дубликатов.
 */
export async function handleSkillSearch(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const query = url.searchParams.get("query")?.trim() || undefined;

  const allManifests = discoverManifests();
  const registry = loadRegistry();

  const filtered = query
    ? allManifests.filter(({ manifest }) => matchesQuery(manifest, query))
    : allManifests;

  const localNames = new Set<string>();
  const skills: Array<{
    name: string;
    version: string;
    description: string;
    whenToUse: string;
    installed: boolean;
    source: "local" | "remote";
  }> = filtered.map(({ manifest }) => {
    localNames.add(manifest.name);
    return {
      name: manifest.name,
      version: manifest.version,
      description: manifest.description,
      whenToUse: manifest.actions[0]?.whenToUse ?? manifest.description,
      installed: manifest.name in registry,
      source: "local" as const,
    };
  });

  // Объединяем удалённые результаты (если настроен ALICE_STORE_URL)
  const remoteResults = await searchRemoteStore(query);
  if (remoteResults) {
    for (const remote of remoteResults) {
      if (localNames.has(remote.name)) continue; // локальное имеет приоритет
      skills.push({
        name: remote.name,
        version: remote.version,
        description: remote.description,
        whenToUse: remote.whenToUse,
        installed: remote.name in registry,
        source: "remote" as const,
      });
    }
  }

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ query: query ?? null, skills }));
}

/**
 * GET /skills/list
 *
 * Перечисляет установленные Skill-ы.
 */
export function handleSkillList(_req: IncomingMessage, res: ServerResponse): void {
  const skills = listSkills();
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ skills }));
}

/**
 * GET /skills/info/:name
 *
 * Просматривает детали указанного Skill (manifest + статус установки).
 */
export async function handleSkillInfo(
  name: string,
  _req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const registry = loadRegistry();
  const installed = registry[name] ?? null;

  // Ищем локальный manifest
  const manifestPath = resolve(SKILLS_ROOT, name, "manifest.yaml");
  let manifest: SkillManifest | null = null;
  if (existsSync(manifestPath)) {
    try {
      manifest = ManifestSchema.parse(parseYaml(readFileSync(manifestPath, "utf-8")));
    } catch {
      // ignore
    }
  }

  // Если локально не найдено — запрашиваем удалённо
  let remoteInfo: RemoteSkillSummary | null = null;
  if (!manifest && !installed) {
    const remote = await getRemoteSkillInfo(name);
    if (remote) {
      remoteInfo = remote as unknown as RemoteSkillSummary;
    }
  }

  if (!manifest && !installed && !remoteInfo) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: `Skill "${name}" not found` }));
    return;
  }

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ name, manifest, installed, remote: remoteInfo }));
}

/**
 * POST /skills/install   { "name": "weather" }
 *
 * Сначала ищет локально skills/<name>/manifest.yaml, при отсутствии — пытается загрузить из удалённого Store.
 */
export async function handleSkillInstall(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readBody(req);
  const name = String(body.name ?? "").trim();

  if (!name) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "name is required" }));
    return;
  }

  let manifestPath = resolve(SKILLS_ROOT, name, "manifest.yaml");

  // Локально не найдено → пытаемся загрузить из удалённого Store
  if (!existsSync(manifestPath)) {
    try {
      manifestPath = await downloadAndExtractRemoteSkill(name, SKILLS_ROOT);
    } catch {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `Skill "${name}" not found (local or remote)` }));
      return;
    }
  }

  try {
    await installSkill(manifestPath, { enginePort: getEnginePort() });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, name }));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: msg }));
  }
}

/**
 * POST /skills/remove   { "name": "weather" }
 */
export async function handleSkillRemove(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readBody(req);
  const name = String(body.name ?? "").trim();

  if (!name) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "name is required" }));
    return;
  }

  try {
    await removeSkill(name);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, name }));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: msg }));
  }
}

/**
 * POST /skills/upgrade   { "name": "weather" }
 *
 * Сначала ищет локально skills/<name>/manifest.yaml, при отсутствии — пытается загрузить последнюю версию из удалённого Store.
 */
export async function handleSkillUpgrade(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readBody(req);
  const name = String(body.name ?? "").trim();

  if (!name) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "name is required" }));
    return;
  }

  let manifestPath = resolve(SKILLS_ROOT, name, "manifest.yaml");

  // Локально не найдено → пытаемся загрузить последнюю версию из удалённого Store
  if (!existsSync(manifestPath)) {
    try {
      manifestPath = await downloadAndExtractRemoteSkill(name, SKILLS_ROOT);
    } catch {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `Skill "${name}" not found (local or remote)` }));
      return;
    }
  }

  try {
    await upgradeSkill(name, manifestPath, { enginePort: getEnginePort() });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, name }));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: msg }));
  }
}

/**
 * POST /skills/rollback   { "name": "weather" }
 */
export async function handleSkillRollback(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const body = await readBody(req);
  const name = String(body.name ?? "").trim();

  if (!name) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "name is required" }));
    return;
  }

  try {
    await rollbackSkill(name, { enginePort: getEnginePort() });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, name }));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: msg }));
  }
}

/**
 * POST /skills/publish   { "dir": "./path/to/skill" }
 *
 * Упаковывает и публикует Skill в удалённый Store.
 * Требует переменные окружения ALICE_STORE_URL и ALICE_STORE_TOKEN.
 */
export async function handleSkillPublish(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readBody(req);
  const dir = String(body.dir ?? ".").trim();

  const manifestPath = resolve(dir, "manifest.yaml");
  if (!existsSync(manifestPath)) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: `No manifest.yaml found in "${dir}"` }));
    return;
  }

  try {
    const raw = readFileSync(manifestPath, "utf-8");
    const manifest = ManifestSchema.parse(parseYaml(raw));

    // Создаём временный tarball (используем execFileSync во избежание shell injection)
    const { execFileSync } = await import("node:child_process");
    const { tmpdir } = await import("node:os");
    const { mkdirSync, rmSync } = await import("node:fs");
    const tmpDir = resolve(tmpdir(), `alice-pkg-publish-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    const archivePath = resolve(tmpDir, `${manifest.name}.tar.gz`);
    execFileSync("tar", ["-czf", archivePath, "-C", resolve(dir), "."], { timeout: 30_000 });

    const hash = await publishToRemoteStore(
      archivePath,
      manifest as unknown as Record<string, unknown>,
    );

    rmSync(tmpDir, { recursive: true, force: true });

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, name: manifest.name, hash }));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: msg }));
  }
}

/**
 * GET /skills/upgrades
 *
 * Проверяет доступные обновления для установленных Skill-ов (результаты кэшируются на 1 час).
 */
export async function handleSkillUpgrades(
  _req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  try {
    const candidates = await checkForUpgrades();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ upgrades: candidates }));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: msg }));
  }
}
