/**
 * Pressure Mod — восприятие шестимерного поля давления.
 *
 * Подключает результаты вычислений из каталога pressure/ к системе Mod:
 * - Инструкция UPDATE_PRESSURES: принимает готовые результаты давления от evolve.ts (во избежание двойного вычисления)
 * - contribute: внедряет естественно-языковое описание ситуации per-entity через buildSituationBriefing
 * - query: открывает pressureState для чтения другими mod
 *
 * Это ключевой mod Alice — поле давления является источником сигналов для конкуренции голосов;
 * без него всей системе поведения нечем питаться.
 *
 * Проектное решение: вычисление давления по-прежнему вызывает computeAllPressures() напрямую в evolve.ts
 * (потому что конкуренция голосов требует немедленного результата), после чего результат
 * инжектируется в этот mod через dispatch.
 * Это устраняет повторное вычисление в onTickEnd и позволяет storyteller
 * обращаться к данным давления через систему mod.
 *
 * @see paper-five-dim/ §3 (шестимерное поле давления) + §3.4 (распространение через Laplacian)
 * @see paper-five-dim/ Definition 7.1 (Context Assembly: Contribute → Rank → Trim → Inject)
 * @see paper-five-dim/ Axiom 2 (Prefill as Fact, Not Instruction)
 */

import { z } from "zod";
import { createMod } from "../core/mod-builder.js";
import { PromptBuilder } from "../core/prompt-style.js";
import type { ContributionItem } from "../core/types.js";
import { readModState, section } from "../core/types.js";
import { ensureChannelId } from "../graph/constants.js";
import type { AllPressures } from "../pressure/aggregate.js";
import { buildSituationBriefing } from "../pressure/situation-lines.js";

// -- Состояние Mod ------------------------------------------------------------

interface PressureState {
  /** Полный результат расчёта давления за последний tick. */
  latest: AllPressures | null;
  /** История API (последние 20 тиков) для обнаружения ритмических паттернов. */
  apiHistory: number[];
  /** Набор фокусных сущностей последнего тика (инжектируется конвейером evolve). */
  focalEntities: string[];
}

// -- Определение Mod ----------------------------------------------------------

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
   * Принять результаты расчёта давления от evolve.ts.
   * evolve.ts диспатчит эту инструкцию сразу после computeAllPressures(),
   * чтобы избежать повторного расчёта в onTickEnd.
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
      // Добавить в историю API (скользящее окно, не более 20 записей)
      ctx.state.apiHistory.push(ctx.state.latest.API);
      if (ctx.state.apiHistory.length > 20) ctx.state.apiHistory.shift();
      return true;
    },
  })
  /** Получить полное состояние давления за последний tick. */
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

    // ADR-64 III-3: Время настенных часов инжектируется всегда (не зависит от данных давления)
    // @see docs/adr/64-runtime-theory-alignment-audit.md
    // Используется ctx.nowMs (устанавливается dispatcher.startTick), в eval-окружении — фиксированная метка времени.
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

    // ADR-83 D6: При отсутствии данных давления предоставить базовый контекст (защита от пустого user prompt)
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

    // Описание ситуации на естественном языке per-entity (конвейер D2a → D2b).
    // Заменяет старую трёхуровневую абстракцию Factor/Trend/Signal — напрямую генерирует социальный контекст, читаемый LLM.
    // Числа используются только для сортировки и градации интенсивности, в вывод не попадают.
    // @see paper-five-dim/ Remark 7: Rendering Level 2 (Guided Signal)
    // ADR-187 D1: Читать текущий action target (устанавливается SET_CONTACT_TARGET), передавать в buildSituationBriefing
    // чтобы сущности, не являющиеся текущим target, помечались "(you're not in this chat right now)"
    const relState = readModState(ctx, "relationships");
    const actionTarget = relState?.targetNodeId ? ensureChannelId(relState.targetNodeId) : null;
    const rawLines = buildSituationBriefing(p, ctx.graph, ctx.tick, ctx.nowMs, {
      focalEntities: ctx.state.focalEntities.length > 0 ? ctx.state.focalEntities : undefined,
      beliefs: ctx.graph.beliefs,
      actionTarget: actionTarget ?? undefined,
    });
    const lines = rawLines.map(PromptBuilder.of);
    // order=5 гарантирует, что описание ситуации будет первым среди всех section (перед threads=30, memory=50)
    items.push(section("situation", lines, "What's going on", 5, 95));

    // ── Обнаружение исторических паттернов (окно истории ритма) ──────────────────────────────────
    // Не меняем тип TranslationEntry — дополнительные contribution items инжектируются
    // прямо в contribute() на основе apiHistory.
    // Аналог обнаружения паттернов ntiHistory в director.mod нарративного движка.
    const history = ctx.state.apiHistory;
    if (history.length >= 5) {
      const recent5 = history.slice(-5);
      const avg5 = recent5.reduce((a, b) => a + b, 0) / recent5.length;

      // Устойчивая высокая нагрузка (5 тиков подряд API > 3.0)
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

      // Резкое падение (последнее значение ниже среднего за 5 тиков на 50%+)
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

      // Устойчивое затишье (10+ тиков подряд API < 0.5) → активировать любопытство
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
