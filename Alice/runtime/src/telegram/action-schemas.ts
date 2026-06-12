/**
 * CQRS 结果 Zod Schemas — 查询动作结果的单一真相来源。
 *
 * 每个 schema 匹配对应 impl 存入图属性的数据形状。
 * safeParse 失败 → formatResult 返回 null（安全降级，不生成 observation）。
 *
 * schema 同时服务于：
 * - impl 写入（编译期类型检查）
 * - formatResult 读取（运行时 safeParse 验证）
 *
 * @see docs/adr/105-react-cqrs-read-during-next.md
 */

import { z } from "zod";

// ── Bot 交互 ──

/** click_inline_button: 回调应答 */
export const CallbackAnswerResult = z.object({
  msgId: z.number(),
  message: z.string().nullish(),
  url: z.string().nullish(),
  alert: z.boolean().optional(),
});
export type CallbackAnswerResult = z.infer<typeof CallbackAnswerResult>;

/** inline_query: 单条结果 */
export const InlineResultItem = z.object({
  id: z.string(),
  title: z.string().nullish(),
  description: z.string().nullish(),
});
export type InlineResultItem = z.infer<typeof InlineResultItem>;

/** inline_query: 结果集 */
export const InlineQueryResult = z.object({
  botUsername: z.string(),
  query: z.string(),
  queryId: z.string(),
  results: z.array(InlineResultItem),
});
export type InlineQueryResult = z.infer<typeof InlineQueryResult>;

// ── 贴纸 ──

/** list_stickers: 贴纸集摘要 */
export const StickerSetSummary = z.object({
  shortName: z.string(),
  title: z.string(),
  count: z.number(),
});
export type StickerSetSummary = z.infer<typeof StickerSetSummary>;

/** get_sticker_set: 贴纸集详情 */
export const StickerSetDetail = z.object({
  shortName: z.string(),
  title: z.string(),
  stickers: z.array(
    z.object({
      fileId: z.string(),
      emoji: z.string().nullish(),
    }),
  ),
});
export type StickerSetDetail = z.infer<typeof StickerSetDetail>;

// ── 搜索 ──

/** ADR-145: search() 本地 FTS 搜索结果条目 */
export const LocalSearchResultItem = z.object({
  msgId: z.number().nullable(),
  chatId: z.string(),
  sender: z.string(),
  text: z.string(),
  /** FTS5 snippet — 命中关键词的上下文片段（»关键词«）。 */
  snippet: z.string().optional(),
  date: z.string(),
  isOutgoing: z.boolean(),
});
export type LocalSearchResultItem = z.infer<typeof LocalSearchResultItem>;

/** ADR-145 W2: 日记搜索结果条目 */
export const DiarySearchResultItem = z.object({
  id: z.number(),
  content: z.string(),
  about: z.string().nullable(),
  date: z.string(),
});
export type DiarySearchResultItem = z.infer<typeof DiarySearchResultItem>;

/** ADR-145 W2: 线程搜索结果条目 */
export const ThreadSearchResultItem = z.object({
  id: z.number(),
  title: z.string(),
  status: z.string(),
  weight: z.string(),
  summary: z.string().nullable(),
});
export type ThreadSearchResultItem = z.infer<typeof ThreadSearchResultItem>;

/** ADR-145 W3: 图记忆融合 — spreading activation 关联事实。 */
export const RelatedFactItem = z.object({
  entity: z.string(),
  fact: z.string(),
  activation: z.number(),
});
export type RelatedFactItem = z.infer<typeof RelatedFactItem>;

/** ADR-145 W3: 统一搜索结果（多源联合） */
export const UnifiedSearchResult = z.object({
  expression: z.string(),
  source: z.enum(["messages", "diary", "threads", "all"]),
  messages: z.array(LocalSearchResultItem).optional(),
  diary: z.array(DiarySearchResultItem).optional(),
  threads: z.array(ThreadSearchResultItem).optional(),
  /** 图记忆融合：从搜索结果中提取 sender → spreading activation → 关联事实。 */
  relatedFacts: z.array(RelatedFactItem).optional(),
});
export type UnifiedSearchResult = z.infer<typeof UnifiedSearchResult>;

