/**
 * Ограничения Zod по количеству символов для примитивов sandbox — защита от аномального вывода LLM.
 *
 * Используем .transform() для усечения вместо .max() для отклонения:
 * - лучше усечь, чем потерять всю операцию
 * - LLM не чувствует точного числа символов, отклонять за лишний 1 символ неразумно
 */
import { z } from "zod";

/** Создаёт schema усекаемой строки: при превышении max символов молча усекает. */
const truncStr = (max: number) => z.string().transform((s) => s.slice(0, max));

// ── Общие перечисления ─────────────────────────────────────────────────────────────

/**
 * Семантические метки Deadline — LLM выбирает метку, код сопоставляет числовое значение.
 * Следует принципам AGENTS.md «семантика — за LLM, структура — за кодом» и «семантическая доступность для LLM».
 * Независимо от языка: LLM любого языка корректно выбирает эти английские метки.
 */
export const DEADLINE_LABELS = [
  "hours",
  "today",
  "tomorrow",
  "days",
  "week",
  "weeks",
  "month",
] as const;

/** Метка Deadline → horizon (ticks, 1 tick ≈ 1 hour). */
export const DEADLINE_TO_HORIZON: Record<(typeof DEADLINE_LABELS)[number], number> = {
  hours: 12,
  today: 24,
  tomorrow: 48,
  days: 168,
  week: 168,
  weeks: 336,
  month: 720,
};

/**
 * Преобразует семантическую метку deadline в horizon (ticks).
 * Некорректная метка — fallback к "week" (168 ticks), без отклонения.
 */
export function deadlineToHorizon(label?: string): number {
  if (!label) return DEADLINE_TO_HORIZON.week;
  return DEADLINE_TO_HORIZON[label as (typeof DEADLINE_LABELS)[number]] ?? DEADLINE_TO_HORIZON.week;
}

// ── Очистка текста ─────────────────────────────────────────────────────────────

/**
 * Удаляет аннотационные маркеры, скопированные LLM из контекста prompt.
 * Совпадает только с известными ключевыми словами медиа/метаданных или форматом реакций emoji×count, не затрагивая обычный текст.
 *
 * Версия в квадратных скобках (legacy + safety net — перехватывает старые форматы, скопированные LLM из истории):
 *   Pattern 1: `[keyword ...]` — аннотация ключевого слова (sticker/photo/voice/...)
 *   Pattern 2: `[emoji×N ...]` — аннотация реакции (без ключевого слова, распознаётся по ×digits)
 *
 * Версия в круглых скобках (defense-in-depth для нового формата — prompt теперь использует аннотации `(...)`):
 *   Pattern 3: `(keyword ...)` — если LLM скопировал и круглые скобки в вывод
 *   Pattern 4: `(emoji×N ...)` — аннотация реакции в круглых скобках
 */
const KEYWORD_ANNOTATION_RE =
  /\[(sticker|photo|voice|gif|video|document|media|poll|contact|venue|reacts|edited|fwd)(?:[:\s|][^\]]*)?]/gi;
const REACTION_ANNOTATION_RE = /\[[^[\]]*×\d+[^[\]]*]/g;

const PAREN_ANNOTATION_RE =
  /\((sticker|photo|voice|gif|video|document|media|poll|contact|venue|reacts|edited|fwd)(?:[:\s|][^)]*)??\)/gi;
const PAREN_REACTION_RE = /\([^()]*×\d+[^()]*\)/g;

/**
 * Обнаружение аннотаций в квадратных скобках — safety net для Zod refine.
 *
 * Исправление аудита: сужаем область совпадения. Старое регулярное выражение `/\[(?!\d{1,2}:\d{2}])[^[\]]{2,}\]/`
 * ошибочно отклоняло легитимный китайский контент в квадратных скобках, генерируемый LLM ([笑], [链接文本], [index]),
 * из-за чего сообщения с ошибкой safeParse молча отбрасывались ("немота").
 *
 * Новая стратегия: совпадаем только с известными паттернами аннотаций prompt (содержимое квадратных скобок,
 * начинающееся с английского ключевого слова media), а не со "всем содержимым квадратных скобок".
 * KEYWORD_ANNOTATION_RE и REACTION_ANNOTATION_RE уже обрабатывают большинство случаев на этапе sanitize,
 * здесь — последний рубеж defense-in-depth.
 */
