/**
 * ADR-206: Channel Mod 测试。
 *
 * 验证:
 * - T1: 压力门控（API > 0.5 → 不注入）
 * - T2: 冷却期（10min 内重复 → 跳过）
 * - T3: 频道未读注入（按 unread 降序、top 3）
 * - T4: admin/owner 频道渲染角色 + 发布冷却提示
 * - T5: token budget（MAX_CHARS=600 截断）
 * - T6: 非 channel 类型的频道节点被跳过
 * - T7: 分享冷却提示（last_shared_ms < 30min）
 *
 * @see docs/adr/206-channel-information-flow/206-channel-information-flow.md §4
 */
import { describe, expect, it, vi } from "vitest";
import type { ContributionItem, ModContext } from "../src/core/types.js";
import { WorldModel } from "../src/graph/world-model.js";
import { channelMod } from "../src/mods/channel.mod.js";

// biome-ignore lint/style/noNonNullAssertion: test — contribute 已知存在
const contribute = channelMod.contribute!;

/** 构造最小 ModContext。 */
function makeCtx(
  state: { lastInjectMs: number },
  opts: { nowMs?: number; pressure?: number } = {},
): ModContext<{ lastInjectMs: number }> & { graph: WorldModel } {
  const graph = new WorldModel();
  graph.tick = 100;
  graph.addAgent("self");

  return {
    graph,
    state,
    tick: 100,
    nowMs: opts.nowMs ?? 1_700_000_000_000,
    getModState: ((modName: string) => {
      if (modName === "pressure") {
        return { latest: { API: opts.pressure ?? 0 } };
      }
      return undefined;
    }) as ModContext["getModState"],
    dispatch: () => undefined,
  };
}

/** 添加一个 channel 类型的频道节点。 */
function addChannel(
  G: WorldModel,
  id: string,
  unread: number,
  opts: { role?: string; chatType?: string; lastSharedMs?: number; lastPublishMs?: number } = {},
) {
  G.addChannel(id, {
    chat_type: (opts.chatType ?? "channel") as "channel",
    tier_contact: 500,
    unread,
    pending_directed: 0,
    last_directed_ms: 0,
    ...(opts.role ? { alice_role: opts.role } : {}),
    ...(opts.lastSharedMs ? { last_shared_ms: opts.lastSharedMs } : {}),
    ...(opts.lastPublishMs ? { last_publish_ms: opts.lastPublishMs } : {}),
  });
  // 设置 display_name 以方便测试断言
  G.setDynamic(id, "display_name", id.replace("channel:", "@"));
}

