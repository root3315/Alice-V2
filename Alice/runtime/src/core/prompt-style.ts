/**
 * Alice Prompt Style Spec — конструктор разметки + страховочный linter.
 *
 * Основной механизм: PromptBuilder предоставляет только допустимые операции (heading/kv/line/list/timeline),
 * исключая нарушения ещё на этапе построения — без постфактум-проверки.
 *
 * Страховочная сеть: lintPromptStyle() выполняет финальную проверку собранного текста,
 * перехватывая голые строки, обошедшие builder.
 *
 * Спецификация разметки (Style Spec):
 *   Разрешено: ## Title, Key: value, - item, [HH:MM] Name: text, ```code```, ---, голый текст
 *   Запрещено: отступы, > blockquote, **bold**, *italic*, вложенные списки, #/###
 *
 * @see docs/adr/141-prompt-style-spec.md
 */

import { createLogger } from "../utils/logger.js";

const log = createLogger("prompt-style");

// ═══════════════════════════════════════════════════════════════════════════
// Branded type — может быть получен только из PromptBuilder
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Branded string тип — может быть получен только из PromptBuilder.
 * Предотвращает обход builder'а через голый string[] при инжекции в ContributionItem.
 */
export type PromptLine = string & { readonly __brand: "PromptLine" };

// ═══════════════════════════════════════════════════════════════════════════
// Builder — соответствие требованиям гарантируется в момент построения
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Конструктор содержимого Prompt.
 *
 * Предоставляет только допустимые операции, вывод гарантированно соответствует Style Spec.
 * Mod использует `const m = new PromptBuilder()` в contribute() вместо голого `string[]`.
 *
 * ```typescript
 * const m = new PromptBuilder();
 * m.kv("Mood", "neutral");
 * m.timeline("14:32", "Carol", "你看！");
 * m.line("Some observation.");
 * return section("key", m.build());
 * ```
 */
export class PromptBuilder {
  private readonly lines: PromptLine[] = [];

  /** ## Заголовок раздела. */
  heading(title: string): this {
    this.lines.push(`## ${title}` as PromptLine);
    return this;
  }

  /** Key: value пара ключ-значение. */
  kv(key: string, value: string): this {
    this.lines.push(`${key}: ${value.replaceAll("\n", " ")}` as PromptLine);
    return this;
  }

  /** Строка голого текста (без отступа). Встроенные переносы строк объединяются в пробел (H15: внешний текст с \n не должен подделать заголовок/структуру промпта). */
  line(text: string): this {
    this.lines.push(text.replaceAll("\n", " ") as PromptLine);
    return this;
  }

  /** Пустая строка. */
  blank(): this {
    this.lines.push("" as PromptLine);
    return this;
  }

  /** - Элемент списка (без отступа, плоский). Встроенные переносы строк автоматически объединяются в пробел во избежание поломки форматирования. */
  list(items: string[]): this {
    for (const item of items) {
      this.lines.push(`- ${item.replaceAll("\n", " ")}` as PromptLine);
    }
    return this;
  }

  /** [HH:MM] Name (msgId N): text запись временной шкалы. msgId опционален, используется для ссылок irc forward --ref. */
  timeline(time: string, name: string, text: string, msgId?: number | null): this {
    const idTag = msgId != null && msgId > 0 ? ` (msgId ${msgId})` : "";
    this.lines.push(`[${time}] ${name}${idTag}: ${text.replaceAll("\n", " ")}` as PromptLine);
    return this;
  }

  /** --- Разделитель. */
  separator(): this {
    this.lines.push("---" as PromptLine);
    return this;
  }

  /** Выводит PromptLine[], напрямую используемый в ContributionItem.lines. */
  build(): PromptLine[] {
    return [...this.lines];
  }

  /** Разбивает голый текст (может содержать переносы строк) на PromptLine[]. Используется для предварительно форматированных констант (например SOUL_CORE). */
  static fromRaw(text: string): PromptLine[] {
    return text.split("\n") as PromptLine[];
  }

  /** Помечает однострочный текст как PromptLine. Для многострочного текста используйте fromRaw(). */
  static of(text: string): PromptLine {
    if (text.includes("\n")) {
      log.warn("PromptBuilder.of() received multi-line text; use fromRaw() instead", {
        preview: text.slice(0, 80),
      });
    }
    return text as PromptLine;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Linter — страховочная сеть (финальная проверка)
// ═══════════════════════════════════════════════════════════════════════════

export interface StyleViolation {
  rule: string;
  line: number;
  text: string;
  message: string;
}

export interface PromptStyleEnforcementOptions {
  /**
   * Как логировать нарушения.
   *
   * - warn: По умолчанию. Для чисто внутренне генерируемых текстов, таких как system prompt
   * - debug: Только аудит, не засоряет обычные логи. Для user prompt с необработанным содержимым Telegram
   * - silent: Только возвращает счётчик, без логирования
   */
  violationLogLevel?: "warn" | "debug" | "silent";
}

const RULES: Array<{ name: string; test: (line: string) => boolean; msg: string }> = [
  { name: "no-indent", test: (l) => /^[ \t]+\S/.test(l), msg: "Отступ в начале строки запрещён" },
  { name: "no-bare-title", test: (l) => /^[A-Z][\w ]+:\s*$/.test(l), msg: "Голый заголовок → ## Title" },
  { name: "no-h1", test: (l) => /^# [^#]/.test(l), msg: "# запрещён → используйте ##" },
  { name: "no-h3", test: (l) => /^###+ /.test(l), msg: "### и глубже запрещены" },
  { name: "no-bold", test: (l) => /\*\*[^*]+\*\*/.test(l), msg: "**bold** запрещён" },
  { name: "no-blockquote", test: (l) => /^> /.test(l), msg: "> blockquote запрещён" },
  { name: "no-nested-list", test: (l) => /^ +- /.test(l), msg: "Вложенные списки запрещены" },
];

/**
 * Проверяет собранный текст prompt на соответствие спецификации разметки.
 *
 * Автоматически пропускает блоки кода ```...``` (в области справки допускаются отступы и спецформаты)
 * и разделители `---` (жёсткая граница зоны).
 */
export function lintPromptStyle(text: string): StyleViolation[] {
  const lines = text.split("\n");
  const violations: StyleViolation[] = [];
  let inCodeBlock = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Переключение границы блока кода
    if (line.startsWith("```")) {
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (inCodeBlock) continue;
    if (line.trim() === "" || line.trim() === "---") continue;

    for (const rule of RULES) {
      if (rule.test(line)) {
        violations.push({ rule: rule.name, line: i + 1, text: line, message: rule.msg });
      }
    }
  }

  return violations;
}

/**
 * Принудительная проверка — при наличии нарушений пишет warn в лог.
 * Вызывается в конце конвейера buildPrompt.
 *
 * @returns Количество нарушений
 */
export function enforcePromptStyle(
  text: string,
  label: string,
  options: PromptStyleEnforcementOptions = {},
): number {
  const violations = lintPromptStyle(text);
  if (violations.length > 0) {
    const payload = {
      count: violations.length,
      first5: violations.slice(0, 5).map((v) => `L${v.line} [${v.rule}] ${v.message}: ${v.text}`),
    };
    const level = options.violationLogLevel ?? "warn";
    if (level === "warn") {
      log.warn(`Prompt style violations in ${label}`, payload);
    } else if (level === "debug") {
      log.debug(`Prompt style violations in ${label}`, payload);
    }
  }
  return violations.length;
}
