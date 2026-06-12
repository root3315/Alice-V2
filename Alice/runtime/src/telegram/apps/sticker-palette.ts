/**
 * Sticker Palette — 语义标签 → fileId 映射查询层。
 *
 * Phase 1: 手动 INSERT 或管理脚本维护。
 * Phase 2: VLM 自动索引（describeMedia("sticker") 的副产物 → upsertFromVLM）
 *         + 使用频率追踪 + 加权采样 + 维度匹配兜底。
 *
 * @see https://github.com/TelechaBot/anime-identify — 动漫图像分类
 */
import type { TelegramClient } from "@mtcute/node";
import { and, eq, isNotNull, notInArray, sql } from "drizzle-orm";
import { z } from "zod";

import type { getDb } from "../../db/connection.js";
import { stickerPalette } from "../../db/schema.js";
import { createLogger } from "../../utils/logger.js";

/** Drizzle DB 实例类型（与 getDb() 返回值对齐）。 */
type Db = ReturnType<typeof getDb>;

// ═══════════════════════════════════════════════════════════════════════════
// Phase 1: 基础查询
// ═══════════════════════════════════════════════════════════════════════════

/** 获取所有启用的调色板标签（供 prompt 注入用）。 */
export function getPaletteLabels(db: Db): string[] {
  const rows = db
    .select({ label: stickerPalette.label, emoji: stickerPalette.emoji })
    .from(stickerPalette)
    .all();
  return rows.map((r) => `${r.emoji ?? "🏷️"} ${r.label}`);
}

/** 调色板是否非空（供 hasStickers 判断）。 */
export function hasPaletteEntries(db: Db): boolean {
  const row = db.select({ id: stickerPalette.id }).from(stickerPalette).limit(1).get();
  return row != null;
}

// ═══════════════════════════════════════════════════════════════════════════
// Phase 2: VLM 自动索引
// ═══════════════════════════════════════════════════════════════════════════

/** 快速查询贴纸是否已在调色板中（file_unique_id 去重）。 */
export function isInPalette(db: Db, fileUniqueId: string): boolean {
  const row = db
    .select({ id: stickerPalette.id })
    .from(stickerPalette)
    .where(eq(stickerPalette.fileUniqueId, fileUniqueId))
    .limit(1)
    .get();
  return row != null;
}

/** upsertFromVLM 参数（Zod 单一真相来源）。 */
export const upsertParamsSchema = z.object({
  fileUniqueId: z.string(),
  fileId: z.string(),
  label: z.string(),
  emoji: z.string().optional(),
  setName: z.string().optional(),
  emotion: z.string(),
  action: z.string(),
  intensity: z.string(),
});

export type UpsertParams = z.infer<typeof upsertParamsSchema>;

/**
 * VLM 分析结果写入调色板。
 * file_unique_id 冲突时更新维度 + 刷新 file_id。
 */
export function upsertFromVLM(db: Db, params: UpsertParams): void {
  db.insert(stickerPalette)
    .values({
      label: params.label,
      fileId: params.fileId,
      fileUniqueId: params.fileUniqueId,
      emoji: params.emoji,
      setName: params.setName,
      emotion: params.emotion,
      action: params.action,
      intensity: params.intensity,
    })
    .onConflictDoUpdate({
      target: stickerPalette.fileUniqueId,
      set: {
        fileId: params.fileId,
        label: params.label,
        emotion: params.emotion,
        action: params.action,
        intensity: params.intensity,
      },
    })
    .run();
}

// ═══════════════════════════════════════════════════════════════════════════
// Phase 2: 维度匹配（已安装优先 → VLM 兜底）
// ═══════════════════════════════════════════════════════════════════════════

/**
 * VLM 维度枚举值 — LLM 查询调色板的唯一词汇。
 * 与 stickerVlmSchema (src/llm/vision.ts) 保持同步。
 * @see docs/adr/148-sticker-palette-phase2-vlm-index.md §D3
 */
const EMOTIONS = new Set([
  "happy",
  "sad",
  "angry",
  "surprised",
  "shy",
  "tired",
  "neutral",
  "love",
  "scared",
]);
const ACTIONS = new Set([
  "wave",
  "hug",
  "cry",
  "laugh",
  "sleep",
  "eat",
  "dance",
  "thumbsup",
  "facepalm",
  "peek",
]);
// "none" 不入集合——不是有意义的查询维度

