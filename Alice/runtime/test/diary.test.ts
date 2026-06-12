/**
 * ADR-82 → ADR-225: Diary Mod 单元测试 — Working Memory 模型。
 *
 * 验证：
 * - diary 写入：合并-或-分配（consolidate-on-write）
 * - per-turn cap + 字符限制
 * - 显著性衰减 + 槽位替换
 * - contribute() 注入 + 目标感知排序
 * - onTickEnd 淡出清理
 * - Jaccard 相似度函数
 *
 * @see docs/adr/82-diary-inner-world.md
 * @see docs/adr/225-diary-working-memory.md
 */
import { describe, expect, it } from "vitest";
import {
  charBigrams,
  type DiaryState,
  diaryMod,
  effectiveSalience,
  jaccardSimilarity,
  type Thought,
} from "../src/mods/diary.mod.js";

// -- 安全提取 ------------------------------------------------------------------

const writeDiary = diaryMod.instructions?.diary.impl;
const contribute = diaryMod.contribute;
const onTickStart = diaryMod.onTickStart;
const onTickEnd = diaryMod.onTickEnd;

if (!writeDiary || !contribute || !onTickStart || !onTickEnd) {
  throw new Error("diaryMod missing required methods");
}

// -- 测试 helper ---------------------------------------------------------------

const NOW = Date.now();

function makeMockCtx(
  tick: number,
  state: DiaryState,
  targetNodeId: string | null = null,
  nowMs: number = NOW,
) {
  return {
    graph: {
      has: () => false,
      getContact: () => ({}),
      nodeAttrs: () => ({}),
      getDynamic: () => undefined,
    } as never,
    state,
    tick,
    nowMs,
    getModState: (modName: string) => {
      if (modName === "relationships") return { targetNodeId };
      return undefined;
    },
    dispatch: () => undefined,
  };
}

function freshState(): DiaryState {
  return { turnWriteCount: 0, thoughts: [] };
}

// ═══════════════════════════════════════════════════════════════════════════
// 相似度函数
// ═══════════════════════════════════════════════════════════════════════════

