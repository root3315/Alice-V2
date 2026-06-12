/**
 * 贴纸调色板单元测试 — syncInstalledSets + resolveLabel + resolveByEmoji。
 *
 * 使用 in-memory SQLite + 真实 schema，直接验证 SQL 逻辑。
 *
 * @see src/telegram/apps/sticker-palette.ts
 * @see docs/adr/168-sticker-installed-set-primary.md
 */
import type { TelegramClient } from "@mtcute/node";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "../src/db/schema.js";
import {
  getAvailableKeywords,
  hasPaletteEntries,
  resolveByEmoji,
  resolveLabel,
  syncInstalledSets,
} from "../src/telegram/apps/sticker-palette.js";

// ── 内存数据库 ──────────────────────────────────────────────────────────

let sqlite: InstanceType<typeof Database>;
let db: ReturnType<typeof drizzle>;

beforeEach(() => {
  sqlite = new Database(":memory:");
  db = drizzle(sqlite, { schema });

  sqlite.exec(`
    CREATE TABLE sticker_palette (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      label TEXT NOT NULL,
      file_id TEXT NOT NULL UNIQUE,
      file_unique_id TEXT NOT NULL UNIQUE,
      emoji TEXT,
      set_name TEXT,
      emotion TEXT,
      action TEXT,
      intensity TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX idx_sticker_palette_label ON sticker_palette(label);
    CREATE INDEX idx_sticker_palette_emotion ON sticker_palette(emotion);

    CREATE TABLE sticker_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_unique_id TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      chat_type TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 1,
      last_used_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE UNIQUE INDEX idx_sticker_usage_unique ON sticker_usage(file_unique_id, chat_id);
    CREATE INDEX idx_sticker_usage_chat ON sticker_usage(chat_id);
    CREATE INDEX idx_sticker_usage_count ON sticker_usage(count);
  `);
});

afterEach(() => {
  sqlite.close();
});

// ── Mock Telegram 客户端 ────────────────────────────────────────────────

function createMockClient(
  sets: Array<{ shortName: string; title: string; count: number }>,
  stickersBySet: Record<string, Array<{ fileId: string; uniqueFileId: string; alt: string }>> = {},
): TelegramClient {
  return {
    getInstalledStickers: vi.fn().mockResolvedValue(sets),
    getStickerSet: vi.fn().mockImplementation((shortName: string) => {
      const stickers = (stickersBySet[shortName] ?? []).map((s) => ({
        sticker: { fileId: s.fileId, uniqueFileId: s.uniqueFileId },
        alt: s.alt,
      }));
      return Promise.resolve({
        shortName,
        title: sets.find((s) => s.shortName === shortName)?.title ?? shortName,
        isFull: true,
        stickers,
      });
    }),
  } as unknown as TelegramClient;
}

// ── syncInstalledSets ───────────────────────────────────────────────────