/**
 * 按维度列查询候选贴纸。
 *
 * 两级采样（已安装优先）：
 * 1. 主池（setName IS NOT NULL）— Alice 自己安装的贴纸集，均匀随机
 * 2. 后备池（setName IS NULL）— VLM 从对话中发现的贴纸，仅当主池无匹配时降级
 *
 * 不做使用频率加权 — 避免高频贴纸固化。
 * @see stickerVlmSchema in src/llm/vision.ts — 维度枚举的单一真相来源
 */
function pickByDimension(
  db: Db,
  column: "emotion" | "action",
  value: string,
  _chatId?: string | number,
): string | null {
  const col = column === "emotion" ? stickerPalette.emotion : stickerPalette.action;

  // 主池：自己安装的贴纸集（优先）
  const own = db
    .select({ fileId: stickerPalette.fileId })
    .from(stickerPalette)
    .where(and(eq(col, value), isNotNull(stickerPalette.setName)))
    .all();
  if (own.length > 0) {
    return own[Math.floor(Math.random() * own.length)].fileId;
  }

  // 后备池：VLM 发现的贴纸（主池无匹配时降级）
  const fallback = db
    .select({ fileId: stickerPalette.fileId })
    .from(stickerPalette)
    .where(and(eq(col, value), sql`${stickerPalette.setName} IS NULL`))
    .all();
  if (fallback.length > 0) {
    return fallback[Math.floor(Math.random() * fallback.length)].fileId;
  }

  return null;
}

/**
 * 解析语义标签 → fileId。
 *
 * 匹配策略（按优先级）：
 * 1. VLM 维度匹配（happy, hug, laugh... — LLM 的标准词汇）
 * 2. 精确 label 匹配（VLM description 全文）
 * 3. 子串包含匹配（label ⊂ description 或 description ⊂ label）
 * 4. null（调用方判断是否为 raw fileId）
 *
 * 无启发式语言特定逻辑——LLM 直接使用 VLM 维度枚举查询。
 * @see stickerVlmSchema in src/llm/vision.ts — 维度枚举的单一真相来源
 */
export function resolveLabel(db: Db, label: string, chatId?: string | number): string | null {
  const lower = label.toLowerCase();

  // 1. VLM dimension match — 维度值是 LLM 的标准查询词汇
  if (EMOTIONS.has(lower)) {
    const hit = pickByDimension(db, "emotion", lower, chatId);
    if (hit) return hit;
  }
  if (ACTIONS.has(lower)) {
    const hit = pickByDimension(db, "action", lower, chatId);
    if (hit) return hit;
  }

  // 2-3. Text-based matching（精确 label → 子串包含）— 已安装优先，VLM 兜底
  const ownRows = db
    .select({ label: stickerPalette.label, fileId: stickerPalette.fileId })
    .from(stickerPalette)
    .where(isNotNull(stickerPalette.setName))
    .all();

  const ownExact = ownRows.find((r) => r.label === label);
  if (ownExact) return ownExact.fileId;
  const ownPartial = ownRows.find((r) => label.includes(r.label) || r.label.includes(label));
  if (ownPartial) return ownPartial.fileId;

  // 已安装无匹配 → VLM 后备池兜底
  const vlmRows = db
    .select({ label: stickerPalette.label, fileId: stickerPalette.fileId })
    .from(stickerPalette)
    .where(sql`${stickerPalette.setName} IS NULL`)
    .all();

  const vlmExact = vlmRows.find((r) => r.label === label);
  if (vlmExact) return vlmExact.fileId;
  const vlmPartial = vlmRows.find((r) => label.includes(r.label) || r.label.includes(label));
  if (vlmPartial) return vlmPartial.fileId;

  return null;
}

// ═══════════════════════════════════════════════════════════════════════════
// Tier 2: keyword → emoji → palette 降级链
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 语义标签 → emoji 映射（结构侧，LLM 不可见）。
 * @see EMOTIONS, ACTIONS — 单一真相来源
 */
export const KEYWORD_TO_EMOJI: Record<string, string> = {
  // emotions
  happy: "😊",
  sad: "😢",
  angry: "😠",
  surprised: "😲",
  shy: "😳",
  tired: "😴",
  love: "❤️",
  scared: "😨",
  // actions
  wave: "👋",
  hug: "🤗",
  cry: "😭",
  laugh: "😂",
  sleep: "😴",
  dance: "💃",
  thumbsup: "👍",
  facepalm: "🤦",
  peek: "🫣",
};

