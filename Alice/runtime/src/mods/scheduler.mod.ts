/**
 * Scheduler Mod — 定时任务系统（ADR-51 Wave 3 #16）。
 *
 * 职责：
 * - 支持 at（一次性定时）和 every（周期性）两种定时任务
 * - SQLite 持久化（重启不丢失）
 * - 通过 contribute 注入即将触发的任务到 LLM 上下文
 * - onTickEnd 检查并标记到期任务
 *
 * 设计要点：
 * - 不直接执行 Telegram 动作——注入 contribute 让 LLM 决定如何响应
 * - Alice 是伴侣，不是 cron job
 * - 上限 50 个活跃任务（防止 LLM 无限创建）
 * - 所有时间使用墙钟 ms，不依赖 tick 间隔假设
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

// -- 常量 --------------------------------------------------------------------

/** 活跃任务上限。 */
const MAX_ACTIVE_TASKS = 50;
/** 即将触发的任务预告窗口（ms）。 */
const UPCOMING_WINDOW_MS = 3 * 60_000;

// -- Mod 状态 ----------------------------------------------------------------

interface SchedulerState {
  /** 本 tick 触发的任务列表（供 contribute 展示）。 */
  firedThisTick: Array<{ id: number; action: string; target: string | null }>;
}

// -- Mod 定义 ----------------------------------------------------------------

export const schedulerMod = createMod<SchedulerState>("scheduler", {
  category: "mechanic",
  description: "Система запланированных задач — срабатывание по at (одноразово) / every (периодически)",
  topics: ["schedule"],
  initialState: { firedThisTick: [] },
})
  /**
   * 创建定时任务。
   * type="at": 在 delay 分钟后触发一次
   * type="every": 每 interval 分钟触发一次（首次在 interval 后）
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

      // 检查活跃任务上限
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
  /** 取消指定任务。 */
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
  /** 获取所有活跃任务。 */
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
        // 预解析 display_name，format() 无法访问 graph
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
    // 不在此处清空 firedThisTick——需要保留到下一 tick 的 contribute 读取
    // 清空逻辑移至 onTickEnd 开头（处理到期任务之前）
  })
  .onTickEnd((ctx) => {
    // 先清空上一轮的触发记录，再处理本轮到期任务
    // 生命周期: onTickStart → contribute → LLM → onTickEnd
    // 这样 contribute 能看到上一 tick onTickEnd 写入的 firedThisTick
    ctx.state.firedThisTick = [];

    const db = getDb();

    // 查找所有到期的活跃任务（targetMs <= nowMs）
    const dueTasks = db
      .select()
      .from(scheduledTasks)
      .where(and(eq(scheduledTasks.active, true), lte(scheduledTasks.targetMs, ctx.nowMs)))
      .all();

    for (const task of dueTasks) {
      // 记录触发
      ctx.state.firedThisTick.push({
        id: task.id,
        action: task.action,
        target: task.target,
      });

      if (task.type === "at") {
        // 一次性任务：触发后 deactivate
        db.update(scheduledTasks)
          .set({ active: false })
          .where(eq(scheduledTasks.id, task.id))
          .run();
      } else if (task.type === "every" && task.intervalMs) {
        // 周期性任务：更新下次触发时间
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

    // 1. 展示本 tick 触发的任务
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
          15, // 高优先级（定时任务触发需要及时响应）
          85,
        ),
      );
    }

    // 2. 展示即将触发的任务（targetMs <= nowMs + UPCOMING_WINDOW_MS）
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
      // 排除已经到期的（targetMs <= nowMs 的会在 onTickEnd 处理，这里只看未来的）
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
