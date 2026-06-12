#!/usr/bin/env tsx
/**
 * ADR-261 Wave 3: audit IAUS timing shadow diagnostics.
 *
 * 只读 candidate_trace，统计 rhythm timing shadow 如果启用会不会改变 winner。
 * 这个脚本不参与 runtime 决策。
 *
 * Usage:
 *   cd runtime && pnpm tsx scripts/timing-shadow-audit.ts
 *   cd runtime && pnpm tsx scripts/timing-shadow-audit.ts --limit 20
 *   cd runtime && pnpm tsx scripts/timing-shadow-audit.ts --recent-ticks 1000
 *
 * @see docs/adr/261-rhythm-profile-projection.md
 */

import { resolve } from "node:path";
import Database from "better-sqlite3";

interface Args {
  dbPath: string;
  limit: number;
  recentTicks: number | null;
}

interface CandidateTraceRow {
  tick: number;
  candidate_id: string;
  target_namespace: string;
  target_id: string | null;
  action_type: string;
  selected: number;
  net_value: number | null;
  normalized_considerations_json: string;
}

interface TimingShadow {
  utility: number;
  applied: boolean;
  reason: string;
  activeNowScore?: number;
  quietNowScore?: number;
  netValue?: number;
  shadowNetValue?: number;
}

interface ParsedCandidate {
  row: CandidateTraceRow;
  timing: TimingShadow;
}

interface AuditVariant {
  name: string;
  activeGain: number;
  quietPenalty: number;
  minUtility: number;
  maxUtility: number;
}

const AUDIT_VARIANTS: readonly AuditVariant[] = [
  {
    name: "current",
    activeGain: 0.15,
    quietPenalty: 0.45,
    minUtility: 0.3,
    maxUtility: 1.15,
  },
  {
    name: "half",
    activeGain: 0.075,
    quietPenalty: 0.225,
    minUtility: 0.65,
    maxUtility: 1.075,
  },
  {
    name: "gentle",
    activeGain: 0.03,
    quietPenalty: 0.09,
    minUtility: 0.85,
    maxUtility: 1.03,
  },
];

const args = parseArgs(process.argv.slice(2));
const db = new Database(args.dbPath, { readonly: true });
const maxTick = readMaxTick(db);
const minTick = args.recentTicks == null || maxTick == null ? null : maxTick - args.recentTicks;

const rows = readRows(db, minTick);

const parsed = rows
  .map((row) => ({ row, timing: readTimingShadow(row.normalized_considerations_json) }))
  .filter((item): item is ParsedCandidate => item.timing != null);

const reasons = new Map<string, number>();
let applied = 0;
let bypassViolations = 0;
for (const item of parsed) {
  const reason = item.timing.reason;
  reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
  if (item.timing.applied) applied++;
  if (
    reason === "bypass" &&
    (item.timing.utility !== 1 || !nearlyEqual(shadowScore(item), originalScore(item)))
  ) {
    bypassViolations++;
  }
}

const pools = new Map<number, ParsedCandidate[]>();
for (const item of parsed) {
  const pool = pools.get(item.row.tick) ?? [];
  pool.push(item);
  pools.set(item.row.tick, pool);
}

const currentAudit = auditPools(pools, storedShadowScore, args.limit);

console.log(
  `scope=${args.recentTicks == null ? "all" : `recent:${args.recentTicks}`} max_tick=${maxTick ?? "unknown"} min_tick=${minTick ?? "none"}`,
);
console.log(
  `rows=${parsed.length} ticks=${pools.size} analyzable_ticks=${currentAudit.analyzableTicks}`,
);
console.log(`applied=${applied} bypass_violations=${bypassViolations}`);
console.log(
  `shadow_changed_top=${currentAudit.changedTop} rate=${formatRate(currentAudit.changedTop, currentAudit.analyzableTicks)}`,
);
console.log(
  `reasons=${[...reasons.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([key, count]) => `${key}:${count}`)
    .join(", ")}`,
);

const eligibleByTarget = topEligibleTargets(parsed, args.limit);
if (eligibleByTarget.length > 0) {
  console.log(
    `eligible_targets=${eligibleByTarget.map(([target, count]) => `${target}:${count}`).join(", ")}`,
  );
}

console.log("variant_flip_rates:");
for (const variant of AUDIT_VARIANTS) {
  const audit = auditPools(
    pools,
    (item) => variantShadowScore(item, variant),
    variant.name === "current" ? 0 : args.limit,
  );
  console.log(
    `- ${variant.name}: changed=${audit.changedTop} rate=${formatRate(audit.changedTop, audit.analyzableTicks)} activeGain=${variant.activeGain} quietPenalty=${variant.quietPenalty} clamp=${variant.minUtility}-${variant.maxUtility}`,
  );
}

if (currentAudit.examples.length > 0) {
  console.log("examples:");
  for (const example of currentAudit.examples) console.log(`- ${example}`);
}

function readMaxTick(database: Database.Database): number | null {
  const row = database.prepare("SELECT max(tick) AS maxTick FROM candidate_trace").get() as
    | { maxTick: number | null }
    | undefined;
  return row?.maxTick ?? null;
}

