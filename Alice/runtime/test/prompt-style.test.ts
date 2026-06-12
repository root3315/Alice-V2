/**
 * prompt-style.test.ts — 排版规范 linter + builder 测试。
 *
 * @see docs/adr/141-prompt-style-spec.md
 */

import { describe, expect, it } from "vitest";
import { lintPromptStyle, PromptBuilder } from "../src/core/prompt-style.js";

// ═══════════════════════════════════════════════════════════════════════════
// Linter 规则测试
// ═══════════════════════════════════════════════════════════════════════════

describe("lintPromptStyle", () => {
  it("合规文本 → 零 violation", () => {
    const text = [
      "## Your Context",
      "TARGET_CHAT: Carol",
      "",
      "- item one",
      "- item two",
      "",
      "[14:32] Carol: hello",
      "[14:33] Alice (you): hi",
      "",
      "Some bare text here.",
      "",
      "---",
      "",
      "## Messages",
      "More content.",
    ].join("\n");

    expect(lintPromptStyle(text)).toEqual([]);
  });

  it("no-indent: 行首缩进被检出", () => {
    const violations = lintPromptStyle("  indented line");
    expect(violations).toHaveLength(1);
    expect(violations[0].rule).toBe("no-indent");
  });

  it("no-indent: tab 缩进被检出", () => {
    const violations = lintPromptStyle("\tindented line");
    expect(violations).toHaveLength(1);
    expect(violations[0].rule).toBe("no-indent");
  });

  it("no-bare-title: 裸标题被检出", () => {
    const violations = lintPromptStyle("Recent Activity:");
    expect(violations).toHaveLength(1);
    expect(violations[0].rule).toBe("no-bare-title");
  });

  it("no-bare-title: Key: value 不触发（有值）", () => {
    const violations = lintPromptStyle("Mood: neutral");
    expect(violations).toEqual([]);
  });

  it("no-h1: # Title 被检出", () => {
    const violations = lintPromptStyle("# Big Title");
    expect(violations).toHaveLength(1);
    expect(violations[0].rule).toBe("no-h1");
  });

  it("no-h1: ## Title 不触发", () => {
    const violations = lintPromptStyle("## Section Title");
    expect(violations).toEqual([]);
  });

  it("no-h3: ### 及更深被检出", () => {
    expect(lintPromptStyle("### Subsection")[0].rule).toBe("no-h3");
    expect(lintPromptStyle("#### Deep")[0].rule).toBe("no-h3");
  });

  it("no-bold: **bold** 被检出", () => {
    const violations = lintPromptStyle("This is **important** text");
    expect(violations).toHaveLength(1);
    expect(violations[0].rule).toBe("no-bold");
  });

  it("no-blockquote: > 引用被检出", () => {
    const violations = lintPromptStyle("> This is a quote");
    expect(violations).toHaveLength(1);
    expect(violations[0].rule).toBe("no-blockquote");
  });

  it("no-nested-list: 缩进列表被检出", () => {
    const violations = lintPromptStyle("  - nested item");
    // 同时触发 no-indent 和 no-nested-list
    const rules = violations.map((v) => v.rule);
    expect(rules).toContain("no-nested-list");
  });

  it("代码块内跳过所有规则", () => {
    const text = [
      "```typescript",
      "  const x = 1;", // 缩进——在代码块内，应跳过
      "  **bold**", // bold——在代码块内，应跳过
      "  > quote", // blockquote——在代码块内，应跳过
      "```",
    ].join("\n");

    expect(lintPromptStyle(text)).toEqual([]);
  });

  it("空行和分隔线不触发", () => {
    const text = ["", "   ", "---"].join("\n");
    expect(lintPromptStyle(text)).toEqual([]);
  });

  it("violation 包含正确行号", () => {
    const text = ["line 1 ok", "", "  indented on line 3"].join("\n");
    const violations = lintPromptStyle(text);
    expect(violations[0].line).toBe(3);
    expect(violations[0].text).toBe("  indented on line 3");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Builder 测试
// ═══════════════════════════════════════════════════════════════════════════

describe("PromptBuilder", () => {
  it("heading 输出 ## 前缀", () => {
    const m = new PromptBuilder();
    m.heading("My Section");
    expect(m.build()).toEqual(["## My Section"]);
  });

  it("kv 输出 Key: value", () => {
    const m = new PromptBuilder();
    m.kv("Mood", "neutral");
    expect(m.build()).toEqual(["Mood: neutral"]);
  });

  it("timeline 输出零缩进时间线", () => {
    const m = new PromptBuilder();
    m.timeline("14:32", "Carol", "你好");
    expect(m.build()).toEqual(["[14:32] Carol: 你好"]);
  });

  it("list 输出零缩进列表", () => {
    const m = new PromptBuilder();
    m.list(["apple", "banana"]);
    expect(m.build()).toEqual(["- apple", "- banana"]);
  });

  it("list 将内嵌换行合并为空格", () => {
    const m = new PromptBuilder();
    m.list(["line1\nline2", "a\nb\nc"]);
    expect(m.build()).toEqual(["- line1 line2", "- a b c"]);
  });

  it("list 换行合并后通过 linter", () => {
    const m = new PromptBuilder();
    m.list(["user said:\nI'm sad"]);
    const text = m.build().join("\n");
    expect(lintPromptStyle(text)).toEqual([]);
  });

  it("链式调用", () => {
    const lines = new PromptBuilder()
      .heading("Test")
      .kv("Key", "value")
      .blank()
      .line("bare text")
      .list(["a", "b"])
      .separator()
      .timeline("09:00", "Alice", "morning")
      .build();

    expect(lines).toEqual([
      "## Test",
      "Key: value",
      "",
      "bare text",
      "- a",
      "- b",
      "---",
      "[09:00] Alice: morning",
    ]);
  });

  it("build 输出通过 linter", () => {
    const lines = new PromptBuilder()
      .heading("Section")
      .kv("Status", "active")
      .line("Description text.")
      .list(["item 1", "item 2"])
      .timeline("10:00", "Bob", "hello")
      .build();

    const text = lines.join("\n");
    expect(lintPromptStyle(text)).toEqual([]);
  });

  it("build 返回副本（不可变）", () => {
    const m = new PromptBuilder();
    m.line("first");
    const result1 = m.build();
    m.line("second");
    const result2 = m.build();
    expect(result1).toHaveLength(1);
    expect(result2).toHaveLength(2);
  });
});
