import { describe, expect, it } from "vitest";
import { parseKeyValueArgs } from "../src/system/cli-bridge.js";

describe("parseKeyValueArgs", () => {
  it("parses --key=value format", () => {
    expect(parseKeyValueArgs(["--count=20", "--name=test"])).toEqual({
      count: 20,
      name: "test",
    });
  });

  it("parses --key value format (LLM natural style)", () => {
    expect(parseKeyValueArgs(["--count", "20", "--name", "test"])).toEqual({
      count: 20,
      name: "test",
    });
  });

  it("parses numbers, booleans, null correctly", () => {
    expect(parseKeyValueArgs(["--num", "42", "--flag", "true", "--empty", "null"])).toEqual({
      num: 42,
      flag: true,
      empty: null,
    });
  });

  it("parses JSON values", () => {
    expect(parseKeyValueArgs(["--list", "[1,2,3]", "--obj", '{"a":1}'])).toEqual({
      list: [1, 2, 3],
      obj: { a: 1 },
    });
  });

  it("handles negative numeric values (Telegram group IDs)", () => {
    expect(parseKeyValueArgs(["--in", "-1009900000001", "--count", "10"])).toEqual({
      in: -1009900000001,
      count: 10,
    });
  });

  it("handles boolean flags (--flag without following value)", () => {
    expect(parseKeyValueArgs(["--verbose"])).toEqual({ verbose: true });
    expect(parseKeyValueArgs(["--verbose", "--dry-run"])).toEqual({
      verbose: true,
      "dry-run": true,
    });
  });

  it("throws on invalid format", () => {
    // 单个无值的参数且后面没有值
    expect(() => parseKeyValueArgs(["lonely"])).toThrow(
      'unknown argument "lonely". Use --key value format.',
    );
  });
});
