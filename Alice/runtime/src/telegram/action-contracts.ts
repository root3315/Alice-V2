/**
 * Result Contract — типобезопасный мост для CQRS-результатов запросов.
 *
 * Schema является единым источником истины для write (impl store) и read (formatResult safeParse).
 * Устраняет неявную синхронизацию формы между impl и formatResult.
 *
 * Возвращаемое значение удовлетворяет QueryRuntimeFields (runtime-подмножество CQRS) —
 * при разворачивании в TelegramActionDef action-регистрация добавляет returnDoc, компилятор принудительно обеспечивает полноту.
 *
 * @see docs/adr/105-react-cqrs-read-during-next.md
 * @see src/telegram/action-types.ts — типы QueryRuntimeFields / QueryActionFields
 */

import { z } from "zod";
import { PromptBuilder } from "../core/prompt-style.js";
import type { WorldModel } from "../graph/world-model.js";
import {
  BotCommandsResult,
  CallbackAnswerResult,
  ChatPreviewResult,
  CommandOutputResult,
  InlineQueryResult,
  NoteItem,
  SearchPublicResult,
  SimilarChannelItem,
  StickerSetDetail,
  StickerSetSummary,
  UnifiedSearchResult,
} from "./action-schemas.js";
import type { QueryRuntimeFields } from "./action-types.js";

// ═══════════════════════════════════════════════════════════════════════════
// Фабрика Contract
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Создаёт типобезопасный CQRS result contract.
 *
 * Возвращаемый объект одновременно удовлетворяет:
 * - `QueryActionFields` (разворачивается в TelegramActionDef)
 * - методу `store()` (вызывается из impl, проверка типов на этапе компиляции)
 *
 * @param schema Zod-схема — единый источник истины для write/read
 * @param source Семантика узла хранения результата — "self" или "target"
 * @param attrKey Имя атрибута графа — результат хранится в этом атрибуте
 * @param format Функция форматирования — преобразует результат в строки observation
 */
export function resultContract<T extends z.ZodTypeAny>(
  schema: T,
  source: "self" | "target",
  attrKey: string,
  format: (data: z.infer<T>) => string[] | null,
) {
  return {
    returnsResult: true as const,
    resultSource: source,
    resultAttrKey: attrKey,
    /** Вызывается из impl — компилятор проверяет, что сохраняемые данные соответствуют схеме. */
    store(G: WorldModel, nodeId: string, data: z.infer<T>): void {
      if (!G.has(nodeId)) return;
      G.setDynamic(nodeId, attrKey, data);
    },
    /** Вызывается из formatQueryObservations — runtime safeParse + форматирование. */
    formatResult(raw: unknown): string[] | null {
      const parsed = schema.safeParse(raw);
      if (!parsed.success) return null;
      return format(parsed.data);
    },
  } satisfies QueryRuntimeFields & {
    store: (G: WorldModel, nodeId: string, data: z.infer<T>) => void;
  };
}

/** Тип возврата resultContract (включает метод store). */
export type ResultContract<T extends z.ZodTypeAny> = ReturnType<typeof resultContract<T>>;

// ═══════════════════════════════════════════════════════════════════════════
// Экземпляры Contract
// ═══════════════════════════════════════════════════════════════════════════

// ── Bot-взаимодействие ──

export const clickInlineButtonContract = resultContract(
  CallbackAnswerResult,
  "target",
  "last_callback_answer",
  ({ msgId, message, url }) => {
    if (!message && !url) return null;
    const m = new PromptBuilder();
    m.line(`Button callback result (msg #${msgId}):`);
    if (message) m.kv("Message", message);
    if (url) m.kv("URL", url);
    return m.build();
  },
);

export const inlineQueryContract = resultContract(
  InlineQueryResult,
  "target",
  "last_inline_query",
  ({ botUsername, queryId, results }) => {
    if (results.length === 0) return null;
    const m = new PromptBuilder();
    m.line(`Inline results from @${botUsername} (queryId: ${queryId}):`);
    for (const r of results.slice(0, 10)) {
      m.line(
        `• ${r.title ?? "(no title)"}${r.description ? ` — ${r.description}` : ""} [resultId: ${r.id}]`,
      );
    }
    m.line("→ send_inline_result(queryId, resultId) — copy the queryId and resultId above.");
    return m.build();
  },
);

// ── Стикеры ──

export const listStickersContract = resultContract(
  z.array(StickerSetSummary),
  "self",
  "installed_stickers",
  (data) => {
    if (data.length === 0) return null;
    const m = new PromptBuilder();
    m.line("Installed sticker sets:");
    for (const s of data.slice(0, 15)) {
      m.line(`${s.shortName} — "${s.title}" (${s.count} stickers)`);
    }
    m.line(
      "→ Use `irc sticker --keyword <keyword>` with palette dimensions: happy, sad, angry, surprised, shy, tired, love, scared, wave, hug, cry, laugh, sleep, eat, dance, thumbsup, facepalm, peek.",
    );
    return m.build();
  },
);

export const getStickerSetContract = resultContract(
  StickerSetDetail,
  "self",
  "last_sticker_set",
  ({ shortName, title, stickers }) => {
    if (stickers.length === 0) return null;
    const m = new PromptBuilder();
    m.line(`Sticker set "${title}" (${shortName}):`);
    for (const s of stickers.slice(0, 20)) {
      if (!s.emoji) continue;
      m.line(`${s.emoji}`);
    }
    m.line(
      "→ Use `irc sticker --keyword <keyword>` with a palette dimension such as happy, shy, laugh, hug, wave, or peek.",
    );
    return m.build();
  },
);

