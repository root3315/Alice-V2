/**
 * Diary Mod — Alice 的工作记忆（内在世界）。
 *
 * ADR-82 → ADR-225: 从 append-only log 回归 working memory buffer。
 *
 * 核心模型：diary 是固定容量的思维槽位池（7 slots），不是无限增长的日志。
 * 每个槽位是一个"活着的想法"——写入同主题内容时合并演化（consolidate-on-write），
 * 而非追加新行。显著性（salience）随时间衰减，淡出的想法让出槽位给新想法。
 *
 * 理论基础：
 * - Baddeley (2000) Working Memory: 有限容量 + 主动维持 + 干扰替换
 * - Cowan (2001): 工作记忆容量 4±1 项
 * - MemGPT (Packer et al. 2023): Core Memory — 小容量、始终可见、可自编辑
 * - Park et al. (2023) Generative Agents: 合并写入 ≈ 隐式反思（无额外 LLM 调用）
 * - ACT-R activation decay: salience × 2^(-age/halfLife)
 *
 * 设计原则：LLM 可以修改 Alice 的主观世界，但不能修改客观世界。
 * 日记是主观的——Alice 觉得 David 在躲她，也许 David 只是忙。
 * 这种"不可靠叙述者"恰恰是人格深度的来源。
 *
 * @see docs/adr/82-diary-inner-world.md — 原始设计
 * @see docs/adr/225-diary-working-memory.md — 本次重构
 */

import { z } from "zod";

import { createMod } from "../core/mod-builder.js";
import { PromptBuilder } from "../core/prompt-style.js";
import type { ContributionItem, ModContext } from "../core/types.js";
import { header, readModState } from "../core/types.js";
import { ensureChannelId, ensureContactId } from "../graph/constants.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("diary");

// ═══════════════════════════════════════════════════════════════════════════
// 常量
// ═══════════════════════════════════════════════════════════════════════════

/** 工作记忆容量（Cowan's 4±1 + 慷慨余量）。 */
const CAPACITY = 7;

/** 每轮脚本最多写入 2 条日记（防 LLM 滥用）。 */
const DIARY_CAP_PER_TURN = 2;

/** 每条日记最长字符数。 */
const MAX_ENTRY_LENGTH = 200;

/** contribute() 注入时最多渲染的思维数。 */
const INJECT_LIMIT = 5;

/** 合并判定阈值（字符双字母组 Jaccard similarity）。
 * 实测：同主题中文改写 ≈ 0.35-0.45，不同话题 ≈ 0.0-0.15。 */
const SIMILARITY_THRESHOLD = 0.35;

/** 显著性半衰期（6 小时）。一个想法 6 小时不被触及，显著性减半。 */
const SALIENCE_HALF_LIFE_MS = 6 * 3600 * 1000;

/** 初始显著性。 */
const INITIAL_SALIENCE = 1.0;

/** 每次合并演化时的显著性提升。 */
const SALIENCE_BUMP = 0.15;

/** 显著性上限。 */
const MAX_SALIENCE = 2.0;

/** 有效显著性低于此值的想法不注入 prompt，并在清理时释放槽位。 */
const INJECT_FLOOR = 0.05;

/** 合并回溯窗口（24 小时）。超出此窗口的想法不与新写入合并。 */
const CONSOLIDATION_WINDOW_MS = 24 * 3600 * 1000;

// ═══════════════════════════════════════════════════════════════════════════
// 数据模型
// ═══════════════════════════════════════════════════════════════════════════

/** 一个活着的想法。 */
interface Thought {
  /** 最新版本的叙事内容。 */
  content: string;
  /** 关联实体 ID（null = 全局想法）。 */
  about: string | null;
  /** 显著性 [0, MAX_SALIENCE]。写入时 bump，随时间衰减。 */
  salience: number;
  /** 首次产生时间（epoch ms）。 */
  createdAt: number;
  /** 最后演化时间（epoch ms）。 */
  updatedAt: number;
}

