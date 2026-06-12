/**
 * OCR 模块单测。
 *
 * - isOcrEnabled / extractText 守卫条件（不触发 ONNX 推理）
 * - processOcrLines 纯函数：置信度过滤、阅读顺序排序、截断
 */
import { describe, expect, it } from "vitest";
import type { Config } from "../src/config.js";
import { extractText, isOcrEnabled, type OcrLine, processOcrLines } from "../src/llm/ocr.js";

/** 最小 Config stub — 只包含 OCR 模块需要的字段。 */
function makeConfig(
  overrides: Partial<Pick<Config, "ocrEnabled" | "ocrMaxPerTick" | "ocrMinConfidence">> = {},
): Config {
  return {
    ocrEnabled: true,
    ocrMaxPerTick: 3,
    ocrMinConfidence: 0.6,
    ...overrides,
  } as Config;
}

/** 构造带 box 的 OcrLine。 */
function line(text: string, mean: number, top: number, left: number): OcrLine {
  return {
    text,
    mean,
    box: [
      [left, top],
      [left + 100, top],
      [left + 100, top + 20],
      [left, top + 20],
    ],
  };
}

describe("isOcrEnabled", () => {
  it("ocrEnabled=true → 返回 true", () => {
    expect(isOcrEnabled(makeConfig({ ocrEnabled: true }))).toBe(true);
  });

  it("ocrEnabled=false → 返回 false", () => {
    expect(isOcrEnabled(makeConfig({ ocrEnabled: false }))).toBe(false);
  });
});

describe("extractText 守卫条件", () => {
  it("ocrEnabled=false → 返回 undefined", async () => {
    const config = makeConfig({ ocrEnabled: false });
    const result = await extractText(Buffer.from("fake image data"), config);
    expect(result).toBeUndefined();
  });

  it("空 buffer → 返回 undefined", async () => {
    const config = makeConfig();
    const result = await extractText(Buffer.alloc(0), config);
    expect(result).toBeUndefined();
  });

  it("超大 buffer（>5MB）→ 返回 undefined", async () => {
    const config = makeConfig();
    const result = await extractText(Buffer.alloc(6 * 1024 * 1024), config);
    expect(result).toBeUndefined();
  });
});

describe("processOcrLines", () => {
  it("空数组 → undefined", () => {
    expect(processOcrLines([], 0.6)).toBeUndefined();
  });

  it("null-ish → undefined", () => {
    // biome-ignore lint: 测试边界条件
    expect(processOcrLines(null as any, 0.6)).toBeUndefined();
  });

  it("全部低于置信度 → undefined", () => {
    const lines: OcrLine[] = [line("低置信度文本", 0.3, 10, 10), line("另一行", 0.5, 30, 10)];
    expect(processOcrLines(lines, 0.6)).toBeUndefined();
  });

  it("置信度过滤：只保留 >= minConfidence 的行", () => {
    const lines: OcrLine[] = [
      line("保留", 0.8, 10, 10),
      line("丢弃", 0.3, 30, 10),
      line("也保留", 0.6, 50, 10),
    ];
    const result = processOcrLines(lines, 0.6);
    expect(result).toBe("保留 也保留");
  });

  it("阅读顺序：top → bottom", () => {
    const lines: OcrLine[] = [
      line("第三行", 0.9, 60, 10),
      line("第一行", 0.9, 10, 10),
      line("第二行", 0.9, 35, 10),
    ];
    const result = processOcrLines(lines, 0.5);
    expect(result).toBe("第一行 第二行 第三行");
  });

  it("阅读顺序：同行内 left → right（top 差值 < 15px）", () => {
    const lines: OcrLine[] = [
      line("右", 0.9, 10, 200),
      line("左", 0.9, 12, 10), // top 差 2px < 15px → 同行
    ];
    const result = processOcrLines(lines, 0.5);
    expect(result).toBe("左 右");
  });

  it("无 box 的行默认排到前面（top=0, left=0）", () => {
    const noBox: OcrLine = { text: "无框", mean: 0.9 };
    const withBox = line("有框", 0.9, 50, 10);
    const result = processOcrLines([withBox, noBox], 0.5);
    expect(result).toBe("无框 有框");
  });

  it("文本 trim：去除首尾空白", () => {
    const lines: OcrLine[] = [line("  有空格  ", 0.9, 10, 10)];
    const result = processOcrLines(lines, 0.5);
    expect(result).toBe("有空格");
  });

  it("截断：超过 500 字符加省略号", () => {
    const longText = "a".repeat(501);
    const lines: OcrLine[] = [line(longText, 0.9, 10, 10)];
    const result = processOcrLines(lines, 0.5);
    expect(result).toHaveLength(501); // 500 + "…"
    expect(result?.endsWith("…")).toBe(true);
    expect(result?.slice(0, 500)).toBe("a".repeat(500));
  });

  it("恰好 500 字符不截断", () => {
    const text = "b".repeat(500);
    const lines: OcrLine[] = [line(text, 0.9, 10, 10)];
    const result = processOcrLines(lines, 0.5);
    expect(result).toBe(text);
  });

  it("全部 trim 后为空 → undefined", () => {
    const lines: OcrLine[] = [line("   ", 0.9, 10, 10), line("  ", 0.9, 30, 10)];
    const result = processOcrLines(lines, 0.5);
    expect(result).toBeUndefined();
  });

  it("综合场景：多行混合置信度 + 排序 + 截断", () => {
    const lines: OcrLine[] = [
      line("Hello", 0.95, 10, 10),
      line("低分丢弃", 0.2, 20, 10),
      line("World", 0.85, 10, 150), // 同行右侧
      line("你好世界", 0.7, 40, 10),
    ];
    const result = processOcrLines(lines, 0.6);
    expect(result).toBe("Hello World 你好世界");
  });
});