describe("syncInstalledSets", () => {
  it("空 palette → 正确填充 + 计数准确", async () => {
    const client = createMockClient([{ shortName: "cats", title: "Cats", count: 3 }], {
      cats: [
        { fileId: "fid1", uniqueFileId: "uid1", alt: "😊" },
        { fileId: "fid2", uniqueFileId: "uid2", alt: "😢" },
      ],
    });

    const stats = await syncInstalledSets(client, db);

    expect(stats.added).toBe(2);
    expect(stats.removed).toBe(0);
    expect(stats.refreshed).toBe(0);
    expect(hasPaletteEntries(db)).toBe(true);
  });

  it("增量同步 → 新贴纸入库，已有贴纸不覆盖", async () => {
    // 手动插入一条已有记录
    sqlite.exec(`
      INSERT INTO sticker_palette (label, file_id, file_unique_id, emoji, set_name, emotion, action, intensity)
      VALUES ('VLM精细标签', 'fid1', 'uid1', '😊', 'cats', 'happy', 'wave', 'high')
    `);

    const client = createMockClient([{ shortName: "cats", title: "Cats", count: 2 }], {
      cats: [
        { fileId: "fid1", uniqueFileId: "uid1", alt: "😊" },
        { fileId: "fid3", uniqueFileId: "uid3", alt: "😠" },
      ],
    });

    const stats = await syncInstalledSets(client, db);

    expect(stats.added).toBe(1); // uid3 是新的
    // uid1 已存在，onConflictDoNothing → 不覆盖
    const row = sqlite
      .prepare("SELECT label, emotion, action FROM sticker_palette WHERE file_unique_id = 'uid1'")
      .get() as { label: string; emotion: string; action: string };
    expect(row.label).toBe("VLM精细标签"); // 保留精细标签
    expect(row.emotion).toBe("happy");
    expect(row.action).toBe("wave");
  });

  it("fileId 刷新 → Telegram 更新 fileId 时正确更新", async () => {
    // 已有记录，但 fileId 过期
    sqlite.exec(`
      INSERT INTO sticker_palette (label, file_id, file_unique_id, emoji, set_name, emotion, action, intensity)
      VALUES ('😊 sticker', 'old_fid', 'uid1', '😊', 'cats', 'happy', 'none', 'medium')
    `);

    const client = createMockClient([{ shortName: "cats", title: "Cats", count: 1 }], {
      cats: [{ fileId: "new_fid", uniqueFileId: "uid1", alt: "😊" }],
    });

    const stats = await syncInstalledSets(client, db);

    expect(stats.added).toBe(0);
    expect(stats.refreshed).toBe(1);
    const row = sqlite
      .prepare("SELECT file_id FROM sticker_palette WHERE file_unique_id = 'uid1'")
      .get() as { file_id: string };
    expect(row.file_id).toBe("new_fid");
  });

  it("fileId 未变 → refreshed 不递增", async () => {
    sqlite.exec(`
      INSERT INTO sticker_palette (label, file_id, file_unique_id, emoji, set_name, emotion, action, intensity)
      VALUES ('😊 sticker', 'fid1', 'uid1', '😊', 'cats', 'happy', 'none', 'medium')
    `);

    const client = createMockClient([{ shortName: "cats", title: "Cats", count: 1 }], {
      cats: [{ fileId: "fid1", uniqueFileId: "uid1", alt: "😊" }],
    });

    const stats = await syncInstalledSets(client, db);
    expect(stats.refreshed).toBe(0);
  });

  it("过期清理 → 删除贴纸包后 palette 清理对应行", async () => {
    // 手动插入两个贴纸集的记录
    sqlite.exec(`
      INSERT INTO sticker_palette (label, file_id, file_unique_id, emoji, set_name, emotion, action, intensity)
      VALUES
        ('😊 sticker', 'fid1', 'uid1', '😊', 'cats', 'happy', 'none', 'medium'),
        ('😢 sticker', 'fid2', 'uid2', '😢', 'dogs', 'sad', 'cry', 'medium')
    `);

    // 只保留 cats，dogs 已被用户删除
    const client = createMockClient([{ shortName: "cats", title: "Cats", count: 1 }], {
      cats: [{ fileId: "fid1", uniqueFileId: "uid1", alt: "😊" }],
    });

    const stats = await syncInstalledSets(client, db);

    expect(stats.removed).toBe(1); // dogs 被清理
    const remaining = sqlite.prepare("SELECT COUNT(*) as cnt FROM sticker_palette").get() as {
      cnt: number;
    };
    expect(remaining.cnt).toBe(1);
  });

  it("VLM 贴纸保护 → setName IS NULL 的不被清理", async () => {
    // 一条来自已安装集，一条来自 VLM（setName = NULL）
    sqlite.exec(`
      INSERT INTO sticker_palette (label, file_id, file_unique_id, emoji, set_name, emotion, action, intensity)
      VALUES
        ('😊 sticker', 'fid1', 'uid1', '😊', 'cats', 'happy', 'none', 'medium'),
        ('VLM发现的贴纸', 'fid_vlm', 'uid_vlm', '🎉', NULL, 'happy', 'dance', 'high')
    `);

    // cats 被删除，但 VLM 贴纸应保留
    const client = createMockClient([{ shortName: "dogs", title: "Dogs", count: 1 }], {
      dogs: [{ fileId: "fid3", uniqueFileId: "uid3", alt: "🐕" }],
    });

    const stats = await syncInstalledSets(client, db);

    expect(stats.removed).toBe(1); // cats 被清理
    // VLM 贴纸保留
    const vlmRow = sqlite
      .prepare("SELECT * FROM sticker_palette WHERE file_unique_id = 'uid_vlm'")
      .get();
    expect(vlmRow).toBeTruthy();
    // dogs 新增
    const dogsRow = sqlite
      .prepare("SELECT * FROM sticker_palette WHERE file_unique_id = 'uid3'")
      .get();
    expect(dogsRow).toBeTruthy();
  });

  it("无已安装贴纸集 → 清理所有 setName 非空记录", async () => {
    sqlite.exec(`
      INSERT INTO sticker_palette (label, file_id, file_unique_id, emoji, set_name, emotion, action, intensity)
      VALUES
        ('😊 sticker', 'fid1', 'uid1', '😊', 'cats', 'happy', 'none', 'medium'),
        ('VLM贴纸', 'fid_vlm', 'uid_vlm', '🎉', NULL, 'happy', 'dance', 'high')
    `);

    const client = createMockClient([], {});
    const stats = await syncInstalledSets(client, db);

    expect(stats.removed).toBe(1); // cats 被清理
    const remaining = sqlite.prepare("SELECT COUNT(*) as cnt FROM sticker_palette").get() as {
      cnt: number;
    };
    expect(remaining.cnt).toBe(1); // VLM 保留
  });

  it("getStickerSet 失败 → 跳过该集，继续处理其余", async () => {
    const client = {
      getInstalledStickers: vi.fn().mockResolvedValue([
        { shortName: "broken", title: "Broken", count: 1 },
        { shortName: "good", title: "Good", count: 1 },
      ]),
      getStickerSet: vi.fn().mockImplementation((name: string) => {
        if (name === "broken") return Promise.reject(new Error("FloodWait"));
        return Promise.resolve({
          shortName: "good",
          title: "Good",
          isFull: true,
          stickers: [{ sticker: { fileId: "fid_g", uniqueFileId: "uid_g" }, alt: "😊" }],
        });
      }),
    } as unknown as TelegramClient;

    const stats = await syncInstalledSets(client, db);
    expect(stats.added).toBe(1); // good 集的贴纸成功入库
  });
});

