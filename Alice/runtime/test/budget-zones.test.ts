/**
 * ADR-114 D1: Budget Zone 隔离测试。
 *
 * 验证 zone 分类、budget 隔离、ANCHOR 免疫、向后兼容。
 * @see docs/adr/114-context-assembly-rehabilitation.md — D1
 */
import { beforeEach, describe, expect, it } from "vitest";
import { PromptBuilder } from "../src/core/prompt-style.js";
import {
  classifyZone,
  DEFAULT_ZONE_RATIOS,
  renderContributions,
  renderContributionsByZone,
} from "../src/core/storyteller.js";
import type { ContributionItem } from "../src/core/types.js";

// -- 辅助 -------------------------------------------------------------------

let fillerCounter = 0;

/** 生成指定 token 数的唯一填充文本（ASCII，约 4 char/token）。 */
function filler(tokens: number): string {
  const tag = `[F${++fillerCounter}]`;
  const padLen = Math.max(0, tokens * 4 - tag.length);
  return tag + "x".repeat(padLen);
}

function makeItem(
  bucket: "header" | "section" | "footer",
  key: string | undefined,
  tokens: number,
  priority = 50,
  order = 50,
): ContributionItem {
  return { bucket, key, lines: [PromptBuilder.of(filler(tokens))], priority, order };
}

// 每个 describe 前重置 filler 计数器
beforeEach(() => {
  fillerCounter = 0;
});

// -- Zone 分类 ---------------------------------------------------------------

describe("classifyZone", () => {
  it("header bucket → anchor", () => {
    const item: ContributionItem = {
      bucket: "header",
      lines: [PromptBuilder.of("test")],
      priority: 100,
    };
    expect(classifyZone(item)).toBe("anchor");
  });

  it("header bucket with key → still anchor", () => {
    const item: ContributionItem = {
      bucket: "header",
      key: "voice-guidance",
      lines: [PromptBuilder.of("test")],
    };
    expect(classifyZone(item)).toBe("anchor");
  });

  const situationKeys = [
    "wall-clock",
    "situation",
    "strategy-hints",
    "risk-flags",
    "self-mood",
    "self-knowledge",
    "scheduler-fired",
  ];
  for (const key of situationKeys) {
    it(`section key "${key}" → situation`, () => {
      expect(classifyZone({ bucket: "section", key, lines: [PromptBuilder.of("x")] })).toBe(
        "situation",
      );
    });
  }

  const memoryKeys = [
    "contact-profile",
    "threads",
    "memory-housekeeping",
    "feedback-loop",
    "conversation",
  ];
  for (const key of memoryKeys) {
    it(`section key "${key}" → memory`, () => {
      expect(classifyZone({ bucket: "section", key, lines: [PromptBuilder.of("x")] })).toBe(
        "memory",
      );
    });
  }

  it("unknown section key → conversation", () => {
    expect(
      classifyZone({ bucket: "section", key: "action-echo", lines: [PromptBuilder.of("x")] }),
    ).toBe("conversation");
  });

  it("section without key → conversation", () => {
    expect(classifyZone({ bucket: "section", lines: [PromptBuilder.of("x")] })).toBe(
      "conversation",
    );
  });

  it("footer bucket → conversation", () => {
    expect(classifyZone({ bucket: "footer", lines: [PromptBuilder.of("x")] })).toBe("conversation");
  });
});

// -- Zone 隔离 ---------------------------------------------------------------

