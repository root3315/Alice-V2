/**
 * TUI 渲染层 — Section 行级分配 + overflow 裁剪。
 *
 * 解决 prompt-builder 中 timeline 无限膨胀侵占其他 section 的问题。
 * Token 预算仍由 storyteller 管理（正交关系）。
 *
 * @see docs/adr/209-tui-native-prompt.md
 */

// ── 类型 ──────────────────────────────────────────────────────────────────

/** Section 行数规格：固定行数 或 填充剩余空间 */
export type SizeSpec = { type: "fixed"; value: number } | { type: "fill" };

/** 溢出策略：clip-top 保留最新（聊天历史），clip-bottom 保留开头（状态面板） */
export type OverflowPolicy = "clip-top" | "clip-bottom";

/** Section 声明 — prompt-builder 用它描述 user prompt 的空间布局 */
export interface SectionSpec {
  id: string;
  size: SizeSpec;
  overflow: OverflowPolicy;
}

/** Section 内容 + 声明的配对 */
export interface SectionInput {
  spec: SectionSpec;
  lines: string[];
}

/** 渲染结果中每个 section 的统计 */
export interface SectionStats {
  id: string;
  /** 原始内容行数 */
  originalLines: number;
  /** 分配到的行数 */
  allocatedRows: number;
  /** 实际输出行数 */
  outputLines: number;
  /** 被裁剪的行数 */
  clippedLines: number;
}

// ── 核心算法 ──────────────────────────────────────────────────────────────

/**
 * 将多个 section 按声明的行级预算渲染为最终文本。
 *
 * 算法：
 * 1. 固定 section 分配 maxRows
 * 2. fill section 均分剩余行数
 * 3. 每个 section 按 overflow 策略裁剪
 * 4. 拼接输出（section 之间空行分隔）
 *
 * @param sections - 按显示顺序排列的 section 列表
 * @param totalRows - 总行数预算（0 表示不限制）
 * @returns 渲染后的文本 + 统计信息
 */
export function renderSections(
  sections: SectionInput[],
  totalRows = 0,
): { text: string; stats: SectionStats[] } {
  if (sections.length === 0) return { text: "", stats: [] };

  // ── Step 1: 行数分配 ──
  const allocations = allocateRows(sections, totalRows);

  // ── Step 2: 按 overflow 策略裁剪 + 拼接 ──
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

// ── 内部函数 ──────────────────────────────────────────────────────────────

/**
 * 按 SizeSpec 分配行数。
 *
 * 1. fixed section 取 min(value, content.length)
 * 2. 剩余行数均分给 fill section
 * 3. totalRows=0 时不限制（fill section 取内容实际行数）
 */
export function allocateRows(sections: SectionInput[], totalRows: number): number[] {
  const result = new Array<number>(sections.length);
  let usedFixed = 0;
  let fillCount = 0;

  // 第一遍：分配固定 section
  for (let i = 0; i < sections.length; i++) {
    const { spec, lines } = sections[i];
    if (spec.size.type === "fixed") {
      result[i] = Math.min(spec.size.value, lines.length);
      usedFixed += result[i];
    } else {
      fillCount++;
    }
  }

  // 第二遍：分配 fill section
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
 * 按 overflow 策略裁剪行。
 *
 * - clip-top: 保留最后 maxRows 行（最新内容）
 * - clip-bottom: 保留前 maxRows 行（开头内容）
 */
export function clipLines(lines: string[], maxRows: number, overflow: OverflowPolicy): string[] {
  if (lines.length <= maxRows) return lines;
  if (maxRows <= 0) return [];
  return overflow === "clip-top" ? lines.slice(-maxRows) : lines.slice(0, maxRows);
}
