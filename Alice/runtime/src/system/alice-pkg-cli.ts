import { defineCommand } from "citty";
import { engineGet, enginePost } from "../../skills/_lib/engine-client.js";
import { die, extractJsonFlag, formatOutput, renderJson } from "./cli-bridge.js";

async function requireResult<T>(promise: Promise<unknown | null>, context: string): Promise<T> {
  const result = await promise;
  if (result == null) die("alice-pkg", `Engine API unavailable (${context})`);
  return result as T;
}

const search = defineCommand({
  meta: { name: "search", description: "Search available skills" },
  args: {
    query: {
      type: "string",
      description: "Search query (omit to list all)",
      default: "",
      valueHint: "keyword",
    },
  },
  async run({ args }) {
    const query = (args.query as string | undefined)?.trim() ?? "";
    const queryParam = query ? `?query=${encodeURIComponent(query)}` : "";
    const result = await requireResult<{
      query: string | null;
      skills: Array<{
        name: string;
        version: string;
        description: string;
        whenToUse: string;
        installed: boolean;
        source?: "local" | "remote";
      }>;
    }>(engineGet(`/skills/search${queryParam}`), "search");

    if (result.skills.length === 0) {
      console.log(query ? `No skills found matching "${query}".` : "No skills available.");
      return;
    }

    for (const s of result.skills) {
      const status = s.installed ? "[installed]" : "[available]";
      const source = s.source === "remote" ? " (remote)" : "";
      console.log(`${s.name} v${s.version} ${status}${source} — ${s.whenToUse}`);
    }
  },
});

const install = defineCommand({
  meta: { name: "install", description: "Install a skill by name" },
  args: {
    name: { type: "string", description: "Skill name", required: true, valueHint: "skill" },
  },
  async run({ args, rawArgs }) {
    const { json } = extractJsonFlag(rawArgs);
    const name = (args.name as string).trim();
    if (!name) die("alice-pkg", "skill name required");
    const result = await requireResult<{ ok?: boolean; error?: string }>(
      enginePost("/skills/install", { name }),
      "install",
    );
    if (result.error) die("alice-pkg", `install: ${result.error}`);
    console.log(json ? renderJson({ ok: true, name }) : formatOutput(`Installed ${name}.`));
  },
});

const remove = defineCommand({
  meta: { name: "remove", description: "Remove an installed skill" },
  args: {
    name: { type: "string", description: "Skill name", required: true, valueHint: "skill" },
  },
  async run({ args, rawArgs }) {
    const { json } = extractJsonFlag(rawArgs);
    const name = (args.name as string).trim();
    if (!name) die("alice-pkg", "skill name required");
    const result = await requireResult<{ ok?: boolean; error?: string }>(
      enginePost("/skills/remove", { name }),
      "remove",
    );
    if (result.error) die("alice-pkg", `remove: ${result.error}`);
    console.log(json ? renderJson({ ok: true, name }) : formatOutput(`Removed ${name}.`));
  },
});

const list = defineCommand({
  meta: { name: "list", description: "List installed skills" },
  async run() {
    const result = await requireResult<{
      skills: Array<{ name: string; version: string; hash: string; capabilities: string[] }>;
    }>(engineGet("/skills/list"), "list");

    if (result.skills.length === 0) {
      console.log("No skills installed.");
      return;
    }

    for (const s of result.skills) {
      const caps = s.capabilities.length > 0 ? ` [${s.capabilities.join(",")}]` : "";
      console.log(`${s.name}  ${s.version}  ${s.hash}${caps}`);
    }
  },
});

const info = defineCommand({
  meta: { name: "info", description: "Show detailed skill information" },
  args: {
    name: { type: "string", description: "Skill name", required: true, valueHint: "skill" },
  },
  async run({ args, rawArgs }) {
    const { json } = extractJsonFlag(rawArgs);
    const name = (args.name as string).trim();
    if (!name) die("alice-pkg", "skill name required");
    const result = await requireResult<{
      name: string;
      manifest: Record<string, unknown> | null;
      installed: Record<string, unknown> | null;
      error?: string;
    }>(engineGet(`/skills/info/${encodeURIComponent(name)}`), "info");
    if (result.error) die("alice-pkg", `info: ${result.error}`);
    if (json) {
      console.log(renderJson(result));
    } else {
      const lines: string[] = [`Skill: ${result.name}`];
      if (result.manifest) {
        lines.push("Manifest:");
        for (const [k, v] of Object.entries(result.manifest)) {
          if (v == null) continue;
          const text = typeof v === "object" ? JSON.stringify(v) : String(v);
          lines.push(`  ${k}: ${text}`);
        }
      }
      if (result.installed) {
        lines.push("Installed:");
        for (const [k, v] of Object.entries(result.installed)) {
          if (v == null) continue;
          const text = typeof v === "object" ? JSON.stringify(v) : String(v);
          lines.push(`  ${k}: ${text}`);
        }
      }
      console.log(lines.join("\n"));
    }
  },
});

const upgrade = defineCommand({
  meta: { name: "upgrade", description: "Upgrade a skill to latest version" },
  args: {
    name: { type: "string", description: "Skill name", required: true, valueHint: "skill" },
  },
  async run({ args, rawArgs }) {
    const { json } = extractJsonFlag(rawArgs);
    const name = (args.name as string).trim();
    if (!name) die("alice-pkg", "skill name required");
    const result = await requireResult<{ ok?: boolean; error?: string }>(
      enginePost("/skills/upgrade", { name }),
      "upgrade",
    );
    if (result.error) die("alice-pkg", `upgrade: ${result.error}`);
    console.log(json ? renderJson({ ok: true, name }) : formatOutput(`Upgraded ${name}.`));
  },
});

const rollback = defineCommand({
  meta: { name: "rollback", description: "Rollback a skill to previous version" },
  args: {
    name: { type: "string", description: "Skill name", required: true, valueHint: "skill" },
  },
  async run({ args, rawArgs }) {
    const { json } = extractJsonFlag(rawArgs);
    const name = (args.name as string).trim();
    if (!name) die("alice-pkg", "skill name required");
    const result = await requireResult<{ ok?: boolean; error?: string }>(
      enginePost("/skills/rollback", { name }),
      "rollback",
    );
    if (result.error) die("alice-pkg", `rollback: ${result.error}`);
    console.log(json ? renderJson({ ok: true, name }) : formatOutput(`Rolled back ${name}.`));
  },
});

const publish = defineCommand({
  meta: { name: "publish", description: "Publish a skill to the remote Store" },
  args: {
    dir: { type: "string", description: "Skill directory (default: .)", valueHint: "path" },
  },
  async run({ args, rawArgs }) {
    const { json } = extractJsonFlag(rawArgs);
    const dir = (args.dir as string | undefined)?.trim() || ".";
    const result = await requireResult<{ ok?: boolean; hash?: string; error?: string }>(
      enginePost("/skills/publish", { dir }),
      "publish",
    );
    if (result.error) die("alice-pkg", `publish: ${result.error}`);
    console.log(
      json
        ? renderJson({ ok: true, hash: result.hash })
        : formatOutput(`Published (hash: ${result.hash}).`),
    );
  },
});

export const alicePkgSubCommands = {
  search,
  install,
  remove,
  list,
  info,
  upgrade,
  rollback,
  publish,
} as const;

export const alicePkgCommand = defineCommand({
  meta: {
    name: "alice-pkg",
    description: "Alice OS package manager",
  },
  subCommands: alicePkgSubCommands,
});
