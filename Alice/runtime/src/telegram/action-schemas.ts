/**
 * CQRS result Zod Schemas — единый источник истины для результатов query-действий.
 *
 * Каждая схема соответствует форме данных, которые impl записывает в атрибут графа.
 * Ошибка safeParse → formatResult возвращает null (безопасная деградация, observation не генерируется).
 *
 * Схема обслуживает одновременно:
 * - запись в impl (проверка типов на этапе компиляции)
 * - чтение в formatResult (runtime safeParse-валидация)
 *
 * @see docs/adr/105-react-cqrs-read-during-next.md
 */

import { z } from "zod";

// ── Bot-взаимодействие ──

/** click_inline_button: ответ на callback */
export const CallbackAnswerResult = z.object({
  msgId: z.number(),
  message: z.string().nullish(),
  url: z.string().nullish(),
  alert: z.boolean().optional(),
});
export type CallbackAnswerResult = z.infer<typeof CallbackAnswerResult>;

/** inline_query: один результат */
export const InlineResultItem = z.object({
  id: z.string(),
  title: z.string().nullish(),
  description: z.string().nullish(),
});
export type InlineResultItem = z.infer<typeof InlineResultItem>;

/** inline_query: набор результатов */
export const InlineQueryResult = z.object({
  botUsername: z.string(),
  query: z.string(),
  queryId: z.string(),
  results: z.array(InlineResultItem),
});
export type InlineQueryResult = z.infer<typeof InlineQueryResult>;

// ── Стикеры ──

/** list_stickers: сводка набора стикеров */
export const StickerSetSummary = z.object({
  shortName: z.string(),
  title: z.string(),
  count: z.number(),
});
export type StickerSetSummary = z.infer<typeof StickerSetSummary>;

/** get_sticker_set: детали набора стикеров */
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

// ── Поиск ──

/** ADR-145: элемент результата локального FTS-поиска search() */
export const LocalSearchResultItem = z.object({
  msgId: z.number().nullable(),
  chatId: z.string(),
  sender: z.string(),
  text: z.string(),
  /** FTS5 snippet — контекстный фрагмент с подсвеченными ключевыми словами (»ключевое слово«). */
  snippet: z.string().optional(),
  date: z.string(),
  isOutgoing: z.boolean(),
});
export type LocalSearchResultItem = z.infer<typeof LocalSearchResultItem>;

/** ADR-145 W2: элемент результата поиска по дневнику */
export const DiarySearchResultItem = z.object({
  id: z.number(),
  content: z.string(),
  about: z.string().nullable(),
  date: z.string(),
});
export type DiarySearchResultItem = z.infer<typeof DiarySearchResultItem>;

/** ADR-145 W2: элемент результата поиска по тредам */
export const ThreadSearchResultItem = z.object({
  id: z.number(),
  title: z.string(),
  status: z.string(),
  weight: z.string(),
  summary: z.string().nullable(),
});
export type ThreadSearchResultItem = z.infer<typeof ThreadSearchResultItem>;

/** ADR-145 W3: слияние памяти графа — связанные факты через spreading activation. */
export const RelatedFactItem = z.object({
  entity: z.string(),
  fact: z.string(),
  activation: z.number(),
});
export type RelatedFactItem = z.infer<typeof RelatedFactItem>;

/** ADR-145 W3: объединённый результат поиска (несколько источников) */
export const UnifiedSearchResult = z.object({
  expression: z.string(),
  source: z.enum(["messages", "diary", "threads", "all"]),
  messages: z.array(LocalSearchResultItem).optional(),
  diary: z.array(DiarySearchResultItem).optional(),
  threads: z.array(ThreadSearchResultItem).optional(),
  /** Слияние памяти графа: из результатов поиска извлекается sender → spreading activation → связанные факты. */
  relatedFacts: z.array(RelatedFactItem).optional(),
});
export type UnifiedSearchResult = z.infer<typeof UnifiedSearchResult>;

/** search_public: результаты публичного поиска */
export const SearchPublicResult = z.object({
  query: z.string(),
  users: z.array(z.object({ id: z.number(), name: z.string() })),
  chats: z.array(z.object({ id: z.number(), title: z.string() })),
});
export type SearchPublicResult = z.infer<typeof SearchPublicResult>;

/** preview_chat: предпросмотр чата */
export const ChatPreviewResult = z.object({
  title: z.string(),
  type: z.string(),
  memberCount: z.number(),
  withApproval: z.boolean().optional(),
  link: z.string(),
});
export type ChatPreviewResult = z.infer<typeof ChatPreviewResult>;

/** get_similar_channels: элемент похожего канала */
export const SimilarChannelItem = z.object({
  id: z.number(),
  title: z.string(),
});
export type SimilarChannelItem = z.infer<typeof SimilarChannelItem>;

/** get_bot_commands: список команд бота */
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

// ── Заметки ──

/** read_notes: элемент заметки */
export const NoteItem = z.object({
  id: z.number(),
  text: z.string(),
  date: z.string(),
});
export type NoteItem = z.infer<typeof NoteItem>;

// ── Знания ──

/** google: результат конвейера поиск → извлечение → синтез */
export const GoogleResult = z.object({
  answer: z.string(),
  sources: z.array(z.object({ title: z.string(), url: z.string() })),
});
export type GoogleResult = z.infer<typeof GoogleResult>;

/** visit: краткое содержание прочитанного по URL */
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

/** use_calendar_app: результат календаря */
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

/** use_countdown_app: результат обратного отсчёта */
export const CountdownResultSchema = z.object({
  target: z.string(),
  days: z.number(),
  weekday: z.string(),
});
export type CountdownResultSchema = z.infer<typeof CountdownResultSchema>;

// ── ADR-133 Wave 5: Selfcheck App ──

/** use_selfcheck_app: раздел измерения самопроверки */
export const SelfcheckSectionSchema = z.object({
  dimension: z.string(),
  label: z.string(),
  lines: z.array(z.string()),
});
export type SelfcheckSectionSchema = z.infer<typeof SelfcheckSectionSchema>;

/** use_selfcheck_app: результат самопроверки */
export const SelfcheckResultSchema = z.object({
  sections: z.array(SelfcheckSectionSchema),
});
export type SelfcheckResultSchema = z.infer<typeof SelfcheckResultSchema>;
