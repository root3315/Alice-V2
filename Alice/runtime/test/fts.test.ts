/**
 * ADR-145: FTS5 全文检索测试。
 *
 * **写入同步由 SQLite 触发器自动完成**（migration 0017_fts5_triggers.sql）——
 * 测试只需写源表，触发器保证 FTS 索引同步。
 *
 * 覆盖：中文搜索、英文搜索、BM25 排序、chatId 过滤、
 * 跨聊天搜索、空结果、特殊字符、FTS5 表达式语法、时间范围过滤、
 * 触发器自动同步（INSERT/DELETE/UPDATE）、ftsEnsurePopulated 启动补全。
 *
 * @see runtime/drizzle/0017_fts5_triggers.sql
 */
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDb, getDb, getSqlite, initDb } from "../src/db/connection.js";
import {
  ftsEnsurePopulated,
  searchDiaryFts,
  searchMessagesFts,
  searchThreadsFts,
} from "../src/db/fts.js";
import { diaryEntries, messageLog, narrativeThreads } from "../src/db/schema.js";

/** 插入测试消息（触发器自动同步 FTS），返回 rowId。 */
function insertMessage(opts: {
  chatId: string;
  text: string | null;
  senderName?: string;
  senderId?: string;
  tick?: number;
  createdAt?: Date;
}): number {
  const db = getDb();
  const result = db
    .insert(messageLog)
    .values({
      tick: opts.tick ?? 1,
      chatId: opts.chatId,
      senderId: opts.senderId ?? "contact:1",
      senderName: opts.senderName ?? "TestUser",
      text: opts.text,
      isOutgoing: false,
      isDirected: false,
      ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
    })
    .returning({ id: messageLog.id })
    .get();
  return result!.id;
}

/** 插入日记（触发器自动同步 FTS），返回 rowId。 */
function insertDiary(opts: {
  tick: number;
  content: string;
  about?: string;
  createdAt?: Date;
}): number {
  const result = getDb()
    .insert(diaryEntries)
    .values({
      tick: opts.tick,
      content: opts.content,
      about: opts.about ?? null,
      ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
    })
    .returning({ id: diaryEntries.id })
    .get();
  return result!.id;
}

/** 插入线程（触发器自动同步 FTS），返回 rowId。 */
function insertThread(opts: {
  title: string;
  status?: string;
  weight?: string;
  summary?: string;
  createdTick: number;
}): number {
  const result = getDb()
    .insert(narrativeThreads)
    .values({
      title: opts.title,
      status: opts.status ?? "open",
      weight: opts.weight ?? "minor",
      summary: opts.summary ?? null,
      createdTick: opts.createdTick,
    })
    .returning({ id: narrativeThreads.id })
    .get();
  return result!.id;
}

// ── FTS5 messageLog 查询 ───────────────────────────────────────────────────

