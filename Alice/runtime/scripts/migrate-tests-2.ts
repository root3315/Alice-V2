/**
 * ADR-154 测试迁移脚本 Phase 2
 * 处理：created/last_access 字段重命名、last_active_ms→last_activity_ms (Channel)
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const TEST_DIR = join(import.meta.dirname!, "../test");

function migrateFile(filePath: string): boolean {
  let content = readFileSync(filePath, "utf-8");
  const original = content;
  const lines = content.split("\n");
  const newLines: string[] = [];

  // Track context: are we inside an addThread/addFact call?
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];

    // Check surrounding context (look back up to 10 lines for addThread/addFact)
    const context = lines.slice(Math.max(0, i - 10), i + 1).join("\n");

    // Pattern 1: `created:` in Thread context → `created_ms:`
    // Match lines that have `created:` (not `created_ms:`) when near addThread
    if (
      line.match(/\bcreated\s*:/) &&
      !line.match(/\bcreated_ms\s*:/) &&
      !line.match(/\bcreated\s*_ms/)
    ) {
      if (
        context.match(/addThread|ThreadAttrs|thread/i) &&
        !context.match(/addFact|FactAttrs|addContact|addChannel|addAgent|addConversation/i)
      ) {
        line = line.replace(/\bcreated\s*:/g, "created_ms:");
      } else if (context.match(/addFact|FactAttrs|fact|info_item/i)) {
        line = line.replace(/\bcreated\s*:/g, "created_ms:");
      }
    }

    // Pattern 2: `last_access:` → `last_access_ms:` (always Fact context)
    if (line.match(/\blast_access\s*:/) && !line.match(/\blast_access_ms\s*:/)) {
      line = line.replace(/\blast_access\s*:/g, "last_access_ms:");
    }

    // Pattern 3: `.created` property access on Fact → `.created_ms`
    // Match: xxxFact.created or similar
    if (line.match(/\.created\b/) && !line.match(/\.created_ms\b/)) {
      if (context.match(/getFact|fact|FactAttrs/i)) {
        line = line.replace(/\.created\b/g, ".created_ms");
      }
    }

    // Pattern 4: `.last_access` property access → `.last_access_ms`
    if (line.match(/\.last_access\b/) && !line.match(/\.last_access_ms\b/)) {
      line = line.replace(/\.last_access\b/g, ".last_access_ms");
    }

    // Pattern 5: Channel `last_active_ms:` → `last_activity_ms:`
    // Only when in Channel context (addChannel)
    if (line.match(/\blast_active_ms\s*:/) && context.match(/addChannel|ChannelAttrs/i)) {
      line = line.replace(/\blast_active_ms\s*:/g, "last_activity_ms:");
    }

    newLines.push(line);
  }

  content = newLines.join("\n");

  if (content !== original) {
    writeFileSync(filePath, content, "utf-8");
    return true;
  }
  return false;
}

const testFiles = readdirSync(TEST_DIR)
  .filter((f) => f.endsWith(".test.ts"))
  .map((f) => join(TEST_DIR, f));

let changed = 0;
for (const f of testFiles) {
  if (migrateFile(f)) changed++;
}
console.log(`Phase 2: Migrated ${changed}/${testFiles.length} files`);
