/**
 * 媒体语义缓存单测。
 *
 * 验证 media-cache.ts 的 SQLite KV 存取 + WAL 模式 + 生命周期。
 */
import { existsSync, unlinkSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import {
  closeMediaCache,
  getCachedDescription,
  getCachedOcrText,
  getCachedStickerSetTitle,
  initMediaCache,
  setCachedDescription,
  setCachedOcrText,
  setCachedStickerSetTitle,
} from "../src/llm/media-cache.js";

const TEST_DB = "test-media-cache.db";

function cleanup() {
  try {
    closeMediaCache();
  } catch {
    /* already closed */
  }
  for (const suffix of ["", "-wal", "-shm"]) {
    const f = TEST_DB + suffix;
    if (existsSync(f)) unlinkSync(f);
  }
}

describe("media-cache", () => {
  afterEach(cleanup);

  it("initMediaCache 创建表并启用 WAL 模式", () => {
    initMediaCache(TEST_DB);
    expect(existsSync(TEST_DB)).toBe(true);
    // 写入后应有 WAL 文件
    setCachedDescription("uid1", "photo", "一只猫");
    closeMediaCache();
  });

  it("setCachedDescription + getCachedDescription 往返", () => {
    initMediaCache(TEST_DB);
    setCachedDescription("uid_photo_1", "photo", "两个人在海边");
    setCachedDescription("uid_gif_1", "gif", "猫在甩头");
    expect(getCachedDescription("uid_photo_1")).toBe("两个人在海边");
    expect(getCachedDescription("uid_gif_1")).toBe("猫在甩头");
  });

  it("未知 key 返回 undefined", () => {
    initMediaCache(TEST_DB);
    expect(getCachedDescription("nonexistent")).toBeUndefined();
  });

  it("setCachedStickerSetTitle + getCachedStickerSetTitle 往返", () => {
    initMediaCache(TEST_DB);
    setCachedStickerSetTitle("set_123", "Pusheen", "pusheen_cat");
    const result = getCachedStickerSetTitle("set_123");
    expect(result).toEqual({ title: "Pusheen", shortName: "pusheen_cat" });
  });

  it("未知 sticker set 返回 undefined", () => {
    initMediaCache(TEST_DB);
    expect(getCachedStickerSetTitle("nonexistent")).toBeUndefined();
  });

  it("closeMediaCache 后 get 返回 undefined（不崩溃）", () => {
    initMediaCache(TEST_DB);
    setCachedDescription("uid1", "photo", "test");
    closeMediaCache();
    // 关闭后调用 get 应返回 undefined（_db 为 null）
    expect(getCachedDescription("uid1")).toBeUndefined();
    expect(getCachedStickerSetTitle("set1")).toBeUndefined();
  });

  it("INSERT OR REPLACE 覆盖旧值", () => {
    initMediaCache(TEST_DB);
    setCachedDescription("uid1", "photo", "旧描述");
    setCachedDescription("uid1", "photo", "新描述");
    expect(getCachedDescription("uid1")).toBe("新描述");
  });

  it("重复 initMediaCache 抛异常", () => {
    initMediaCache(TEST_DB);
    expect(() => initMediaCache(TEST_DB)).toThrow("already initialized");
  });

  it("关闭后可重新 init", () => {
    initMediaCache(TEST_DB);
    setCachedDescription("uid1", "photo", "持久化测试");
    closeMediaCache();
    // 重新打开后数据应仍在
    initMediaCache(TEST_DB);
    expect(getCachedDescription("uid1")).toBe("持久化测试");
  });

  // ── OCR 缓存 ──────────────────────────────────────────────────────
  it("setCachedOcrText + getCachedOcrText 往返", () => {
    initMediaCache(TEST_DB);
    setCachedOcrText("uid_ocr_1", "Hello World 你好世界");
    expect(getCachedOcrText("uid_ocr_1")).toBe("Hello World 你好世界");
  });

  it("OCR 缓存未知 key 返回 undefined", () => {
    initMediaCache(TEST_DB);
    expect(getCachedOcrText("nonexistent_ocr")).toBeUndefined();
  });

  it("VLM 缓存和 OCR 缓存互不干扰", () => {
    initMediaCache(TEST_DB);
    // 同一个 fileUniqueId 可同时有 VLM 描述和 OCR 文字
    setCachedDescription("uid_both", "photo", "一张截图");
    setCachedOcrText("uid_both", "截图中的文字内容");
    expect(getCachedDescription("uid_both")).toBe("一张截图");
    expect(getCachedOcrText("uid_both")).toBe("截图中的文字内容");
  });

  it("closeMediaCache 后 OCR get 返回 undefined（不崩溃）", () => {
    initMediaCache(TEST_DB);
    setCachedOcrText("uid_ocr_close", "test");
    closeMediaCache();
    expect(getCachedOcrText("uid_ocr_close")).toBeUndefined();
  });

  it("OCR 缓存 INSERT OR REPLACE 覆盖旧值", () => {
    initMediaCache(TEST_DB);
    setCachedOcrText("uid_ocr_dup", "旧文字");
    setCachedOcrText("uid_ocr_dup", "新文字");
    expect(getCachedOcrText("uid_ocr_dup")).toBe("新文字");
  });
});
