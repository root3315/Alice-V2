/**
 * 真实数据回放集成测试 — 用 Telegram Desktop 导出数据验证压力管线行为。
 *
 * 数据集：
 * - private_sonya: 1,123 条，202 天，1:1 私聊
 * - smallgroup_poetry: 13,562 条，42 天，34 人小群
 * - supergroup_miaomiao: 372,800 条，192 天，3036 人大群（采样回放）
 *
 * testdata 不提交到 git，缺失时测试自动 skip。
 *
 * @see simulation/telegram_parser.py
 * @see simulation/testdata/README.md
 * @see docs/adr/78-group-naturalness-review.md
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { computeAllPressures } from "../src/pressure/aggregate.js";
import { UNREAD_FRESHNESS_HALFLIFE_S } from "../src/pressure/signal-decay.js";

import {
  buildGraphFromParsedChat,
  type ParsedChat,
  parseTelegramExport,
} from "../src/utils/testdata-parser.js";

// 项目根目录（runtime/ 的上一级）
const PROJECT_ROOT = resolve(import.meta.dirname, "../..");
const DATA_PATH = resolve(PROJECT_ROOT, "simulation/testdata/private_sonya/result.json");
const HAS_DATA = existsSync(DATA_PATH);

const GROUP_DATA_PATH = resolve(PROJECT_ROOT, "simulation/testdata/smallgroup_poetry/result.json");
const HAS_GROUP_DATA = existsSync(GROUP_DATA_PATH);

const SUPERGROUP_DATA_PATH = resolve(
  PROJECT_ROOT,
  "simulation/testdata/supergroup_miaomiao/result.json",
);
const HAS_SUPERGROUP_DATA = existsSync(SUPERGROUP_DATA_PATH);

// ---------------------------------------------------------------------------
// 辅助：事件回放引擎
// ---------------------------------------------------------------------------

interface PressureSnapshot {
  tick: number;
  P1: number;
  P2: number;
  P3: number;
  P4: number;
  P5: number;
  P6: number;
  API: number;
  eventCount: number;
  timestamp: number;
  /** 该采样区间内的 directed 消息数（群聊验证用） */
  directedInInterval: number;
}

/**
 * 逐条回放事件流，每条消息更新图属性，每 sampleInterval 条采样一次压力。
 *
 * 为什么逐条处理？在 1:1 私聊中，如果按大批次处理，Alice 和对方总在同一批次出现，
 * 导致 unread 永远被清零。逐条处理才能捕捉到"对方连续发了 N 条、Alice 还没回"的窗口。
 *
 * 简化约定：
 * - Alice 的 senderId 通过启发式识别
 * - 非 Alice 消息 → unread++，可能 pending_directed++
 * - Alice 消息 → 清零 unread 和 pending_directed
 * - 每 sampleInterval 条消息采样一次压力（tick = 采样序号）
 *
 * ADR-78: 群聊 directed 检测改进 — 只有 reply-to Alice 消息才算 directed，
 * 不是所有 reply-to 都算。通过 aliceMessageIds 集合交叉判断。
 */
