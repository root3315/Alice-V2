/**
 * Episode Mod — LLM-видимый слой Cognitive Episode Graph (ADR-215).
 *
 * 1. query: episodeContext — просмотр контекста указанного episode
 * 2. query: recentEpisodes — сводка по последним N episode
 *
 * @see docs/adr/215-cognitive-episode-graph.md
 */
import { and, desc, eq, gt, isNotNull } from "drizzle-orm";
import { z } from "zod";

import { createMod } from "../core/mod-builder.js";
import { PromptBuilder } from "../core/prompt-style.js";
import type { ContributionItem } from "../core/types.js";
import { readModState, section } from "../core/types.js";
import { getDb } from "../db/connection.js";
import { episodes } from "../db/schema.js";
import { recordConsults } from "../engine/episode.js";
import { ensureChannelId, ensureContactId } from "../graph/constants.js";
import { safeDisplayName } from "../graph/display.js";

/** #11: безопасный JSON.parse — null/битый ряд → null (не роняем результат запроса). */
function safeJson(s: string | null | undefined): unknown {
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

const CONTINUITY_FRESHNESS_MS = 2 * 60 * 60 * 1000;
const CONTINUITY_TYPES = new Set(["unfinished", "unresolved_emotion", "interrupted"]);

interface EpisodeContinuityResidue {
  type?: string;
  toward?: string | null;
  reason?: string;
  createdMs?: number;
}

// biome-ignore lint/complexity/noBannedTypes: Mod без состояния
export const episodeMod = createMod<{}>("episode", {
  category: "mechanic",
  description: "Причинно-следственный граф когнитивных эпизодов — запросы episode",
  initialState: {},
})
  .query("episode_context", {
    params: z.object({
      id: z.string().describe("episode ID (e.g. episode:32311)"),
    }),
    description: "Посмотреть контекст указанного episode",
    affordance: {
      priority: "capability",
      category: "memory",
      whenToUse: "When you need to recall what happened in a past episode",
      whenNotToUse: "When the current conversation already gives you enough context",
    },
    returns: "{ id, target, voice, outcome, residue, causedBy, resolves, tickRange }",
    returnHint: "{id, target, outcome, residue, causedBy}",
    impl(ctx, args) {
      const row = getDb().select().from(episodes).where(eq(episodes.id, args.id)).get();
      if (!row) return { error: "Episode not found" };

      // записываем ребро consults — получаем ID текущего episode
      try {
        const current = getDb()
          .select({ id: episodes.id })
          .from(episodes)
          .orderBy(desc(episodes.tickStart))
          .limit(1)
          .get();
        if (current && current.id !== args.id) {
          recordConsults(current.id, args.id);
        }
      } catch {
        /* ignore */
      }

      return {
        id: row.id,
        target: row.target ? safeDisplayName(ctx.graph, row.target) : null,
        voice: row.voice,
        outcome: row.outcome,
        tickRange: [row.tickStart, row.tickEnd],
        residue: safeJson(row.residue),
        causedBy: safeJson(row.causedBy),
        consults: safeJson(row.consults),
        resolves: safeJson(row.resolves),
      };
    },
    format(result) {
      const r = result as Record<string, unknown>;
      if (r.error) return [String(r.error)];
      const parts = [`${r.id}: ${r.target ?? "?"} [${r.outcome}]`];
      if (r.voice) parts.push(`voice: ${r.voice}`);
      if (r.residue) {
        const res = r.residue as { type: string; toward?: string };
        parts.push(`residue: ${res.type}${res.toward ? ` → ${res.toward}` : ""}`);
      }
      if (r.causedBy) parts.push(`caused by: ${(r.causedBy as string[]).join(", ")}`);
      if (r.resolves) parts.push(`resolves: ${(r.resolves as string[]).join(", ")}`);
      return [parts.join(" | ")];
    },
  })
  .query("recent_episodes", {
    params: z.object({
      count: z.number().int().min(1).max(10).default(5).describe("number of episodes to return"),
    }),
    description: "Сводка по последним N episode",
    affordance: {
      priority: "capability",
      category: "memory",
      whenToUse: "When you want to review recent cognitive episodes",
      whenNotToUse: "For trivial interactions or when carry-over is sufficient",
    },
    returns: "Array<{ id, target, outcome, residue }>",
    returnHint: "[{id, target, outcome}]",
    impl(ctx, args) {
      const rows = getDb()
        .select()
        .from(episodes)
        .orderBy(desc(episodes.tickStart))
        .limit(args.count)
        .all();
      return rows.map((r) => ({
        id: r.id,
        target: r.target ? safeDisplayName(ctx.graph, r.target) : null,
        outcome: r.outcome,
        residue: safeJson(r.residue),
        causedBy: safeJson(r.causedBy),
      }));
    },
    format(result) {
      const rows = result as Array<Record<string, unknown>>;
      if (rows.length === 0) return ["(no recent episodes)"];
      return rows.map((r) => {
        const parts = [`${r.id}: ${r.target ?? "?"} [${r.outcome ?? "open"}]`];
        if (r.residue) {
          const res = r.residue as { type: string };
          parts.push(`(${res.type})`);
        }
        return parts.join(" ");
      });
    },
  })
  .contribute((ctx): ContributionItem[] => {
    const relState = readModState(ctx, "relationships");
    const currentTarget = relState?.targetNodeId ?? null;
    if (!currentTarget) return [];

    const carry = findTargetContinuity(currentTarget, ctx.nowMs);
    if (!carry) return [];

    const targetName = ctx.graph.has(currentTarget)
      ? safeDisplayName(ctx.graph, currentTarget)
      : currentTarget;

    const m = new PromptBuilder();
    m.line(
      carry.reason
        ? `Something still feels open with ${targetName}: ${carry.reason}`
        : `Something still feels open with ${targetName}.`,
    );

    return [section("conversation-continuity", m.build(), undefined, 18, 72)];
  })
  .build();

function findTargetContinuity(currentTarget: string, nowMs: number): { reason?: string } | null {
  const cutoff = nowMs - CONTINUITY_FRESHNESS_MS;
  const rows = getDb()
    .select({
      residue: episodes.residue,
      target: episodes.target,
      createdMs: episodes.createdMs,
    })
    .from(episodes)
    .where(and(isNotNull(episodes.residue), gt(episodes.createdMs, cutoff)))
    .orderBy(desc(episodes.createdMs))
    .limit(10)
    .all();

  for (const row of rows) {
    if (!row.residue) continue;
    const parsed = parseContinuityResidue(row.residue);
    if (!parsed) continue;
    if (!CONTINUITY_TYPES.has(parsed.type ?? "")) continue;
    if (!targetMatches(currentTarget, parsed.toward ?? row.target)) continue;
    return {
      reason:
        typeof parsed.reason === "string" && parsed.reason.trim()
          ? parsed.reason.trim()
          : undefined,
    };
  }

  return null;
}

function parseContinuityResidue(raw: string): EpisodeContinuityResidue | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as EpisodeContinuityResidue;
  } catch {
    return null;
  }
}

function targetMatches(currentTarget: string, candidate: string | null | undefined): boolean {
  if (!candidate) return false;
  if (candidate === currentTarget) return true;
  const currentChannel = ensureChannelId(currentTarget);
  const currentContact = ensureContactId(currentTarget);
  const candidateChannel = ensureChannelId(candidate);
  const candidateContact = ensureContactId(candidate);
  return (
    (!!currentChannel && currentChannel === candidateChannel) ||
    (!!currentContact && currentContact === candidateContact) ||
    (!!currentChannel && currentChannel === candidate) ||
    (!!currentContact && currentContact === candidate)
  );
}