/**
 * emoji → emotion 反向映射（bootstrap + Tier 2 共用）。
 * KEYWORD_TO_EMOJI 的反向版本 + 常见变体扩展。
 */
export const EMOJI_TO_EMOTION: Record<string, string> = {
  "😊": "happy",
  "😃": "happy",
  "😄": "happy",
  "😁": "happy",
  "🥰": "love",
  "😢": "sad",
  "😭": "sad",
  "😠": "angry",
  "😡": "angry",
  "😲": "surprised",
  "😮": "surprised",
  "😳": "shy",
  "😴": "tired",
  "😨": "scared",
  "😱": "scared",
  "❤️": "love",
  "💕": "love",
  "😍": "love",
};

/** emoji → action 反向映射。 */
export const EMOJI_TO_ACTION: Record<string, string> = {
  "👋": "wave",
  "🤗": "hug",
  "😭": "cry",
  "😂": "laugh",
  "💃": "dance",
  "🕺": "dance",
  "👍": "thumbsup",
  "🤦": "facepalm",
  "🫣": "peek",
};

/**
 * Tier 2 降级：keyword → emoji → palette.emoji 列匹配。
 * palette 有数据但维度列（emotion/action）缺失时（如 bootstrap 阶段），
 * 通过 emoji 列做间接匹配。
 */
export function resolveByEmoji(db: Db, keyword: string, _chatId?: string | number): string | null {
  const emoji = KEYWORD_TO_EMOJI[keyword.toLowerCase()];
  if (!emoji) return null;

  // 已安装优先，VLM 兜底
  const own = db
    .select({ fileId: stickerPalette.fileId })
    .from(stickerPalette)
    .where(and(eq(stickerPalette.emoji, emoji), isNotNull(stickerPalette.setName)))
    .all();
  if (own.length > 0) {
    return own.length === 1 ? own[0].fileId : own[Math.floor(Math.random() * own.length)].fileId;
  }

  const candidates = db
    .select({ fileId: stickerPalette.fileId })
    .from(stickerPalette)
    .where(and(eq(stickerPalette.emoji, emoji), sql`${stickerPalette.setName} IS NULL`))
    .all();

  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0].fileId;

  // 多候选 → 均匀随机（emoji 列无使用频率维度）
  return candidates[Math.floor(Math.random() * candidates.length)].fileId;
}

/**
 * 生成可用关键词预览（Tier 3 error message 用）。
 * 从 palette 动态生成——有维度数据用维度，否则用 EMOTIONS/ACTIONS 常量。
 */
export function getAvailableKeywords(db: Db): string {
  // 查 palette 中存在的 emotion/action 值
  const emotionRows = db
    .select({ emotion: stickerPalette.emotion })
    .from(stickerPalette)
    .where(sql`${stickerPalette.emotion} IS NOT NULL AND ${stickerPalette.emotion} != 'neutral'`)
    .groupBy(stickerPalette.emotion)
    .all();
  const actionRows = db
    .select({ action: stickerPalette.action })
    .from(stickerPalette)
    .where(sql`${stickerPalette.action} IS NOT NULL AND ${stickerPalette.action} != 'none'`)
    .groupBy(stickerPalette.action)
    .all();

  const emotions = emotionRows.map((r) => r.emotion).filter(Boolean);
  const actions = actionRows.map((r) => r.action).filter(Boolean);

  // 有维度数据 → 用实际数据；否则用常量集合
  const emotionList = emotions.length > 0 ? emotions : [...EMOTIONS].filter((e) => e !== "neutral");
  const actionList = actions.length > 0 ? actions : [...ACTIONS];

  return `Emotions: ${emotionList.join(", ")}. Actions: ${actionList.join(", ")}`;
}

/**
 * Финальный фолбэк: любой стикер из палитры (установленные приоритетнее VLM-найденных).
 * Нужен, чтобы `irc sticker --keyword X` НИКОГДА не падал, даже если набор не
 * классифицирован по эмоциям/действиям (как нейтральный bootstrap-набор) — лучше
 * отправить нейтральный стикер, чем вернуть ошибку. null только если палитра пуста.
 */