// ── Поиск ──

/** ADR-145 W3: Единый search contract (объединение источников: messages/diary/threads/all). */
export const unifiedSearchContract = resultContract(
  UnifiedSearchResult,
  "self",
  "last_search",
  ({ expression, source, messages, diary, threads, relatedFacts }) => {
    const totalCount = (messages?.length ?? 0) + (diary?.length ?? 0) + (threads?.length ?? 0);
    if (totalCount === 0) return [`No results for "${expression}" in ${source}.`];
    const m = new PromptBuilder();
    m.line(`Search results for "${expression}" (${source}, ${totalCount} found):`);

    if (messages?.length) {
      if (source === "all") m.line("— Messages:");
      for (const r of messages.slice(0, 10)) {
        const time = r.date.slice(11, 16);
        // Предпочтительнее FTS5 snippet (уже помечены ключевые слова), иначе усекаем оригинал
        const preview = r.snippet || (r.text.length > 120 ? `${r.text.slice(0, 120)}...` : r.text);
        m.line(`[${time}] ${r.sender} (${r.chatId}): ${preview}`);
      }
    }
    if (diary?.length) {
      if (source === "all") m.line("— Diary:");
      for (const d of diary.slice(0, 5)) {
        const time = d.date.slice(0, 10);
        const aboutLabel = d.about ? ` [about ${d.about}]` : "";
        m.line(`[${time}]${aboutLabel} ${d.content}`);
      }
    }
    if (threads?.length) {
      if (source === "all") m.line("— Threads:");
      for (const t of threads.slice(0, 5)) {
        m.line(
          `#${t.id} "${t.title}" (${t.status}/${t.weight})${t.summary ? ` — ${t.summary.slice(0, 80)}` : ""}`,
        );
      }
    }
    if (relatedFacts?.length) {
      m.line("— Related memories:");
      for (const f of relatedFacts) {
        m.line(`· ${f.fact}`);
      }
    }
    return m.build();
  },
);

export const searchPublicContract = resultContract(
  SearchPublicResult,
  "self",
  "last_search_public",
  ({ query, users, chats }) => {
    if (users.length === 0 && chats.length === 0) return null;
    const m = new PromptBuilder();
    m.line(`Public search results for "${query}":`);
    for (const c of chats.slice(0, 10)) {
      m.line(`[chat ${c.id}] ${c.title}`);
    }
    for (const u of users.slice(0, 5)) {
      m.line(`[user ${u.id}] ${u.name}`);
    }
    return m.build();
  },
);

export const previewChatContract = resultContract(
  ChatPreviewResult,
  "self",
  "last_chat_preview",
  ({ title, type, memberCount, withApproval, link }) => {
    return [
      `Chat preview: "${title}" (${type}, ${memberCount} members${withApproval ? ", requires approval" : ""})`,
      `→ Join via \`irc join ${link}\`.`,
    ];
  },
);

export const getSimilarChannelsContract = resultContract(
  z.array(SimilarChannelItem),
  "target",
  "similar_channels",
  (data) => {
    if (data.length === 0) return null;
    const m = new PromptBuilder();
    m.line("Similar channels:");
    for (const c of data.slice(0, 10)) {
      m.line(`[${c.id}] ${c.title}`);
    }
    return m.build();
  },
);

export const getBotCommandsContract = resultContract(
  BotCommandsResult,
  "self",
  "last_bot_commands",
  ({ botId, commands }) => {
    if (commands.length === 0) return null;
    const m = new PromptBuilder();
    m.line(`Bot @${botId} commands:`);
    for (const c of commands.slice(0, 20)) {
      m.line(`/${c.command} — ${c.description}`);
    }
    return m.build();
  },
);

// ── Заметки ──

export const readNotesContract = resultContract(z.array(NoteItem), "self", "last_notes", (data) => {
  if (data.length === 0) return null;
  const m = new PromptBuilder();
  m.line(`Saved Messages (${data.length} recent notes):`);
  for (const n of data.slice(0, 10)) {
    const preview = n.text.length > 100 ? `${n.text.slice(0, 100)}...` : n.text;
    m.timeline(n.date, "", preview);
  }
  return m.build();
});

// ── Знания ──

export const createInviteLinkContract = resultContract(
  z.string().min(1),
  "target",
  "last_invite_link",
  (link) => {
    const normalized = link
      .split(/\s+/)
      .map((part) => part.trim())
      .find((part) => part.length > 0);
    if (!normalized) return null;
    const m = new PromptBuilder();
    m.kv("Invite link", normalized);
    return m.build();
  },
);

export const commandOutputContract = resultContract(
  CommandOutputResult,
  "self",
  "last_command_output",
  ({ command, stdout }) => {
    const lines = stdout
      .split("\n")
      .map((line) => line.trimEnd())
      .filter((line) => line.length > 0)
      .slice(0, 40);
    if (lines.length === 0) return [`${command}: (no output)`];
    return [`${command}:`, ...lines];
  },
);

// googleContract, visitContract — перенесены в Skill CLI-скрипты (runtime/skills/google/, runtime/skills/visit/)
// Результаты google/visit получаются через Exa API + LLM-конвейер Engine API,
// CLI-скрипт напрямую записывает в атрибуты графа self.last_google_result / self.last_visit_result.

// selfcheckContract — перенесён в Skill CLI-скрипт (runtime/skills/selfcheck/)
// Результаты selfcheck получаются через эндпоинт Engine API POST /engine/selfcheck,
// CLI-скрипт напрямую записывает в атрибут графа self.last_selfcheck_result.
