/**
 * M5 读操作测试。
 *
 * 验证:
 * 1. action-defs 注册完整性（shell-native system chat surface included）
 * 2. usageHint/category 工具函数（getUsageHintsByCategory, renderAllUsageHints）
 * 3. strategy.mod contribute 不再产出 capability-hints section（ADR-72 W2）
 *
 * ADR-105 CQRS 后，fire-and-retrieve contribute 路径已删除——
 * 读操作结果通过 formatQueryObservations() 注入 observations，不再通过 contribute。
 *
 * @see docs/adr/105-react-cqrs-read-during-next.md
 * @see docs/adr/51-m5-interaction-primitives-implementation.md
 */
import { describe, expect, it } from "vitest";
import type { ModContext } from "../src/core/types.js";
import { WorldModel } from "../src/graph/world-model.js";
import type { GroupChatState, PersonalityDriftState } from "../src/mods/strategy/types.js";
import { strategyMod } from "../src/mods/strategy.mod.js";
import {
  getUsageHintsByCategory,
  renderAllUsageHints,
  renderCategoryHints,
  TELEGRAM_ACTION_MAP,
  TELEGRAM_ACTIONS,
} from "../src/telegram/actions/index.js";

// -- action-defs 注册验证 ---------------------------------------------------

describe("action-defs 注册完整性", () => {
  it("共 36 个动作注册（含 shell-native system chat surface + publish_channel）", () => {
    expect(TELEGRAM_ACTIONS.length).toBe(36);
  });

  it("TELEGRAM_ACTION_MAP 包含所有注册动作", () => {
    expect(TELEGRAM_ACTION_MAP.size).toBe(36);
    for (const def of TELEGRAM_ACTIONS) {
      expect(TELEGRAM_ACTION_MAP.has(def.name)).toBe(true);
    }
  });

  it("11 个读操作已注册（CQRS query，含 shell-native system chat queries）", () => {
    const readOps = [
      "tail",
      "whois",
      "topic",
      "list_stickers",
      "get_sticker_set",
      "search",
      "search_public",
      "preview_chat",
      "get_similar_channels",
      "get_bot_commands",
      "read_notes",
      // google, visit — migrated to Skill CLI (loaded via syncEnv)
      // use_calendar_app, use_countdown_app — migrated to Skill CLI (loaded via syncEnv)
    ];
    for (const name of readOps) {
      expect(TELEGRAM_ACTION_MAP.has(name)).toBe(true);
    }
  });

  it("所有动作有 name、description、params、impl", () => {
    for (const def of TELEGRAM_ACTIONS) {
      expect(def.name).toBeTruthy();
      expect(def.description.length).toBeGreaterThan(0);
      expect(Array.isArray(def.params)).toBe(true);
      expect(typeof def.impl).toBe("function");
    }
  });

  it("动作名不重复", () => {
    const names = TELEGRAM_ACTIONS.map((d) => d.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

// -- category + usageHint 工具函数 ------------------------------------------

describe("category + usageHint 工具函数", () => {
  it("所有动作都有 category", () => {
    for (const def of TELEGRAM_ACTIONS) {
      expect(def.category).toBeTruthy();
    }
  });

  it("getUsageHintsByCategory 返回正确类别", () => {
    const stickerHints = getUsageHintsByCategory("sticker");
    expect(stickerHints.length).toBeGreaterThanOrEqual(2); // send_sticker + list_stickers + get_sticker_set
    for (const h of stickerHints) {
      const def = TELEGRAM_ACTION_MAP.get(h.name);
      expect(def?.category).toBe("sticker");
    }
  });

  it("getUsageHintsByCategory 只返回有 usageHint 的动作", () => {
    const all = getUsageHintsByCategory("messaging");
    for (const h of all) {
      expect(h.hint).toBeTruthy();
    }
  });

  it("renderCategoryHints 格式正确", () => {
    const text = renderCategoryHints("bot");
    expect(text).toContain("inline_query");
    expect(text).toContain("click_inline_button");
  });

  it("renderAllUsageHints 覆盖所有有 hint 的类别", () => {
    const text = renderAllUsageHints();
    // 验证关键类别出现
    expect(text).toContain("[sticker]");
    expect(text).toContain("[bot]");
    expect(text).toContain("[group]");
    expect(text).toContain("[search]");
    // 验证关键函数名出现
    expect(text).toContain("list_stickers");
    expect(text).toContain("search");
    expect(text).toContain("inline_query");
    expect(text).toContain("join_chat");
    expect(text).toContain("join");
    expect(text).toContain("tail");
  });

  it("getUsageHintsByCategory 对无 hint 的类别返回空数组", () => {
    // messaging 中 mark_read 没有 usageHint，但 send_message 有
    const hints = getUsageHintsByCategory("messaging");
    // 至少 send_message 有 hint
    const hasMarkRead = hints.some((h) => h.name === "mark_read");
    expect(hasMarkRead).toBe(false); // mark_read 没有 usageHint
  });
});

// -- ADR-72 W2: capability hints 已从 strategy.mod 移除 ----------------------

describe("strategy.mod contribute — capability-hints section 已移除（ADR-72 W2）", () => {
  it("contribute 不再产出 capability-hints section", () => {
    interface StrategyState {
      recentActions: Array<{ target: string | null; tick: number; intent: string }>;
      activeHints: Array<{ type: string; message: string }>;
      messageFrequency: Record<string, unknown>;
      crisisChannels: Record<string, number>;
      groupStates: Record<string, GroupChatState>;
      personalityDrift: PersonalityDriftState;
    }

    const state: StrategyState = {
      recentActions: [],
      activeHints: [],
      messageFrequency: {},
      crisisChannels: {},
      groupStates: {},
      personalityDrift: {
        lastAuditTick: 0,
        previousWeights: null,
        drift: 0,
        velocity: 0,
        health: "healthy",
      },
    };

    const graph = new WorldModel();
    graph.tick = 10;
    graph.addAgent("self");
    const ctx = {
      graph,
      state,
      tick: 10,
      getModState: (name: string) => {
        if (name === "pressure") return { latest: { P6: 0.8 } };
        if (name === "relationships") return { targetNodeId: "channel:test" };
        return undefined;
      },
      dispatch: () => undefined,
    };

    graph.addChannel("channel:test", { chat_type: "group" });
    graph.setDynamic("channel:test", "chat_type", "group");
    graph.addContact("contact:bot1");
    graph.setDynamic("contact:bot1", "is_bot", true);

    // biome-ignore lint/style/noNonNullAssertion: test
    const items = strategyMod.contribute!(ctx as unknown as ModContext);
    const capSection = items.find((i) => i.key === "capability-hints");
    // ADR-72 W2: Capability Hints 已迁移到独立注册表，strategy.mod 不再 contribute
    expect(capSection).toBeUndefined();
  });
});