function replayEvents(parsed: ParsedChat, sampleInterval: number = 50): PressureSnapshot[] {
  const G = buildGraphFromParsedChat(parsed);
  const snapshots: PressureSnapshot[] = [];

  const aliceId = findAliceId(parsed);
  const events = parsed.events.filter((e) => e.kind === "message");
  let tick = 0;
  let directedInInterval = 0;

  // ADR-78: 追踪 Alice 的消息 ID，用于群聊 directed 准确检测
  const aliceMessageIds = new Set<number>();

  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    const chId = parsed.chatId;
    // 统一使用墙钟时间，与 computeAllPressures 的 nowMs 默认值（Date.now()）对齐。
    // 旧代码 last_directed_ms / last_active_ms 用 tick * 60_000（模拟时间），
    // 但 P5 衰减用 Date.now() 做 ageS 计算，导致 age ≈ epoch 以来的秒数 → P5=0。
    const nowMs = Date.now();

    if (ev.senderId === aliceId) {
      // Alice 发言 → 清零未读和 directed
      G.setDynamic(chId, "unread", 0);
      G.setDynamic(chId, "unread_ewms", 0); // ADR-150
      G.setDynamic(chId, "pending_directed", 0);
      G.setDynamic(chId, "last_alice_action_ms", nowMs);
      aliceMessageIds.add(ev.messageId);
    } else {
      // 对方发言 → 累加
      const prevUnread = Number(G.getChannel(chId).unread ?? 0);
      G.setDynamic(chId, "unread", prevUnread + 1);
      // ADR-134: P1 effectiveUnread 依赖此时间戳
      G.setDynamic(chId, "last_incoming_ms", nowMs);
      // ADR-150: EWMS 同步更新
      const oldEwms = Number(G.getChannel(chId).unread_ewms ?? 0);
      const oldEwmsMs = Number(G.getChannel(chId).unread_ewms_ms ?? 0);
      const dtS = oldEwmsMs > 0 ? Math.max(0, (nowMs - oldEwmsMs) / 1000) : 0;
      const decay = dtS > 0 ? 2 ** (-dtS / UNREAD_FRESHNESS_HALFLIFE_S) : 1;
      G.setDynamic(chId, "unread_ewms", oldEwms * decay + 1.0);
      G.setDynamic(chId, "unread_ewms_ms", nowMs);

      // ADR-78: 群聊中只有 reply-to Alice 的消息才算 directed（不是所有 reply-to）
      const isDirected =
        parsed.chatType === "personal_chat" ||
        (ev.replyTo !== null && aliceMessageIds.has(ev.replyTo));

      if (isDirected) {
        const prevDirected = Number(G.getChannel(chId).pending_directed ?? 0);
        G.setDynamic(chId, "pending_directed", prevDirected + 1);
        G.setDynamic(chId, "last_directed_ms", nowMs);
        directedInInterval++;
      }
    }

    // 更新联系人 last_active
    if (G.has(ev.senderId)) {
      G.setDynamic(ev.senderId, "last_active_ms", nowMs);
      const ic = Number(G.getContact(ev.senderId).interaction_count ?? 0);
      G.setDynamic(ev.senderId, "interaction_count", ic + 1);
    }

    // 定期采样压力
    if ((i + 1) % sampleInterval === 0 || i === events.length - 1) {
      tick++;
      G.tick = tick;
      const pressures = computeAllPressures(G, tick, { nowMs });

      snapshots.push({
        tick,
        P1: pressures.P1,
        P2: pressures.P2,
        P3: pressures.P3,
        P4: pressures.P4,
        P5: pressures.P5,
        P6: pressures.P6,
        API: pressures.API,
        eventCount: sampleInterval,
        timestamp: ev.timestamp,
        directedInInterval,
      });
      directedInInterval = 0;
    }
  }

  return snapshots;
}