describe("Jaccard similarity", () => {
  it("相同文本 → 1.0", () => {
    expect(jaccardSimilarity("今天好累", "今天好累")).toBe(1.0);
  });

  it("完全不同 → ~0.0", () => {
    expect(jaccardSimilarity("今天好累", "ABCDEFGH")).toBeLessThan(0.1);
  });

  it("改写变体 → 超过阈值 0.35", () => {
    const a = "今天一直在想爱丽丝泉那张卫星图，然后频道里又出现伊蕾娜";
    const b = "又看到一张伊蕾娜，一直在想爱丽丝泉那张卫星图的感觉";
    expect(jaccardSimilarity(a, b)).toBeGreaterThan(0.35);
  });

  it("不同话题 → 低于阈值", () => {
    const a = "池泽从昨天下午到今天早上一直没有回复";
    const b = "爱丽丝泉那张图让我想到了远方和存在感";
    expect(jaccardSimilarity(a, b)).toBeLessThan(0.3);
  });

  it("charBigrams 正确生成 CJK 双字母组", () => {
    const bg = charBigrams("你好世界");
    expect(bg.has("你好")).toBe(true);
    expect(bg.has("好世")).toBe(true);
    expect(bg.has("世界")).toBe(true);
    expect(bg.size).toBe(3);
  });

  it("空字符串 → 0", () => {
    expect(jaccardSimilarity("", "")).toBe(0);
    expect(jaccardSimilarity("hello", "")).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 显著性衰减
// ═══════════════════════════════════════════════════════════════════════════

describe("effectiveSalience", () => {
  it("刚写入 → 等于 base salience", () => {
    const t: Thought = {
      content: "test",
      about: null,
      salience: 1.0,
      createdAt: NOW,
      updatedAt: NOW,
    };
    expect(effectiveSalience(t, NOW)).toBe(1.0);
  });

  it("6 小时后 → 减半", () => {
    const sixHoursAgo = NOW - 6 * 3600 * 1000;
    const t: Thought = {
      content: "test",
      about: null,
      salience: 1.0,
      createdAt: sixHoursAgo,
      updatedAt: sixHoursAgo,
    };
    expect(effectiveSalience(t, NOW)).toBeCloseTo(0.5, 2);
  });

  it("12 小时后 → 约 25%", () => {
    const twelveHoursAgo = NOW - 12 * 3600 * 1000;
    const t: Thought = {
      content: "test",
      about: null,
      salience: 1.0,
      createdAt: twelveHoursAgo,
      updatedAt: twelveHoursAgo,
    };
    expect(effectiveSalience(t, NOW)).toBeCloseTo(0.25, 2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// diary 写入
// ═══════════════════════════════════════════════════════════════════════════

describe("ADR-225: Diary Mod — Working Memory", () => {
  describe("diary instruction", () => {
    it("基本写入成功 — 无当前 target 时分配全局槽位", () => {
      const state = freshState();
      const ctx = makeMockCtx(100, state);

      const result = writeDiary(ctx as never, { content: "今天好累" });
      expect(result).toMatchObject({ success: true, evolved: false });
      expect(state.turnWriteCount).toBe(1);
      expect(state.thoughts).toHaveLength(1);
      expect(state.thoughts[0].content).toBe("今天好累");
      expect(state.thoughts[0].about).toBeNull();
    });

    it("省略 about 时绑定当前 target，避免泛化残留进入全局池", () => {
      const state = freshState();
      const ctx = makeMockCtx(100, state, "contact:42");

      const result = writeDiary(ctx as never, { content: "那句话还在心里刺刺的" });

      expect(result).toMatchObject({ success: true, evolved: false });
      expect(state.thoughts).toHaveLength(1);
      expect(state.thoughts[0].about).toBe("contact:42");
    });

    it("带 about 参数写入", () => {
      const state = freshState();
      const ctx = makeMockCtx(100, state);

      writeDiary(ctx as never, { content: "他最近在躲我", about: "contact:42" });
      expect(state.thoughts[0].about).toBe("contact:42");
    });

    it("per-turn cap 限制（最多 2 条）", () => {
      const state = freshState();
      const ctx = makeMockCtx(100, state);

      writeDiary(ctx as never, { content: "第一条" });
      writeDiary(ctx as never, { content: "完全不同的话题" });
      const result = writeDiary(ctx as never, { content: "第三条" }) as {
        success: boolean;
        error?: string;
      };

      expect(result.success).toBe(false);
      expect(result.error).toContain("max 2");
      expect(state.turnWriteCount).toBe(2);
    });

    it("超长内容自动截断", () => {
      const state = freshState();
      const ctx = makeMockCtx(100, state);

      const longContent = "这是一段很长的日记".repeat(50);
      writeDiary(ctx as never, { content: longContent });
      expect(state.thoughts[0].content.length).toBeLessThanOrEqual(200);
    });

    it("合并写入 — 同主题改写合并为同一槽位", () => {
      const state = freshState();
      const ctx = makeMockCtx(100, state);

      writeDiary(ctx as never, { content: "今天一直在想爱丽丝泉那张卫星图，红色沙漠变绿了" });
      expect(state.thoughts).toHaveLength(1);

      // 重置 per-turn cap（模拟新一轮）
      state.turnWriteCount = 0;

      // 改写同一想法
      const result = writeDiary(ctx as never, {
        content: "又看到伊蕾娜，一直在想爱丽丝泉那张卫星图的感觉",
      });
      expect(result).toMatchObject({ success: true, evolved: true });
      // 应该合并而非新增
      expect(state.thoughts).toHaveLength(1);
      // 内容更新为最新版本
      expect(state.thoughts[0].content).toContain("伊蕾娜");
    });

    it("不同��题写入分配不同槽位", () => {
      const state = freshState();
      const ctx = makeMockCtx(100, state);

      writeDiary(ctx as never, { content: "今天一直在想爱丽丝泉" });
      writeDiary(ctx as never, { content: "池泽没有回复我" });

      expect(state.thoughts).toHaveLength(2);
    });

    it("不同 about 即使内容相似也不合并", () => {
      const state = freshState();
      const ctx = makeMockCtx(100, state);

      writeDiary(ctx as never, { content: "好想念这个人", about: "contact:1" });
      // 重置 per-turn cap
      state.turnWriteCount = 0;
      writeDiary(ctx as never, { content: "好想念这个人", about: "contact:2" });

      expect(state.thoughts).toHaveLength(2);
    });

    it("容量满时替换最低显著性槽位", () => {
      const state = freshState();
      // 预填 7 个槽位
      for (let i = 0; i < 7; i++) {
        state.thoughts.push({
          content: `想法${i}`,
          about: null,
          salience: 0.5 + i * 0.1,
          createdAt: NOW - 3600_000,
          updatedAt: NOW - 3600_000,
        });
      }
      // 最低显著性的是 thoughts[0]（salience=0.5）

      const ctx = makeMockCtx(100, state);
      writeDiary(ctx as never, { content: "全新的重要想法" });

      expect(state.thoughts).toHaveLength(7);
      // thoughts[0] 应该被替换（最低 effectiveSalience）
      expect(state.thoughts[0].content).toBe("全新的重要想法");
    });
  });

  // ── contribute() ──────────────────────────────────────────────────────

  describe("contribute() 注入", () => {
    it("无想法时不注入", () => {
      const state = freshState();
      const ctx = makeMockCtx(100, state);

      const items = contribute(ctx as never);
      expect(items).toHaveLength(0);
    });

    it("只注入当前 target 相关想法（priority 75）", () => {
      const state = freshState();
      state.thoughts.push({
        content: "今天好累",
        about: "contact:42",
        salience: 1.0,
        createdAt: NOW,
        updatedAt: NOW,
      });
      const ctx = makeMockCtx(100, state, "contact:42");

      const items = contribute(ctx as never);
      expect(items).toHaveLength(1);
      expect(items[0].bucket).toBe("header");
      expect(items[0].priority).toBe(75);

      const text = items[0].lines.join("\n");
      expect(text).toContain("你最近的想法");
      expect(text).toContain("今天好累");
    });

    it("global 想法不进入普通 prompt", () => {
      const state = freshState();
      state.thoughts.push({
        content: "全局漂移想法",
        about: null,
        salience: 1.0,
        createdAt: NOW,
        updatedAt: NOW,
      });
      const ctx = makeMockCtx(100, state, "contact:42");

      const items = contribute(ctx as never);
      expect(items).toHaveLength(0);
    });

    it("无效 about 不会被误贴到当前 target", () => {
      const state = freshState();
      const ctx = makeMockCtx(100, state, "contact:42");

      const result = writeDiary(ctx as never, {
        content: "这条没有可靠归属",
        about: "not-a-real-id",
      }) as { success: boolean };

      expect(result.success).toBe(true);
      expect(state.thoughts[0].about).toBeNull();
      expect(contribute(ctx as never)).toHaveLength(0);
    });

    it("总量不超过 5 条", () => {
      const state = freshState();
      for (let i = 0; i < 7; i++) {
        state.thoughts.push({
          content: `想法${i}`,
          about: "contact:42",
          salience: 1.0,
          createdAt: NOW,
          updatedAt: NOW,
        });
      }
      const ctx = makeMockCtx(100, state, "contact:42");

      const items = contribute(ctx as never);
      const text = items[0].lines.join("\n");
      const entryLines = text.split("\n").filter((l) => l.startsWith("- "));
      expect(entryLines.length).toBeLessThanOrEqual(5);
    });

    it("不注入其他 target 的想法", () => {
      const state = freshState();
      state.thoughts.push({
        content: "全局想法",
        about: null,
        salience: 1.0,
        createdAt: NOW,
        updatedAt: NOW,
      });
      state.thoughts.push({
        content: "关于David的想法",
        about: "contact:42",
        salience: 0.5, // 显著性更低，但 target 匹配
        createdAt: NOW,
        updatedAt: NOW,
      });
      const ctx = makeMockCtx(100, state, "contact:42");

      const items = contribute(ctx as never);
      const text = items[0].lines.join("\n");
      expect(text).toContain("关于David的想法");
      expect(text).not.toContain("全局想法");
    });
  });

  // ── 生命周期钩子 ──────────────────────────────────────────────────��─

  describe("生命周期钩子", () => {
    it("onTickStart 重置 per-turn 计数", () => {
      const state: DiaryState = { turnWriteCount: 2, thoughts: [] };
      const ctx = makeMockCtx(101, state);

      onTickStart(ctx as never);
      expect(state.turnWriteCount).toBe(0);
    });

    it("onTickEnd 清理已淡出的想法", () => {
      const state = freshState();
      // 一条很旧的（24+ 小时前，显著性接近 0）
      state.thoughts.push({
        content: "旧想法",
        about: null,
        salience: 1.0,
        createdAt: NOW - 48 * 3600_000,
        updatedAt: NOW - 48 * 3600_000,
      });
      // 一条新的
      state.thoughts.push({
        content: "新想法",
        about: null,
        salience: 1.0,
        createdAt: NOW - 100_000,
        updatedAt: NOW - 100_000,
      });

      const ctx = makeMockCtx(300, state, null, NOW);
      onTickEnd(ctx as never);

      // 旧想法的 effectiveSalience: 1.0 × 2^(-48/6) = 1.0 × 2^-8 ≈ 0.004 < 0.05
      // 应该被清理
      expect(state.thoughts).toHaveLength(1);
      expect(state.thoughts[0].content).toBe("新想法");
    });
  });

  // ── Zod Schema ────────────────────────────────────────────────────────

  describe("Zod schema 校验", () => {
    it("空内容被 schema 拒绝", () => {
      // biome-ignore lint/style/noNonNullAssertion: test — schema 已��存在
      const schema = diaryMod.instructions!.diary.params.content.schema!;
      expect(schema.safeParse("").success).toBe(false);
      expect(schema.safeParse("   ").success).toBe(false);
      expect(schema.safeParse("hello").success).toBe(true);
    });
  });
});
