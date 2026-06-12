/**
 * 运行时配置提取 — 从 Config / ActContext 派生 ActionRuntimeConfig。
 *
 * 从 react/subcycle.ts 提取为独立模块，消除循环依赖风险。
 */

import type { Config } from "../../config.js";
import type { ActionRuntimeConfig } from "../../core/action-executor.js";

/** 从 Config 提取 Telegram action impl 所需的运行时配置。 */
export function extractRuntimeConfig(config: Config): ActionRuntimeConfig {
  return {
    ttsConfig: {
      ttsBaseUrl: config.ttsBaseUrl,
      ttsApiKey: config.ttsApiKey,
      ttsModel: config.ttsModel,
      ttsVoice: config.ttsVoice,
      ttsGroupId: config.ttsGroupId,
    },
    exaApiKey: config.exaApiKey,
    musicApiBaseUrl: config.musicApiBaseUrl,
    youtubeApiKey: config.youtubeApiKey,
    timezoneOffset: config.timezoneOffset,
  };
}
