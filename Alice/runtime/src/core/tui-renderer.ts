/**
 * TUI-слой рендеринга — построчное распределение по секциям + обрезка при переполнении.
 *
 * Решает проблему бесконечного роста timeline в prompt-builder, который вытесняет другие секции.
 * Token-бюджет по-прежнему управляется storyteller (ортогональные отношения).
 *
 * @see docs/adr/209-tui-native-prompt.md
 */

// ── Типы ──────────────────────────────────────────────────────────────────

/** Спецификация строк секции: фиксированное количество строк или заполнение оставшегося пространства */
export type SizeSpec = { type: "fixed"; value: number } | { type: "fill" };

/** Политика переполнения: clip-top сохраняет последние строки (история чата), clip-bottom сохраняет начало (панель статуса) */
export type OverflowPolicy = "clip-top" | "clip-bottom";

/** Объявление секции — prompt-builder использует его для описания пространственного расположения user prompt */
export interface SectionSpec {
  id: string;
  size: SizeSpec;
  overflow: OverflowPolicy;
}

/** Пара: содержимое секции + её объявление */
export interface SectionInput {
  spec: SectionSpec;
  lines: string[];
}

/** Статистика каждой секции в результате рендеринга */
export interface SectionStats {
  id: string;
  /** Количество строк исходного содержимого */
  originalLines: number;
  /** Количество выделенных строк */
  allocatedRows: number;
  /** Фактическое количество выходных строк */
  outputLines: number;
  /** Количество обрезанных строк */
  clippedLines: number;
}

// ── Основной алгоритм ─────────────────────────────────────────────────────

/**
 * Рендерит несколько секций в итоговый текст по объявленному построчному бюджету.
 *
 * Алгоритм:
 * 1. Фиксированным секциям выделяем maxRows
 * 2. Fill-секции равномерно делят оставшиеся строки
 * 3. Каждая секция обрезается по политике overflow
 * 4. Результаты склеиваются (секции разделяются пустой строкой)
 *
 * @param sections - список секций в порядке отображения
 * @param totalRows - общий бюджет строк (0 — без ограничений)
 * @returns отрендеренный текст + статистика
 */
export function renderSections(
  sections: SectionInput[],
  totalRows = 0,
): { text: string; stats: SectionStats[] } {
  if (sections.length === 0) return { text: "", stats: [] };

  // ── Шаг 1: Распределение строк ──
  const allocations = allocateRows(sections, totalRows);

  // ── Шаг 2: Обрезка по политике overflow + склейка ──
  const outputParts: string[] = [];
  const stats: SectionStats[] = [];

  for (let i = 0; i < sections.length; i++) {
    const { spec, lines } = sections[i];
    const allocated = allocations[i];
    const clipped = clipLines(lines, allocated, spec.overflow);

    stats.push({
      id: spec.id,
      originalLines: lines.length,
      allocatedRows: allocated,
      outputLines: clipped.length,
      clippedLines: Math.max(0, lines.length - clipped.length),
    });

    if (clipped.length > 0) {
      outputParts.push(clipped.join("\n"));
    }
  }

  return { text: outputParts.join("\n\n"), stats };
}

// ── Внутренние функции ─────────────────────────────────────────────────────

/**
 * Распределяет строки согласно SizeSpec.
 *
 * 1. fixed-секция получает min(value, content.length)
 * 2. Оставшиеся строки равномерно делятся между fill-секциями
 * 3. При totalRows=0 ограничений нет (fill-секция берёт фактическое количество строк содержимого)
 */
export function allocateRows(sections: SectionInput[], totalRows: number): number[] {
  const result = new Array<number>(sections.length);
  let usedFixed = 0;
  let fillCount = 0;

  // Первый проход: распределяем фиксированные секции
  for (let i = 0; i < sections.length; i++) {
    const { spec, lines } = sections[i];
    if (spec.size.type === "fixed") {
      result[i] = Math.min(spec.size.value, lines.length);
      usedFixed += result[i];
    } else {
      fillCount++;
    }
  }

  // Второй проход: распределяем fill-секции
  if (fillCount > 0) {
    if (totalRows <= 0) {
      for (let i = 0; i < sections.length; i++) {
        if (sections[i].spec.size.type === "fill") {
          result[i] = sections[i].lines.length;
        }
      }
    } else {
      const remaining = Math.max(0, totalRows - usedFixed);
      const perFill = Math.floor(remaining / fillCount);
      let leftover = remaining - perFill * fillCount;

      for (let i = 0; i < sections.length; i++) {
        if (sections[i].spec.size.type === "fill") {
          const extra = leftover > 0 ? 1 : 0;
          if (extra) leftover--;
          result[i] = Math.min(perFill + extra, sections[i].lines.length);
        }
      }
    }
  }

  return result;
}

/**
 * Обрезает строки согласно политике overflow.
 *
 * - clip-top: сохраняет последние maxRows строк (самый новый контент)
 * - clip-bottom: сохраняет первые maxRows строк (контент с начала)
 */
export function clipLines(lines: string[], maxRows: number, overflow: OverflowPolicy): string[] {
  if (lines.length <= maxRows) return lines;
  if (maxRows <= 0) return [];
  return overflow === "clip-top" ? lines.slice(-maxRows) : lines.slice(0, maxRows);
}
