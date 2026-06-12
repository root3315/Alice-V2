/**
 * 临时脚本：导出 branch.baseline.greeting 场景的 system/user prompt。
 * 用法：npx tsx --env-file=.env src/eval/dump-greeting.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { loadConfig } from "../config.js";
import { createBlackboard } from "../engine/tick/blackboard.js";
import { buildTickPrompt, type TickPromptContext } from "../engine/tick/prompt-builder.js";
import type { FeatureFlags } from "../engine/tick/types.js";
import { initProviders } from "../llm/client.js";
import { createEvalFixture, setupEvalDb, teardownEvalDb } from "./fixtures.js";
import { ALL_SCENARIOS } from "./scenarios/index.js";

const config = loadConfig();
initProviders(config);

const scenario = ALL_SCENARIOS.find((s) => s.id === "branch.baseline.greeting");
if (!scenario) {
  console.error("scenario not found");
  process.exit(1);
}

setupEvalDb();
try {
  const fx = createEvalFixture(scenario);

  const features: FeatureFlags = {
    hasWeather: true,
    hasMusic: !!config.musicApiBaseUrl,
    hasBrowser: !!config.exaApiKey,
    hasTTS: !!(config.ttsBaseUrl && config.ttsApiKey),
    hasStickers: false,
    hasBots: false,
    hasSystemThreads: false,
    hasVideo: !!config.youtubeApiKey,
  };
  const board = createBlackboard({
    pressures: fx.ctx.getCurrentPressures(),
    voice: fx.item.action,
    target: fx.item.target ?? null,
    features,
    contextVars: fx.contextVars,
    maxSteps: 3,
  });
  const promptCtx: TickPromptContext = {
    G: fx.graph,
    dispatcher: fx.dispatcher,
    mods: fx.dispatcher.mods,
    config: fx.ctx.config,
    item: fx.item,
    tick: fx.tick,
    messages: fx.messages,
    observations: [],
    round: 0,
    nowMs: fx.nowMs,
  };
  const { system, user } = await buildTickPrompt(board, promptCtx);

  const dir = "eval-dump-greeting";
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}/system.txt`, system, "utf-8");
  writeFileSync(`${dir}/user.txt`, user, "utf-8");
  console.log(`Done. system=${system.length} chars, user=${user.length} chars`);
} finally {
  teardownEvalDb();
}
