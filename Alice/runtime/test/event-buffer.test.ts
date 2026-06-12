/**
 * EventBuffer 单元测试 — 事件缓冲区的 push/drain/length 行为。
 */
import { describe, expect, it } from "vitest";
import { EventBuffer } from "../src/telegram/events.js";
import type { GraphNonMessagePerturbation, GraphPerturbation } from "../src/telegram/mapper.js";

function makeEvent(
  tick: number,
  type: GraphPerturbation["type"] = "new_message",
  isDirected = false,
): GraphPerturbation {
  if (type === "new_message") {
    return { type, chatType: "group", tick, channelId: `channel:${tick}`, isDirected };
  }
  return {
    type: type as GraphNonMessagePerturbation["type"],
    tick,
    channelId: `channel:${tick}`,
    isDirected,
  };
}

describe("EventBuffer", () => {
  it("push + drain 基本流程", () => {
    const buf = new EventBuffer();
    buf.push(makeEvent(1));
    buf.push(makeEvent(2));

    const { events, droppedCount } = buf.drain();
    expect(events).toHaveLength(2);
    expect(events[0].tick).toBe(1);
    expect(events[1].tick).toBe(2);
    expect(droppedCount).toBe(0);
  });

  it("drain 返回所有事件并清空缓冲", () => {
    const buf = new EventBuffer();
    buf.push(makeEvent(1));
    buf.push(makeEvent(2));

    const { events } = buf.drain();
    expect(events).toHaveLength(2);
    expect(buf.length).toBe(0);
  });

  it("连续 drain 返回空数组", () => {
    const buf = new EventBuffer();
    buf.push(makeEvent(1));

    buf.drain();
    const { events } = buf.drain();
    expect(events).toEqual([]);
  });

  it("空 buffer drain 返回空数组", () => {
    const buf = new EventBuffer();
    const { events, droppedCount, droppedDirectedCount } = buf.drain();
    expect(events).toEqual([]);
    expect(droppedCount).toBe(0);
    expect(droppedDirectedCount).toBe(0);
  });

  it("length 属性随 push/drain 变化", () => {
    const buf = new EventBuffer();
    expect(buf.length).toBe(0);

    buf.push(makeEvent(1));
    expect(buf.length).toBe(1);

    buf.push(makeEvent(2));
    expect(buf.length).toBe(2);

    buf.drain();
    expect(buf.length).toBe(0);
  });

  it("保持事件推入顺序", () => {
    const buf = new EventBuffer();
    for (let i = 0; i < 5; i++) {
      buf.push(makeEvent(i));
    }

    const { events } = buf.drain();
    for (let i = 0; i < 5; i++) {
      expect(events[i].tick).toBe(i);
    }
  });

  it("支持不同事件类型", () => {
    const buf = new EventBuffer();
    buf.push(makeEvent(1, "new_message"));
    buf.push(makeEvent(2, "read_history"));
    buf.push(makeEvent(3, "user_status"));

    const { events } = buf.drain();
    expect(events[0].type).toBe("new_message");
    expect(events[1].type).toBe("read_history");
    expect(events[2].type).toBe("user_status");
  });

  it("drain 后可继续 push", () => {
    const buf = new EventBuffer();
    buf.push(makeEvent(1));
    buf.drain();

    buf.push(makeEvent(10));
    buf.push(makeEvent(20));
    const { events } = buf.drain();

    expect(events).toHaveLength(2);
    expect(events[0].tick).toBe(10);
    expect(events[1].tick).toBe(20);
  });

  it("regular 段 overflow 时丢弃最旧事件并记录 droppedCount", () => {
    // maxSize=200 → maxProtected=100, maxRegular=100
    const buf = new EventBuffer(200);
    for (let i = 0; i < 105; i++) {
      buf.push(makeEvent(i)); // 非 directed → 进 regular 段
    }

    const { events, droppedCount } = buf.drain();
    expect(events).toHaveLength(100); // regular 上限
    expect(events[0].tick).toBe(5); // 最早 5 条被丢弃
    expect(droppedCount).toBe(5);
  });

  it("droppedCount 跨多次 drain 重置", () => {
    // maxSize=200 → maxProtected=100, maxRegular=100
    const buf = new EventBuffer(200);
    for (let i = 0; i < 101; i++) {
      buf.push(makeEvent(i)); // 非 directed → regular 溢出 1 条
    }

    const first = buf.drain();
    expect(first.droppedCount).toBe(1);

    // 第二次 drain 无溢出
    buf.push(makeEvent(200));
    const second = buf.drain();
    expect(second.droppedCount).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ADR-114 D4: 双段优先级保护
// ═══════════════════════════════════════════════════════════════════════════

describe("EventBuffer — ADR-114 D4: 双段优先级保护", () => {
  it("1500 事件（含 5 directed）→ directed 全部保留", () => {
    const buf = new EventBuffer(1000);
    // 先推 5 条 directed（穿插在大量非 directed 中）
    const directedTicks = [100, 300, 500, 700, 900];
    for (let i = 0; i < 1500; i++) {
      const isDirected = directedTicks.includes(i);
      buf.push(makeEvent(i, "new_message", isDirected));
    }

    const { events, droppedCount, droppedDirectedCount } = buf.drain();
    // 5 条 directed 全部保留
    const directedEvents = events.filter((e) => e.isDirected);
    expect(directedEvents).toHaveLength(5);
    for (const dt of directedTicks) {
      expect(directedEvents.some((e) => e.tick === dt)).toBe(true);
    }
    // regular 段溢出了
    expect(droppedCount).toBeGreaterThan(0);
    // directed 没溢出
    expect(droppedDirectedCount).toBe(0);
  });

  it("protected 段满后 FIFO 丢弃最旧 directed", () => {
    // maxSize=200 → maxProtected=100, maxRegular=100
    const buf = new EventBuffer(200);
    // 推入 110 条 directed
    for (let i = 0; i < 110; i++) {
      buf.push(makeEvent(i, "new_message", true));
    }

    const { events, droppedDirectedCount } = buf.drain();
    // 只保留最新 100 条
    expect(events).toHaveLength(100);
    expect(events[0].tick).toBe(10); // 最早 10 条被丢弃
    expect(events[99].tick).toBe(109);
    expect(droppedDirectedCount).toBe(10);
  });

  it("drain 合并两段并按 tick 排序", () => {
    const buf = new EventBuffer();
    // 交替推入 directed 和 non-directed，tick 交叉
    buf.push(makeEvent(3, "new_message", true));
    buf.push(makeEvent(1, "new_message", false));
    buf.push(makeEvent(5, "new_message", true));
    buf.push(makeEvent(2, "new_message", false));
    buf.push(makeEvent(4, "new_message", false));

    const { events } = buf.drain();
    expect(events).toHaveLength(5);
    // 按 tick 升序排列
    for (let i = 0; i < events.length - 1; i++) {
      expect(events[i].tick).toBeLessThanOrEqual(events[i + 1].tick);
    }
    expect(events.map((e) => e.tick)).toEqual([1, 2, 3, 4, 5]);
  });

  it("droppedDirectedCount 正确报告并在 drain 后重置", () => {
    // maxSize=200 → maxProtected=100
    const buf = new EventBuffer(200);
    for (let i = 0; i < 105; i++) {
      buf.push(makeEvent(i, "new_message", true));
    }
    const first = buf.drain();
    expect(first.droppedDirectedCount).toBe(5);

    // 第二次 drain 重置
    buf.push(makeEvent(200, "new_message", true));
    const second = buf.drain();
    expect(second.droppedDirectedCount).toBe(0);
  });

  it("length 返回两段总和", () => {
    const buf = new EventBuffer();
    buf.push(makeEvent(1, "new_message", true)); // protected
    buf.push(makeEvent(2, "new_message", false)); // regular
    buf.push(makeEvent(3, "new_message", true)); // protected

    expect(buf.length).toBe(3);

    buf.drain();
    expect(buf.length).toBe(0);
  });

  it("directed 和 regular 段独立溢出", () => {
    // maxSize=200 → maxProtected=100, maxRegular=100
    const buf = new EventBuffer(200);
    // regular 段满
    for (let i = 0; i < 110; i++) {
      buf.push(makeEvent(i, "new_message", false));
    }
    // protected 段满
    for (let i = 200; i < 310; i++) {
      buf.push(makeEvent(i, "new_message", true));
    }

    const { events, droppedCount, droppedDirectedCount } = buf.drain();
    expect(events).toHaveLength(200); // 100 regular + 100 protected
    expect(droppedCount).toBe(10);
    expect(droppedDirectedCount).toBe(10);
  });

  it("小 buffer 不会出现负数 maxRegularSize", () => {
    // maxSize=4 → maxProtected=2, maxRegular=2
    const buf = new EventBuffer(4);
    buf.push(makeEvent(1, "new_message", true));
    buf.push(makeEvent(2, "new_message", true));
    buf.push(makeEvent(3, "new_message", true)); // overflow protected

    buf.push(makeEvent(4, "new_message", false));
    buf.push(makeEvent(5, "new_message", false));
    buf.push(makeEvent(6, "new_message", false)); // overflow regular

    const { events, droppedCount, droppedDirectedCount } = buf.drain();
    expect(events).toHaveLength(4); // 2 protected + 2 regular
    expect(droppedCount).toBe(1);
    expect(droppedDirectedCount).toBe(1);
  });
});