describe("FTS5 messageLog 全文搜索", () => {
  beforeEach(() => initDb(":memory:"));
  afterEach(() => closeDb());

  // ── 基础搜索 ──

  it("中文搜索：trigram 匹配", () => {
    insertMessage({ chatId: "channel:1", text: "今天天气不错，适合出去玩" });
    insertMessage({ chatId: "channel:1", text: "明天有雨，记得带伞" });

    const results = searchMessagesFts("天气");
    expect(results).toHaveLength(1);
    expect(results[0].text).toContain("天气");
  });

  it("英文搜索", () => {
    insertMessage({ chatId: "channel:1", text: "say hello to everyone" });
    insertMessage({ chatId: "channel:1", text: "goodbye world" });

    const results = searchMessagesFts("hello");
    expect(results).toHaveLength(1);
    expect(results[0].text).toContain("hello");
  });

  it("混合语言搜索", () => {
    insertMessage({ chatId: "channel:1", text: "这个 API 的 endpoint 是什么" });
    insertMessage({ chatId: "channel:1", text: "今天的晚餐吃什么" });

    const results = searchMessagesFts("API");
    expect(results).toHaveLength(1);
    expect(results[0].text).toContain("API");
  });

  // ── chatId 过滤 ──

  it("指定 chatId 只返回对应聊天的结果", () => {
    insertMessage({ chatId: "channel:1", text: "猫猫好可爱" });
    insertMessage({ chatId: "channel:2", text: "猫猫不听话" });

    const results = searchMessagesFts("猫猫", { chatId: "channel:1" });
    expect(results).toHaveLength(1);
    expect(results[0].chatId).toBe("channel:1");
  });

  it("不指定 chatId 返回所有聊天的匹配结果", () => {
    insertMessage({ chatId: "channel:1", text: "猫猫好可爱" });
    insertMessage({ chatId: "channel:2", text: "猫猫不听话" });

    const results = searchMessagesFts("猫猫");
    expect(results).toHaveLength(2);
  });

  // ── 空结果 ──

  it("搜索不存在的内容返回空数组", () => {
    insertMessage({ chatId: "channel:1", text: "今天天气不错" });
    const results = searchMessagesFts("火星登陆计划");
    expect(results).toHaveLength(0);
  });

  it("空查询返回空数组", () => {
    insertMessage({ chatId: "channel:1", text: "今天天气不错" });
    const results = searchMessagesFts("");
    expect(results).toHaveLength(0);
    const results2 = searchMessagesFts("   ");
    expect(results2).toHaveLength(0);
  });

  // ── limit 参数 ──

  it("limit 控制返回条数", () => {
    for (let i = 0; i < 10; i++) {
      insertMessage({ chatId: "channel:1", text: `测试消息第${i}条` });
    }
    const results = searchMessagesFts("测试", { limit: 3 });
    expect(results).toHaveLength(3);
  });

  // ── BM25 排序 ──

  it("BM25 排序：更相关的结果排在前面", () => {
    insertMessage({ chatId: "channel:1", text: "今天下雨了，猫不愿意出门", senderName: "A" });
    insertMessage({
      chatId: "channel:1",
      text: "猫猫猫猫猫，我家的猫今天特别黏人，猫真是太可爱了",
      senderName: "B",
    });

    const results = searchMessagesFts("猫");
    expect(results.length).toBeGreaterThanOrEqual(2);
    expect(results[0].senderName).toBe("B");
  });

  // ── 返回字段完整性 ──

  it("返回的记录包含完整字段", () => {
    insertMessage({
      chatId: "channel:test",
      text: "字段完整性测试",
      senderName: "Alice",
      tick: 42,
    });

    const results = searchMessagesFts("完整性");
    expect(results).toHaveLength(1);
    const r = results[0];
    expect(r.chatId).toBe("channel:test");
    expect(r.senderName).toBe("Alice");
    expect(r.tick).toBe(42);
    expect(r.text).toBe("字段完整性测试");
    expect(r.isOutgoing).toBe(false);
    expect(r.createdAt).toBeInstanceOf(Date);
  });

  // ── 特殊字符 ──

  it("包含引号的内容可搜索", () => {
    insertMessage({ chatId: "channel:1", text: '他说"这是一个测试"' });
    const results = searchMessagesFts("测试");
    expect(results).toHaveLength(1);
  });

  // ── FTS5 表达式语法 ──

  it("OR 表达式：匹配任一关键词", () => {
    insertMessage({ chatId: "channel:1", text: "今天天气不错" });
    insertMessage({ chatId: "channel:1", text: "明天有雨记得带伞" });
    insertMessage({ chatId: "channel:1", text: "买了一本新书" });

    const results = searchMessagesFts("天气 OR 带伞");
    expect(results).toHaveLength(2);
  });

  it("隐式 AND 表达式：空格分隔的词必须全部命中", () => {
    insertMessage({ chatId: "channel:1", text: "今天天气不错适合出去玩" });
    insertMessage({ chatId: "channel:1", text: "今天天气很差不想出门" });
    insertMessage({ chatId: "channel:1", text: "出去玩真开心" });

    const results = searchMessagesFts("天气 出去");
    expect(results).toHaveLength(1);
    expect(results[0].text).toContain("天气");
    expect(results[0].text).toContain("出去");
  });

  // ── 时间范围过滤 ──

  it("afterTs 过滤：只返回指定时间之后的消息", () => {
    const now = Math.floor(Date.now() / 1000);
    const oldTs = now - 86400 * 30;
    const recentTs = now - 3600;

    insertMessage({
      chatId: "channel:1",
      text: "旧消息搜索测试",
      senderName: "Old",
      createdAt: new Date(oldTs * 1000),
    });
    insertMessage({
      chatId: "channel:1",
      text: "新消息搜索测试",
      senderName: "New",
      createdAt: new Date(recentTs * 1000),
    });

    const sevenDaysAgo = now - 86400 * 7;
    const results = searchMessagesFts("搜索测试", { afterTs: sevenDaysAgo });
    expect(results).toHaveLength(1);
    expect(results[0].senderName).toBe("New");
  });

  it("beforeTs 过滤：只返回指定时间之前的消息", () => {
    const now = Math.floor(Date.now() / 1000);
    const oldTs = now - 86400 * 30;
    const recentTs = now - 3600;

    insertMessage({
      chatId: "channel:1",
      text: "时间过滤测试旧",
      senderName: "Old",
      createdAt: new Date(oldTs * 1000),
    });
    insertMessage({
      chatId: "channel:1",
      text: "时间过滤测试新",
      senderName: "New",
      createdAt: new Date(recentTs * 1000),
    });

    const sevenDaysAgo = now - 86400 * 7;
    const results = searchMessagesFts("时间过滤测试", { beforeTs: sevenDaysAgo });
    expect(results).toHaveLength(1);
    expect(results[0].senderName).toBe("Old");
  });

  // ── senderId 过滤 ──

  it("指定 senderId 只返回该发送者的消息", () => {
    insertMessage({
      chatId: "channel:1",
      text: "今天去公园散步了",
      senderId: "contact:alice",
      senderName: "Alice",
    });
    insertMessage({
      chatId: "channel:1",
      text: "今天去公园跑步了",
      senderId: "contact:bob",
      senderName: "Bob",
    });

    const results = searchMessagesFts("公园", { senderId: "contact:alice" });
    expect(results).toHaveLength(1);
    expect(results[0].senderName).toBe("Alice");

    const all = searchMessagesFts("公园");
    expect(all).toHaveLength(2);
  });

  // ── snippet ──

  it("搜索结果包含 snippet 字段（FTS5 snippet 函数）", () => {
    insertMessage({
      chatId: "channel:1",
      text: "这是一段很长的消息内容包含关键词搜索测试在里面后面还有很多文字",
    });

    const results = searchMessagesFts("搜索测试");
    expect(results).toHaveLength(1);
    expect(results[0].snippet).toBeTruthy();
    expect(results[0].snippet).toContain("»");
    expect(results[0].snippet).toContain("«");
  });

  // ── 非法 FTS5 表达式 ──

  it("非法 MATCH 表达式抛出异常（调用方需 try/catch）", () => {
    insertMessage({ chatId: "channel:1", text: "正常消息" });
    expect(() => searchMessagesFts('"unclosed')).toThrow();
  });

  // ── 批量写入 ──

  it("连续写入 + 查询正常工作", () => {
    for (let i = 0; i < 100; i++) {
      insertMessage({ chatId: "channel:1", text: `批量消息${i}号` });
    }
    const results = searchMessagesFts("批量");
    expect(results.length).toBeGreaterThan(0);
    expect(results.length).toBeLessThanOrEqual(20);
  });
});

