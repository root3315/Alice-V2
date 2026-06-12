import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Config, loadConfig } from "../src/config.js";
import { emptyScriptExecutionResult } from "../src/core/script-execution.js";
import { closeDb, getDb, initDb } from "../src/db/connection.js";
import { actionLog } from "../src/db/schema.js";
import { ActionQueue, type ActionQueueItem } from "../src/engine/action-queue.js";
import { type ActContext, startReActLoop } from "../src/engine/react/orchestrator.js";
import type { SubcycleResult } from "../src/engine/react/types.js";
import { WorldModel } from "../src/graph/world-model.js";
import { EventBuffer } from "../src/telegram/events.js";
import type { PressureDims } from "../src/utils/math.js";
import { PersonalityVector } from "../src/voices/personality.js";

const runTickSubcycleMock = vi.hoisted(() => vi.fn());

vi.mock("../src/engine/tick/bridge.js", () => ({
  runTickSubcycle: runTickSubcycleMock,
}));

function makeQueuedItem(target: string): ActionQueueItem {
  const pressureSnapshot: PressureDims = [100, 0, 0, 0, 0, 0];
  return {
    enqueueTick: 1,
    action: "sociability",
    target,
    pressureSnapshot,
    contributions: {},
    observation: {
      candidateId: "candidate:stale",
      enqueueId: "enqueue:stale",
      api: 1,
      apiPeak: 1,
    },
  };
}

function makeConfig(): Config {
  const config = loadConfig();
  config.stalenessThreshold = 0.01;
  return config;
}