/** search_public: 公共搜索结果 */
export const SearchPublicResult = z.object({
  query: z.string(),
  users: z.array(z.object({ id: z.number(), name: z.string() })),
  chats: z.array(z.object({ id: z.number(), title: z.string() })),
});
export type SearchPublicResult = z.infer<typeof SearchPublicResult>;

/** preview_chat: 聊天预览 */
export const ChatPreviewResult = z.object({
  title: z.string(),
  type: z.string(),
  memberCount: z.number(),
  withApproval: z.boolean().optional(),
  link: z.string(),
});
export type ChatPreviewResult = z.infer<typeof ChatPreviewResult>;

/** get_similar_channels: 相似频道条目 */
export const SimilarChannelItem = z.object({
  id: z.number(),
  title: z.string(),
});
export type SimilarChannelItem = z.infer<typeof SimilarChannelItem>;

/** get_bot_commands: Bot 命令列表 */
export const BotCommandsResult = z.object({
  botId: z.string(),
  commands: z.array(
    z.object({
      command: z.string(),
      description: z.string(),
    }),
  ),
});
export type BotCommandsResult = z.infer<typeof BotCommandsResult>;

// ── 笔记 ──

/** read_notes: 笔记条目 */
export const NoteItem = z.object({
  id: z.number(),
  text: z.string(),
  date: z.string(),
});
export type NoteItem = z.infer<typeof NoteItem>;

// ── 知识 ──

/** google: 搜索 → 提取 → 合成 管线结果 */
export const GoogleResult = z.object({
  answer: z.string(),
  sources: z.array(z.object({ title: z.string(), url: z.string() })),
});
export type GoogleResult = z.infer<typeof GoogleResult>;

/** visit: URL 阅读摘要 */
export const VisitResult = z.object({
  title: z.string(),
  url: z.string(),
  summary: z.string(),
});
export type VisitResult = z.infer<typeof VisitResult>;

/** Shared stdout capture payload for shell-native command queries. */
export const CommandOutputResult = z.object({
  command: z.string(),
  stdout: z.string(),
});
export type CommandOutputResult = z.infer<typeof CommandOutputResult>;

// ── ADR-132: Calendar App ──

/** use_calendar_app: 日历结果 */
export const CalendarResultSchema = z.object({
  datetime: z.string(),
  timezone: z.string(),
  period: z.string(),
  gregorian: z.string(),
  weekday: z.string(),
  lunar: z.string(),
  solarTerm: z.string().nullable(),
  holidays: z.array(z.string()),
  recommends: z.array(z.string()),
  avoids: z.array(z.string()),
  todayInHistory: z.string().nullable(),
  solarTermPoem: z.string().nullable(),
});
export type CalendarResultSchema = z.infer<typeof CalendarResultSchema>;

// ── ADR-132: Countdown App ──

/** use_countdown_app: 倒计时结果 */
export const CountdownResultSchema = z.object({
  target: z.string(),
  days: z.number(),
  weekday: z.string(),
});
export type CountdownResultSchema = z.infer<typeof CountdownResultSchema>;

// ── ADR-133 Wave 5: Selfcheck App ──

/** use_selfcheck_app: 自检维度段 */
export const SelfcheckSectionSchema = z.object({
  dimension: z.string(),
  label: z.string(),
  lines: z.array(z.string()),
});
export type SelfcheckSectionSchema = z.infer<typeof SelfcheckSectionSchema>;

/** use_selfcheck_app: 自检结果 */
export const SelfcheckResultSchema = z.object({
  sections: z.array(SelfcheckSectionSchema),
});
export type SelfcheckResultSchema = z.infer<typeof SelfcheckResultSchema>;
