/**
 * 自观察数据采集 + action-defs hint 生成测试。
 *
 * ADR-81: reflect.ts 已删除。保留数据采集函数（gatherOutboundActions,
 * gatherInteractionPatterns）和 action-defs hint 生成的测试。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDb, getDb, initDb } from "../src/db/connection.js";
import { actionLog, messageLog } from "../src/db/schema.js";
import { gatherInteractionPatterns, gatherOutboundActions } from "../src/llm/self-observation.js";
import { renderAllUsageHints } from "../src/telegram/actions/index.js";

// -- self-observation 数据采集 -------------------------------------------------

describe("Self-observation data gathering", () => {
  beforeEach(() => initDb(":memory:"));
  afterEach(() => closeDb());

  describe("gatherOutboundActions", () => {
    it("空 DB 返回空数组", () => {
      const actions = gatherOutboundActions(100);
      expect(actions).toEqual([]);
    });

    it("返回指定窗口内的行动（时间升序）", () => {
      const db = getDb();
      db.insert(actionLog)
        .values({
          tick: 60,
          voice: "care",
          actionType: "send_message",
          chatId: "channel:1",
          success: true,
        })
        .run();
      db.insert(actionLog)
        .values({
          tick: 95,
          voice: "curiosity",
          actionType: "mark_read",
          chatId: "channel:2",
          success: false,
        })
        .run();

      // 窗口=50，tick=100 → 查 tick>=50
      const actions = gatherOutboundActions(100, 50);
      expect(actions).toHaveLength(2);
      expect(actions[0].tick).toBe(60);
      expect(actions[1].tick).toBe(95);
      expect(actions[1].voice).toBe("curiosity");
      expect(actions[1].success).toBe(false);
    });

    it("窗口外的行动不返回", () => {
      const db = getDb();
      db.insert(actionLog)
        .values({ tick: 10, voice: "care", actionType: "send_message", success: true })
        .run();

      // 窗口=50，tick=100 → 查 tick>=50，tick=10 在窗口外
      const actions = gatherOutboundActions(100, 50);
      expect(actions).toEqual([]);
    });
  });

  describe("gatherInteractionPatterns", () => {
    it("空 DB 返回空数组", () => {
      const patterns = gatherInteractionPatterns(100);
      expect(patterns).toEqual([]);
    });

    it("正确统计 outbound/inbound 比", () => {
      const db = getDb();
      for (let i = 0; i < 2; i++) {
        db.insert(messageLog)
          .values({ tick: 50 + i, chatId: "channel:1", isOutgoing: true })
          .run();
      }
      for (let i = 0; i < 3; i++) {
        db.insert(messageLog)
          .values({ tick: 50 + i, chatId: "channel:1", isOutgoing: false })
          .run();
      }

      const patterns = gatherInteractionPatterns(100, 100);
      expect(patterns).toHaveLength(1);
      expect(patterns[0].chatId).toBe("channel:1");
      expect(patterns[0].outbound).toBe(2);
      expect(patterns[0].inbound).toBe(3);
      expect(patterns[0].ratio).toBeCloseTo(2 / 3, 5);
    });

    it("全 outbound 时 ratio = Infinity", () => {
      const db = getDb();
      db.insert(messageLog).values({ tick: 80, chatId: "channel:2", isOutgoing: true }).run();

      const patterns = gatherInteractionPatterns(100, 100);
      expect(patterns).toHaveLength(1);
      expect(patterns[0].ratio).toBe(Infinity);
    });

    it("全 inbound 时 ratio = 0", () => {
      const db = getDb();
      db.insert(messageLog).values({ tick: 80, chatId: "channel:3", isOutgoing: false }).run();

      const patterns = gatherInteractionPatterns(100, 100);
      expect(patterns[0].ratio).toBe(0);
    });
  });
});

// -- action-defs hint 生成 -----------------------------------------------------

describe("action-defs hints", () => {
  it("renderAllUsageHints 包含已知类别", () => {
    const hints = renderAllUsageHints();
    expect(hints).toContain("[messaging]");
    expect(hints).toContain("[sticker]");
    expect(hints).toContain("send_message");
  });

  it("renderAllUsageHints 类别标题后跟具体动作", () => {
    const hints = renderAllUsageHints();
    const lines = hints.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith("[") && lines[i].endsWith("]")) {
        // 类别标题后应跟具体动作行
        expect(lines[i + 1]?.trim().length).toBeGreaterThan(0);
      }
    }
  });
});