interface DiaryState {
  /** 当前 turn 写入计数（每次 ACT 重置）。 */
  turnWriteCount: number;
  /** 工作记忆槽位。固定容量，每个槽是一个"活着的想法"。 */
  thoughts: Thought[];
}

// ═══════════════════════════════════════════════════════════════════════════
// 相似度计算
// ═══════════════════════════════════════════════════════════════════════════

/** CJK-native 字符双字母组（bigram）集合。 */
function charBigrams(text: string): Set<string> {
  const chars = [...text]; // Unicode-aware spread
  const bg = new Set<string>();
  for (let i = 0; i < chars.length - 1; i++) {
    bg.add(chars[i] + chars[i + 1]);
  }
  return bg;
}

/**
 * Jaccard similarity ∈ [0, 1]。
 *
 * 使用字符双字母组——CJK 天然适配（每个汉字是一个 Unicode char）。
 * O(n) 复杂度，无外部依赖，是近似重复检测的成熟技术。
 */
function jaccardSimilarity(a: string, b: string): number {
  const sa = charBigrams(a);
  const sb = charBigrams(b);
  let inter = 0;
  for (const x of sa) {
    if (sb.has(x)) inter++;
  }
  const union = sa.size + sb.size - inter;
  return union === 0 ? 0 : inter / union;
}

// ═══════════════════════════════════════════════════════════════════════════
// 显著性衰减
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 即时计算有效显著性（lazy evaluation，无需批量 DB 更新）。
 *
 * 模型：ACT-R base-level activation 的指数近似。
 * effectiveSalience = salience × 2^(-age / halfLife)
 */
function effectiveSalience(t: Thought, nowMs: number): number {
  const age = nowMs - t.updatedAt;
  if (age <= 0) return t.salience;
  return t.salience * 0.5 ** (age / SALIENCE_HALF_LIFE_MS);
}

// ═══════════════════════════════════════════════════════════════════════════
// 写入路径：合并-或-分配
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 在现有想法中查找可合并的目标。
 *
 * 条件：same about + 在合并窗口内 + 内容相似度超过阈值。
 * 返回槽位索引，-1 = 未找到。
 */
function findSimilarThought(
  thoughts: Thought[],
  content: string,
  about: string | null,
  nowMs: number,
): number {
  const cutoff = nowMs - CONSOLIDATION_WINDOW_MS;
  for (let i = 0; i < thoughts.length; i++) {
    const t = thoughts[i];
    // about 维度必须匹配
    if (t.about !== about) continue;
    // 超出合并窗口的不合并
    if (t.updatedAt < cutoff) continue;
    // 内容相似度检测
    if (jaccardSimilarity(content, t.content) >= SIMILARITY_THRESHOLD) {
      return i;
    }
  }
  return -1;
}

/**
 * 写入一条想法：合并到已有槽 / 分配新槽 / 替换最低显著性槽。
 */
function writeThought(
  state: DiaryState,
  content: string,
  about: string | null,
  nowMs: number,
): { evolved: boolean } {
  // 1. 查找可合并的想法
  const idx = findSimilarThought(state.thoughts, content, about, nowMs);
  if (idx >= 0) {
    // 合并（evolve）：内容替换为最新版本，显著性提升
    const t = state.thoughts[idx];
    t.content = content;
    t.salience = Math.min(t.salience + SALIENCE_BUMP, MAX_SALIENCE);
    t.updatedAt = nowMs;
    log.info("Thought evolved (consolidated)", { about, salience: t.salience });
    return { evolved: true };
  }

  // 2. 有空槽 → 分配
  if (state.thoughts.length < CAPACITY) {
    state.thoughts.push({
      content,
      about,
      salience: INITIAL_SALIENCE,
      createdAt: nowMs,
      updatedAt: nowMs,
    });
    log.info("New thought allocated", { about, slot: state.thoughts.length });
    return { evolved: false };
  }

  // 3. 满 → 替换有效显著性最低的槽
  let minIdx = 0;
  let minSal = effectiveSalience(state.thoughts[0], nowMs);
  for (let i = 1; i < state.thoughts.length; i++) {
    const s = effectiveSalience(state.thoughts[i], nowMs);
    if (s < minSal) {
      minSal = s;
      minIdx = i;
    }
  }
  log.info("Thought replaced (lowest salience)", {
    replaced: state.thoughts[minIdx].content.slice(0, 30),
    replacedSalience: minSal,
    about,
  });
  state.thoughts[minIdx] = {
    content,
    about,
    salience: INITIAL_SALIENCE,
    createdAt: nowMs,
    updatedAt: nowMs,
  };
  return { evolved: false };
}