describe("renderContributionsByZone", () => {
  it("忙群消息多时 MEMORY zone 仍有 ≥ 15% budget", () => {
    const totalBudget = 12000;
    const items: ContributionItem[] = [
      // MEMORY zone: 需要大量空间
      makeItem("section", "contact-profile", 800, 70, 25),
      makeItem("section", "threads", 600, 70, 30),
      // SITUATION zone
      makeItem("section", "wall-clock", 50, 98, 4),
      makeItem("section", "situation", 200, 95, 5),
      // CONVERSATION zone
      makeItem("section", "action-echo", 300, 68, 15),
    ];

    // 模拟忙群：大量 messages 导致高 conversationFixedTokens
    const busyConvFixed = 8000; // 30 条消息 + scriptGuide + manual

    const result = renderContributionsByZone(items, totalBudget, undefined, busyConvFixed);

    // MEMORY zone 内容不应被忙群消息饿死
    expect(result.user).toContain(items[0].lines[0]); // contact-profile
    expect(result.user).toContain(items[1].lines[0]); // threads

    // SITUATION zone 内容也不应被影响
    expect(result.user).toContain(items[2].lines[0]); // wall-clock
    expect(result.user).toContain(items[3].lines[0]); // situation
  });

  it("ANCHOR zone 免疫裁剪——header items 永远保留", () => {
    const totalBudget = 1000; // 极小 budget
    const items: ContributionItem[] = [
      // 大量 header（anchor zone）
      makeItem("header", undefined, 500, 100),
      makeItem("header", "voice-guidance", 300, 95),
      // section items
      makeItem("section", "wall-clock", 50, 98, 4),
    ];

    const result = renderContributionsByZone(items, totalBudget);

    // header 内容应全部保留（免疫裁剪）
    expect(result.system).toContain(items[0].lines[0]);
    expect(result.system).toContain(items[1].lines[0]);
  });

  it("zone ratio 总和 — 默认比例加和为 1.0", () => {
    const sum = Object.values(DEFAULT_ZONE_RATIOS).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1.0);
  });

  it("自定义 zone ratios 覆盖默认值", () => {
    const totalBudget = 10000;
    const items: ContributionItem[] = [
      // 在 MEMORY zone 放很多内容
      makeItem("section", "contact-profile", 2000, 70, 25),
      makeItem("section", "threads", 2000, 70, 30),
    ];

    // 给 MEMORY zone 50% budget
    const result = renderContributionsByZone(items, totalBudget, { memory: 0.5 });

    // 两个 memory items 共 4000 tokens，memory budget = 5000，应全部保留
    expect(result.user).toContain(items[0].lines[0]);
    expect(result.user).toContain(items[1].lines[0]);
  });

  it("空 items 返回空字符串", () => {
    const result = renderContributionsByZone([], 12000);
    expect(result.system).toBe("");
    expect(result.user).toBe("");
  });

  it("conversationFixedTokens 压缩 CONVERSATION zone budget 但不影响其他 zone", () => {
    const totalBudget = 10000;
    const items: ContributionItem[] = [
      // CONVERSATION zone: 需要空间但 budget 被 messages 压缩
      makeItem("section", "action-echo", 2000, 68, 15),
      makeItem("section", "self-awareness", 500, 50, 38),
      // SITUATION zone: 独立 budget
      makeItem("section", "situation", 500, 95, 5),
    ];

    // CONVERSATION zone 只有 10000*0.40 = 4000 budget, 减去 fixedTokens 3500 = 500
    // action-echo 2000 tokens 超出 500 budget → 会被裁剪
    const result = renderContributionsByZone(items, totalBudget, undefined, 3500);

    // SITUATION zone 不受影响
    expect(result.user).toContain(items[2].lines[0]);
  });
});

// -- 向后兼容 -----------------------------------------------------------------

describe("renderContributions 向后兼容", () => {
  it("原函数行为不变——header 免疫，section 可裁剪", () => {
    const items: ContributionItem[] = [
      makeItem("header", undefined, 200, 100),
      makeItem("section", "a", 200, 80, 10),
      makeItem("section", "b", 200, 30, 20), // 低 priority
    ];

    // budget 只够 header + 一个 section
    const result = renderContributions(items, { maxTokens: 450 });

    // header 保留
    expect(result.system).toContain(items[0].lines[0]);
    // 高 priority section 保留
    expect(result.user).toContain(items[1].lines[0]);
    // 低 priority section 被裁剪
    expect(result.user).not.toContain(items[2].lines[0]);
  });
});