// ── Diary FTS5 ──────────────────────────────────────────────────────────────

describe("FTS5 diary 全文搜索", () => {
  beforeEach(() => initDb(":memory:"));
  afterEach(() => closeDb());

  it("中文内容搜索命中", () => {
    insertDiary({ tick: 1, content: "今天心情很好 出去散步了" });
    insertDiary({ tick: 2, content: "和朋友一起吃了火锅 好开心" });

    const results = searchDiaryFts("散步");
    expect(results).toHaveLength(1);
    expect(results[0].content).toContain("散步");
  });

  it("about 过滤", () => {
    insertDiary({ tick: 1, content: "和 Carol 聊了很久 很开心", about: "contact:carol" });
    insertDiary({ tick: 2, content: "一个人散步 也很开心" });

    const results = searchDiaryFts("开心", { about: "contact:carol" });
    expect(results).toHaveLength(1);
    expect(results[0].about).toBe("contact:carol");
  });

  it("时间范围过滤", () => {
    const now = Math.floor(Date.now() / 1000);
    insertDiary({
      tick: 1,
      content: "旧日记 想去旅行",
      createdAt: new Date((now - 86400 * 30) * 1000),
    });
    insertDiary({ tick: 2, content: "新日记 也想旅行", createdAt: new Date((now - 3600) * 1000) });

    const sevenDaysAgo = now - 86400 * 7;
    const results = searchDiaryFts("旅行", { afterTs: sevenDaysAgo });
    expect(results).toHaveLength(1);
    expect(results[0].content).toContain("新日记");
  });

  it("空结果", () => {
    insertDiary({ tick: 1, content: "今天天气不错" });
    const results = searchDiaryFts("火星基地");
    expect(results).toHaveLength(0);
  });
});

// ── Threads FTS5 ────────────────────────────────────────────────────────────

