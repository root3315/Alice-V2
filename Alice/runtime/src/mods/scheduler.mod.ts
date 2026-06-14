/**
 * Scheduler Mod — система запланированных задач (ADR-51 Wave 3 #16).
 *
 * Обязанности:
 * - Поддержка двух типов задач: at (одноразовое) и every (периодическое)
 * - Персистентность через SQLite (не теряется при перезапуске)
 * - Инжекция предстоящих задач в LLM-контекст через contribute
 * - Проверка и пометка просроченных задач в onTickEnd
 *
 * Ключевые решения:
 * - Не выполняет Telegram-действия напрямую — инжектирует через contribute, позволяя LLM решать, как реагировать
 * - Алиса — компаньон, а не cron job
 * - Лимит 50 активных задач (защита от бесконечного создания LLM)
 * - Всё время в мс настенных часов, без предположений об интервале тика
 */
import { and, eq, lte } from "drizzle-orm";
import { z } from "zod";
import { createMod } from "../core/mod-builder.js";
import { PromptBuilder } from "../core/prompt-style.js";
import type { ContributionItem } from "../core/types.js";
import { section } from "../core/types.js";
import { getDb } from "../db/connection.js";
import { scheduledTasks } from "../db/schema.js";
import { humanDuration } from "../utils/time-format.js";

// -- Константы ---------------------------------------------------------------

/** Максимальное число активных задач. */
const MAX_ACTIVE_TASKS = 50;
/** Окно предупреждения о предстоящих задачах (мс). */
const UPCOMING_WINDOW_MS = 3 * 60_000;

// -- Состояние Mod -----------------------------------------------------------

interface SchedulerState {
  /** Задачи, сработавшие недавно (показываются в contribute несколько тиков — против потери). */
  firedThisTick: Array<{
    id: number;
    action: string;
    target: string | null;
    /** Сколько раз уже показана в contribute (#4: дроп после нескольких показов, а не одного). */
    shown?: number;
    /** Когда сработала (мс) — для TTL-бэкстопа. */
    firedMs?: number;
  }>;
}

// -- Определение Mod ---------------------------------------------------------