// ── resolveLabel ────────────────────────────────────────────────────────

describe("resolveLabel", () => {
  it("dimension 匹配 → 返回正确 fileId", () => {
    sqlite.exec(`
      INSERT INTO sticker_palette (label, file_id, file_unique_id, emoji, set_name, emotion, action, intensity)
      VALUES ('开心猫猫', 'fid_happy', 'uid_happy', '😊', 'my_set', 'happy', 'none', 'medium')
    `);

    const result = resolveLabel(db, "happy");
    expect(result).toBe("fid_happy");
  });

  it("action 维度匹配 → 返回正确 fileId", () => {
    sqlite.exec(`
      INSERT INTO sticker_palette (label, file_id, file_unique_id, emoji, set_name, emotion, action, intensity)
      VALUES ('拥抱贴纸', 'fid_hug', 'uid_hug', '🤗', 'my_set', 'love', 'hug', 'medium')
    `);

    const result = resolveLabel(db, "hug");
    expect(result).toBe("fid_hug");
  });

  it("精确 label 匹配 → 返回正确 fileId", () => {
    sqlite.exec(`
      INSERT INTO sticker_palette (label, file_id, file_unique_id, emoji, set_name, emotion, action, intensity)
      VALUES ('开心跳舞的猫猫', 'fid_cat', 'uid_cat', '😺', 'my_set', 'happy', 'dance', 'high')
    `);

    const result = resolveLabel(db, "开心跳舞的猫猫");
    expect(result).toBe("fid_cat");
  });

  it("无匹配 → 返回 null", () => {
    const result = resolveLabel(db, "nonexistent");
    expect(result).toBeNull();
  });

  it("主池优先 → 自己安装的贴纸优先于 VLM 后备池", () => {
    sqlite.exec(`
      INSERT INTO sticker_palette (label, file_id, file_unique_id, emoji, set_name, emotion, action, intensity)
      VALUES
        ('VLM发现的开心', 'fid_vlm', 'uid_vlm', '😊', NULL, 'happy', 'none', 'medium'),
        ('自己安装的开心', 'fid_own', 'uid_own', '😊', 'my_cats', 'happy', 'none', 'medium')
    `);

    // 多次采样，应始终命中主池（setName 非空）
    const results = new Set<string>();
    for (let i = 0; i < 20; i++) {
      results.add(resolveLabel(db, "happy")!);
    }
    expect(results.size).toBe(1);
    expect(results.has("fid_own")).toBe(true);
  });

  it("主池无匹配 → 降级到 VLM 后备池", () => {
    sqlite.exec(`
      INSERT INTO sticker_palette (label, file_id, file_unique_id, emoji, set_name, emotion, action, intensity)
      VALUES
        ('自己安装的开心', 'fid_own', 'uid_own', '😊', 'my_cats', 'happy', 'none', 'medium'),
        ('VLM发现的伤心', 'fid_vlm_sad', 'uid_vlm_sad', '😢', NULL, 'sad', 'cry', 'medium')
    `);

    // 查 sad → 主池无匹配，降级到 VLM 后备池
    const result = resolveLabel(db, "sad");
    expect(result).toBe("fid_vlm_sad");
  });
});

