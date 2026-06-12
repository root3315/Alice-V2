#!/usr/bin/env tsx
/**
 * Prompt Preview — 组装完整的 LLM 可见 prompt 并输出到目录。
 *
 * 类似 eval-dump 的目录结构，每个组件一个文件，方便按需阅读。
 *
 * 用法：
 *   cd runtime && npx tsx scripts/preview-prompt.ts              # 默认输出
 *   cd runtime && npx tsx scripts/preview-prompt.ts --blind      # 追加盲审文件
 *
 * 输出目录：scripts/preview-dump-{timestamp}/
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createAliceDispatcher } from "../src/core/dispatcher.js";
import { loadAllMods } from "../src/core/mod-loader.js";
import { PromptBuilder } from "../src/core/prompt-style.js";
import { estimateTokens, renderContributionsByZone } from "../src/core/storyteller.js";
import { closeDb, initDb } from "../src/db/connection.js";
import { buildActionFooter } from "../src/engine/act/index.js";
import { GLOBAL_TOKEN_BUDGET } from "../src/engine/act/prompt-budget.js";
import { buildShellGuide } from "../src/engine/act/shell-guide.js";
import { resolveTarget } from "../src/engine/tick/target.js";
import { ALICE_SELF } from "../src/graph/constants.js";
import { WorldModel } from "../src/graph/world-model.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const blind = process.argv.includes("--blind");

// ── 1. 初始化 ────────────────────────────────────────────────────
initDb(":memory:");
const G = new WorldModel();
G.tick = 100;

G.addAgent(ALICE_SELF, {
  mood_valence: 0.3,
  mood_arousal: 0.3,
  mood_effective: 0.3,
  mood_shift: "had a nice chat earlier",
  personality_health: "healthy",
});

G.addContact("contact_12345", {
  display_name: "Carol",
  tier: 15,
  relation_type: "close_friend",
  language_preference: "中文",
  interaction_count: 35,
  trust: 0.7,
  unread: 2,
  pending_directed: 1,
});
G.addChannel("ch_12345", {
  display_name: "Carol",
  chat_type: "private",
  unread: 2,
  pending_directed: 1,
});

const facts = [
  { content: "Carol recently adopted a cat named Mochi", type: "observation" },
  { content: "Carol works as a UX designer", type: "observation" },
  { content: "Carol enjoys photography on weekends", type: "interest" },
];
for (let i = 0; i < facts.length; i++) {
  const fid = `info_12345_${i}`;
  G.addFact(fid, {
    content: facts[i].content,
    fact_type: facts[i].type,
    importance: 0.7,
    stability: 1.0,
    last_access: 90,
    volatility: 0,
    tracked: false,
    created: 50 + i * 10,
    novelty: 0.5,
    reinforcement_count: 1,
    source_contact: "contact_12345",
    source: "llm",
  });
  G.addRelation("contact_12345", "knows", fid);
}

G.addFact("info_self_0", {
  content: "I tend to be curious about people's hobbies",
  fact_type: "self_knowledge",
  importance: 0.6,
  stability: 1.5,
  last_access: 80,
  volatility: 0,
  tracked: false,
  created: 20,
  novelty: 0.3,
  reinforcement_count: 2,
  source_contact: ALICE_SELF,
  source: "llm",
});
G.addRelation(ALICE_SELF, "knows", "info_self_0");

// ── 2. Dispatcher + Mods ──────────────────────────────────────────
const mods = loadAllMods();
const dispatcher = createAliceDispatcher({ graph: G, mods });

dispatcher.startTick(100);
dispatcher.dispatch("SET_CONTACT_TARGET", { nodeId: "ch_12345" });
dispatcher.dispatch("SET_VOICE", { voice: "curiosity" });

// ADR-102: Action Echo mock
dispatcher.dispatch("SET_CHAT_TARGET", { chatId: "ch_12345", liveMessageCount: 3 });
dispatcher.dispatch("SEND_MESSAGE", {
  chatId: "ch_12345",
  text: "你最近有拍什么新照片吗",
  msgId: 995,
});
dispatcher.dispatch("SEND_MESSAGE", {
  chatId: "ch_12345",
  text: "上次那个公园的照片超好看",
  msgId: 996,
});

// ── 3. 收集 contributions + zone 预算渲染 ──────────────────────────
const contributions = dispatcher.collectContributions();
const mockActionItem = {
  action: "curiosity" as const,
  target: "ch_12345",
  reason: undefined,
  pressureSnapshot: [0, 0, 0.5, 0, 0.8, 0] as [number, number, number, number, number, number],
  enqueueTick: 99,
  contributions: {},
};

const scriptGuideDefault = buildShellGuide({ isGroup: false });
const manual = await dispatcher.generateManual();
const footer = buildActionFooter(G, mockActionItem, 100);

// 使用 renderContributionsByZone（与 buildPrompt 一致）
const conversationFixedTokens =
  estimateTokens(scriptGuideDefault) + estimateTokens(manual) + estimateTokens(footer);

const {
  system: renderedSystem,
  user: renderedUser,
  zoneStats,
} = renderContributionsByZone(
  contributions,
  GLOBAL_TOKEN_BUDGET,
  undefined, // 默认 zone 配置
  conversationFixedTokens,
);

// ── 4. 组装 system prompt ──────────────────────────────────────────
const systemPrompt = `${renderedSystem}\n\n${manual}\n\n${scriptGuideDefault}`;

// ── 5. 组装 user prompt（对齐 buildPrompt 逻辑）──────────────────────
const resolved = resolveTarget(G, "ch_12345");
const userParts = [renderedUser];

// Context 段——对齐 buildPrompt: 只显示 display name，不暴露 raw ID
{
  const m = new PromptBuilder();
  m.blank();
  m.heading("Your Context");
  const varLine = [`TARGET_CHAT: ${resolved.displayName}`];
  if (resolved.contactId) {
    varLine.push(`TARGET_CONTACT: ${resolved.displayName}`);
  }
  m.line(varLine.join("  "));
  // 模拟 ACTIVE_THREADS（对齐 buildPrompt 的平坦格式）
  m.kv("ACTIVE_THREADS", '#7 "周末爬山", #12 "摄影项目"');
  userParts.push(...m.build());
}

// 模拟时间线
{
  const m = new PromptBuilder();
  m.blank();
  m.heading("Recent activity (private chat — all directed at you)");
  m.timeline("14:32", "Carol (#998)", "你看！我新养的猫 Mochi 🐱");
  m.timeline("14:32", "Carol (#999)", "[photo]");
  m.timeline("14:33", "Carol (#1000)", "刚从收容所领养的，特别乖");
  userParts.push(...m.build());
}

userParts.push("");
userParts.push(footer);
const userPrompt = userParts.join("\n");

// ── 6. 输出到目录 ──────────────────────────────────────────────────
const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const outDir = resolve(__dirname, `preview-dump-${ts}`);
mkdirSync(outDir, { recursive: true });

function write(name: string, content: string) {
  const p = resolve(outDir, name);
  writeFileSync(p, content, "utf-8");
  const lines = content.split("\n").length;
  console.log(`  ${name} (${lines} lines)`);
}

// 完整 prompt（可直接粘贴审查）
write("system.txt", systemPrompt);
write("user.txt", userPrompt);

// 分解组件——按需阅读
write(
  "contributions.txt",
  `=== System (anchor) ===\n${renderedSystem}\n\n=== User (situation) ===\n${renderedUser}`,
);
write("manual.txt", manual);
write("examples.private.js", extractExamples(buildShellGuide()));
write("footer.txt", footer);

// 统计
const stats = {
  generated: new Date().toISOString(),
  scenario: "Carol（密友，tier 15）发了猫照片，Alice 当前声部 curiosity",
  contributions: {
    total: contributions.length,
    header: contributions.filter((c) => c.bucket === "header").length,
    section: contributions.filter((c) => c.bucket === "section").length,
    footer: contributions.filter((c) => c.bucket === "footer").length,
  },
  zoneStats,
  chars: {
    system: systemPrompt.length,
    user: userPrompt.length,
    total: systemPrompt.length + userPrompt.length,
  },
  tokens: {
    system: estimateTokens(systemPrompt),
    user: estimateTokens(userPrompt),
    total: estimateTokens(systemPrompt) + estimateTokens(userPrompt),
  },
};
write("stats.json", JSON.stringify(stats, null, 2));

// README
write(
  "README.md",
  `# Prompt Preview

> 自动生成于 ${stats.generated}
> 场景：${stats.scenario}

## 文件说明

| 文件 | 内容 |
|------|------|
| system.txt | 完整 System Prompt（= contributions + manual + examples） |
| user.txt | 完整 User Prompt（= situation + context + timeline + footer） |
| contributions.txt | Mod 贡献（anchor + situation 分离展示） |
| manual.txt | 函数声明（.d.ts 风格 API 手册） |
| examples.private.js | 黄金示例 |
| footer.txt | 行动尾部（instinct + topic） |
| stats.json | token 预算 + zone 利用率 |

## 审查指引

1. \`system.txt\` — 人设 + API + 示例是否一致？
2. \`user.txt\` — 情境信息是否充分？有无 raw ID 泄漏？
3. \`contributions.txt\` — Mod 贡献是否整洁？有无冗余？
4. \`examples.*.js\` — 场景覆盖是否充分？行为示范是否正确？
5. \`stats.json\` — token 利用率是否健康？
`,
);

// --blind
if (blind) {
  write(
    "blind-review.md",
    `Please evaluate this LLM prompt on a scale of 1-10 across these dimensions:
1. Cognitive Load: Can the LLM scan and understand this quickly?
2. Function API: Are the function signatures clear and usable?
3. Behavioral Guidance: Do the examples teach good behavior?
4. Context Usage: Is the context sufficient and non-redundant?
5. Failure Modes: What will the LLM likely get wrong?

---

## System Prompt

${systemPrompt}

---

## User Prompt

${userPrompt}`,
  );
}

console.log(`\nOutput: ${outDir}`);
closeDb();

// ── 辅助函数 ──────────────────────────────────────────────────────

function extractExamples(scriptGuide: string): string {
  const examplesStart = scriptGuide.indexOf("```javascript\n/* 场景：");
  if (examplesStart === -1) return "(no examples found)";
  const raw = scriptGuide.slice(examplesStart).trim();
  // 去掉 markdown 代码围栏，保留纯 JS
  return raw
    .replace(/^```javascript\n/gm, "")
    .replace(/^```$/gm, "")
    .trim();
}