describe("FTS5 threads 全文搜索", () => {
  beforeEach(() => initDb(":memory:"));
  afterEach(() => closeDb());

  it("标题搜索命中", () => {
    insertThread({ title: "旅行计划讨论", summary: "讨论五月份去大理的方案", createdTick: 1 });
    insertThread({ title: "项目方案选型", summary: "React vs Vue 技术选型", createdTick: 2 });

    const results = searchThreadsFts("旅行");
    expect(results).toHaveLength(1);
    expect(results[0].title).toContain("旅行");
  });

  it("摘要搜索命中", () => {
    insertThread({ title: "旅行计划讨论", summary: "讨论五月份去大理的方案", createdTick: 1 });

    const results = searchThreadsFts("大理");
    expect(results).toHaveLength(1);
    expect(results[0].summary).toContain("大理");
  });

  it("status 过滤", () => {
    insertThread({ title: "旅行计划讨论", status: "open", createdTick: 1 });
    insertThread({ title: "旅行安排确认", status: "resolved", createdTick: 2 });

    const results = searchThreadsFts("旅行", { status: "open" });
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe("open");
  });

  it("空结果", () => {
    insertThread({ title: "项目方案选型", summary: "React vs Vue", createdTick: 1 });
    const results = searchThreadsFts("火星殖民");
    expect(results).toHaveLength(0);
  });
});

// ── FTS5 触发器自动同步 ──────────────────────────────────────────────────────

describe("FTS5 trigger 自动同步", () => {
  beforeEach(() => initDb(":memory:"));
  afterEach(() => closeDb());

  // ── message_log 触发器 ──

  it("INSERT 自动同步：写源表即可搜索", () => {
    // 只写源表——触发器自动同步到 FTS
    insertMessage({ chatId: "channel:1", text: "触发器同步测试消息" });
    expect(searchMessagesFts("触发器同步")).toHaveLength(1);
  });

  it("DELETE 自动同步：删除源表行后搜索不到", () => {
    const id = insertMessage({ chatId: "channel:1", text: "即将被删除的消息" });
    expect(searchMessagesFts("即将被删除")).toHaveLength(1);

    // 删除源表行——AFTER DELETE 触发器自动清理 FTS
    getDb().delete(messageLog).where(sql`${messageLog.id} = ${id}`).run();
    expect(searchMessagesFts("即将被删除")).toHaveLength(0);
  });

  it("UPDATE text 自动同步：旧文本搜不到、新文本搜得到", () => {
    const id = insertMessage({ chatId: "channel:1", text: "原始文本内容" });
    expect(searchMessagesFts("原始文本")).toHaveLength(1);

    // 更新 text——AFTER UPDATE OF text 触发器自动同步
    getDb()
      .update(messageLog)
      .set({ text: "修改后的内容" })
      .where(sql`${messageLog.id} = ${id}`)
      .run();

    expect(searchMessagesFts("原始文本")).toHaveLength(0);
    expect(searchMessagesFts("修改后")).toHaveLength(1);
  });

  it("NULL text 不入索引：媒体消息不产生 FTS 记录", () => {
    const sqlite = getSqlite();
    insertMessage({ chatId: "channel:1", text: null });

    // _docsize 应为 0——NULL text 不触发 AFTER INSERT（WHEN new.text IS NOT NULL）
    const count = (
      sqlite.prepare("SELECT count(*) as n FROM message_log_fts_docsize").get() as { n: number }
    ).n;
    expect(count).toBe(0);
  });

  it("UPDATE text NULL→non-NULL：消息补充文本后入索引", () => {
    const id = insertMessage({ chatId: "channel:1", text: null });
    expect(searchMessagesFts("补充文本")).toHaveLength(0);

    // 更新 NULL → 有文本
    getDb()
      .update(messageLog)
      .set({ text: "补充文本消息" })
      .where(sql`${messageLog.id} = ${id}`)
      .run();
    expect(searchMessagesFts("补充文本")).toHaveLength(1);
  });

  // ── diary_entries 触发器 ──

  it("diary INSERT 自动同步", () => {
    insertDiary({ tick: 1, content: "日记触发器测试" });
    expect(searchDiaryFts("日记触发器")).toHaveLength(1);
  });

  it("diary DELETE 自动同步", () => {
    const id = insertDiary({ tick: 1, content: "即将删除的日记" });
    expect(searchDiaryFts("即将删除")).toHaveLength(1);

    getDb().delete(diaryEntries).where(sql`${diaryEntries.id} = ${id}`).run();
    expect(searchDiaryFts("即将删除")).toHaveLength(0);
  });

  // ── narrative_threads 触发器 ──

  it("threads INSERT 自动同步", () => {
    insertThread({ title: "线程触发器测试", createdTick: 1 });
    expect(searchThreadsFts("线程触发器")).toHaveLength(1);
  });

  it("threads UPDATE summary 自动同步", () => {
    const id = insertThread({ title: "需要摘要的线程", createdTick: 1 });
    expect(searchThreadsFts("新增摘要内容")).toHaveLength(0);

    // 更新 summary——AFTER UPDATE OF title, summary 触发器自动同步
    getDb()
      .update(narrativeThreads)
      .set({ summary: "新增摘要内容" })
      .where(sql`${narrativeThreads.id} = ${id}`)
      .run();
    expect(searchThreadsFts("新增摘要内容")).toHaveLength(1);
  });

  it("threads UPDATE 非 FTS 列不触发重索引", () => {
    const sqlite = getSqlite();
    insertThread({ title: "状态测试线程", createdTick: 1 });

    // 记录当前 _docsize
    const before = (
      sqlite.prepare("SELECT count(*) as n FROM threads_fts_docsize").get() as { n: number }
    ).n;
    expect(before).toBe(1);

    // 更新 status（非 FTS 列）——不应触发 FTS 更新
    getDb()
      .update(narrativeThreads)
      .set({ status: "resolved" })
      .where(sql`${narrativeThreads.id} = 1`)
      .run();

    // 索引不变，原标题仍可搜索
    expect(searchThreadsFts("状态测试")).toHaveLength(1);
  });
});

