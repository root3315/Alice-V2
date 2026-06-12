import { describe, expect, it } from "vitest";
import {
  isTransportChannelTarget,
  parseTransportMessageId,
  parseTransportTargetId,
  stableTransportMessageId,
  stableTransportTargetId,
  TransportTargetId,
  transportMessageRef,
  transportTargetRef,
} from "../src/platform/transport.js";

describe("TransportTargetId", () => {
  it("parses stable Telegram channel target ids", () => {
    const target = TransportTargetId.parse("channel:telegram:-1001234567890");

    expect(target?.kind).toBe("channel");
    expect(target?.platform).toBe("telegram");
    expect(target?.nativeId).toBe("-1001234567890");
    expect(target?.stableId).toBe("channel:telegram:-1001234567890");
  });

  it("classifies channel target ids without deriving group semantics from native ids", () => {
    expect(TransportTargetId.isChannel("channel:telegram:-1001234567890")).toBe(true);
    expect(isTransportChannelTarget("channel:telegram:-1001234567890")).toBe(true);
    expect(isTransportChannelTarget("channel:telegram:123456789")).toBe(true);
    expect(isTransportChannelTarget("channel:qq:123456789")).toBe(true);
  });

  it("rejects legacy channel:number refs at the transport parse boundary", () => {
    expect(parseTransportTargetId("channel:-1001234567890")).toBeNull();
    expect(isTransportChannelTarget("channel:-1001234567890")).toBe(false);
  });

  it("rejects reserved bridge protocol names as target platforms", () => {
    expect(parseTransportTargetId("channel:onebot:123")).toBeNull();
    expect(parseTransportTargetId("contact:napcat:123")).toBeNull();
    expect(parseTransportTargetId("channel:qq:123")).toMatchObject({
      platform: "qq",
      stableId: "channel:qq:123",
    });
  });

  it("rejects contacts and malformed target ids as channel targets", () => {
    expect(isTransportChannelTarget("contact:telegram:-1001234567890")).toBe(false);
    expect(isTransportChannelTarget("contact:qq:123456789")).toBe(false);
    expect(isTransportChannelTarget("telegram:-1001234567890")).toBe(false);
  });

  it("constructs stable target ids without manual colon assembly", () => {
    expect(stableTransportTargetId("channel", "QQ", 123)).toBe("channel:qq:123");
    expect(transportTargetRef("contact", "QQ", 456)).toMatchObject({
      kind: "contact",
      platform: "qq",
      nativeId: "456",
      stableId: "contact:qq:456",
      legacy: false,
    });
  });

  it("distinguishes target refs from message refs at parse boundaries", () => {
    const target = parseTransportTargetId("channel:qq:123");
    const message = parseTransportMessageId("message:qq:123:456");

    expect(target?.stableId).toBe("channel:qq:123");
    expect(message?.stableId).toBe("message:qq:123:456");
    expect(parseTransportTargetId("message:qq:123:456")).toBeNull();
    expect(parseTransportMessageId("channel:qq:123")).toBeNull();
  });

  it("constructs stable message ids without manual colon assembly", () => {
    expect(stableTransportMessageId("QQ", "123", 456)).toBe("message:qq:123:456");
    expect(transportMessageRef("QQ", 123, "abc")).toMatchObject({
      platform: "qq",
      chatNativeId: "123",
      messageNativeId: "abc",
      stableId: "message:qq:123:abc",
    });
  });
});
