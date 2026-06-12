/**
 * Telegram 动作类型系统 — 判别联合 + 执行上下文。
 *
 * TelegramActionDef 是 WriteAction | QueryAction 判别联合：
 * - WriteAction: 终端批量执行，无 CQRS 字段
 * - QueryAction: 立即执行，结果注入下一轮 observation
 *
 * 判别器: `returnsResult` — true 为 QueryAction，undefined/absent 为 WriteAction。
 * 编译期强制 CQRS 四字段全有或全无，消除无效组合。
 *
 * @see docs/adr/51-m5-interaction-primitives-implementation.md
 * @see docs/adr/105-react-cqrs-read-during-next.md
 */

import type { TelegramClient } from "@mtcute/node";
import type { z } from "zod";
import type { Dispatcher } from "../core/dispatcher.js";
import type { AffordanceDeclaration } from "../engine/tick/types.js";
import type { ChannelNodeId, TelegramId } from "../graph/entities.js";
import type { WorldModel } from "../graph/world-model.js";

// ═══════════════════════════════════════════════════════════════════════════
// 参数定义
// ═══════════════════════════════════════════════════════════════════════════

/** 参数类型，决定沙箱注入时的 coerce 行为。 */
export type ActionParamType = "string" | "number" | "array";

/** 单个参数定义（同时服务于注入 coerce 和声明生成）。 */
export interface ActionParamDef {
  type: ActionParamType;
  /** 必填参数缺失时 coerce 为默认值（string→""，number→0）。 */
  required: boolean;
  /** 人类可读描述（写入 LLM 手册）。 */
  description: string;
  /** 可选 Zod schema——存在时覆盖 type/required 的自动推导 coerce 逻辑。 */
  schema?: z.ZodTypeAny;
  /**
   * 上下文自动注入 — 值为 contextVars 中的键名。
   *
   * 设置后该参数对 LLM 完全不可见：
   * - 不写入手册声明（declaration.ts 跳过）
   * - 不占位置参数位（沙箱注入时跳过，LLM 无需传入）
   * - 执行时从 contextVars[inject] 自动填充
   *
   * 这是四柱隔离模型的结构性实现：不是限制 LLM 填错值，
   * 而是让 LLM 根本无法指定值 — make invalid states unrepresentable。
   *
   * @example chatId with inject: "TARGET_CHAT"
   *   → LLM writes react(msgId, emoji) instead of react(chatId, msgId, emoji)
   *   → sandbox auto-fills chatId from contextVars.TARGET_CHAT
   */
  inject?: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// 执行上下文
// ═══════════════════════════════════════════════════════════════════════════

/** impl 函数的执行上下文（由 action-executor 创建并注入）。 */
export interface ActionImplContext {
  client: TelegramClient;
  G: WorldModel;
  dispatcher: Dispatcher;
  tick: number;
  /** 当前轮的上下文变量（如 TARGET_CHAT），供 exec/system commands 透传。 */
  contextVars?: Readonly<Record<string, unknown>>;
  log: {
    info(msg: string, data?: Record<string, unknown>): void;
    warn(msg: string, data?: Record<string, unknown>): void;
  };
  /** chatId（number / channel:xxx / contact:xxx / 纯数字字符串）→ Telegram 数字 ID。 */
  parseChatId(chatId: string | number | TelegramId): TelegramId;
  /** chatId → 图节点 ID（channel:xxx 格式）。 */
  ensureGraphId(chatId: string | number | TelegramId): ChannelNodeId;

  // ── 注入式配置（取代模块级全局变量）──

