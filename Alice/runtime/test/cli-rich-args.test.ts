/**
 * Lenient rich-arg parsers (checklist items / table rows).
 *
 * `parseJsonStringArray` / `parseJsonStringMatrix` were exported from
 * cli-commands.ts so the tolerant LLM-input handling (JSON, markdown lists,
 * markdown tables, comma lists) can be unit-tested directly. A `die` stub that
 * throws stands in for the CLI's process-exiting error path.
 */

import { describe, expect, it } from "vitest";
import { parseJsonStringArray, parseJsonStringMatrix } from "../src/system/cli-commands.js";
import type { CliErrorCode } from "../src/system/cli-types.js";

/** Throwing `die` stub — captures the code so tests can assert it. */
class DieError extends Error {
  constructor(
    message: string,
    readonly code?: CliErrorCode,
  ) {
    super(message);
  }
}

const die = (msg: string, code?: CliErrorCode): never => {
  throw new DieError(msg, code);
};

describe("parseJsonStringArray", () => {
  it("parses a JSON array of strings", () => {
    expect(parseJsonStringArray('["a","b"]', die, "items")).toEqual(["a", "b"]);
  });

  it("parses dash/star markdown bullet lines", () => {
    expect(parseJsonStringArray("- a\n- b\n* c", die, "items")).toEqual(["a", "b", "c"]);
  });

  it("parses numbered list lines", () => {
    expect(parseJsonStringArray("1. x\n2. y", die, "items")).toEqual(["x", "y"]);
  });

  it("parses a single comma-separated line", () => {
    expect(parseJsonStringArray("a, b, c", die, "items")).toEqual(["a", "b", "c"]);
  });

  it("parses checkbox-marker lines (stripping [ ] / [x])", () => {
    expect(parseJsonStringArray("[ ] todo\n[x] done", die, "items")).toEqual(["todo", "done"]);
  });

  it("coerces JSON numbers to strings", () => {
    expect(parseJsonStringArray("[1,2]", die, "items")).toEqual(["1", "2"]);
  });

  it("dies with command_missing_argument on empty input", () => {
    let caught: DieError | undefined;
    try {
      parseJsonStringArray("", die, "items");
    } catch (e) {
      caught = e as DieError;
    }
    expect(caught).toBeInstanceOf(DieError);
    expect(caught?.code).toBe("command_missing_argument");
  });
});

describe("parseJsonStringMatrix", () => {
  it("parses a JSON matrix", () => {
    expect(parseJsonStringMatrix('[["a","b"],["c","d"]]', die, "rows")).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
  });

  it("parses markdown rows and skips the separator row", () => {
    expect(parseJsonStringMatrix("a | b\n|---|\nc | d", die, "rows")).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
  });

  it("parses a single pipe-delimited row with surrounding bars", () => {
    expect(parseJsonStringMatrix("| a | b |", die, "rows")).toEqual([["a", "b"]]);
  });

  it("dies with command_missing_argument on empty input", () => {
    let caught: DieError | undefined;
    try {
      parseJsonStringMatrix("", die, "rows");
    } catch (e) {
      caught = e as DieError;
    }
    expect(caught).toBeInstanceOf(DieError);
    expect(caught?.code).toBe("command_missing_argument");
  });
});
