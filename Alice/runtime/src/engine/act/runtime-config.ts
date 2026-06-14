/**
 * Извлечение конфигурации времени выполнения — получение ActionRuntimeConfig из Config / ActContext.
 *
 * Выделено из react/subcycle.ts в отдельный модуль для устранения риска циклических зависимостей.
 */

import type { Config } from "../../config.js";
import type { ActionRuntimeConfig } from "../../core/action-executor.js";

/** Извлекает из Config конфигурацию времени выполнения, необходимую для реализации Telegram-действий. */
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
