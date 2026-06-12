import { describe, expect, it } from "vitest";
import { findUnknownOption } from "../src/system/cli-strict.js";

describe("findUnknownOption", () => {
  const sayArgs = {
    json: {},
    in: {},
    text: {},
    "resolve-thread": {},
  };

  const tailArgs = {
    json: {},
    in: {},
    count: { alias: "c" },
  };

  it("accepts declared long flags", () => {
    expect(findUnknownOption(["--in", "123", "--text", "hello"], sayArgs)).toBeNull();
  });

  it("accepts citty camelCase aliases derived from kebab-case names", () => {
    expect(findUnknownOption(["--resolveThread", "42", "--text", "done"], sayArgs)).toBeNull();
  });

  it("accepts declared short aliases", () => {
    expect(findUnknownOption(["-c", "5"], tailArgs)).toBeNull();
  });

  it("does not mistake negative numbers for flags", () => {
    expect(findUnknownOption(["--in", "-1001234567890", "--text", "ok"], sayArgs)).toBeNull();
  });

  it("reports unknown long flags", () => {
    expect(findUnknownOption(["--unread"], sayArgs)).toBe("--unread");
  });

  it("reports unknown short flags", () => {
    expect(findUnknownOption(["-x"], tailArgs)).toBe("-x");
  });
});
