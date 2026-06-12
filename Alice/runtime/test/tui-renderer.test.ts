/**
 * TUI 渲染层测试 — Section 行级分配 + overflow 裁剪。
 *
 * @see runtime/src/core/tui-renderer.ts
 * @see docs/adr/209-tui-native-prompt.md
 */
import { describe, expect, it } from "vitest";
import {
  allocateRows,
  clipLines,
  renderSections,
  type SectionInput,
} from "../src/core/tui-renderer.js";

// -- helpers ----------------------------------------------------------------

function makeSection(
  id: string,
  size: { type: "fixed"; value: number } | { type: "fill" },
  lines: string[],
  overflow: "clip-top" | "clip-bottom" = "clip-bottom",
): SectionInput {
  return { spec: { id, size, overflow }, lines };
}

function lines(n: number, prefix = "line"): string[] {
  return Array.from({ length: n }, (_, i) => `${prefix}-${i + 1}`);
}

// -- allocateRows -----------------------------------------------------------

describe("allocateRows", () => {
  it("fixed sections get min(value, content.length)", () => {
    const sections: SectionInput[] = [
      makeSection("a", { type: "fixed", value: 5 }, lines(3)),
      makeSection("b", { type: "fixed", value: 2 }, lines(10)),
    ];
    expect(allocateRows(sections, 100)).toEqual([3, 2]);
  });

  it("fill section gets remaining rows", () => {
    const sections: SectionInput[] = [
      makeSection("status", { type: "fixed", value: 3 }, lines(3)),
      makeSection("timeline", { type: "fill" }, lines(50)),
      makeSection("footer", { type: "fixed", value: 4 }, lines(4)),
    ];
    // totalRows=40, fixed=3+4=7, fill gets 40-7=33, capped by content=50 → 33
    const result = allocateRows(sections, 40);
    expect(result[0]).toBe(3);
    expect(result[1]).toBe(33);
    expect(result[2]).toBe(4);
  });

  it("fill section capped by content length", () => {
    const sections: SectionInput[] = [
      makeSection("status", { type: "fixed", value: 3 }, lines(3)),
      makeSection("timeline", { type: "fill" }, lines(5)),
      makeSection("footer", { type: "fixed", value: 4 }, lines(4)),
    ];
    const result = allocateRows(sections, 100);
    expect(result[1]).toBe(5);
  });

  it("totalRows=0 means unlimited", () => {
    const sections: SectionInput[] = [makeSection("a", { type: "fill" }, lines(100))];
    const result = allocateRows(sections, 0);
    expect(result[0]).toBe(100);
  });

  it("multiple fill sections share remaining equally", () => {
    const sections: SectionInput[] = [
      makeSection("a", { type: "fill" }, lines(50)),
      makeSection("b", { type: "fill" }, lines(50)),
    ];
    const result = allocateRows(sections, 20);
    expect(result[0] + result[1]).toBeLessThanOrEqual(20);
    expect(Math.abs(result[0] - result[1])).toBeLessThanOrEqual(1);
  });

  it("handles all rows consumed by fixed sections", () => {
    const sections: SectionInput[] = [
      makeSection("a", { type: "fixed", value: 20 }, lines(20)),
      makeSection("b", { type: "fill" }, lines(50)),
      makeSection("c", { type: "fixed", value: 20 }, lines(20)),
    ];
    const result = allocateRows(sections, 40);
    expect(result[1]).toBe(0);
  });
});

// -- clipLines --------------------------------------------------------------

describe("clipLines", () => {
  it("clip-top preserves last N lines", () => {
    const input = lines(10, "msg");
    const result = clipLines(input, 3, "clip-top");
    expect(result).toEqual(["msg-8", "msg-9", "msg-10"]);
  });

  it("clip-bottom preserves first N lines", () => {
    const input = lines(10, "ctx");
    const result = clipLines(input, 3, "clip-bottom");
    expect(result).toEqual(["ctx-1", "ctx-2", "ctx-3"]);
  });

  it("returns all lines when within budget", () => {
    const input = lines(3);
    expect(clipLines(input, 5, "clip-top")).toEqual(input);
    expect(clipLines(input, 5, "clip-bottom")).toEqual(input);
  });

  it("returns empty for maxRows=0", () => {
    expect(clipLines(lines(5), 0, "clip-top")).toEqual([]);
  });
});

// -- renderSections ---------------------------------------------------------

describe("renderSections", () => {
  it("renders sections separated by blank lines", () => {
    const sections: SectionInput[] = [
      makeSection("a", { type: "fixed", value: 2 }, ["line-a1", "line-a2"]),
      makeSection("b", { type: "fixed", value: 2 }, ["line-b1", "line-b2"]),
    ];
    const { text } = renderSections(sections);
    expect(text).toBe("line-a1\nline-a2\n\nline-b1\nline-b2");
  });

  it("skips empty sections in output", () => {
    const sections: SectionInput[] = [
      makeSection("a", { type: "fixed", value: 2 }, ["line-a1"]),
      makeSection("empty", { type: "fixed", value: 5 }, []),
      makeSection("b", { type: "fixed", value: 2 }, ["line-b1"]),
    ];
    const { text } = renderSections(sections);
    expect(text).toBe("line-a1\n\nline-b1");
  });

  it("timeline clip-top preserves newest messages", () => {
    const msgs = Array.from(
      { length: 20 },
      (_, i) => `[14:${String(i).padStart(2, "0")}] msg-${i + 1}`,
    );
    const sections: SectionInput[] = [
      makeSection("status", { type: "fixed", value: 2 }, ["status-1", "status-2"]),
      makeSection("timeline", { type: "fill" }, msgs, "clip-top"),
      makeSection("footer", { type: "fixed", value: 2 }, ["footer-1", "footer-2"]),
    ];
    // totalRows=16, fixed=2+2=4, fill gets 12
    const { text, stats } = renderSections(sections, 16);

    expect(stats[1].clippedLines).toBe(8);
    expect(stats[1].outputLines).toBe(12);
    expect(text).toContain("msg-20");
    expect(text).not.toContain("msg-1\n");
  });

  it("returns stats for each section", () => {
    const sections: SectionInput[] = [
      makeSection("a", { type: "fixed", value: 3 }, lines(5)),
      makeSection("b", { type: "fill" }, lines(2)),
    ];
    const { stats } = renderSections(sections, 10);

    expect(stats[0].id).toBe("a");
    expect(stats[0].originalLines).toBe(5);
    expect(stats[0].outputLines).toBe(3);
    expect(stats[0].clippedLines).toBe(2);

    expect(stats[1].id).toBe("b");
    expect(stats[1].clippedLines).toBe(0);
  });

  it("handles empty input", () => {
    const { text, stats } = renderSections([]);
    expect(text).toBe("");
    expect(stats).toEqual([]);
  });
});
