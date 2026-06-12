import { describe, expect, it } from "vitest";
import { lintPromptStyle } from "../src/core/prompt-style.js";
import { createInviteLinkContract } from "../src/telegram/action-contracts.js";

describe("createInviteLinkContract", () => {
  it("多行 invite link 会归一化为单行 kv", () => {
    const result = createInviteLinkContract.formatResult("\nhttps://t.me/+abc123\n");

    expect(result).toEqual(["Invite link: https://t.me/+abc123"]);
    expect(lintPromptStyle(result?.join("\n") ?? "")).toEqual([]);
  });
});
