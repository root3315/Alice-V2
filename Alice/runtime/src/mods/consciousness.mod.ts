/**
 * Consciousness Mod — ADR-204 意识流浮现层。
 *
 * 无状态 Mod。contribute() 调用 surface() 拉取最近意识流事件，
 * 注入 Awareness section（situation 之后、strategy-hints 之前）。
 *
 * @see docs/adr/204-consciousness-stream/
 */
import { createMod } from "../core/mod-builder.js";
import { PromptBuilder } from "../core/prompt-style.js";
import type { ContributionItem } from "../core/types.js";
import { readModState, section } from "../core/types.js";
import { getDb } from "../db/connection.js";
import { surface } from "../engine/consciousness.js";
import { humanDuration } from "../utils/time-format.js";

// biome-ignore lint/complexity/noBannedTypes: 无状态 Mod
export const consciousnessMod = createMod<{}>("consciousness", {
  category: "mechanic",
  description: "Всплытие потока сознания — недавние следы выполнения внедряются в prompt",
  initialState: {},
})
  .contribute((ctx): ContributionItem[] => {
    // 收集 seed entity IDs（当前目标 + self）
    const seedEntityIds: string[] = [];
    const relState = readModState(ctx, "relationships");
    if (relState?.targetNodeId) seedEntityIds.push(relState.targetNodeId);

    let pointers: ReturnType<typeof surface>;
    try {
      pointers = surface(getDb(), ctx.nowMs, seedEntityIds, 5, ctx.graph);
    } catch {
      return [];
    }

    if (pointers.length === 0) return [];

    const pb = new PromptBuilder();
    for (const p of pointers) {
      const ago = humanDuration(p.ageMs / 1000);
      // ADR-210: raw graph ID → display name 替换
      const summary = p.summary.replace(/\b(channel|contact):[-\d]+/g, (match) => {
        if (ctx.graph.has(match)) {
          return String(
            ctx.graph.getDynamic(match, "display_name") ??
              ctx.graph.getDynamic(match, "title") ??
              "(somewhere)",
          );
        }
        return "(somewhere)";
      });
      pb.line(`- [${ago} ago] ${summary}`);
    }

    const lines = pb.build();
    if (lines.length === 0) return [];

    // order=6 → situation(5,95) 之后、strategy-hints(12,88) 之前
    return [section("awareness", lines, "Awareness", 6, 82)];
  })
  .build();