// ── ftsEnsurePopulated + _docsize 影子表 ────────────────────────────────────

describe("ftsEnsurePopulated — 启动时索引补全", () => {
  beforeEach(() => initDb(":memory:"));
  afterEach(() => closeDb());

  it("FTS 索引被清空后 ftsEnsurePopulated 重建", () => {
    const sqlite = getSqlite();

    // 写入数据（触发器自动同步）
    insertMessage({ chatId: "channel:1", text: "补全测试消息" });
    expect(searchMessagesFts("补全")).toHaveLength(1);

    // 手动清空 FTS 索引（模拟索引损坏）
    sqlite.exec("INSERT INTO message_log_fts(message_log_fts) VALUES('delete-all')");
    expect(searchMessagesFts("补全")).toHaveLength(0);

    // ftsEnsurePopulated 检测到空索引并 rebuild
    ftsEnsurePopulated();
    expect(searchMessagesFts("补全")).toHaveLength(1);
  });

  it("FTS 索引已有数据时跳过 rebuild（幂等性）", () => {
    insertMessage({ chatId: "channel:1", text: "已索引消息" });
    expect(searchMessagesFts("已索引")).toHaveLength(1);

    // 再次调用不应破坏已有索引
    ftsEnsurePopulated();
    expect(searchMessagesFts("已索引")).toHaveLength(1);
  });

  it("源表和 FTS 都为空时安全跳过", () => {
    expect(() => ftsEnsurePopulated()).not.toThrow();
  });

  it("三种 FTS 表均能补全", () => {
    const sqlite = getSqlite();

    // 写入数据（触发器同步）
    insertMessage({ chatId: "channel:1", text: "消息补全" });
    insertDiary({ tick: 1, content: "日记补全" });
    insertThread({ title: "线程补全", createdTick: 1 });

    // 清空所有 FTS 索引
    sqlite.exec("INSERT INTO message_log_fts(message_log_fts) VALUES('delete-all')");
    sqlite.exec("INSERT INTO diary_fts(diary_fts) VALUES('delete-all')");
    sqlite.exec("INSERT INTO threads_fts(threads_fts) VALUES('delete-all')");

    expect(searchMessagesFts("消息补全")).toHaveLength(0);
    expect(searchDiaryFts("日记补全")).toHaveLength(0);
    expect(searchThreadsFts("线程补全")).toHaveLength(0);

    // 一次调用补全所有三张表
    ftsEnsurePopulated();

    expect(searchMessagesFts("消息补全")).toHaveLength(1);
    expect(searchDiaryFts("日记补全")).toHaveLength(1);
    expect(searchThreadsFts("线程补全")).toHaveLength(1);
  });
});

// ── _docsize 影子表行为验证 ─────────────────────────────────────────────────