const BRACKET_ANNOTATION_RE =
  /\[(?:sticker|photo|voice|gif|video|document|media|poll|contact|venue|reacts|edited|fwd|forwarded|reply|audio|action)\b[^[\]]*]/i;

/**
 * Прямые ASCII-кавычки → типографские кавычки.
 *
 * В режиме generateObject / tool calling LLM находится в пространстве JSON-синтаксиса
 * и склонен использовать ASCII `'` `"` для цитирования — люди в чате так не пишут.
 *
 * Оставляем только два вида кавычек:
 * - Китайские кавычки ""（U+201C/U+201D）— для китайского текста всегда
 * - Английский апостроф '（U+2019）— только для сокращений типа don't / it's
 *
 * Ключевое правило: `'中文'` → `"中文"` (китайцы не используют одинарные кавычки как основные).
 */
const CJK_RE = /[\u4e00-\u9fff\u3400-\u4dbf]/;

export function normalizeQuotes(s: string): string {
  // Парные двойные кавычки "..." → "..."
  let r = s.replace(/"([^"\n]+)"/g, "\u201c$1\u201d");
  // Парные одинарные кавычки '...': CJK-содержимое повышается до китайских двойных кавычек, английское остаётся в одинарных
  r = r.replace(/'([^'\n]+)'/g, (_, content) =>
    CJK_RE.test(content) ? `\u201c${content}\u201d` : `\u2018${content}\u2019`,
  );
  // Оставшиеся одиночные " → "
  r = r.replace(/"/g, "\u201d");
  // Оставшиеся одиночные ' → '（английский апостроф）
  r = r.replace(/'/g, "\u2019");
  return r;
}

/**
 * Удаляет одиночную точку в конце предложения (китайскую 。 или английскую .).
 * Многоточия (...、。。。、…) сохраняются — они несут выразительную функцию, а не артефакт LLM.
 */
function trimTrailingPeriod(s: string): string {
  return s.replace(/(?<![.。…])([.。])$/, "");
}

/**
 * В текстовых параметрах shell-скриптов LLM часто записывает перенос строки как литерал \n.
 * Пользователь Telegram должен видеть настоящий перенос строки, а не обратный слеш+n.
 */
function decodeEscapedNewlines(s: string): string {
  return s
    .replace(/\\r\\n/g, "\n")
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\n");
}

/** Очистка исходящего текста LLM: удаление утечших аннотационных маркеров + точки в конце предложения + нормализация кавычек + усечение. */
export function sanitizeOutgoingText(s: string, max = 4096): string {
  return normalizeQuotes(
    trimTrailingPeriod(
      decodeEscapedNewlines(s)
        .replace(KEYWORD_ANNOTATION_RE, "")
        .replace(REACTION_ANNOTATION_RE, "")
        .replace(PAREN_ANNOTATION_RE, "")
        .replace(PAREN_REACTION_RE, "")
        .trim(),
    ),
  ).slice(0, max);
}

// ── Schema примитивов управления потоком ─────────────────────────────────────────────────────

/** think(thought) — ограничение 2000 символов; сверхдлинные рассуждения бессмысленны. */
export const ThinkSchema = truncStr(2000);

/** stay_silent(reason) — ограничение 500 символов. */
export const StaySilentSchema = truncStr(500);

/** reply(text, replyTo?) — text 4096 (лимит Telegram API), replyTo положительное целое. */
export const ReplySchema = z.object({
  text: z
    .string()
    .min(1)
    .refine((s) => !BRACKET_ANNOTATION_RE.test(s), {
      message: "square bracket annotations are not allowed in message text",
    })
    .transform((s) => sanitizeOutgoingText(s)),
  replyTo: z.number().int().positive().optional(),
});

/** say(text) — произнести фразу в группу/чат (без привязки к конкретному сообщению). ADR-118: семантическое разделение. */
export const SaySchema = z.object({
  text: z
    .string()
    .min(1)
    .refine((s) => !BRACKET_ANNOTATION_RE.test(s), {
      message: "square bracket annotations are not allowed in message text",
    })
    .transform((s) => sanitizeOutgoingText(s)),
});
