/**
 * Глобальная конфигурация: управляющая панель TOML + секреты из env.
 *
 * runtime/config.toml хранит открытую структурированную конфигурацию; ключи, номера телефонов
 * и другие чувствительные значения передаются только через *_env-поля TOML, ссылающиеся на переменные окружения.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseToml, type TomlTable } from "smol-toml";
import { z } from "zod";
import { ensureChannelId, telegramChannelId } from "./graph/constants.js";
import {
  type AttentionDebtConfig,
  DEFAULT_ATTENTION_DEBT_CONFIG,
} from "./pressure/attention-debt.js";
import {
  DEFAULT_SATURATION_COST_CONFIG,
  DEFAULT_SOCIAL_COST_CONFIG,
  type SaturationCostConfig,
  SaturationCostConfigSchema,
  type SocialCostConfig,
  SocialCostConfigSchema,
} from "./pressure/social-cost.js";
import { ALICE_STATE_DIR } from "./runtime-paths.js";
import type { PersonalityWeights, PressureDims } from "./utils/math.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const RUNTIME_ROOT = resolve(__dirname, "..");
const DEFAULT_CONFIG_PATH = resolve(RUNTIME_ROOT, "config.toml");
const OptionalEnvNameSchema = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.string().min(1).optional(),
);
const OptionalUrlStringSchema = z.union([z.literal(""), z.string().url()]);
export const SoulProfileSchema = z.enum(["default", "ojou"]);
export type SoulProfile = z.infer<typeof SoulProfileSchema>;

// -- D5: Provider Fallback（ADR-123 §D5）-------------------------------------
// @see docs/adr/123-crystallization-substrate-generalization.md §D5

export const ProviderConfigSchema = z.object({
  name: z.string().min(1),
  baseUrl: z.string().url(),
  apiKey: z.string(),
  model: z.string().min(1),
  modalities: z.array(z.enum(["vision", "tts", "embedding"])).optional(),
});

export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;

const LlmEndpointTomlSchema = z.object({
  name: z.string().min(1),
  base_url: z.string().url(),
  api_key_env: z.string().min(1),
  model: z.string().min(1),
  modalities: z.array(z.enum(["vision", "tts", "embedding"])).optional(),
});

const LlmRoutingTomlSchema = z.object({
  first_pass: z.array(z.string().min(1)).min(1),
  tool_tick: z.array(z.string().min(1)).min(1),
  // Ops-каналы (работач): отдельные маршруты под Opus. Опциональны — без них
  // ops-каналы используют first_pass/tool_tick (поведение как раньше).
  ops_first_pass: z.array(z.string().min(1)).min(1).optional(),
  ops_tool_tick: z.array(z.string().min(1)).min(1).optional(),
  eval: z.array(z.string().min(1)).min(1).optional(),
  auxiliary: z.array(z.string().min(1)).min(1).optional(),
  reflect: z.array(z.string().min(1)).min(1).optional(),
});

const RuntimeTomlSchema = z.object({
  telegram: z.object({
    api_id_env: z.string().min(1).default("TELEGRAM_API_ID"),
    api_hash_env: z.string().min(1).default("TELEGRAM_API_HASH"),
    phone_env: z.string().min(1).default("TELEGRAM_PHONE"),
    admin_env: z.string().min(1).default("TELEGRAM_ADMIN"),
    operator_channel_id: z.string().default(""),
  }),
  qq: z
    .object({
      onebot_api_base_url: OptionalUrlStringSchema.default(""),
      onebot_event_ws_url: OptionalUrlStringSchema.default(""),
      onebot_access_token_env: OptionalEnvNameSchema,
      onebot_timeout_ms: z.number().int().positive().default(10_000),
      onebot_reconnect_min_ms: z.number().int().positive().default(1_000),
      onebot_reconnect_max_ms: z.number().int().positive().default(60_000),
    })
    .default({}),
  llm: z
    .object({
      endpoints: z.array(LlmEndpointTomlSchema).min(1),
      routing: LlmRoutingTomlSchema,
    })
    .superRefine((llm, ctx) => {
      const names = new Set(llm.endpoints.map((endpoint) => endpoint.name));
      const checkRoute = (routeName: keyof z.infer<typeof LlmRoutingTomlSchema>) => {
        const route = llm.routing[routeName];
        if (!route) return;
        for (const endpointName of route) {
          if (!names.has(endpointName)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ["routing", routeName],
              message: `Unknown LLM endpoint "${endpointName}" in llm.routing.${routeName}`,
            });
          }
        }
      };
      checkRoute("first_pass");
      checkRoute("tool_tick");
      checkRoute("ops_first_pass");
      checkRoute("ops_tool_tick");
      checkRoute("eval");
      checkRoute("auxiliary");
      checkRoute("reflect");
    }),
  vision: z
    .object({
      model: z.string().default(""),
      base_url: z.string().url().optional(),
      api_key_env: OptionalEnvNameSchema,
      max_per_tick: z.number().int().nonnegative().default(5),
    })
    .default({}),
  tts: z
    .object({
      base_url: z.string().default(""),
      api_key_env: OptionalEnvNameSchema,
      model: z.string().default("tts-1"),
      voice: z.string().default(""),
      group_id_env: OptionalEnvNameSchema,
    })
    .default({}),
  asr: z
    .object({
      base_url: z.string().default(""),
      api_key_env: OptionalEnvNameSchema,
      model: z.string().default("whisper-1"),
    })
    .default({}),
  // Семантическая память (ADDITIVE): локальный OpenAI-совместимый /v1/embeddings.
  // OFF BY DEFAULT — пустой base_url ⇒ семантический recall полностью отключён,
  // recall работает байт-в-байт как раньше (keyword/recency/graph).
  embedding: z
    .object({
      base_url: z.string().default(""),
      api_key_env: OptionalEnvNameSchema,
      model: z.string().default(""),
    })
    .default({}),
  services: z
    .object({
      exa_api_key_env: OptionalEnvNameSchema,
      music_api_base_url: z.string().default(""),
      youtube_api_key_env: OptionalEnvNameSchema,
      wd_tagger_url: z.string().default("http://127.0.0.1:39100"),
      anime_classify_url: z.string().default("http://127.0.0.1:39101"),
    })
    .default({}),
  soul: z
    .object({
      profile: SoulProfileSchema.default("default"),
    })
    .default({}),
  ocr: z
    .object({
      enabled: z.boolean().default(true),
      max_per_tick: z.number().int().nonnegative().default(3),
      min_confidence: z.number().min(0).max(1).default(0.6),
    })
    .default({}),
  pressure: z
    .object({
      thread_age_scale: z.number().positive().default(86_400),
      delta: z.number().default(1.0),
      eta: z.number().default(0.6),
      k: z.number().default(20),
      mu: z.number().default(0.3),
      d: z.number().default(-0.5),
      kappa: z
        .tuple([z.number(), z.number(), z.number(), z.number(), z.number(), z.number()])
        .default([5.0, 8.0, 8.0, 5.0, 3.0, 0.5]),
      k_steepness: z.number().default(5.0),
      kappa_prospect: z.number().default(3.0),
      kappa_adapt_alpha: z.number().default(0.02),
    })
    .default({}),
  action_rate: z
    .object({
      window_s: z.number().int().positive().default(3000),
      floor: z.number().default(0.05),
      cap_private: z.number().int().nonnegative().default(10),
      cap_group: z.number().int().nonnegative().default(8),
      cap_channel: z.number().int().nonnegative().default(3),
      cap_bot: z.number().int().nonnegative().default(3),
    })
    .default({}),
  personality: z
    .object({
      learning_rate: z.number().default(0.0001),
      mean_reversion: z.number().default(0.002),
      pi_min: z.number().default(0.05),
      pi_home: z
        .tuple([z.number(), z.number(), z.number(), z.number()])
        .default([0.25, 0.25, 0.25, 0.25]),
      mood_half_life_s: z.number().positive().default(3600),
      mood_nudge_scale: z.number().default(0.05),
    })
    .default({}),
  time: z
    .object({
      dt_min_ms: z.number().int().positive().default(1000),
      dt_max_ms: z.number().int().positive().default(300_000),
      kappa_t: z.number().default(1.0),
      snapshot_interval_s: z.number().int().positive().default(600),
      staleness_threshold: z.number().default(0.5),
      timezone_offset: z.number().default(8),
      rhythm_profile_rebuild_interval_s: z.number().int().nonnegative().default(21_600),
    })
    .default({}),
  wakeup: z
    .object({
      offline_threshold_s: z.number().int().nonnegative().default(600),
      graduation_ticks: z.number().int().nonnegative().default(10),
    })
    .default({}),
  mode: z
    .object({
      theta_silence_s: z.number().int().nonnegative().default(300),
      theta_low_api: z.number().default(0.05),
      theta_mem: z.number().default(0.3),
    })
    .default({}),
  dormant: z
    .object({
      quiet_window_start: z.number().int().min(0).max(23).default(23),
      quiet_window_end: z.number().int().min(0).max(23).default(7),
      theta_api: z.number().default(0.15),
      wake_tier: z.number().default(150),
    })
    .default({}),
  idle: z
    .object({
      threshold_s: z.number().int().nonnegative().default(1800),
      s10_leak_prob: z.number().default(0.15),
    })
    .default({}),
  exploration: z
    .object({
      max_joins_per_day: z.number().int().nonnegative().default(5),
      max_search_per_hour: z.number().int().nonnegative().default(10),
      join_cooldown_ms: z.number().int().nonnegative().default(3_600_000),
      search_cooldown_ms: z.number().int().nonnegative().default(300_000),
      post_join_search_cooldown_ms: z.number().int().nonnegative().default(1_800_000),
      silent_duration_s: z.number().int().nonnegative().default(600),
      apprentice_duration_s: z.number().int().nonnegative().default(1800),
      apprentice_max_messages: z.number().int().nonnegative().default(3),
      circuit_breaker_threshold: z.number().int().positive().default(3),
      circuit_breaker_open_ms: z.number().int().nonnegative().default(3_600_000),
    })
    .default({}),
  belief: z
    .object({
      beta: z.number().default(0.1),
      gamma: z.number().default(0.15),
      thompson_eta: z.number().default(0.1),
    })
    .default({}),
  iaus: z
    .object({
      deterministic: z.boolean().default(false),
      habituation_alpha: z.number().default(0.5),
      habituation_half_life_s: z.number().positive().default(1800),
      momentum_bonus: z.number().default(0.05),
      momentum_decay_ms: z.number().int().nonnegative().default(300_000),
      curve_modulation_strength: z.number().default(0.5),
      desire_boost: z.number().default(0.15),
    })
    .default({}),
  attention_debt: z
    .object({
      delta: z.number().default(DEFAULT_ATTENTION_DEBT_CONFIG.delta),
    })
    .default({}),
  budget_zones: z
    .object({
      anchor: z.number().optional(),
      situation: z.number().optional(),
      conversation: z.number().optional(),
      memory: z.number().optional(),
    })
    .optional(),
  peripheral: z
    .object({
      per_channel_cap: z.number().int().nonnegative().default(3),
      total_cap: z.number().int().nonnegative().default(8),
      min_text_length: z.number().int().nonnegative().default(15),
    })
    .default({}),
  generators: z
    .object({
      digest_hour: z.number().int().min(0).max(23).default(8),
      reflection_day: z.number().int().min(0).max(6).default(0),
      reflection_hour: z.number().int().min(0).max(23).default(20),
      anomaly_z_threshold: z.number().default(3.0),
    })
    .default({}),
  focus: z
    .object({
      whitelist_path: z.string().default(""),
      whitelist: z.array(z.string().min(1)).default([]),
    })
    .default({}),
  log: z
    .object({
      level: z.string().default("info"),
    })
    .default({}),
});

type RuntimeTomlConfig = z.infer<typeof RuntimeTomlSchema>;

const DEFAULT_FOCUS_WHITELIST_FILENAME = "focus-whitelist.txt";

function normalizeFocusWhitelistTarget(raw: string, source: string): string {
  const target = raw.trim();
  const channelId = ensureChannelId(target);
  if (channelId) return channelId;
  throw new Error(
    `${source} contains invalid focus whitelist target "${raw}". Use canonical channel:<platform>:<native-id> target ids.`,
  );
}

function parseFocusWhitelistFile(content: string): ReadonlySet<string> {
  const targets = new Set<string>();
  for (const [index, line] of content.split(/\r?\n/u).entries()) {
    const trimmed = line.replace(/\s+#.*$/u, "").trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    targets.add(normalizeFocusWhitelistTarget(trimmed, `focus whitelist file line ${index + 1}`));
  }
  return targets;
}

function loadFocusWhitelistFromConfig(focus: RuntimeTomlConfig["focus"]): {
  path: string;
  targets: ReadonlySet<string> | null;
} {
  if (focus.whitelist.length > 0) {
    const normalized = new Set<string>();
    for (const [index, target] of focus.whitelist.entries()) {
      normalized.add(
        normalizeFocusWhitelistTarget(target, `config.toml focus.whitelist[${index}]`),
      );
    }
    return { path: "config.toml:focus.whitelist", targets: normalized };
  }

  const rawPath = focus.whitelist_path.trim();
  if (rawPath) {
    const resolvedPath = resolve(rawPath);
    const content = readFileSync(resolvedPath, "utf-8");
    return {
      path: resolvedPath,
      targets: parseFocusWhitelistFile(content),
    };
  }

  const resolvedPath = resolve(ALICE_STATE_DIR, DEFAULT_FOCUS_WHITELIST_FILENAME);
  if (!existsSync(resolvedPath)) return { path: "", targets: null };

  const content = readFileSync(resolvedPath, "utf-8");
  return {
    path: resolvedPath,
    targets: parseFocusWhitelistFile(content),
  };
}

function loadRuntimeToml(): RuntimeTomlConfig {
  const configPath = resolve(process.env.ALICE_CONFIG_PATH ?? DEFAULT_CONFIG_PATH);
  if (!existsSync(configPath)) {
    throw new Error(`Missing runtime config TOML: ${configPath}`);
  }

  const parsed = parseToml(readFileSync(configPath, "utf-8")) as TomlTable;
  return RuntimeTomlSchema.parse(parsed);
}

function secretFromEnv(envName: string | undefined, label: string, required = false): string {
  if (!envName) return "";
  const value = process.env[envName] ?? "";
  if (required && value.length === 0) {
    throw new Error(`Missing required secret env ${envName} for ${label}`);
  }
  return value;
}

function intSecretFromEnv(envName: string, label: string): number {
  const raw = secretFromEnv(envName, label);
  if (!raw) return 0;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value)) {
    throw new Error(`Invalid integer env ${envName} for ${label}`);
  }
  return value;
}

function providersFromToml(config: RuntimeTomlConfig): ProviderConfig[] {
  return config.llm.endpoints.map((provider) =>
    ProviderConfigSchema.parse({
      name: provider.name,
      baseUrl: provider.base_url,
      apiKey: secretFromEnv(provider.api_key_env, `llm.endpoints "${provider.name}"`),
      model: provider.model,
      modalities: provider.modalities,
    }),
  );
}

function optionalBudgetZones(
  budgetZones: RuntimeTomlConfig["budget_zones"],
): Config["budgetZones"] {
  if (!budgetZones) return undefined;
  const result: NonNullable<Config["budgetZones"]> = {};
  for (const key of ["anchor", "situation", "conversation", "memory"] as const) {
    const value = budgetZones[key];
    if (value != null) result[key] = value;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

export interface Config {
  // Telegram
  telegramApiId: number;
  telegramApiHash: string;
  telegramPhone: string;

  // QQ OneBot bridge
  /** ADR-264/265: OneBot v11 HTTP action base URL. Empty = QQ transport disabled. */
  qqOneBotApiBaseUrl: string;
  /** ADR-264/265: OneBot v11 event WebSocket URL. Empty = QQ inbound disabled. */
  qqOneBotEventWsUrl: string;
  /** OneBot access token. Empty when the protocol endpoint does not require one. */
  qqOneBotAccessToken: string;
  /** OneBot action request timeout. */
  qqOneBotTimeoutMs: number;
  /** OneBot event WebSocket reconnect lower bound. */
  qqOneBotReconnectMinMs: number;
  /** OneBot event WebSocket reconnect upper bound. */
  qqOneBotReconnectMaxMs: number;

  // LLM
  /** D5: цепочка fallback для нескольких LLM-эндпоинтов (ADR-123 §D5). */
  providers: ProviderConfig[];
  /** Маршрутизация эндпоинтов по назначению. firstPass/toolTick — пул с перемешиванием; eval/auxiliary/reflect — порядок fallback. */
  llmRouting: {
    firstPass: string[];
    toolTick: string[];
    /** Ops-каналы (работач): Opus-маршруты. Пусты → используются firstPass/toolTick. */
    opsFirstPass: string[];
    opsToolTick: string[];
    eval: string[];
    auxiliary: string[];
    reflect: string[];
  };
  llmBaseUrl: string;
  llmApiKey: string;
  llmModel: string;
  /** Модель специально для Reflection (если пусто — fallback на llmModel). Интроспекция не видна пользователю, можно использовать более дешёвую модель. */
  llmReflectModel: string;
  /** ADR-226: base URL Reflect Provider (если пусто — fallback на llmBaseUrl). */
  llmReflectBaseUrl: string;
  /** ADR-226: API key Reflect Provider (если пусто — fallback на llmApiKey). */
  llmReflectApiKey: string;

  // ADR-88: Vision (восприятие изображений)
  /** Название модели Vision (например gpt-4o-mini). Пустая строка = восприятие изображений отключено. */
  visionModel: string;
  /** Vision API base URL (если пусто — fallback на llmBaseUrl). */
  visionBaseUrl: string;
  /** Vision API key (если пусто — fallback на llmApiKey). */
  visionApiKey: string;
  /** Максимальное количество изображений, обрабатываемых за один tick. */
  visionMaxPerTick: number;

  // ADR-88: TTS (синтез речи)
  /** TTS API base URL (OpenAI-compatible /audio/speech или Fish Audio). Пусто = отключено. */
  ttsBaseUrl: string;
  /** TTS API key. */
  ttsApiKey: string;
  /** Название TTS-модели (например tts-1, speech-1.5). */
  ttsModel: string;
  /** TTS voice ID (voice preset или Fish Audio reference_id). */
  ttsVoice: string;
  /** MiniMax Group ID (только для MiniMax TTS, другими бэкендами игнорируется). */
  ttsGroupId: string;

  // ADR-119: ASR (распознавание речи)
  /** ASR API base URL (совместимый с OpenAI /audio/transcriptions). Пусто = отключено. */
  asrBaseUrl: string;
  /** ASR API key. */
  asrApiKey: string;
  /** Название ASR-модели (например whisper-1). */
  asrModel: string;

  // Семантическая память (ADDITIVE retrieval enrichment) — локальный /v1/embeddings.
  /** Base URL OpenAI-совместимого сервера эмбеддингов. Пусто = семантический recall ОТКЛЮЧЁН (recall ведёт себя как раньше). */
  embeddingBaseUrl: string;
  /** API key сервера эмбеддингов (для локального/keyless обычно пустой). */
  embeddingApiKey: string;
  /** Название модели эмбеддинга (например bge-m3). Пусто (вместе с base_url) = отключено. */
  embeddingModel: string;

  /** ADR-117 D7: Exa API key (поиск внешних знаний). Пустая строка = browse отключён. */
  exaApiKey: string;
  /** ADR-132 Wave 3: base URL музыкального API (совместимый с NeteaseCloudMusicApi). Пусто = отключено. */
  musicApiBaseUrl: string;
  /** ADR-132 Wave 4: YouTube Data API v3 key. Пусто = доступен только Bilibili. */
  youtubeApiKey: string;
  /** URL сервиса WD14 Tagger. По умолчанию http://127.0.0.1:39100, при недоступности автоматическое понижение уровня. */
  wdTaggerUrl: string;
  /** ADR-153: URL сервиса классификации AnimeIDF. По умолчанию http://127.0.0.1:39101, при недоступности понижение уровня (всё пропускается). */
  animeClassifyUrl: string;

  /** Профиль личности. default -> SOUL.md; ojou -> SOUL.ojou.md. */
  soulProfile: SoulProfile;

  // OCR — локальный PaddleOCR PP-OCRv4 (без API-расходов)
  /** Переключатель OCR. По умолчанию включён. */
  ocrEnabled: boolean;
  /** Максимальное количество OCR-изображений за один tick (независимо от visionMaxPerTick). */
  ocrMaxPerTick: number;
  /** Порог уверенности OCR (0–1): блоки текста ниже этого значения отбрасываются. */
  ocrMinConfidence: number;

  // Параметры поля давлений
  /** ADR-64 VI-1: логарифмическая шкала возраста потока P4 (секунды, по умолчанию 86400 = 1 день). */
  threadAgeScale: number;
  delta: number; // показатель сингулярности дедлайна P4
  // ADR-111: betaR перенесён в константу P3_BETA_R (выведено из Weber-Fechner, не настраивается)
  eta: number; // базовое значение любопытства P6
  k: number; // окно ретроспективы P6
  mu: number; // затухание распространения Лапласиана
  d: number; // показатель кривой забывания P2 (< 0)

  // κ нормализации API (на каждую компоненту давления)
  kappa: PressureDims;

  // ADR-23: параметры P_prospect
  kSteepness: number; // крутизна сигмоиды P_prospect
  kappaProspect: number; // κ нормализации P_prospect

  /** ADR-112 D4: коэффициент затухания EMA адаптивного κ (по умолчанию 0.02, полупериод 50 тиков). */
  kappaAdaptAlpha: number;

  // Шлюз частоты действий
  actionRateWindow: number;
  /** Жёсткий лимит частоты действий с учётом типа чата (абсолютный счётчик в окне). @see ADR-113 F15, ADR-189 D2, ADR-206 §3 */
  rateCap: { private: number; group: number; channel: number; bot: number };
  actionRateFloor: number;

  // Эволюция личности
  learningRate: number;
  meanReversion: number;
  piMin: number;
  piHome: PersonalityWeights;

  // Время — адаптивный tick (статья §6.4 Definition 6.3)
  /** Δt_min (миллисекунды). */
  dtMin: number;
  /** Δt_max (миллисекунды). */
  dtMax: number;
  /** κ_t — константа экспоненциального затухания API → интервал. */
  kappaT: number;
  snapshotIntervalS: number; // интервал снимков (секунды)
  stalenessThreshold: number;

  // ADR-190: Wakeup Mode
  /** Длительность офлайна (секунды), при превышении которой активируется режим wakeup. Рестарты ниже порога идут прямо в patrol. */
  wakeupOfflineThresholdS: number;
  /** Количество тиков, необходимых для завершения wakeup. α_w(n) = min(1, n / N). */
  wakeupGraduationTicks: number;

  // Пороги FSM режима агента (статья §6.2)
  /** conversation → patrol: тишина в focus превышает это число секунд. */
  thetaSilenceS: number;
  /** patrol → consolidation: API ниже этого значения. */
  thetaLowAPI: number;
  /** patrol → consolidation: P2 выше этого значения (потребность в консолидации памяти). */
  thetaMem: number;

  // ADR-225: Dormant Mode — ритм сна
  /** Начало тихого окна в местном времени (по умолчанию 23). При переходе через полночь start > end (например 23–7). */
  quietWindowStart: number;
  /** Конец тихого окна в местном времени (по умолчанию 7). */
  quietWindowEnd: number;
  /** patrol/consolidation → dormant: входить в сон только если API ниже этого значения (по умолчанию 0.15). */
  thetaDormantAPI: number;
  /** Порог пробуждения в dormant для близких контактов (directed-сообщения с tier < этого значения могут разбудить, по умолчанию 150). */
  dormantWakeTier: number;

  // Автозапуск при простое
  idleThreshold: number; // секунды без действий → триггер действия

  // Вероятность утечки участия в групповом чате S10
  s10LeakProb: number;

  // ADR-110: полупериод затухания self mood (секунды)
  moodHalfLife: number;

  // Часовой пояс: смещение местного времени пользователя относительно UTC (часы), например UTC+8 → 8
  timezoneOffset: number;
  /** ADR-261: интервал автоматического перестроения rhythm_profiles. 0 = автоперестроение отключено. */
  rhythmProfileRebuildIntervalS: number;

  // Защита исследования (ExplorationGuard)
  exploration: {
    maxJoinsPerDay: number;
    maxSearchPerHour: number;
    joinCooldownMs: number;
    searchCooldownMs: number;
    postJoinSearchCooldownMs: number;
    silentDurationS: number;
    apprenticeDurationS: number;
    apprenticeMaxMessages: number;
    circuitBreakerThreshold: number;
    circuitBreakerOpenMs: number;
  };

  // D5: Social Cost
  socialCost: SocialCostConfig;

  /** ADR-136: конфигурация стоимости насыщения C_sat. @see docs/adr/136-constrained-vmax/README.md */
  saturationCost: SaturationCostConfig;

  /** Social POMDP: коэффициент штрафа за неопределённость β. β=0 — деградация до версии без убеждений. */
  beliefBeta: number;

  /** ADR-151: коэффициент информационного выигрыша VoI γ. γ > 0 — цели с высокой неопределённостью получают бонус исследования, компенсирующий штраф β·H. */
  beliefGamma: number;

  /** ADR-151 #6: коэффициент шума Thompson Sampling η. η > 0 — цели с высокой σ² получают случайное возмущение для исследования. η=0 — отключено. */
  thompsonEta: number;

  /** ADR-180: детерминированный режим IAUS (argmax вместо Boltzmann). Только для тестов. */
  iausDeterministic: boolean;

  /** ADR-222: коэффициент α привыкания (по умолчанию 0.5). ρ_H = 1/(1+α·H). */
  habituationAlpha: number;
  /** ADR-222: полупериод привыкания (секунды, по умолчанию 1800). */
  habituationHalfLifeS: number;
  /** ADR-182 D1: коэффициент momentum bonus. ADR-222: снижен с 0.2 до 0.05. */
  momentumBonus: number;
  /** ADR-182 D1: таймаут затухания momentum (мс). */
  momentumDecayMs: number;
  /** ADR-183: сила модуляции кривой личностью (0 = без модуляции, 1 = максимальная модуляция). */
  curveModulationStrength: number;
  /** ADR-185 §1: коэффициент desire boost (0 = отключено, по умолчанию 0.15). */
  desireBoost: number;
  /** ADR-185 §3: амплитуда mood nudge (0 = отключено, по умолчанию 0.05). */
  moodNudgeScale: number;

  /** ADR-100: конфигурация долга внимания. @see docs/adr/100-attention-debt.md §9 */
  attentionDebt: AttentionDebtConfig;

  /** ADR-114 D1: пропорциональное переопределение budget zone. @see docs/adr/114-context-assembly-rehabilitation.md */
  budgetZones?: Partial<Record<"anchor" | "situation" | "conversation" | "memory", number>>;

  /** ADR-121: параметры социального периферийного зрения. @see docs/adr/121-social-peripheral-vision/README.md §3.4 */
  peripheral: {
    /** Максимальное количество сообщений, инжектируемых из каждого общего канала. */
    perChannelCap: number;
    /** Максимальное суммарное количество инжектируемых сообщений. */
    totalCap: number;
    /** Минимальная длина текста (сообщения короче этого значения фильтруются). */
    minTextLength: number;
  };

  /**
   * ADR-115: параметры эндогенных генераторов потоков.
   * @see docs/adr/115-evolve-observability/
   */
  generators: {
    /** Местный час срабатывания утреннего Digest (0–23). */
    digestHour: number;
    /** День недели для еженедельной рефлексии (0=воскресенье, 6=суббота). */
    reflectionDay: number;
    /** Местный час срабатывания еженедельной рефлексии (0–23). */
    reflectionHour: number;
    /** Порог z-score для Anomaly Generator. */
    anomalyZThreshold: number;
  };

  /**
   * Источник белого списка фокуса. Рекомендуется focus.whitelist из config.toml; при совместимости с путём к файлу — абсолютный путь.
   */
  focusWhitelistPath: string;
  /**
   * Белый список целей-кандидатов. При установке фокусный набор и IAUS выбирают цели только из этих target.
   * Само поле давлений по-прежнему вычисляется по полному графу.
   */
  focusWhitelist: ReadonlySet<string> | null;

  /**
   * ADR-172: ID канала приватного чата оператора (формат graph ID "channel:xxx").
   * Системные потоки (morning_digest, weekly_reflection) маршрутизируются в этот канал.
   * При отсутствии — fallback на вывод из telegramAdmin.
   */
  operatorChannelId: string;

  // Администратор
  telegramAdmin: string;

  // Журналирование
  logLevel: string;
}