  /** TTS 配置（send_voice 使用）。未配置时各字段为空字符串。 */
  ttsConfig: TtsConfig;
  /** Exa API key（google / visit 使用）。空字符串表示未配置。 */
  exaApiKey: string;
  /** ADR-132 Wave 3: 音乐 API base URL（NeteaseCloudMusicApi）。空 = 禁用。 */
  musicApiBaseUrl: string;
  /** ADR-132 Wave 4: YouTube Data API v3 key。空 = 仅 Bilibili。 */
  youtubeApiKey: string;
  /** 时区偏移小时数（App Toolkit 使用）。默认 8（UTC+8）。 */
  timezoneOffset: number;
}

/** TTS 语音合成配置。 */
export interface TtsConfig {
  ttsBaseUrl: string;
  ttsApiKey: string;
  ttsModel: string;
  ttsVoice: string;
  ttsGroupId?: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// 返回值
// ═══════════════════════════════════════════════════════════════════════════

/**
 * impl 返回的结构化结果。
 * 发送类动作用此返回 msgId 和 obligationsConsumed，
 * 非发送类动作可继续返回 boolean（executor 自动适配）。
 *
 * @see docs/adr/ Pillar 4: Closed Feedback Arc
 */
export interface ActionImplResult {
  success: boolean;
  /** Telegram 消息 ID（send_message 成功时返回）。 */
  msgId?: number;
  /** 此动作消解的 directed 义务数（默认 0）。 */
  obligationsConsumed?: number;
  /** 诊断信息（失败时流入修正轮次 observation，帮助 LLM 学习）。 */
  error?: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// 动作类别
// ═══════════════════════════════════════════════════════════════════════════

/** 动作类别 — strategy.mod 用于条件注入 capability hints。 */
export type ActionCategory =
  | "messaging"
  | "reaction"
  | "media"
  | "sticker"
  | "moderation"
  | "group"
  | "bot"
  | "search"
  | "account"
  | "knowledge"
  | "app"
  | "skills";

// ═══════════════════════════════════════════════════════════════════════════
// 判别联合：TelegramActionDef = WriteAction | QueryAction
// ═══════════════════════════════════════════════════════════════════════════

/** 所有动作共享的基础字段。 */
interface TelegramActionBase {
  /** 动作名称（= 沙箱函数名 = executor 查找键）。 */
  name: string;
  /** 描述行（写入 LLM 手册，每行前自动加 2 空格缩进）。 */
  description: string[];
  /** 参数列表，按位置顺序排列。 */
  params: [name: string, def: ActionParamDef][];
  /**
   * 动作类别（用于 strategy.mod 按类别生成 capability hints）。
   * 省略时默认 "messaging"。
   */
  category?: ActionCategory;
  /**
   * 策略提示（LLM 在对应上下文中看到的使用指导）。
   * strategy.mod 从此字段自动生成引用，不再硬编码函数名。
   * 省略时不生成额外提示（手册本身已包含基本描述）。
   */
  usageHint?: string;
  /**
   * 执行实现。接收上下文和 coerce 后的参数。
   * 返回 boolean（简单成功/失败）或 ActionImplResult（含 msgId / obligationsConsumed）。
   * @see narrative-engine/mods/types.ts InstructionDefinition.impl
   */
  impl(ctx: ActionImplContext, args: Record<string, unknown>): Promise<boolean | ActionImplResult>;

  /**
   * ADR-142: Affordance 声明 — 工具可发现性元数据。
   * @see docs/adr/142-action-space-architecture/README.md
   */
  affordance?: AffordanceDeclaration;
}

/** 写动作——终端批量执行，无 CQRS 结果字段。 */
export interface WriteActionFields {
  returnsResult?: undefined;
  resultSource?: undefined;
  resultAttrKey?: undefined;
  formatResult?: undefined;
  returnDoc?: undefined;
}

/**
 * CQRS 运行时字段 — resultContract 工厂满足的最小契约。
 * store() 和 formatResult() 的运行时行为由此定义。
 */
export interface QueryRuntimeFields {
  /** ADR-105 CQRS: 标记读操作。 */
  returnsResult: true;
  /** CQRS: 结果存储节点——"self"（Alice 自身）或 "target"（当前目标聊天）。 */
  resultSource: "self" | "target";
  /** CQRS: 图属性名——结果存储在此属性中。 */
  resultAttrKey: string;
  /**
   * CQRS: 格式化 observation 文本。使用 Zod safeParse 做运行时类型验证。
   * 返回 null 表示数据为空/无效，不生成 observation。
   */
  formatResult: (data: unknown) => string[] | null;
}

/**
 * 查询动作完整字段 — 运行时 CQRS + 手册元数据。
 * 编译期强制 action 注册时提供 returnDoc。
 */
export interface QueryActionFields extends QueryRuntimeFields {
  /**
   * 返回值语义说明（读操作专用，CQRS formatQueryObservations 消费）。
   * 描述结果存储位置和获取方式，写入 LLM 手册的 @returns 行。
   */
  returnDoc: string;
}

/** 写动作（终端批量执行）。 */
export type TelegramWriteAction = TelegramActionBase & WriteActionFields;

/** 查询动作（CQRS 立即执行 + observation 注入）。 */
export type TelegramQueryAction = TelegramActionBase & QueryActionFields;

/**
 * 单个 Telegram 动作的完整定义（元数据 + 实现）。
 * 判别联合：returnsResult === true 为 QueryAction，否则为 WriteAction。
 */
export type TelegramActionDef = TelegramWriteAction | TelegramQueryAction;

// ═══════════════════════════════════════════════════════════════════════════
// 类型守卫
// ═══════════════════════════════════════════════════════════════════════════

/** 判断动作是否为 CQRS 查询动作。用于替代 `def?.returnsResult` 手动检查。 */
export function isQueryAction(def: TelegramActionDef): def is TelegramQueryAction {
  return def.returnsResult === true;
}
