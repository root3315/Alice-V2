/**
 * ADR-154 测试迁移脚本 — 批量替换旧 API 为新 WorldModel API。
 * 一次性使用，执行后删除。
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const TEST_DIR = join(import.meta.dirname!, "../test");

function migrateFile(filePath: string): number {
  let content = readFileSync(filePath, "utf-8");
  const original = content;

  // Pattern 1: nodeAttrs("channel:xxx") → getChannel("channel:xxx")
  content = content.replace(/\.nodeAttrs\("channel:/g, '.getChannel("channel:');

  // Pattern 2: nodeAttrs("contact:xxx") → getContact("contact:xxx")
  content = content.replace(/\.nodeAttrs\("contact:/g, '.getContact("contact:');

  // Pattern 3: nodeAttrs("self") → getAgent("self")
  content = content.replace(/\.nodeAttrs\("self"\)/g, '.getAgent("self")');

  // Pattern 4: nodeAttrs("t followed by number or word → getThread
  content = content.replace(/\.nodeAttrs\("(t\d+)"\)/g, '.getThread("$1")');

  // Pattern 5: nodeAttrs("i followed by number → getFact
  content = content.replace(/\.nodeAttrs\("(i\d+|info\d*|fact\d*)"\)/g, '.getFact("$1")');

  // Pattern 6: nodeAttrs("conversation:xxx") → getConversation("conversation:xxx")
  content = content.replace(/\.nodeAttrs\("conversation:/g, '.getConversation("conversation:');

  // Pattern 7: nodeAttrs(variable) where we can't determine type → getEntry(variable)
  // Only apply if nodeAttrs still remains after specific patterns
  content = content.replace(/\.nodeAttrs\(/g, ".getEntry(");

  // Pattern 8: setNodeAttr → setDynamic (in mock objects and assertions)
  content = content.replace(/\.setNodeAttr\(/g, ".setDynamic(");
  content = content.replace(/setNodeAttr:/g, "setDynamic:");

  // Pattern 9: removeNodeAttr → removeDynamic
  content = content.replace(/\.removeNodeAttr\(/g, ".removeDynamic(");
  content = content.replace(/removeNodeAttr:/g, "removeDynamic:");

  // Pattern 10: toDict() → serialize()
  content = content.replace(/\.toDict\(\)/g, ".serialize()");

  // Pattern 11: fromDict( → deserialize(
  content = content.replace(/WorldModel\.fromDict\(/g, "WorldModel.deserialize(");

  // Pattern 12: trust property in addContact — remove it
  // Match patterns like: { ..., trust: 0.8 }  or  { trust: 0.8, ... }
  content = content.replace(/,\s*trust:\s*[\d.]+/g, "");
  content = content.replace(/trust:\s*[\d.]+\s*,\s*/g, "");

  // Pattern 13: 'created' → 'created_ms' in Thread addThread calls (field in object literal)
  // This is tricky — only replace in Thread context. Skip for now, handle manually.

  // Pattern 14: 'last_access' → 'last_access_ms' in Fact context
  // Also tricky — handle manually.

  // Pattern 15: dirtyNodeAttrs → dirtyNodeEntries
  content = content.replace(/dirtyNodeAttrs/g, "dirtyNodeEntries");

  // Pattern 16: addEntity("info_item" → addFact(
  content = content.replace(/addEntity\("info_item",\s*/g, "addFact(");

  // Pattern 17: "info_item" as entity type string
  // Leave alone — getEntitiesByType already handles "info_item" → "fact" compat

  if (content !== original) {
    writeFileSync(filePath, content, "utf-8");
    const changes = content.split("\n").length; // approximate
    return 1;
  }
  return 0;
}

const testFiles = readdirSync(TEST_DIR)
  .filter((f) => f.endsWith(".test.ts"))
  .map((f) => join(TEST_DIR, f));

let changed = 0;
for (const f of testFiles) {
  changed += migrateFile(f);
}
console.log(`Migrated ${changed}/${testFiles.length} files`);