// ═══════════════════════════════════════════════════════════════════════════
// about 字段规范化（复用 ADR-102 逻辑）
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 将 diary about 字段规范化为图节点 ID 格式。
 *
 * 标准 ID 格式 → 保持 | ~ID/纯数字 → contact:X | 其他 → null（进 global pool）。
 * @see ADR-102
 */
function normalizeAbout(about: string): string | null {
  if (about.startsWith("contact:") || about.startsWith("channel:")) return about;
  const contactId = ensureContactId(about);
  if (contactId) return contactId;
  log.debug("normalizeAbout: non-ID format, falling back to null", { about });
  return null;
}

function thoughtMatchesCurrentTarget(t: Thought, currentTarget: string | null): boolean {
  if (!t.about || !currentTarget) return false;
  if (t.about === currentTarget) return true;
  return ensureChannelId(t.about) === currentTarget || ensureContactId(currentTarget) === t.about;
}

function currentDiaryTarget(ctx: ModContext<DiaryState>): string | null {
  const relState = readModState(ctx, "relationships");
  return relState?.targetNodeId ?? null;
}

// ═══════════════════════════════════════════════════════════════════════════
// 时间格式化
// ═══════════════════════════════════════════════════════════════════════════

/** ADR-110: 将毫秒差值格式化为人类可读的时间标签。 */
function formatTimeAgo(ageMs: number): string {
  const seconds = ageMs / 1000;
  if (seconds <= 300) return "только что";
  if (seconds <= 1800) return `${Math.round(seconds / 60)} мин назад`;
  if (seconds <= 3600) return "полчаса назад";
  return `${Math.round(seconds / 3600)} ч назад`;
}

// ═══════════════════════════════════════════════════════════════════════════
// Mod 定义
// ═══════════════════════════════════════════════════════════════════════════