// ── resolveByEmoji ──────────────────────────────────────────────────────

describe("resolveByEmoji", () => {
  it("keyword→emoji 匹配 → 返回 fileId（已安装贴纸集）", () => {
    sqlite.exec(`
      INSERT INTO sticker_palette (label, file_id, file_unique_id, emoji, set_name, emotion, action, intensity)
      VALUES ('😊 sticker', 'fid1', 'uid1', '😊', 'my_set', 'happy', 'none', 'medium')
    `);

    const result = resolveByEmoji(db, "happy");
    expect(result).toBe("fid1");
  });

  it("action keyword 匹配 → 返回 fileId（已安装贴纸集）", () => {
    sqlite.exec(`
      INSERT INTO sticker_palette (label, file_id, file_unique_id, emoji, set_name, emotion, action, intensity)
      VALUES ('🤗 sticker', 'fid_hug', 'uid_hug', '🤗', 'my_set', 'love', 'hug', 'medium')
    `);

    const result = resolveByEmoji(db, "hug");
    expect(result).toBe("fid_hug");
  });

  it("已安装优先 → VLM 后备池兜底", () => {
    sqlite.exec(`
      INSERT INTO sticker_palette (label, file_id, file_unique_id, emoji, set_name, emotion, action, intensity)
      VALUES
        ('😊 own', 'fid_own', 'uid_own', '😊', 'my_set', 'happy', 'none', 'medium'),
        ('😊 vlm', 'fid_vlm', 'uid_vlm', '😊', NULL, 'happy', 'none', 'medium')
    `);

    // 多次采样，应始终命中已安装贴纸（主池优先）
    const results = new Set<string>();
    for (let i = 0; i < 20; i++) {
      results.add(resolveByEmoji(db, "happy")!);
    }
    expect(results.size).toBe(1);
    expect(results.has("fid_own")).toBe(true);
  });

  it("主池无匹配 → VLM 后备池兜底", () => {
    sqlite.exec(`
      INSERT INTO sticker_palette (label, file_id, file_unique_id, emoji, set_name, emotion, action, intensity)
      VALUES ('😊 vlm', 'fid_vlm', 'uid_vlm', '😊', NULL, 'happy', 'none', 'medium')
    `);

    const result = resolveByEmoji(db, "happy");
    expect(result).toBe("fid_vlm");
  });

  it("未知 keyword → 返回 null", () => {
    const result = resolveByEmoji(db, "celebrate");
    expect(result).toBeNull();
  });
});

// ── getAvailableKeywords ────────────────────────────────────────────────

describe("getAvailableKeywords", () => {
  it("palette 有维度数据 → 输出包含实际维度", () => {
    sqlite.exec(`
      INSERT INTO sticker_palette (label, file_id, file_unique_id, emoji, emotion, action, intensity)
      VALUES
        ('😊 sticker', 'fid1', 'uid1', '😊', 'happy', 'none', 'medium'),
        ('😢 sticker', 'fid2', 'uid2', '😢', 'sad', 'cry', 'medium')
    `);

    const result = getAvailableKeywords(db);
    expect(result).toContain("happy");
    expect(result).toContain("sad");
    expect(result).toContain("cry");
  });

  it("palette 空 → 回退到常量集合", () => {
    const result = getAvailableKeywords(db);
    expect(result).toContain("Emotions:");
    expect(result).toContain("Actions:");
    expect(result).toContain("happy");
    expect(result).toContain("hug");
  });
});

// ── hasPaletteEntries ───────────────────────────────────────────────────

describe("hasPaletteEntries", () => {
  it("空表 → false", () => {
    expect(hasPaletteEntries(db)).toBe(false);
  });

  it("有数据 → true", () => {
    sqlite.exec(`
      INSERT INTO sticker_palette (label, file_id, file_unique_id, emoji, emotion, action, intensity)
      VALUES ('test', 'fid', 'uid', '😊', 'happy', 'none', 'medium')
    `);
    expect(hasPaletteEntries(db)).toBe(true);
  });
});
