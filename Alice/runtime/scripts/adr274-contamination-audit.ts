#!/usr/bin/env tsx
/**
 * ADR-274 read-only contamination audit.
 *
 * This script checks whether residue / carry-over / global diary prompt surfaces
 * are leaking back into ordinary behavior evidence. It is diagnostic-only:
 * runtime code must not read this output as control input.
 *
 * Usage:
 *   cd runtime && pnpm exec tsx scripts/adr274-contamination-audit.ts
 *   cd runtime && pnpm exec tsx scripts/adr274-contamination-audit.ts --hours 4 --limit 20
 *   cd runtime && pnpm exec tsx scripts/adr274-contamination-audit.ts --json
 *
 * @see docs/adr/274-iaus-prototype-reset/README.md
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";

interface Args {
  dbPath: string;
  promptLogsDir: string;
  hours: number;
  limit: number;
  json: boolean;
}

interface EpisodeRow {
  id: string;
  tick_start: number;
  tick_end: number | null;
  target: string | null;
  outcome: string | null;
  residue: string | null;
  created_ms: number;
}

interface ResidueSummary {
  totalEpisodes: number;
  residueRows: number;
  targetlessResidueRows: number;
  llmFailedResidueRows: number;
  outageResidueRows: number;
  normalResidueRows: number;
  malformedResidueRows: number;
  examples: Array<{
    id: string;
    tickStart: number;
    target: string | null;
    createdAt: string;
    outageWindow: boolean;
    residue: unknown;
  }>;
}

interface PromptHit {
  file: string;
  mtime: string;
  carryOver: boolean;
  previously: boolean;
  recentThoughts: boolean;
}

interface AuditReport {
  scope: {
    dbPath: string;
    promptLogsDir: string;
    since: string;
    outageDatesJst: string[];
  };
  residue: ResidueSummary;
  promptSurface: {
    scanned: number;
    hits: PromptHit[];
  };
  verdict: {
    directRecentResidueDriver: "not_supported" | "supported" | "unknown";
    ordinaryPromptCarryOverLeak: "not_supported" | "supported" | "unknown";
    note: string;
  };
}

const OUTAGE_DATES_JST = new Set(["2026-05-12", "2026-05-13", "2026-05-14"]);

const args = parseArgs(process.argv.slice(2));
const sinceMs = Date.now() - args.hours * 60 * 60 * 1000;

const db = new Database(args.dbPath, { readonly: true });
const episodes = readEpisodes(db, sinceMs);
const residue = summarizeResidue(episodes, args.limit);
const promptSurface = scanPromptLogs(args.promptLogsDir, sinceMs, args.limit);

const report: AuditReport = {
  scope: {
    dbPath: args.dbPath,
    promptLogsDir: args.promptLogsDir,
    since: new Date(sinceMs).toISOString(),
    outageDatesJst: [...OUTAGE_DATES_JST],
  },
  residue,
  promptSurface,
  verdict: {
    directRecentResidueDriver:
      residue.residueRows === 0
        ? "not_supported"
        : residue.normalResidueRows > 0
          ? "supported"
          : "unknown",
    ordinaryPromptCarryOverLeak:
      promptSurface.hits.some((hit) => hit.carryOver || hit.previously) ? "supported" : "not_supported",
    note:
      "Prompt-log surface hits are diagnostic clues, not runtime semantic authority. DB residue JSON is the structured source for residue status.",
  },
};

if (args.json) {
  console.log(JSON.stringify(report, null, 2));
} else {
  renderText(report);
}

function readEpisodes(database: Database.Database, since: number): EpisodeRow[] {
  if (!tableExists(database, "episodes")) return [];
  return database
    .prepare(
      `SELECT id, tick_start, tick_end, target, outcome, residue, created_ms
       FROM episodes
       WHERE created_ms >= @since
       ORDER BY created_ms DESC
       LIMIT 500`,
    )
    .all({ since }) as EpisodeRow[];
}

function summarizeResidue(rows: readonly EpisodeRow[], limit: number): ResidueSummary {
  let residueRows = 0;
  let targetlessResidueRows = 0;
  let llmFailedResidueRows = 0;
  let outageResidueRows = 0;
  let normalResidueRows = 0;
  let malformedResidueRows = 0;
  const examples: ResidueSummary["examples"] = [];

  for (const row of rows) {
    if (!row.residue) continue;
    residueRows++;
    const outageWindow = isOutageDateJst(row.created_ms);
    if (outageWindow) outageResidueRows++;
    else normalResidueRows++;

    let parsed: unknown;
    try {
      parsed = JSON.parse(row.residue);
    } catch {
      malformedResidueRows++;
      parsed = row.residue;
    }

    if (isRecord(parsed)) {
      if (parsed.toward == null) targetlessResidueRows++;
      if (parsed.engagementOutcome === "llm_failed") llmFailedResidueRows++;
    }

    if (examples.length < limit) {
      examples.push({
        id: row.id,
        tickStart: row.tick_start,
        target: row.target,
        createdAt: new Date(row.created_ms).toISOString(),
        outageWindow,
        residue: parsed,
      });
    }
  }

  return {
    totalEpisodes: rows.length,
    residueRows,
    targetlessResidueRows,
    llmFailedResidueRows,
    outageResidueRows,
    normalResidueRows,
    malformedResidueRows,
    examples,
  };
}

function scanPromptLogs(dir: string, since: number, limit: number): AuditReport["promptSurface"] {
  if (!existsSync(dir)) return { scanned: 0, hits: [] };

  const hits: PromptHit[] = [];
  let scanned = 0;
  const files = readdirSync(dir)
    .filter((name) => name.endsWith(".md"))
    .map((name) => ({ name, path: join(dir, name), stat: statSync(join(dir, name)) }))
    .filter((entry) => entry.stat.mtimeMs >= since)
    .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);

  for (const file of files) {
    scanned++;
    const text = readFileSync(file.path, "utf8");
    const hit = {
      file: file.name,
      mtime: file.stat.mtime.toISOString(),
      carryOver: text.includes("Carry-over"),
      previously: text.includes("Previously:") || text.includes("Previously ("),
      recentThoughts: text.includes("你最近的想法"),
    };
    if ((hit.carryOver || hit.previously || hit.recentThoughts) && hits.length < limit) {
      hits.push(hit);
    }
  }

  return { scanned, hits };
}

function renderText(report: AuditReport): void {
  console.log("ADR-274 contamination audit");
  console.log(`scope since=${report.scope.since}`);
  console.log(`db=${report.scope.dbPath}`);
  console.log(`prompt_logs=${report.scope.promptLogsDir}`);
  console.log(`excluded_outage_dates_jst=${report.scope.outageDatesJst.join(",")}`);
  console.log("");

  console.log("residue:");
  console.log(`- total_episodes=${report.residue.totalEpisodes}`);
  console.log(`- residue_rows=${report.residue.residueRows}`);
  console.log(`- normal_residue_rows=${report.residue.normalResidueRows}`);
  console.log(`- outage_residue_rows=${report.residue.outageResidueRows}`);
  console.log(`- targetless_residue_rows=${report.residue.targetlessResidueRows}`);
  console.log(`- llm_failed_residue_rows=${report.residue.llmFailedResidueRows}`);
  console.log(`- malformed_residue_rows=${report.residue.malformedResidueRows}`);

  if (report.residue.examples.length > 0) {
    console.log("- examples:");
    for (const item of report.residue.examples) {
      console.log(
        `  - ${item.id} tick=${item.tickStart} target=${item.target ?? "null"} outage=${item.outageWindow} residue=${JSON.stringify(item.residue)}`,
      );
    }
  }

  console.log("");
  console.log("prompt_surface:");
  console.log(`- scanned=${report.promptSurface.scanned}`);
  console.log(`- hits=${report.promptSurface.hits.length}`);
  for (const hit of report.promptSurface.hits) {
    const kinds = [
      hit.carryOver ? "Carry-over" : null,
      hit.previously ? "Previously" : null,
      hit.recentThoughts ? "recent-thoughts" : null,
    ].filter(Boolean);
    console.log(`  - ${hit.file} ${kinds.join(",")} mtime=${hit.mtime}`);
  }

  console.log("");
  console.log("verdict:");
  console.log(`- direct_recent_residue_driver=${report.verdict.directRecentResidueDriver}`);
  console.log(`- ordinary_prompt_carry_over_leak=${report.verdict.ordinaryPromptCarryOverLeak}`);
  console.log(`- note=${report.verdict.note}`);
}

function tableExists(database: Database.Database, tableName: string): boolean {
  const row = database
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?")
    .get(tableName) as { name: string } | undefined;
  return Boolean(row);
}

function isOutageDateJst(ms: number): boolean {
  const date = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(ms));
  return OUTAGE_DATES_JST.has(date);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseArgs(argv: string[]): Args {
  const runtimeRoot = resolve(import.meta.dirname ?? ".", "..");
  const args: Args = {
    dbPath: resolve(runtimeRoot, "alice.db"),
    promptLogsDir: resolve(runtimeRoot, "prompt-logs"),
    hours: 4,
    limit: 10,
    json: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (!value) throw new Error(`Missing value for ${arg}`);
      return value;
    };
    if (arg === "--db") args.dbPath = resolve(next());
    else if (arg === "--prompt-logs") args.promptLogsDir = resolve(next());
    else if (arg === "--hours") args.hours = Number(next());
    else if (arg === "--limit") args.limit = Number(next());
    else if (arg === "--json") args.json = true;
    else if (arg === "--help" || arg === "-h") {
      console.log(
        "Usage: pnpm exec tsx scripts/adr274-contamination-audit.ts [--db alice.db] [--prompt-logs prompt-logs] [--hours 4] [--limit 10] [--json]",
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown arg: ${arg}`);
    }
  }

  if (!Number.isFinite(args.hours) || args.hours <= 0) throw new Error("--hours must be > 0");
  if (!Number.isFinite(args.limit) || args.limit < 0) throw new Error("--limit must be >= 0");
  return args;
}
