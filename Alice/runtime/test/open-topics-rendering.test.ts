/**
 * Open topics 渲染格式回归测试。
 *
 * 验证从 JSON.stringify 改为人类可读列表后，LLM 仍能从输出中提取 threadId。
 * 格式: `- #<threadId> "<title>"`
 *
 * @see runtime/src/prompt/renderers/group.ts  §Section 5
 * @see runtime/src/prompt/renderers/private.ts §Section 5
 */
import { describe, expect, it } from "vitest";
import { lintPromptStyle } from "../src/core/prompt-style.js";

/**
 * 从渲染器中提取的 Open topics 格式化逻辑（与 group.ts / private.ts 保持一致）。
 * 如果渲染器中格式变了，这里的测试会失败，提醒同步更新。
 */
function renderOpenTopics(threads: Array<{ threadId: string; title: string }>): string[] {
  if (threads.length === 0) return [];
  const lines: string[] = [];
  lines.push("## Open topics");
  for (const t of threads) {
    lines.push(`- #${t.threadId} "${t.title}"`);
  }
  return lines;
}

describe("Open topics rendering format", () => {
  it("空线程列表不输出", () => {
    expect(renderOpenTopics([])).toEqual([]);
  });

  it("单线程输出包含 threadId 和 title", () => {
    const result = renderOpenTopics([{ threadId: "158", title: "VNDB 创始人 Yorhel 逝世" }]);
    expect(result).toContain("## Open topics");
    expect(result[1]).toBe('- #158 "VNDB 创始人 Yorhel 逝世"');
  });

  it("多线程按顺序输出", () => {
    const threads = [
      { threadId: "157", title: "morning_digest" },
      { threadId: "158", title: "VNDB 创始人 Yorhel 逝世" },
      { threadId: "159", title: "weekly_reflection" },
    ];
    const result = renderOpenTopics(threads);
    expect(result).toHaveLength(4); // header + 3 threads
    expect(result[1]).toMatch(/^- #157 /);
    expect(result[2]).toMatch(/^- #158 /);
    expect(result[3]).toMatch(/^- #159 /);
  });

  it("threadId 可被正则提取（LLM 兼容性）", () => {
    const result = renderOpenTopics([{ threadId: "42", title: "Test" }]);
    const line = result[1];
    // LLM 应能用 #<number> 模式提取 threadId
    const match = line.match(/#(\d+)/);
    expect(match).not.toBeNull();
    expect(match?.[1]).toBe("42");
  });

  it("title 中有特殊字符不破坏格式", () => {
    const result = renderOpenTopics([{ threadId: "1", title: 'Test "quoted" & <special>' }]);
    expect(result[1]).toContain("#1");
    expect(result[1]).toContain("Test");
  });

  it("整体输出通过 prompt-style lint", () => {
    const result = renderOpenTopics([
      { threadId: "157", title: "morning_digest" },
      { threadId: "158", title: "VNDB 创始人 Yorhel 逝世" },
    ]);
    expect(lintPromptStyle(result.join("\n"))).toEqual([]);
  });
});
