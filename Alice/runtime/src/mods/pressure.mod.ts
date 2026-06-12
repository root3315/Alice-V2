/**
 * Pressure Mod — 六维压力场感知。
 *
 * 将 pressure/ 目录的计算结果接入 Mod 系统：
 * - UPDATE_PRESSURES 指令：接收 evolve.ts 已计算的压力结果（避免双重计算）
 * - contribute：通过 buildSituationBriefing 注入 per-entity 自然语言情境描述
 * - query：暴露 pressureState 供其他 mod 读取
 *
 * 这是 Alice 的核心 mod——压力场是声部竞争的信号源，
 * 没有它，整个行为系统没有输入。
 *
 * 设计选择：压力计算仍在 evolve.ts 中直接调用 computeAllPressures()
 * （因为声部竞争需要即时结果），计算完成后通过 dispatch 注入本 mod。
 * 这样避免了 onTickEnd 中的重复计算，同时让 storyteller
 * 能通过 mod 系统访问压力数据。
 *
 * @see paper-five-dim/ §3（六维压力场）+ §3.4（Laplacian 传播）
 * @see paper-five-dim/ Definition 7.1（Context Assembly: Contribute → Rank → Trim → Inject）
 * @see paper-five-dim/ Axiom 2（Prefill as Fact, Not Instruction）
 */

import { z } from "zod";
import { createMod } from "../core/mod-builder.js";
import { PromptBuilder } from "../core/prompt-style.js";
import type { ContributionItem } from "../core/types.js";
import { readModState, section } from "../core/types.js";
import { ensureChannelId } from "../graph/constants.js";
import type { AllPressures } from "../pressure/aggregate.js";
import { buildSituationBriefing } from "../pressure/situation-lines.js";

// -- Mod 状态 -----------------------------------------------------------------

interface PressureState {
  /** 最近一次 tick 的完整压力计算结果。 */
  latest: AllPressures | null;
  /** API 历史（最近 20 个 tick），用于节奏模式检测。 */
  apiHistory: number[];
  /** 最近一次 tick 的焦点实体集合（由 evolve 管线注入）。 */
  focalEntities: string[];
}

// -- Mod 定义 -----------------------------------------------------------------