export const diaryMod = createMod<DiaryState>("diary", {
  category: "mechanic",
  description: "Рабочая память Алисы — эмоциональные воспоминания + желания + инерция настроения (слоты мыслей фиксированной ёмкости)",
  topics: ["diary"],
  initialState: { turnWriteCount: 0, thoughts: [] },
})
  .instruction("diary", {
    params: z.object({
      // Схема НЕ режет жёстко: impl сам аккуратно обрезает >MAX_ENTRY_LENGTH и
      // нормализует about. coerce → number/прочее не валят валидацию (была частая
      // ошибка "content max 200" / "about expected string, received number").
      content: z.coerce.string().trim().min(1).describe("Текст записи (свободная форма; длинное аккуратно обрежется)"),
      about: z.coerce.string().optional().describe("@id связанной сущности (необязательно, например @7785440246)"),
    }),
    description: "Сделать личную запись в дневнике",
    affordance: {
      priority: "capability",
      category: "memory",
      whenToUse: "Recording personal reflections or significant events",
      whenNotToUse: "Routine interactions with nothing notable",
    },
    impl(ctx, args) {
      // Per-turn cap
      if (ctx.state.turnWriteCount >= DIARY_CAP_PER_TURN) {
        return { success: false, error: `max ${DIARY_CAP_PER_TURN} diary() per turn` };
      }

      const content = String(args.content);
      const trimmed =
        content.length > MAX_ENTRY_LENGTH ? content.slice(0, MAX_ENTRY_LENGTH) : content;

      // 规范化 about 字段
      let about = args.about != null ? String(args.about) : null;
      if (about) {
        const resolved = normalizeAbout(about);
        if (!resolved) {
          about = null;
          log.debug("diary about could not be resolved; storing as global", {
            original: args.about,
            resolved: about,
          });
        } else {
          about = resolved;
        }
      } else {
        about = currentDiaryTarget(ctx);
      }
      // ADR-91 Layer 1: diary about Bot → 清除 about
      if (about && ctx.graph.has(about) && ctx.graph.getDynamic(about, "is_bot") === true) {
        about = null;
      }

      // 合并-或-分配写入
      const { evolved } = writeThought(ctx.state, trimmed, about, ctx.nowMs);
      ctx.state.turnWriteCount++;

      return { success: true, evolved };
    },
  })
  // 每个 tick 开始时重置 per-turn 计数
  .onTickStart((ctx) => {
    ctx.state.turnWriteCount = 0;
  })
  // 每个 tick 结束时清除已淡出的想法（释放槽位）
  .onTickEnd((ctx) => {
    const nowMs = ctx.nowMs;
    const before = ctx.state.thoughts.length;
    ctx.state.thoughts = ctx.state.thoughts.filter(
      (t) => effectiveSalience(t, nowMs) >= INJECT_FLOOR,
    );
    const removed = before - ctx.state.thoughts.length;
    if (removed > 0) {
      log.info("Faded thoughts pruned", { removed, remaining: ctx.state.thoughts.length });
    }
  })
  // 唯一注入路径：system prompt "你最近的想法" section
  .contribute((ctx): ContributionItem[] => {
    const { thoughts } = ctx.state;
    if (thoughts.length === 0) return [];

    const nowMs = ctx.nowMs;

    // 读取当前对话目标（用于 target-aware 排序）
    const relState = readModState(ctx, "relationships");
    const currentTarget = relState?.targetNodeId ?? null;

    // 计算有效显著性，只保留当前 target 相关想法。
    const active = thoughts
      .map((t) => ({ ...t, eSal: effectiveSalience(t, nowMs) }))
      .filter((t) => t.eSal >= INJECT_FLOOR)
      // H4: глобальные мысли (about=null — само-рефлексия, ночные, общие) универсально релевантны,
      // иначе они занимают слот и затухают, ни разу не показавшись LLM (вся inner-world фича инертна).
      .filter((t) => t.about === null || thoughtMatchesCurrentTarget(t, currentTarget))
      .sort((a, b) => {
        return b.eSal - a.eSal;
      });

    const toInject = active.slice(0, INJECT_LIMIT);
    if (toInject.length === 0) return [];

    // 按时间排序（最旧在前，阅读顺序）
    toInject.sort((a, b) => a.updatedAt - b.updatedAt);

    const m = new PromptBuilder();
    m.heading("Твои недавние мысли (о них знаешь только ты)");
    m.blank();

    const items: string[] = [];
    for (const t of toInject) {
      const timeLabel = formatTimeAgo(nowMs - t.updatedAt);
      const aboutName =
        t.about && ctx.graph.has(t.about)
          ? String(ctx.graph.getDynamic(t.about, "display_name") ?? t.about)
          : t.about;
      const aboutLabel = aboutName ? ` про ${aboutName}` : "";
      items.push(`${timeLabel}${aboutLabel}: ${t.content}`);
    }
    m.list(items);

    // priority 75: 低于 SOUL_CORE (100) 和 voice-guidance (90)，
    // 高于 Instincts (80)。日记是人格的延伸，应优先于规则。
    return [header(m.build(), 75)];
  })
  .build();

// 导出工具函数供测试使用
export { charBigrams, effectiveSalience, jaccardSimilarity };
export type { DiaryState, Thought };