describe("react orchestrator staleness", () => {
  beforeEach(() => {
    initDb(":memory:");
    runTickSubcycleMock.mockReset();
  });
  afterEach(() => closeDb());

  it("stale queue expiry releases target lock without consuming pending_directed", async () => {
    const target = "channel:stale";
    const G = new WorldModel();
    G.addChannel(target, {
      chat_type: "private",
      pending_directed: 2,
      last_directed_ms: Date.now(),
    });

    const queue = new ActionQueue();
    queue.enqueue(makeQueuedItem(target));
    const loop = startReActLoop({
      client: {} as ActContext["client"],
      G,
      config: makeConfig(),
      queue,
      personality: new PersonalityVector(),
      getCurrentTick: () => 2,
      getCurrentPressures: () => [0, 0, 0, 0, 0, 0],
      onPersonalityUpdate: () => {},
      dispatcher: {
        dispatch: () => undefined,
        query: () => null,
        getInstructionNames: () => [],
        getInstructionDef: () => undefined,
        getQueryNames: () => [],
        getQueryDef: () => undefined,
        startTick: () => {},
        endTick: () => {},
        collectContributions: () => [],
        generateManual: async () => "",
        mods: [],
        snapshotModStates: () => new Map(),
        restoreModStates: () => {},
        saveModStatesToDb: () => {},
        loadModStatesFromDb: () => false,
        readModState: () => undefined,
      },
      buffer: new EventBuffer(),
      recordAction: vi.fn(),
      reportLLMOutcome: vi.fn(),
    });

    await vi.waitFor(() => {
      expect(queue.isTargetActive(target)).toBe(false);
    });
    queue.close();
    await loop;

    expect(G.getChannel(target).pending_directed).toBe(2);
  });

  it("provider_unavailable does not increment LLM scheduler backoff", async () => {
    const target = "channel:provider";
    const G = new WorldModel();
    G.addChannel(target, { chat_type: "private" });

    const queue = new ActionQueue();
    queue.enqueue(makeQueuedItem(target));
    runTickSubcycleMock.mockResolvedValueOnce({
      outcome: "empty",
      execution: emptyScriptExecutionResult(),
      duration: 1,
      roundsUsed: 0,
      episodeRounds: 0,
      failureKind: "provider_unavailable",
    } satisfies SubcycleResult);

    const reportLLMOutcome = vi.fn();
    const loop = startReActLoop({
      client: {} as ActContext["client"],
      G,
      config: { ...makeConfig(), stalenessThreshold: 999 },
      queue,
      personality: new PersonalityVector(),
      getCurrentTick: () => 2,
      getCurrentPressures: () => [100, 0, 0, 0, 0, 0],
      onPersonalityUpdate: () => {},
      dispatcher: {
        dispatch: () => undefined,
        query: () => null,
        getInstructionNames: () => [],
        getInstructionDef: () => undefined,
        getQueryNames: () => [],
        getQueryDef: () => undefined,
        startTick: () => {},
        endTick: () => {},
        collectContributions: () => [],
        generateManual: async () => "",
        mods: [],
        snapshotModStates: () => new Map(),
        restoreModStates: () => {},
        saveModStatesToDb: () => {},
        loadModStatesFromDb: () => false,
        readModState: () => undefined,
      },
      buffer: new EventBuffer(),
      recordAction: vi.fn(),
      reportLLMOutcome,
    });

    await vi.waitFor(() => {
      expect(reportLLMOutcome).toHaveBeenCalledWith(true);
    });
    queue.close();
    await loop;
  });

  it("ignores resting structural side effects for internal-only actions", async () => {
    const target = "channel:internal-resting";
    const G = new WorldModel();
    G.addAgent("self");
    G.addChannel(target, { chat_type: "private", pending_directed: 1 });

    const queue = new ActionQueue();
    queue.enqueue(makeQueuedItem(target));
    runTickSubcycleMock.mockResolvedValueOnce({
      outcome: "resting",
      execution: emptyScriptExecutionResult({
        completedActions: ["internal:command=feel"],
      }),
      duration: 1,
      roundsUsed: 0,
      episodeRounds: 0,
    } satisfies SubcycleResult);

    const loop = startReActLoop({
      client: {} as ActContext["client"],
      G,
      config: { ...makeConfig(), stalenessThreshold: 999 },
      queue,
      personality: new PersonalityVector(),
      getCurrentTick: () => 2,
      getCurrentPressures: () => [100, 0, 0, 0, 0, 0],
      onPersonalityUpdate: () => {},
      dispatcher: {
        dispatch: () => undefined,
        query: () => null,
        getInstructionNames: () => [],
        getInstructionDef: () => undefined,
        getQueryNames: () => [],
        getQueryDef: () => undefined,
        startTick: () => {},
        endTick: () => {},
        collectContributions: () => [],
        generateManual: async () => "",
        mods: [],
        snapshotModStates: () => new Map(),
        restoreModStates: () => {},
        saveModStatesToDb: () => {},
        loadModStatesFromDb: () => false,
        readModState: () => undefined,
      },
      buffer: new EventBuffer(),
      recordAction: vi.fn(),
      reportLLMOutcome: vi.fn(),
    });

    await vi.waitFor(() => {
      expect(queue.isTargetActive(target)).toBe(false);
    });
    queue.close();
    await loop;

    const self = G.getAgent("self");
    expect(self.resting_until_ms).toBeUndefined();
    expect(G.getChannel(target).pending_directed).toBe(0);

    const rows = getDb().select().from(actionLog).all();
    expect(rows[0]?.actionType).toBe("internal");
    expect(rows[0]?.engagementOutcome).toBe("complete");
  });

  it("ignores cooling_down structural side effects for reaction-only actions", async () => {
    const target = "channel:reaction-cooling";
    const G = new WorldModel();
    G.addAgent("self");
    G.addChannel(target, { chat_type: "private", pending_directed: 1 });

    const queue = new ActionQueue();
    queue.enqueue(makeQueuedItem(target));
    runTickSubcycleMock.mockResolvedValueOnce({
      outcome: "cooling_down",
      execution: emptyScriptExecutionResult({
        completedActions: ["react:chatId=reaction-cooling:msgId=42:emoji=😴"],
      }),
      duration: 1,
      roundsUsed: 0,
      episodeRounds: 0,
    } satisfies SubcycleResult);

    const loop = startReActLoop({
      client: {} as ActContext["client"],
      G,
      config: { ...makeConfig(), stalenessThreshold: 999 },
      queue,
      personality: new PersonalityVector(),
      getCurrentTick: () => 2,
      getCurrentPressures: () => [100, 0, 0, 0, 0, 0],
      onPersonalityUpdate: () => {},
      dispatcher: {
        dispatch: () => undefined,
        query: () => null,
        getInstructionNames: () => [],
        getInstructionDef: () => undefined,
        getQueryNames: () => [],
        getQueryDef: () => undefined,
        startTick: () => {},
        endTick: () => {},
        collectContributions: () => [],
        generateManual: async () => "",
        mods: [],
        snapshotModStates: () => new Map(),
        restoreModStates: () => {},
        saveModStatesToDb: () => {},
        loadModStatesFromDb: () => false,
        readModState: () => undefined,
      },
      buffer: new EventBuffer(),
      recordAction: vi.fn(),
      reportLLMOutcome: vi.fn(),
    });

    await vi.waitFor(() => {
      expect(queue.isTargetActive(target)).toBe(false);
    });
    queue.close();
    await loop;

    const channel = G.getChannel(target);
    expect(channel.aversion).toBeUndefined();
    expect(channel.pending_directed).toBe(0);

    const rows = getDb().select().from(actionLog).all();
    expect(rows[0]?.actionType).toBe("message");
    expect(rows[0]?.engagementOutcome).toBe("complete");
  });

  it("keeps resting structural side effects for visible Telegram actions", async () => {
    const target = "channel:visible-resting";
    const G = new WorldModel();
    G.addAgent("self");
    G.addChannel(target, { chat_type: "private", pending_directed: 1 });

    const queue = new ActionQueue();
    queue.enqueue(makeQueuedItem(target));
    runTickSubcycleMock.mockResolvedValueOnce({
      outcome: "resting",
      execution: emptyScriptExecutionResult({
        completedActions: ["sent:chatId=visible-resting:msgId=42"],
      }),
      duration: 1,
      roundsUsed: 0,
      episodeRounds: 0,
    } satisfies SubcycleResult);

    const loop = startReActLoop({
      client: {} as ActContext["client"],
      G,
      config: { ...makeConfig(), stalenessThreshold: 999 },
      queue,
      personality: new PersonalityVector(),
      getCurrentTick: () => 2,
      getCurrentPressures: () => [100, 0, 0, 0, 0, 0],
      onPersonalityUpdate: () => {},
      dispatcher: {
        dispatch: () => undefined,
        query: () => null,
        getInstructionNames: () => [],
        getInstructionDef: () => undefined,
        getQueryNames: () => [],
        getQueryDef: () => undefined,
        startTick: () => {},
        endTick: () => {},
        collectContributions: () => [],
        generateManual: async () => "",
        mods: [],
        snapshotModStates: () => new Map(),
        restoreModStates: () => {},
        saveModStatesToDb: () => {},
        loadModStatesFromDb: () => false,
        readModState: () => undefined,
      },
      buffer: new EventBuffer(),
      recordAction: vi.fn(),
      reportLLMOutcome: vi.fn(),
    });

    await vi.waitFor(() => {
      expect(queue.isTargetActive(target)).toBe(false);
    });
    queue.close();
    await loop;

    const self = G.getAgent("self");
    expect(self.resting_until_ms).toBeGreaterThan(Date.now());

    const rows = getDb().select().from(actionLog).all();
    expect(rows[0]?.actionType).toBe("message");
    expect(rows[0]?.engagementOutcome).toBe("resting");
  });
});