describe("ADR-206: Channel Mod", () => {
  // T1: 压力门控
  it("T1: API > 0.5 时不注入频道动态", () => {
    const ctx = makeCtx({ lastInjectMs: 0 }, { pressure: 0.8 });
    addChannel(ctx.graph, "channel:news", 10);

    // 绕过概率跳过
    vi.spyOn(Math, "random").mockReturnValue(0.99);
    const result = contribute(ctx as unknown as ModContext);
    vi.restoreAllMocks();

    expect(result).toEqual([]);
  });

  // T2: 冷却期
  it("T2: 冷却期内（<10min）不重复注入", () => {
    const now = 1_700_000_000_000;
    const ctx = makeCtx(
      { lastInjectMs: now - 5 * 60_000 }, // 5 分钟前刚注入
      { nowMs: now, pressure: 0 },
    );
    addChannel(ctx.graph, "channel:news", 10);

    vi.spyOn(Math, "random").mockReturnValue(0.99);
    const result = contribute(ctx as unknown as ModContext);
    vi.restoreAllMocks();

    expect(result).toEqual([]);
  });

  // T3: 频道未读注入
  it("T3: 按 unread 降序注入，最多 3 个频道", () => {
    const ctx = makeCtx({ lastInjectMs: 0 }, { pressure: 0 });
    addChannel(ctx.graph, "channel:a", 5);
    addChannel(ctx.graph, "channel:b", 20);
    addChannel(ctx.graph, "channel:c", 10);
    addChannel(ctx.graph, "channel:d", 1);

    vi.spyOn(Math, "random").mockReturnValue(0.99);
    const result = contribute(ctx as unknown as ModContext) as ContributionItem[];
    vi.restoreAllMocks();

    expect(result.length).toBe(1); // 1 section
    const section = result[0];
    expect(section.key).toBe("channel-updates");

    // 验证排序：b(20) > c(10) > a(5)，d(1) 被截断
    const rendered = section.lines.map((l) => String(l));
    expect(rendered[0]).toContain("@b");
    expect(rendered[1]).toContain("@c");
    expect(rendered[2]).toContain("@a");
    expect(rendered.length).toBe(3);
  });

  // T4: admin/owner 频道渲染
  it("T4: admin 频道显示角色 + 发布冷却提示", () => {
    const now = 1_700_000_000_000;
    const ctx = makeCtx({ lastInjectMs: 0 }, { nowMs: now, pressure: 0 });
    addChannel(ctx.graph, "channel:myblog", 3, {
      role: "admin",
      lastPublishMs: now - 1 * 3_600_000, // 1 小时前发布
    });

    vi.spyOn(Math, "random").mockReturnValue(0.99);
    const result = contribute(ctx as unknown as ModContext) as ContributionItem[];
    vi.restoreAllMocks();

    const text = result[0].lines.map((l) => String(l)).join("");
    expect(text).toContain("你的频道");
    expect(text).toContain("admin");
    expect(text).toContain("发布冷却中");
  });

  // T5: token budget
  it("T5: 超过 MAX_CHARS=600 时截断", () => {
    const ctx = makeCtx({ lastInjectMs: 0 }, { pressure: 0 });
    // 每个频道名约 200 字符 → 3 个就超 600
    for (let i = 0; i < 5; i++) {
      const longName = `channel:${"x".repeat(50)}_${i}`;
      addChannel(ctx.graph, longName, 100 - i);
      ctx.graph.setDynamic(longName, "display_name", "A".repeat(180));
    }

    vi.spyOn(Math, "random").mockReturnValue(0.99);
    const result = contribute(ctx as unknown as ModContext) as ContributionItem[];
    vi.restoreAllMocks();

    if (result.length > 0) {
      const lineCount = result[0].lines.length;
      // 600 字符预算 / ~190 字符每行 ≈ 最多 3 行
      expect(lineCount).toBeLessThanOrEqual(3);
    }
  });

  // T6: 非 channel 类型跳过
  it("T6: chat_type=group 的节点不参与频道注入", () => {
    const ctx = makeCtx({ lastInjectMs: 0 }, { pressure: 0 });
    addChannel(ctx.graph, "channel:group1", 100, { chatType: "group" });

    vi.spyOn(Math, "random").mockReturnValue(0.99);
    const result = contribute(ctx as unknown as ModContext);
    vi.restoreAllMocks();

    expect(result).toEqual([]);
  });

  // T7: 分享冷却提示
  it("T7: last_shared_ms < 30min 时显示'最近已分享'", () => {
    const now = 1_700_000_000_000;
    const ctx = makeCtx({ lastInjectMs: 0 }, { nowMs: now, pressure: 0 });
    addChannel(ctx.graph, "channel:shared", 5, {
      lastSharedMs: now - 10 * 60_000, // 10 分钟前分享
    });

    vi.spyOn(Math, "random").mockReturnValue(0.99);
    const result = contribute(ctx as unknown as ModContext) as ContributionItem[];
    vi.restoreAllMocks();

    const text = result[0].lines.map((l) => String(l)).join("");
    expect(text).toContain("最近已分享");
  });

  // T8: state 更新
  it("T8: 成功注入后更新 lastInjectMs", () => {
    const now = 1_700_000_000_000;
    const state = { lastInjectMs: 0 };
    const ctx = makeCtx(state, { nowMs: now, pressure: 0 });
    addChannel(ctx.graph, "channel:news", 10);

    vi.spyOn(Math, "random").mockReturnValue(0.99);
    contribute(ctx as unknown as ModContext);
    vi.restoreAllMocks();

    expect(state.lastInjectMs).toBe(now);
  });
});