export const schedulerMod = createMod<SchedulerState>("scheduler", {
  category: "mechanic",
  description: "Система запланированных задач — срабатывание по at (одноразово) / every (периодически)",
  topics: ["schedule"],
  initialState: { firedThisTick: [] },
})
  /**
   * Создать запланированную задачу.
   * type="at": срабатывает один раз через delay минут
   * type="every": срабатывает каждые interval минут (впервые — через interval)
   */
  .instruction("schedule_task", {
    params: z.object({
      type: z.enum(["at", "every"]).describe('"at" или "every"'),
      delay: z.number().positive().optional().describe("at: how many minutes from now"),
      interval: z.number().positive().optional().describe("every: interval in minutes"),
      action: z.string().min(1).max(500).describe("описание действия при срабатывании"),
      target: z.string().optional().describe("целевой chatId (опционально)"),
      payload: z.string().optional().describe("дополнительные данные в JSON (опционально)"),
    }),
    description: "Создать запланированную задачу (at=одноразовая / every=периодическая). delay/interval — в минутах",
    examples: ['schedule_task({ type: "at", delay: 5, action: "remind about meeting" })'],
    affordance: {
      whenToUse: "Create a timed reminder or recurring task",
      whenNotToUse: "For immediate actions that don't need scheduling",
      priority: "capability",
      category: "scheduler",
    },
    impl(ctx, args) {
      const db = getDb();
      const type = String(args.type);
      const action = String(args.action);
      const target = args.target != null ? String(args.target) : null;
      const payload = args.payload != null ? String(args.payload) : null;

      // Проверить лимит активных задач
      const activeCount = db
        .select({ id: scheduledTasks.id })
        .from(scheduledTasks)
        .where(eq(scheduledTasks.active, true))
        .all().length;

      if (activeCount >= MAX_ACTIVE_TASKS) {
        return {
          success: false,
          error: `active task limit reached (${MAX_ACTIVE_TASKS})`,
        };
      }

      let targetMs: number;
      let intervalMs: number | null = null;

      if (type === "at") {
        const delay = Number(args.delay);
        if (!delay || delay <= 0) {
          return { success: false, error: "at type requires positive delay" };
        }
        targetMs = ctx.nowMs + delay * 60_000;
      } else {
        const iv = Number(args.interval);
        if (!iv || iv <= 0) {
          return { success: false, error: "every type requires positive interval" };
        }
        intervalMs = iv * 60_000;
        targetMs = ctx.nowMs + intervalMs;
      }

      const result = db
        .insert(scheduledTasks)
        .values({
          type,
          targetMs,
          intervalMs,
          action,
          target,
          payload,
          active: true,
        })
        .returning({ id: scheduledTasks.id })
        .get();

      return { success: true, taskId: result.id };
    },
  })
  /** Отменить указанную задачу. */
  .instruction("cancel_task", {
    params: z.object({
      taskId: z.number().int().positive().describe("ID задачи"),
    }),
    description: "Отменить указанную запланированную задачу",
    affordance: {
      whenToUse: "Cancel a scheduled task that's no longer needed",
      whenNotToUse: "When the task should still trigger",
      priority: "capability",
      category: "scheduler",
    },
    impl(_ctx, args) {
      const db = getDb();
      const taskId = Number(args.taskId);

      const task = db
        .select()
        .from(scheduledTasks)
        .where(and(eq(scheduledTasks.id, taskId), eq(scheduledTasks.active, true)))
        .get();

      if (!task) {
        return { success: false, error: `task ${taskId} not found or already inactive` };
      }

      db.update(scheduledTasks).set({ active: false }).where(eq(scheduledTasks.id, taskId)).run();

      return { success: true, cancelledTaskId: taskId };
    },
  })
  /** Получить все активные задачи. */
  .query("reminders", {
    params: z.object({}),
    description: "Вернуть все активные запланированные задачи",
    affordance: {
      whenToUse: "List all active scheduled tasks and reminders",
      whenNotToUse: "When you don't need to check scheduled tasks",
      priority: "core",
    },
    returns:
      "Array<{ id: number; type: string; targetMs: number; action: string; target: string | null }>",
    returnHint: "[{id, type, action, target, remaining}]",
    impl(ctx) {
      const db = getDb();
      const rows = db.select().from(scheduledTasks).where(eq(scheduledTasks.active, true)).all();
      return rows.map((r) => ({
        ...r,
        _currentMs: ctx.nowMs,
        // Предварительный разбор display_name — format() не имеет доступа к graph
        _targetName:
          r.target && ctx.graph.has(r.target)
            ? String(ctx.graph.getDynamic(r.target, "display_name") ?? r.target)
            : r.target,
      }));
    },
    format(result) {
      const rows = result as Array<Record<string, unknown>>;
      if (rows.length === 0) return ["(no reminders)"];
      return rows.map((r) => {
        const typeTag =
          r.type === "every"
            ? `repeats every ~${humanDuration(Number(r.intervalMs ?? 0) / 1000)}`
            : "once";
        const target = r._targetName ? ` → ${r._targetName}` : "";
        const currentMs = Number(r._currentMs ?? 0);
        const remaining =
          r.type === "at" && r.targetMs != null
            ? `, in ~${humanDuration(Math.max(0, (Number(r.targetMs) - currentMs) / 1000))}`
            : "";
        return `#${r.id} [${typeTag}] "${r.action}"${target}${remaining}`;
      });
    },
  })
  .onTickStart((_ctx) => {
    // firedThisTick здесь не очищается — нужно сохранить до чтения contribute следующего тика
    // Логика очистки перенесена в начало onTickEnd (до обработки просроченных задач)
  })
  .onTickEnd((ctx) => {
    // Жизненный цикл: onTickStart → contribute → LLM → onTickEnd. contribute видит firedThisTick,
    // записанный на предыдущем onTickEnd. #4: НЕ стираем сразу (раньше — один показ, и если тот тик
    // был «тихим»/упал LLM, напоминание терялось навсегда: at-задача уже деактивирована). Считаем
    // показы (этот тик их уже показал) и дропаем после FIRED_MAX_SHOWS или по TTL.
    const now = ctx.nowMs;
    const FIRED_MAX_SHOWS = 2; // переживает один «плохой» тик; больше — риск повторного напоминания
    const FIRED_TTL_MS = 10 * 60_000;
    ctx.state.firedThisTick = ctx.state.firedThisTick
      .map((t) => ({ ...t, shown: (t.shown ?? 0) + 1 }))
      .filter((t) => (t.shown ?? 0) < FIRED_MAX_SHOWS && now - (t.firedMs ?? now) < FIRED_TTL_MS);

    const db = getDb();

    // Найти все просроченные активные задачи (targetMs <= nowMs)
    const dueTasks = db
      .select()
      .from(scheduledTasks)
      .where(and(eq(scheduledTasks.active, true), lte(scheduledTasks.targetMs, ctx.nowMs)))
      .all();

    for (const task of dueTasks) {
      if (ctx.state.firedThisTick.some((t) => t.id === task.id)) continue; // уже показывается — не дублируем
      // Записать срабатывание (shown=0 → покажется в contribute следующего тика)
      ctx.state.firedThisTick.push({
        id: task.id,
        action: task.action,
        target: task.target,
        shown: 0,
        firedMs: now,
      });

      if (task.type === "at") {
        // Одноразовая задача: деактивировать после срабатывания
        db.update(scheduledTasks)
          .set({ active: false })
          .where(eq(scheduledTasks.id, task.id))
          .run();
      } else if (task.type === "every" && task.intervalMs) {
        // Периодическая задача: обновить время следующего срабатывания
        db.update(scheduledTasks)
          .set({ targetMs: ctx.nowMs + task.intervalMs })
          .where(eq(scheduledTasks.id, task.id))
          .run();
      }
    }
  })
  .contribute((ctx): ContributionItem[] => {
    const items: ContributionItem[] = [];
    const db = getDb();

    // 1. Показать задачи, сработавшие в этом тике
    if (ctx.state.firedThisTick.length > 0) {
      const firedLines = ctx.state.firedThisTick.map((t) => {
        const targetLabel =
          t.target && ctx.graph.has(t.target)
            ? String(ctx.graph.getDynamic(t.target, "display_name") ?? t.target)
            : t.target;
        return PromptBuilder.of(
          `#${t.id}: "${t.action}"${targetLabel ? ` (target: ${targetLabel})` : ""}`,
        );
      });
      items.push(
        section(
          "scheduler-fired",
          firedLines,
          "Scheduled tasks just fired",
          15, // Высокий приоритет (задача сработала — нужен быстрый ответ)
          85,
        ),
      );
    }

    // 2. Показать предстоящие задачи (targetMs <= nowMs + UPCOMING_WINDOW_MS)
    const upcomingTasks = db
      .select()
      .from(scheduledTasks)
      .where(
        and(
          eq(scheduledTasks.active, true),
          lte(scheduledTasks.targetMs, ctx.nowMs + UPCOMING_WINDOW_MS),
        ),
      )
      .all()
      // Исключить уже просроченные (targetMs <= nowMs будут обработаны в onTickEnd, здесь только будущие)
      .filter((t) => (t.targetMs ?? 0) > ctx.nowMs);

    if (upcomingTasks.length > 0) {
      const upcomingLines = upcomingTasks.map((t) => {
        const targetLabel =
          t.target && ctx.graph.has(t.target)
            ? String(ctx.graph.getDynamic(t.target, "display_name") ?? t.target)
            : t.target;
        return PromptBuilder.of(
          `#${t.id} (in ~${humanDuration(((t.targetMs ?? 0) - ctx.nowMs) / 1000)}): "${t.action}"${targetLabel ? ` → ${targetLabel}` : ""}`,
        );
      });
      items.push(section("scheduler-upcoming", upcomingLines, "Upcoming scheduled tasks", 20, 75));
    }

    return items;
  })
  .build();