export const pressureMod = createMod<PressureState>("pressure", {
  category: "core",
  description: "Восприятие шестимерного поля давления (P1-P6 + Laplacian-распространение + нормализация API)",
  initialState: {
    latest: null,
    apiHistory: [],
    focalEntities: [],
  },
})
  /**
   * 接收 evolve.ts 计算的压力结果。
   * evolve.ts 在 computeAllPressures() 后立即 dispatch 此指令，
   * 避免 onTickEnd 中的重复计算。
   */
  .instruction("UPDATE_PRESSURES", {
    params: z.object({
      pressures: z.record(z.unknown()).describe("Результат расчёта AllPressures"),
      focalEntities: z.array(z.string()).optional().describe("Текущий набор фокусных сущностей"),
    }),
    description: "Обновить состояние давления текущего tick (внедряется конвейером evolve)",
    impl(ctx, args) {
      ctx.state.latest = args.pressures as unknown as AllPressures;
      ctx.state.focalEntities = (args.focalEntities as string[]) ?? [];
      // 追加 API 历史（滑动窗口，最多 20 条）
      ctx.state.apiHistory.push(ctx.state.latest.API);
      if (ctx.state.apiHistory.length > 20) ctx.state.apiHistory.shift();
      return true;
    },
  })
  /** 获取最近一次 tick 的完整压力状态。 */
  .query("pressure", {
    params: z.object({}),
    description: "Получить текущее шестимерное состояние давления (P1-P6 + API + детализация вкладов)",
    returns:
      "{ P1: number; P2: number; P3: number; P4: number; P5: number; P6: number; API: number; contributions: Record<string, Record<string, number>> } | null",
    impl(ctx) {
      return ctx.state.latest;
    },
  })
  .contribute((ctx): ContributionItem[] => {
    const items: ContributionItem[] = [];

    // ADR-64 III-3: 墙钟时间始终注入（不依赖压力数据）
    // @see docs/adr/64-runtime-theory-alignment-audit.md
    // 使用 ctx.nowMs（由 dispatcher.startTick 设置），eval 环境下为固定时间戳。
    const now = new Date(ctx.nowMs);
    const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    const timeStr = now.toLocaleTimeString("en-US", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    const dateStr = `${dayNames[now.getDay()]} ${now.toLocaleDateString("en-US", { month: "long", day: "numeric" })}`;
    items.push(
      section("wall-clock", [PromptBuilder.of(`It's ${dateStr}, ${timeStr}.`)], undefined, 4, 98),
    );

    // ADR-83 D6: 无压力数据时提供基本情境（防止空 user prompt）
    if (!ctx.state.latest) {
      items.push(
        section(
          "situation",
          [PromptBuilder.of("Nothing particular stands out right now.")],
          "What's going on",
          5,
          90,
        ),
      );
      return items;
    }
    const p = ctx.state.latest;

    // Per-entity 自然语言情境描述（D2a → D2b 管线）。
    // 替代旧的 Factor/Trend/Signal 三层抽象——直接生成 LLM 可读的社交情境。
    // 数字仅用于排序和强度分级，不出现在输出中。
    // @see paper-five-dim/ Remark 7: Rendering Level 2 (Guided Signal)
    // ADR-187 D1: 读取当前 action target（由 SET_CONTACT_TARGET 设置），传入 buildSituationBriefing
    // 使非当前 target 的 entity 标注 "(you're not in this chat right now)"
    const relState = readModState(ctx, "relationships");
    const actionTarget = relState?.targetNodeId ? ensureChannelId(relState.targetNodeId) : null;
    const rawLines = buildSituationBriefing(p, ctx.graph, ctx.tick, ctx.nowMs, {
      focalEntities: ctx.state.focalEntities.length > 0 ? ctx.state.focalEntities : undefined,
      beliefs: ctx.graph.beliefs,
      actionTarget: actionTarget ?? undefined,
    });
    const lines = rawLines.map(PromptBuilder.of);
    // order=5 确保情境描述在所有 section 最前面（threads=30, memory=50 之前）
    items.push(section("situation", lines, "What's going on", 5, 95));

    // ── 历史模式检测（节奏历史窗口）──────────────────────────────────
    // 不改 TranslationEntry 类型，直接在 contribute() 中根据 apiHistory 注入额外贡献项。
    // 参考叙事引擎 director.mod 的 ntiHistory 模式检测。
    const history = ctx.state.apiHistory;
    if (history.length >= 5) {
      const recent5 = history.slice(-5);
      const avg5 = recent5.reduce((a, b) => a + b, 0) / recent5.length;

      // 持续高压（连续 5 tick API > 3.0）
      if (recent5.every((v) => v > 3.0)) {
        items.push(
          section(
            "rhythm-sustained-high",
            [PromptBuilder.of("It's been non-stop busy for a while now.")],
            "Rhythm",
            7,
            85,
          ),
        );
      }

      // 突然跌落（最近值比 5-tick 均值低 50%+）
      const latest = history[history.length - 1];
      if (avg5 > 1.0 && latest < avg5 * 0.5) {
        items.push(
          section(
            "rhythm-sudden-drop",
            [PromptBuilder.of("Sudden pressure drop — conversation may have ended or user left.")],
            "Rhythm",
            7,
            85,
          ),
        );
      }

      // 低迷恒温（连续 10+ tick API < 0.5）→ 主动触发好奇心
      if (history.length >= 10) {
        const recent10 = history.slice(-10);
        if (recent10.every((v) => v < 0.5)) {
          items.push(
            section(
              "rhythm-extended-calm",
              [PromptBuilder.of("It's been quiet for a while — nothing much happening.")],
              "Rhythm",
              7,
              85,
            ),
          );
        }
      }
    }

    return items;
  })
  .build();