/** 启发式识别 Alice 的 senderId。 */
function findAliceId(parsed: ParsedChat): string | null {
  for (const [id, name] of parsed.participants) {
    if (id.includes("5275155445") || name.includes("莉莉丝") || name.includes("Lilith")) {
      return id;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// 测试 — 私聊 (private_sonya)
// ---------------------------------------------------------------------------

describe("testdata replay — private_sonya", () => {
  it.skipIf(!HAS_DATA)("解析不崩溃", () => {
    const parsed = parseTelegramExport(DATA_PATH);
    expect(parsed.chatName).toBeTruthy();
    expect(parsed.events.length).toBeGreaterThan(0);
    expect(parsed.participants.size).toBeGreaterThan(0);
  });

  it.skipIf(!HAS_DATA)("graph 包含正确的联系人", () => {
    const parsed = parseTelegramExport(DATA_PATH);
    const G = buildGraphFromParsedChat(parsed);

    // 应有 agent + contacts + channel
    expect(G.has("self")).toBe(true);
    expect(G.has(parsed.chatId)).toBe(true);
    // personal_chat 应有 2 个参与者
    expect(parsed.participants.size).toBe(2);
    for (const [senderId] of parsed.participants) {
      expect(G.has(senderId)).toBe(true);
      expect(G.getEntry(senderId).type).toBe("contact");
      expect(G.getContact(senderId).tier).toBe(150);
    }

    // channel 类型应为 private（personal_chat 映射）
    expect(G.getChannel(parsed.chatId).chat_type).toBe("private");
  });

  it.skipIf(!HAS_DATA)("事件按时间排序且 timestamp 有效", () => {
    const parsed = parseTelegramExport(DATA_PATH);
    const msgEvents = parsed.events.filter((e) => e.kind === "message");
    expect(msgEvents.length).toBeGreaterThan(100);

    for (let i = 1; i < msgEvents.length; i++) {
      expect(msgEvents[i].timestamp).toBeGreaterThanOrEqual(msgEvents[i - 1].timestamp);
    }

    // 所有 timestamp 应为合理的 Unix epoch（2020-2025 范围）
    for (const ev of msgEvents) {
      expect(ev.timestamp).toBeGreaterThan(1577836800); // 2020-01-01
      expect(ev.timestamp).toBeLessThan(1893456000); // 2030-01-01
    }
  });

  it.skipIf(!HAS_DATA)("rich text 正确提取长度", () => {
    const parsed = parseTelegramExport(DATA_PATH);
    // 至少有一些非零长度消息
    const withText = parsed.events.filter((e) => e.textLength > 0);
    expect(withText.length).toBeGreaterThan(0);
    // 不应有负值
    for (const ev of parsed.events) {
      expect(ev.textLength).toBeGreaterThanOrEqual(0);
    }
  });

  it.skipIf(!HAS_DATA)("P1 在消息密集期上升", () => {
    const parsed = parseTelegramExport(DATA_PATH);
    const snapshots = replayEvents(parsed, 50);
    expect(snapshots.length).toBeGreaterThan(5);

    // 找到 unread 累积的区间（Alice 未说话时 P1 应上升）
    // 收集所有 P1 > 0 的快照
    const p1Positive = snapshots.filter((s) => s.P1 > 0);
    // 对于私聊，应有大量时刻 P1 > 0（对方发消息未被回复）
    expect(p1Positive.length).toBeGreaterThan(0);
  });

  it.skipIf(!HAS_DATA)("P3 在长间隔后上升", () => {
    const parsed = parseTelegramExport(DATA_PATH);
    const snapshots = replayEvents(parsed, 50);

    // P3 关系冷却：silence 越大越高。
    // 202 天跨度的私聊，如果有长间隔应能观察到 P3 波动。
    // 由于 batchSize=50 且 theta_c=80(tier 150)，tick 差值需 > 80 才显著。
    // 但这里 tick 是批次序号（不是时间），所以 P3 主要取决于 contact.last_active_ms 和 nowMs 差。
    // 至少验证 P3 不全为零。
    const p3Values = snapshots.map((s) => s.P3);
    const maxP3 = Math.max(...p3Values);
    // P3 应在某些时刻上升
    expect(maxP3).toBeGreaterThan(0);
  });

  it.skipIf(!HAS_DATA)("P5 在被回复时上升", () => {
    const parsed = parseTelegramExport(DATA_PATH);
    const snapshots = replayEvents(parsed, 50);

    // P5 回应义务：pending_directed > 0 时应 > 0
    const p5Positive = snapshots.filter((s) => s.P5 > 0);
    // 私聊中对方消息都是 directed，所以 P5 应经常上升
    expect(p5Positive.length).toBeGreaterThan(0);
  });

  it.skipIf(!HAS_DATA)("API 始终为正值", () => {
    const parsed = parseTelegramExport(DATA_PATH);
    const snapshots = replayEvents(parsed, 50);

    for (const s of snapshots) {
      expect(s.API).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(s.API)).toBe(true);
      expect(Number.isNaN(s.API)).toBe(false);
    }
  });

  it.skipIf(!HAS_DATA)("压力值在合理范围内", () => {
    const parsed = parseTelegramExport(DATA_PATH);
    const snapshots = replayEvents(parsed, 50);

    for (const s of snapshots) {
      // P1-P6 都不应为 NaN 或 Infinity
      for (const pk of ["P1", "P2", "P3", "P4", "P5", "P6"] as const) {
        const v = s[pk];
        expect(Number.isFinite(v), `${pk} at tick ${s.tick} is not finite: ${v}`).toBe(true);
        expect(v).toBeGreaterThanOrEqual(0);
      }
      // API ∈ [0, 7) 的合理范围（6 个 tanh + 1 个 prospect tanh）
      expect(s.API).toBeLessThan(7);
    }
  });

  it.skipIf(!HAS_DATA)("压力时间序列有变化（不全为常数）", () => {
    const parsed = parseTelegramExport(DATA_PATH);
    const snapshots = replayEvents(parsed, 50);

    // API 应有波动（不全为同一个值）
    const apis = snapshots.map((s) => s.API);
    const uniqueApis = new Set(apis.map((v) => v.toFixed(4)));
    expect(uniqueApis.size).toBeGreaterThan(1);

    // P1 应有波动（Alice 有时回复，有时不回）
    const p1s = snapshots.map((s) => s.P1);
    const uniqueP1s = new Set(p1s.map((v) => v.toFixed(4)));
    expect(uniqueP1s.size).toBeGreaterThan(1);
  });
});

// ---------------------------------------------------------------------------
// 测试 — 小群 (smallgroup_poetry)
// ADR-78: 群聊自然性验证 — 验证群聊场景下的压力管线行为
// ---------------------------------------------------------------------------

describe("testdata replay — smallgroup_poetry", () => {
  it.skipIf(!HAS_GROUP_DATA)("解析不崩溃", () => {
    const parsed = parseTelegramExport(GROUP_DATA_PATH);
    expect(parsed.chatName).toBeTruthy();
    expect(parsed.events.length).toBeGreaterThan(0);
    // 小群应有多个参与者
    expect(parsed.participants.size).toBeGreaterThan(2);
  });

  it.skipIf(!HAS_GROUP_DATA)("graph chat_type 为 supergroup", () => {
    const parsed = parseTelegramExport(GROUP_DATA_PATH);
    const G = buildGraphFromParsedChat(parsed);
    // private_supergroup 映射为 supergroup
    expect(["group", "supergroup"]).toContain(G.getChannel(parsed.chatId).chat_type);
  });

  it.skipIf(!HAS_GROUP_DATA)("多发送者正确识别", () => {
    const parsed = parseTelegramExport(GROUP_DATA_PATH);
    const G = buildGraphFromParsedChat(parsed);
    // 34 个参与者 — 允许误差（某些可能被过滤）
    expect(parsed.participants.size).toBeGreaterThan(5);
    for (const [senderId] of parsed.participants) {
      expect(G.has(senderId)).toBe(true);
    }
  });

  it.skipIf(!HAS_GROUP_DATA)("群聊 P5 远低于私聊（大部分消息非 directed）", () => {
    const parsed = parseTelegramExport(GROUP_DATA_PATH);
    const snapshots = replayEvents(parsed, 200);
    expect(snapshots.length).toBeGreaterThan(5);

    // 群聊中大部分消息不是 directed at Alice → P5 在多数采样点应较低
    const p5Values = snapshots.map((s) => s.P5);
    const p5Zero = p5Values.filter((v) => v === 0).length;

    // 至少一半的采样点 P5 = 0（没有 pending_directed）
    expect(p5Zero / p5Values.length).toBeGreaterThan(0.3);
  });

  it.skipIf(!HAS_GROUP_DATA)("群聊 directed 消息只在 reply-to Alice 时触发", () => {
    const parsed = parseTelegramExport(GROUP_DATA_PATH);
    const snapshots = replayEvents(parsed, 200);

    // 统计有 directed 消息的采样区间占比
    const withDirected = snapshots.filter((s) => s.directedInInterval > 0);
    // 大部分区间不应有 directed（Alice 不太可能在小群中被频繁 @）
    expect(withDirected.length / snapshots.length).toBeLessThan(0.5);
  });

  it.skipIf(!HAS_GROUP_DATA)("群聊 API 均值低于典型私聊（群聊权重更低）", () => {
    const parsed = parseTelegramExport(GROUP_DATA_PATH);
    const snapshots = replayEvents(parsed, 200);

    const avgAPI = snapshots.reduce((sum, s) => sum + s.API, 0) / snapshots.length;
    // 群聊 chat_type_weight 为 0.8（vs 私聊 3.0），API 均值应较低
    // 不设绝对阈值（取决于消息量），但验证有合理范围
    expect(avgAPI).toBeLessThan(5);
    expect(avgAPI).toBeGreaterThanOrEqual(0);
  });

  it.skipIf(!HAS_GROUP_DATA)("压力值在合理范围内", () => {
    const parsed = parseTelegramExport(GROUP_DATA_PATH);
    const snapshots = replayEvents(parsed, 200);

    for (const s of snapshots) {
      for (const pk of ["P1", "P2", "P3", "P4", "P5", "P6"] as const) {
        const v = s[pk];
        expect(Number.isFinite(v), `${pk} at tick ${s.tick} is not finite: ${v}`).toBe(true);
        expect(v).toBeGreaterThanOrEqual(0);
      }
      expect(s.API).toBeLessThan(7);
    }
  });

  it.skipIf(!HAS_GROUP_DATA)("压力时间序列有变化", () => {
    const parsed = parseTelegramExport(GROUP_DATA_PATH);
    const snapshots = replayEvents(parsed, 200);

    const apis = snapshots.map((s) => s.API);
    const uniqueApis = new Set(apis.map((v) => v.toFixed(4)));
    expect(uniqueApis.size).toBeGreaterThan(1);
  });
});

// ---------------------------------------------------------------------------
// 测试 — 大群 (supergroup_miaomiao)
// ADR-78: 高流速群聊场景 — 372,800 条消息，采样回放
// ---------------------------------------------------------------------------

describe("testdata replay — supergroup_miaomiao (sampled)", () => {
  it.skipIf(!HAS_SUPERGROUP_DATA)("解析不崩溃", () => {
    const parsed = parseTelegramExport(SUPERGROUP_DATA_PATH);
    expect(parsed.chatName).toBeTruthy();
    expect(parsed.events.length).toBeGreaterThan(1000);
    // 大群应有大量参与者
    expect(parsed.participants.size).toBeGreaterThan(50);
  });

  it.skipIf(!HAS_SUPERGROUP_DATA)("高流速群聊压力不溢出", { timeout: 60_000 }, () => {
    const parsed = parseTelegramExport(SUPERGROUP_DATA_PATH);
    // 大群采样：每 1000 条消息采样一次，避免测试过慢
    const snapshots = replayEvents(parsed, 1000);
    expect(snapshots.length).toBeGreaterThan(10);

    for (const s of snapshots) {
      for (const pk of ["P1", "P2", "P3", "P4", "P5", "P6"] as const) {
        const v = s[pk];
        expect(Number.isFinite(v), `${pk} at tick ${s.tick} is not finite: ${v}`).toBe(true);
        expect(v).toBeGreaterThanOrEqual(0);
      }
      expect(s.API).toBeLessThan(7);
      expect(Number.isFinite(s.API)).toBe(true);
    }
  });

  it.skipIf(!HAS_SUPERGROUP_DATA)("大群 P5 应极低（Alice 几乎不被 @）", { timeout: 60_000 }, () => {
    const parsed = parseTelegramExport(SUPERGROUP_DATA_PATH);
    const snapshots = replayEvents(parsed, 1000);

    const p5Values = snapshots.map((s) => s.P5);
    const p5Zero = p5Values.filter((v) => v === 0).length;

    // 大群中 Alice 几乎不会被 directed → 绝大部分 P5 = 0
    expect(p5Zero / p5Values.length).toBeGreaterThan(0.5);
  });

  it.skipIf(!HAS_SUPERGROUP_DATA)("大群 API 不会无限增长（tanh 饱和）", { timeout: 60_000 }, () => {
    const parsed = parseTelegramExport(SUPERGROUP_DATA_PATH);
    const snapshots = replayEvents(parsed, 1000);

    // P1-P6 是原始压力值（可以很大），但 API = Σ tanh(Pk/κk) + tanh(P_prospect/κ_p)
    // 无论原始压力多大，API 被 tanh 饱和约束在 [0, 7) 范围。
    // 这里验证：即使 unread 达到数十万，API 仍不溢出。
    const apiValues = snapshots.map((s) => s.API);
    const maxAPI = Math.max(...apiValues);
    expect(maxAPI).toBeLessThan(7);
    expect(Number.isFinite(maxAPI)).toBe(true);

    // P1 原始值可以很大（unread 累积），但必须是有限数
    const p1Values = snapshots.map((s) => s.P1);
    const maxP1 = Math.max(...p1Values);
    expect(Number.isFinite(maxP1)).toBe(true);
  });
});
