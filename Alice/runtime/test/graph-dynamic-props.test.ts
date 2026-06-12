import { describe, expect, it } from "vitest";
import {
  isBlockedByContact,
  isBotContact,
  readBlockedByContact,
  readChatType,
  readDisplayLabel,
  readDisplayName,
  readForwardRegistry,
  readLastAliceActionMs,
  readLastOutgoingText,
  readLastSharedMs,
  readRecentlyClearedMs,
  readTitle,
  writeLastAliceActionMs,
  writeLastOutgoingText,
  writeRecentlyClearedMs,
} from "../src/graph/dynamic-props.js";
import type { ChatType } from "../src/graph/entities.js";
import { WorldModel } from "../src/graph/world-model.js";

function makeGraph(): WorldModel {
  const G = new WorldModel();
  G.addContact("contact:alice", { display_name: "Alice" });
  G.addContact("contact:bot", { display_name: "Helper", is_bot: true });
  G.addChannel("channel:private", { chat_type: "private", display_name: "Alice DM" });
  G.addThread("thread:plan", { title: "Plan" });
  return G;
}

describe("typed dynamic graph props", () => {
  it("reads display labels without caller casts", () => {
    const G = makeGraph();

    const displayName: string | undefined = readDisplayName(G, "contact:alice");
    const title: string | undefined = readTitle(G, "thread:plan");
    const label: string = readDisplayLabel(G, "thread:plan");

    expect(displayName).toBe("Alice");
    expect(title).toBe("Plan");
    expect(label).toBe("Plan");
    expect(readDisplayLabel(G, "missing")).toBe("missing");
  });

  it("defaults wrong profile shapes safely", () => {
    const G = makeGraph();
    G.setDynamic("contact:alice", "display_name", 123);
    G.setDynamic("thread:plan", "title", { text: "Plan" });
    G.setDynamic("channel:private", "chat_type", "megagroup");
    G.setDynamic("contact:bot", "is_bot", "true");
    G.setDynamic("contact:alice", "blocked_alice", "yes");

    expect(readDisplayName(G, "contact:alice")).toBeUndefined();
    expect(readTitle(G, "thread:plan")).toBeUndefined();
    expect(readDisplayLabel(G, "contact:alice")).toBe("contact:alice");
    expect(readChatType(G, "channel:private")).toBeUndefined();
    expect(isBotContact(G, "contact:bot")).toBe(false);
    expect(isBlockedByContact(G, "contact:alice")).toBe(false);
    expect(readBlockedByContact(G, "contact:alice")).toBe(false);
  });

  it("returns typed chat_type and bot flags without caller casts", () => {
    const G = makeGraph();

    const chatType: ChatType | undefined = readChatType(G, "channel:private");
    const bot: boolean = isBotContact(G, "contact:bot");

    expect(chatType).toBe("private");
    expect(bot).toBe(true);
    expect(isBotContact(G, "missing")).toBe(false);
  });

  it("reads and writes recent action facts with safe defaults", () => {
    const G = makeGraph();

    G.setDynamic("channel:private", "last_alice_action_ms", "100");
    G.setDynamic("channel:private", "last_outgoing_text", 42);
    G.setDynamic("channel:private", "recently_cleared_ms", null);
    G.setDynamic("channel:private", "last_shared_ms", false);

    const lastActionBefore: number = readLastAliceActionMs(G, "channel:private");
    const outgoingBefore: string = readLastOutgoingText(G, "channel:private");
    const clearedBefore: number = readRecentlyClearedMs(G, "channel:private");
    const lastShared: number = readLastSharedMs(G, "channel:private");

    expect(lastActionBefore).toBe(0);
    expect(outgoingBefore).toBe("");
    expect(clearedBefore).toBe(0);
    expect(lastShared).toBe(0);

    writeLastAliceActionMs(G, "channel:private", 1000);
    writeLastOutgoingText(G, "channel:private", "hello");
    writeRecentlyClearedMs(G, "channel:private", 2000);

    const lastActionAfter: number = readLastAliceActionMs(G, "channel:private");
    const outgoingAfter: string = readLastOutgoingText(G, "channel:private");
    const clearedAfter: number = readRecentlyClearedMs(G, "channel:private");

    expect(lastActionAfter).toBe(1000);
    expect(outgoingAfter).toBe("hello");
    expect(clearedAfter).toBe(2000);
  });

  it("truncates outgoing text at the existing 150 character projection limit", () => {
    const G = makeGraph();

    writeLastOutgoingText(G, "channel:private", "a".repeat(151));

    expect(readLastOutgoingText(G, "channel:private")).toHaveLength(150);
  });

  it("defaults malformed forward registries instead of leaking bad shapes", () => {
    const G = makeGraph();

    G.setDynamic("channel:private", "forwarded_msgs", { "1": "Alice" });
    expect(readForwardRegistry(G, "channel:private")).toEqual({});

    G.setDynamic("channel:private", "forwarded_msgs", { "1": ["Alice"] });
    expect(readForwardRegistry(G, "channel:private")).toEqual({ "1": ["Alice"] });
  });

  it("write helpers ignore missing nodes instead of requiring caller guards", () => {
    const G = makeGraph();

    expect(() => writeLastAliceActionMs(G, "missing", 1)).not.toThrow();
    expect(() => writeLastOutgoingText(G, "missing", "hello")).not.toThrow();
    expect(() => writeRecentlyClearedMs(G, "missing", 1)).not.toThrow();
  });
});