// -- 多 item 分隔 + header key ------------------------------------------------

describe("renderContributions 多 item 分隔", () => {
  it("同 key 多 item 间有空行分隔", () => {
    const items: ContributionItem[] = [
      {
        bucket: "section",
        key: "shared",
        lines: [PromptBuilder.of("line-a")],
        priority: 80,
        order: 10,
      },
      {
        bucket: "section",
        key: "shared",
        lines: [PromptBuilder.of("line-b")],
        priority: 60,
        order: 10,
      },
    ];
    const result = renderContributions(items);
    // priority 降序：a(80) 先于 b(60)，中间有空行
    expect(result.user).toBe("line-a\n\nline-b");
  });

  it("单 item group 无多余空行", () => {
    const items: ContributionItem[] = [
      {
        bucket: "section",
        key: "solo",
        lines: [PromptBuilder.of("only")],
        priority: 50,
        order: 10,
      },
    ];
    const result = renderContributions(items);
    expect(result.user).toBe("only");
  });

  it("header key 隔离——不同 key 的 header 分属不同组", () => {
    const items: ContributionItem[] = [
      { bucket: "header", lines: [PromptBuilder.of("core")], priority: 100 },
      { bucket: "header", key: "voice", lines: [PromptBuilder.of("voice")], priority: 90 },
    ];
    const result = renderContributions(items);
    // 不同 key → 不同组 → 用 \n\n---\n\n 分隔（system 组间分隔）
    expect(result.system).toContain("core");
    expect(result.system).toContain("voice");
    expect(result.system).toContain("---");
  });
});

// -- ADR-209: Item 级裁剪 + 摘要行 -------------------------------------------

describe("ADR-209 item-level trimming", () => {
  it("removes lowest-priority items before removing entire group", () => {
    // 3 个 item 同 group，不同 priority，总 token 超限
    const items: ContributionItem[] = [
      makeItem("section", "contacts", 200, 90), // 高优先
      makeItem("section", "contacts", 200, 70), // 中优先
      makeItem("section", "contacts", 200, 50), // 低优先 — 应先被删
    ];
    // budget 400 tokens：只够 2 个 item
    const result = renderContributions(items, { maxTokens: 400 });
    // group 应该存活（不是整组被删），且含摘要行
    expect(result.user).toContain("omitted");
    // 最高优先 item 的内容应保留
    expect(result.user).toContain("[F1]"); // priority=90 的 item
  });

  it("adds omission summary when items are trimmed", () => {
    const items: ContributionItem[] = [
      makeItem("section", "contacts", 300, 90),
      makeItem("section", "contacts", 300, 50),
      makeItem("section", "contacts", 300, 30),
    ];
    const result = renderContributions(items, { maxTokens: 400 });
    expect(result.user).toMatch(/\(\d+ more omitted\)/);
  });

  it("falls back to group-level removal if still over budget after item trim", () => {
    // 两个 group：一个 header（免疫），一个 section
    const items: ContributionItem[] = [
      makeItem("header", "soul", 300, 100),
      makeItem("section", "mood", 500, 40), // 单 item group — item 级裁剪跳过，group 级删除
    ];
    const result = renderContributions(items, { maxTokens: 350 });
    // header 保留，section 被整组移除
    expect(result.system).toContain("[F1]");
    expect(result.user).toBe("");
  });

  it("header items are never trimmed", () => {
    const items: ContributionItem[] = [
      makeItem("header", "soul", 200, 100),
      makeItem("header", "soul", 200, 80),
      makeItem("section", "mood", 100, 50),
    ];
    // budget 只够 header
    const result = renderContributions(items, { maxTokens: 450 });
    expect(result.system).toContain("[F1]");
    expect(result.system).toContain("[F2]");
  });
});