describe("_docsize 影子表 vs content= 表的 count(*) 行为", () => {
  beforeEach(() => initDb(":memory:"));
  afterEach(() => closeDb());

  it("content= FTS 表的 count(*) 代理到源表，_docsize 反映真实索引状态", () => {
    const sqlite = getSqlite();

    // 触发器同步写入
    insertMessage({ chatId: "channel:1", text: "影子表行为验证" });

    // content= 表的 count(*) 代理到源表
    const ftsCount = (
      sqlite.prepare("SELECT count(*) as n FROM message_log_fts").get() as { n: number }
    ).n;
    expect(ftsCount).toBe(1);

    // _docsize 也应该是 1（触发器已同步）
    const docSizeCount = (
      sqlite.prepare("SELECT count(*) as n FROM message_log_fts_docsize").get() as { n: number }
    ).n;
    expect(docSizeCount).toBe(1);

    // 清空 FTS 索引
    sqlite.exec("INSERT INTO message_log_fts(message_log_fts) VALUES('delete-all')");

    // content= count(*) 仍代理到源表——返回 1
    const afterClear = (
      sqlite.prepare("SELECT count(*) as n FROM message_log_fts").get() as { n: number }
    ).n;
    expect(afterClear).toBe(1);

    // _docsize 正确反映清空状态——返回 0
    const afterClearDocsize = (
      sqlite.prepare("SELECT count(*) as n FROM message_log_fts_docsize").get() as { n: number }
    ).n;
    expect(afterClearDocsize).toBe(0);

    // 这就是 ftsEnsurePopulated 必须查 _docsize 的原因
    expect(searchMessagesFts("影子表")).toHaveLength(0);
  });

  it("触发器同步后 _docsize 行数与源表一致", () => {
    const sqlite = getSqlite();

    insertMessage({ chatId: "channel:1", text: "增量同步测试一" });
    insertMessage({ chatId: "channel:1", text: "增量同步测试二" });

    const docSizeCount = (
      sqlite.prepare("SELECT count(*) as n FROM message_log_fts_docsize").get() as { n: number }
    ).n;
    expect(docSizeCount).toBe(2);

    const srcCount = (
      sqlite.prepare("SELECT count(*) as n FROM message_log").get() as { n: number }
    ).n;
    expect(srcCount).toBe(2);
    expect(docSizeCount).toBe(srcCount);
  });
});

// ── 事务原子性验证 ──────────────────────────────────────────────────────────

describe("SQLite 事务中触发器的原子性", () => {
  beforeEach(() => initDb(":memory:"));
  afterEach(() => closeDb());

  it("事务提交：INSERT + 触发器 FTS 同步一起持久化", () => {
    const sqlite = getSqlite();
    const db = getDb();

    sqlite.transaction(() => {
      db.insert(messageLog)
        .values({
          tick: 1,
          chatId: "channel:1",
          senderId: "contact:1",
          senderName: "Test",
          text: "事务测试消息",
          isOutgoing: false,
          isDirected: false,
        })
        .run();
    })();

    // 源表和 FTS 都应该已提交
    const srcCount = (
      sqlite.prepare("SELECT count(*) as n FROM message_log").get() as { n: number }
    ).n;
    const ftsCount = (
      sqlite.prepare("SELECT count(*) as n FROM message_log_fts_docsize").get() as { n: number }
    ).n;
    expect(srcCount).toBe(1);
    expect(ftsCount).toBe(1);
    expect(searchMessagesFts("事务测试")).toHaveLength(1);
  });

  it("事务回滚：INSERT + 触发器 FTS 同步一起回滚", () => {
    const sqlite = getSqlite();
    const db = getDb();

    expect(() => {
      sqlite.transaction(() => {
        db.insert(messageLog)
          .values({
            tick: 1,
            chatId: "channel:1",
            senderId: "contact:1",
            senderName: "Test",
            text: "回滚测试消息",
            isOutgoing: false,
            isDirected: false,
          })
          .run();
        // 触发器已执行——但事务还未提交
        throw new Error("simulated failure");
      })();
    }).toThrow("simulated failure");

    // 源表和 FTS 都应该被回滚
    const srcCount = (
      sqlite.prepare("SELECT count(*) as n FROM message_log").get() as { n: number }
    ).n;
    const ftsCount = (
      sqlite.prepare("SELECT count(*) as n FROM message_log_fts_docsize").get() as { n: number }
    ).n;
    expect(srcCount).toBe(0);
    expect(ftsCount).toBe(0);
    expect(searchMessagesFts("回滚测试")).toHaveLength(0);
  });
});