export function getLlmProviderByRoute(
  config: Pick<Config, "providers" | "llmRouting">,
  route: keyof Config["llmRouting"] = "firstPass",
): ProviderConfig | undefined {
  const providerByName = new Map(config.providers.map((provider) => [provider.name, provider]));
  for (const name of config.llmRouting[route] ?? []) {
    const provider = providerByName.get(name);
    if (provider) return provider;
  }
  return config.providers[0];
}

export function loadConfig(): Config {
  const toml = loadRuntimeToml();
  const providers = providersFromToml(toml);
  const providerByName = new Map(providers.map((provider) => [provider.name, provider]));
  const primaryProvider = providerByName.get(toml.llm.routing.first_pass[0]) ?? providers[0];
  const auxiliaryRoute = toml.llm.routing.auxiliary ?? toml.llm.routing.first_pass;
  const reflectProvider =
    providerByName.get(toml.llm.routing.reflect?.[0] ?? auxiliaryRoute[0]) ?? primaryProvider;
  const telegramAdmin = secretFromEnv(toml.telegram.admin_env, "telegram.admin_env");
  const focusWhitelist = loadFocusWhitelistFromConfig(toml.focus);

  return {
    telegramApiId: intSecretFromEnv(toml.telegram.api_id_env, "telegram.api_id_env"),
    telegramApiHash: secretFromEnv(toml.telegram.api_hash_env, "telegram.api_hash_env"),
    telegramPhone: secretFromEnv(toml.telegram.phone_env, "telegram.phone_env"),
    qqOneBotApiBaseUrl: toml.qq.onebot_api_base_url,
    qqOneBotEventWsUrl: toml.qq.onebot_event_ws_url,
    qqOneBotAccessToken: secretFromEnv(
      toml.qq.onebot_access_token_env,
      "qq.onebot_access_token_env",
    ),
    qqOneBotTimeoutMs: toml.qq.onebot_timeout_ms,
    qqOneBotReconnectMinMs: toml.qq.onebot_reconnect_min_ms,
    qqOneBotReconnectMaxMs: toml.qq.onebot_reconnect_max_ms,

    providers,
    llmRouting: {
      firstPass: toml.llm.routing.first_pass,
      toolTick: toml.llm.routing.tool_tick,
      opsFirstPass: toml.llm.routing.ops_first_pass ?? toml.llm.routing.first_pass,
      opsToolTick: toml.llm.routing.ops_tool_tick ?? toml.llm.routing.tool_tick,
      eval: toml.llm.routing.eval ?? toml.llm.routing.first_pass,
      auxiliary: auxiliaryRoute,
      reflect: toml.llm.routing.reflect ?? auxiliaryRoute,
    },
    llmBaseUrl: primaryProvider.baseUrl,
    llmApiKey: primaryProvider.apiKey,
    llmModel: primaryProvider.model,
    llmReflectModel: reflectProvider.model,
    llmReflectBaseUrl: reflectProvider.baseUrl,
    llmReflectApiKey: reflectProvider.apiKey,

    visionModel: toml.vision.model,
    visionBaseUrl: toml.vision.base_url ?? primaryProvider.baseUrl,
    visionApiKey:
      secretFromEnv(toml.vision.api_key_env, "vision.api_key_env") || primaryProvider.apiKey,
    visionMaxPerTick: toml.vision.max_per_tick,

    ttsBaseUrl: toml.tts.base_url,
    ttsApiKey: secretFromEnv(toml.tts.api_key_env, "tts.api_key_env"),
    ttsModel: toml.tts.model,
    ttsVoice: toml.tts.voice,
    ttsGroupId: secretFromEnv(toml.tts.group_id_env, "tts.group_id_env"),

    asrBaseUrl: toml.asr.base_url,
    asrApiKey: secretFromEnv(toml.asr.api_key_env, "asr.api_key_env"),
    asrModel: toml.asr.model,

    embeddingBaseUrl: toml.embedding.base_url,
    embeddingApiKey: secretFromEnv(toml.embedding.api_key_env, "embedding.api_key_env"),
    embeddingModel: toml.embedding.model,

    exaApiKey: secretFromEnv(toml.services.exa_api_key_env, "services.exa_api_key_env"),
    musicApiBaseUrl: toml.services.music_api_base_url,
    youtubeApiKey: secretFromEnv(toml.services.youtube_api_key_env, "services.youtube_api_key_env"),
    wdTaggerUrl: toml.services.wd_tagger_url,
    animeClassifyUrl: toml.services.anime_classify_url,
    soulProfile: toml.soul.profile,

    ocrEnabled: toml.ocr.enabled,
    ocrMaxPerTick: toml.ocr.max_per_tick,
    ocrMinConfidence: toml.ocr.min_confidence,

    threadAgeScale: toml.pressure.thread_age_scale,
    delta: toml.pressure.delta,
    // ADR-111: betaR перенесён в константу P3_BETA_R (больше не является runtime-конфигурацией)
    eta: toml.pressure.eta,
    k: toml.pressure.k,
    mu: toml.pressure.mu,
    d: toml.pressure.d,

    kappa: toml.pressure.kappa,

    kSteepness: toml.pressure.k_steepness,
    kappaProspect: toml.pressure.kappa_prospect,
    kappaAdaptAlpha: toml.pressure.kappa_adapt_alpha,

    actionRateWindow: toml.action_rate.window_s,
    rateCap: {
      private: toml.action_rate.cap_private,
      group: toml.action_rate.cap_group,
      channel: toml.action_rate.cap_channel,
      bot: toml.action_rate.cap_bot,
    },
    actionRateFloor: toml.action_rate.floor,

    learningRate: toml.personality.learning_rate,
    meanReversion: toml.personality.mean_reversion,
    piMin: toml.personality.pi_min,
    piHome: toml.personality.pi_home,

    dtMin: toml.time.dt_min_ms,
    dtMax: toml.time.dt_max_ms,
    kappaT: toml.time.kappa_t,
    snapshotIntervalS: toml.time.snapshot_interval_s,
    stalenessThreshold: toml.time.staleness_threshold,

    idleThreshold: toml.idle.threshold_s,

    s10LeakProb: toml.idle.s10_leak_prob,
    moodHalfLife: toml.personality.mood_half_life_s,

    wakeupOfflineThresholdS: toml.wakeup.offline_threshold_s,
    wakeupGraduationTicks: toml.wakeup.graduation_ticks,

    thetaSilenceS: toml.mode.theta_silence_s,
    thetaLowAPI: toml.mode.theta_low_api,
    thetaMem: toml.mode.theta_mem,

    quietWindowStart: toml.dormant.quiet_window_start,
    quietWindowEnd: toml.dormant.quiet_window_end,
    thetaDormantAPI: toml.dormant.theta_api,
    dormantWakeTier: toml.dormant.wake_tier,

    timezoneOffset: toml.time.timezone_offset,
    rhythmProfileRebuildIntervalS: toml.time.rhythm_profile_rebuild_interval_s,

    exploration: {
      maxJoinsPerDay: toml.exploration.max_joins_per_day,
      maxSearchPerHour: toml.exploration.max_search_per_hour,
      joinCooldownMs: toml.exploration.join_cooldown_ms,
      searchCooldownMs: toml.exploration.search_cooldown_ms,
      postJoinSearchCooldownMs: toml.exploration.post_join_search_cooldown_ms,
      silentDurationS: toml.exploration.silent_duration_s,
      apprenticeDurationS: toml.exploration.apprentice_duration_s,
      apprenticeMaxMessages: toml.exploration.apprentice_max_messages,
      circuitBreakerThreshold: toml.exploration.circuit_breaker_threshold,
      circuitBreakerOpenMs: toml.exploration.circuit_breaker_open_ms,
    },

    socialCost: SocialCostConfigSchema.parse(DEFAULT_SOCIAL_COST_CONFIG),

    saturationCost: SaturationCostConfigSchema.parse(DEFAULT_SATURATION_COST_CONFIG),

    beliefBeta: toml.belief.beta,
    beliefGamma: toml.belief.gamma,
    thompsonEta: toml.belief.thompson_eta,
    iausDeterministic: toml.iaus.deterministic,
    habituationAlpha: toml.iaus.habituation_alpha,
    habituationHalfLifeS: toml.iaus.habituation_half_life_s,
    momentumBonus: toml.iaus.momentum_bonus,
    momentumDecayMs: toml.iaus.momentum_decay_ms,
    curveModulationStrength: toml.iaus.curve_modulation_strength,
    desireBoost: toml.iaus.desire_boost,
    moodNudgeScale: toml.personality.mood_nudge_scale,

    attentionDebt: { delta: toml.attention_debt.delta },
    budgetZones: optionalBudgetZones(toml.budget_zones),

    peripheral: {
      perChannelCap: toml.peripheral.per_channel_cap,
      totalCap: toml.peripheral.total_cap,
      minTextLength: toml.peripheral.min_text_length,
    },

    generators: {
      digestHour: toml.generators.digest_hour,
      reflectionDay: toml.generators.reflection_day,
      reflectionHour: toml.generators.reflection_hour,
      anomalyZThreshold: toml.generators.anomaly_z_threshold,
    },

    focusWhitelistPath: focusWhitelist.path,
    focusWhitelist: focusWhitelist.targets,

    operatorChannelId:
      toml.telegram.operator_channel_id || (telegramAdmin ? telegramChannelId(telegramAdmin) : ""),

    telegramAdmin,

    logLevel: toml.log.level,
  };
}