export function pickAnySticker(db: Db): string | null {
  const own = db
    .select({ fileId: stickerPalette.fileId })
    .from(stickerPalette)
    .where(isNotNull(stickerPalette.setName))
    .all();
  const pool =
    own.length > 0
      ? own
      : db.select({ fileId: stickerPalette.fileId }).from(stickerPalette).all();
  if (pool.length === 0) return null;
  return pool[Math.floor(Math.random() * pool.length)].fileId;
}

// ═══════════════════════════════════════════════════════════════════════════
// 已安装贴纸集增量同步
// ═══════════════════════════════════════════════════════════════════════════

const syncLog = createLogger("sticker-sync");

export interface SyncStats {
  added: number;
  removed: number;
  refreshed: number;
}

/**
 * 增量同步已安装贴纸集 → palette（幂等，任何时候安全运行）。
 *
 * 逻辑：
 * 1. 拉取已安装贴纸集列表（Telegram API）
 * 2. 对每个集：拉取详情 → 对每个贴纸：
 *    - fileUniqueId 已存在 → 刷新 fileId（Telegram 会更新 fileId）
 *    - fileUniqueId 不存在 → 插入粗标签（emoji→dimension）
 * 3. 清理过期贴纸：palette 中 setName 不在已安装列表中的行 → DELETE
 *    （排除 setName IS NULL 的 VLM 发现贴纸——它们不来自已安装集）
 *
 * @returns SyncStats — 同步统计
 */
export async function syncInstalledSets(client: TelegramClient, db: Db): Promise<SyncStats> {
  let added = 0;
  let removed = 0;
  let refreshed = 0;

  const sets = await client.getInstalledStickers();
  const maxSets = 10;
  const maxStickersPerSet = 20;
  const installedSetNames = new Set<string>();

  for (const set of sets.slice(0, maxSets)) {
    installedSetNames.add(set.shortName);
    try {
      const fullSet = await client.getStickerSet(set.shortName);
      if (!fullSet.isFull) continue;

      for (const doc of fullSet.stickers.slice(0, maxStickersPerSet)) {
        const emoji = doc.alt ?? "";
        if (!emoji) continue;

        const fileId = doc.sticker.fileId;
        const fileUniqueId = doc.sticker.uniqueFileId;

        // emoji → dimension 反向映射
        const emotion = EMOJI_TO_EMOTION[emoji] ?? "neutral";
        const action = EMOJI_TO_ACTION[emoji] ?? "none";
        const label = `${emoji} sticker`;

        try {
          // 新贴纸：插入粗标签（不覆盖已有的精细 VLM 标签）
          const { changes } = db
            .insert(stickerPalette)
            .values({
              label,
              fileId,
              fileUniqueId,
              emoji,
              setName: set.shortName,
              emotion,
              action,
              intensity: "medium",
            })
            .onConflictDoNothing()
            .run();
          if (changes > 0) {
            added++;
          } else {
            // 已存在 → 刷新 fileId（Telegram 可能更新了 fileId）
            const { changes: updateChanges } = db
              .update(stickerPalette)
              .set({ fileId })
              .where(
                and(
                  eq(stickerPalette.fileUniqueId, fileUniqueId),
                  sql`${stickerPalette.fileId} != ${fileId}`,
                ),
              )
              .run();
            if (updateChanges > 0) refreshed++;
          }
        } catch {
          // 单条失败不阻塞整体
        }
      }
    } catch (e) {
      syncLog.warn("Failed to fetch sticker set", {
        setName: set.shortName,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  // 清理过期贴纸：setName 不在已安装列表中的行（保护 VLM 贴纸：setName IS NULL）
  try {
    if (installedSetNames.size === 0) {
      // 无已安装贴纸集 → 清理所有来自贴纸集的条目
      const { changes } = db.delete(stickerPalette).where(isNotNull(stickerPalette.setName)).run();
      removed = changes;
    } else {
      const { changes } = db
        .delete(stickerPalette)
        .where(
          and(
            isNotNull(stickerPalette.setName),
            notInArray(stickerPalette.setName, [...installedSetNames]),
          ),
        )
        .run();
      removed = changes;
    }
  } catch (e) {
    syncLog.warn("Stale sticker cleanup failed", {
      error: e instanceof Error ? e.message : String(e),
    });
  }

  syncLog.info("Sync complete", { added, removed, refreshed });
  return { added, removed, refreshed };
}