function readRows(database: Database.Database, minTickValue: number | null): CandidateTraceRow[] {
  const whereTick = minTickValue == null ? "" : "AND tick >= @minTick";
  return database
    .prepare(
      `SELECT tick, candidate_id, target_namespace, target_id, action_type, selected,
              net_value, normalized_considerations_json
       FROM candidate_trace
       WHERE json_type(normalized_considerations_json, '$.__diagnostics.timingShadow') IS NOT NULL
       ${whereTick}
       ORDER BY tick ASC, candidate_rank ASC, id ASC`,
    )
    .all(minTickValue == null ? undefined : { minTick: minTickValue }) as CandidateTraceRow[];
}

function auditPools(
  inputPools: ReadonlyMap<number, readonly ParsedCandidate[]>,
  scoreShadow: (item: ParsedCandidate) => number | null,
  exampleLimit: number,
): { analyzableTicks: number; changedTop: number; examples: string[] } {
  let analyzableTicks = 0;
  let changedTop = 0;
  const examples: string[] = [];
  for (const [tick, pool] of inputPools) {
    const scored = pool.filter((item) => originalScore(item) != null);
    if (scored.length === 0) continue;
    analyzableTicks++;

    const original = maxBy(scored, (item) => originalScore(item) ?? Number.NEGATIVE_INFINITY);
    const shadow = maxBy(scored, (item) => scoreShadow(item) ?? Number.NEGATIVE_INFINITY);
    if (!original || !shadow) continue;
    if (original.row.candidate_id !== shadow.row.candidate_id) {
      changedTop++;
      if (examples.length < exampleLimit) {
        examples.push(`tick=${tick} original=${summarize(original)} shadow=${summarize(shadow)}`);
      }
    }
  }
  return { analyzableTicks, changedTop, examples };
}

function readTimingShadow(raw: string): TimingShadow | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return null;
    const diagnostics = parsed.__diagnostics;
    if (!isRecord(diagnostics)) return null;
    const timing = diagnostics.timingShadow;
    if (!isRecord(timing)) return null;
    if (typeof timing.utility !== "number" || !Number.isFinite(timing.utility)) return null;
    if (typeof timing.applied !== "boolean") return null;
    if (typeof timing.reason !== "string" || timing.reason.length === 0) return null;
    return {
      utility: timing.utility,
      applied: timing.applied,
      reason: timing.reason,
      activeNowScore: finiteOptional(timing.activeNowScore),
      quietNowScore: finiteOptional(timing.quietNowScore),
      netValue: finiteOptional(timing.netValue),
      shadowNetValue: finiteOptional(timing.shadowNetValue),
    };
  } catch {
    return null;
  }
}

function summarize(item: { row: CandidateTraceRow; timing: TimingShadow }): string {
  const target = item.row.target_id
    ? `${item.row.target_namespace}:${item.row.target_id}`
    : item.row.target_namespace;
  const score = originalScore(item)?.toFixed(4) ?? "null";
  const shadow = shadowScore(item)?.toFixed(4) ?? score;
  return `${item.row.action_type}/${target} V=${score} shadow=${shadow} reason=${item.timing.reason}`;
}

function originalScore(item: { row: CandidateTraceRow; timing: TimingShadow }): number | null {
  return item.timing.netValue ?? item.row.net_value;
}

function shadowScore(item: { row: CandidateTraceRow; timing: TimingShadow }): number | null {
  return item.timing.shadowNetValue ?? originalScore(item);
}

function storedShadowScore(item: ParsedCandidate): number | null {
  return shadowScore(item);
}

function variantShadowScore(item: ParsedCandidate, variant: AuditVariant): number | null {
  const original = originalScore(item);
  if (original == null) return null;
  if (!item.timing.applied || item.timing.reason !== "eligible") return original;
  const active = item.timing.activeNowScore;
  const quiet = item.timing.quietNowScore;
  if (active == null || quiet == null) return original;
  const utility = Math.max(
    variant.minUtility,
    Math.min(variant.maxUtility, 1.0 + variant.activeGain * active - variant.quietPenalty * quiet),
  );
  return original * utility;
}

function topEligibleTargets(
  items: readonly ParsedCandidate[],
  limit: number,
): Array<[target: string, count: number]> {
  const counts = new Map<string, number>();
  for (const item of items) {
    if (item.timing.reason !== "eligible") continue;
    const target = item.row.target_id
      ? `${item.row.target_namespace}:${item.row.target_id}`
      : item.row.target_namespace;
    counts.set(target, (counts.get(target) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
}

function formatRate(numerator: number, denominator: number): string {
  return denominator > 0 ? (numerator / denominator).toFixed(4) : "0.0000";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object";
}

function finiteOptional(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function maxBy<T>(items: readonly T[], score: (item: T) => number): T | null {
  let best: T | null = null;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (const item of items) {
    const value = score(item);
    if (value > bestScore) {
      best = item;
      bestScore = value;
    }
  }
  return best;
}

function nearlyEqual(a: number | null | undefined, b: number | null | undefined): boolean {
  if (a == null || b == null) return a == null && b == null;
  return Math.abs(a - b) < 1e-9;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    dbPath: resolve(import.meta.dirname ?? ".", "../alice.db"),
    limit: 10,
    recentTicks: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--db" && next) {
      args.dbPath = resolve(process.cwd(), next);
      i++;
    } else if (arg === "--limit" && next) {
      args.limit = Number(next);
      i++;
    } else if (arg === "--recent-ticks" && next) {
      args.recentTicks = Number(next);
      i++;
    }
  }
  return args;
}
