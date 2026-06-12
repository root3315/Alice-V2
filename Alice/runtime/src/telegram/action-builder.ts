/**
 * defineAction Builder — Telegram 动作类型安全化。
 *
 * 用 z.object() 定义参数 → impl 得到编译期类型推断，
 * 内部转换为现有 [name, ActionParamDef][] tuple，消费者零改动。
 *
 * @see docs/adr/149-define-action-builder.md
 * @see src/core/mod-builder.ts — createMod builder（同类先例）
 */

import { z } from "zod";
import { extractDescription } from "../core/mod-builder.js";
import type { AffordanceDeclaration } from "../engine/tick/types.js";
import type { ResultContract } from "./action-contracts.js";
import type {
  ActionCategory,
  ActionImplContext,
  ActionImplResult,
  ActionParamDef,
  ActionParamType,
  TelegramActionDef,
} from "./action-types.js";

// ═══════════════════════════════════════════════════════════════════════════
// 配置类型
// ═══════════════════════════════════════════════════════════════════════════

/** inject 映射：参数名 → contextVars 键名（如 `{ chatId: "TARGET_CHAT" }`）。 */
type InjectMap<T extends z.ZodRawShape> = Partial<Record<keyof T & string, string>>;

/** 写动作配置。 */
interface WriteActionConfig<T extends z.ZodRawShape> {
  name: string;
  category: ActionCategory;
  description: string[];
  usageHint?: string;
  affordance?: AffordanceDeclaration;
  params: z.ZodObject<T>;
  inject?: InjectMap<T>;
  impl: (
    ctx: ActionImplContext,
    args: z.output<z.ZodObject<T>>,
  ) => Promise<boolean | ActionImplResult>;
}

/** 查询动作配置（多 contract + returnDoc）。 */
interface QueryActionConfig<T extends z.ZodRawShape, R extends z.ZodTypeAny>
  extends Omit<WriteActionConfig<T>, "impl"> {
  contract: ResultContract<R>;
  returnDoc: string;
  impl: (
    ctx: ActionImplContext,
    args: z.output<z.ZodObject<T>>,
  ) => Promise<boolean | ActionImplResult>;
}

// ═══════════════════════════════════════════════════════════════════════════
// 内部 helpers
// ═══════════════════════════════════════════════════════════════════════════

/** 从 Zod schema 推断 ActionParamType。 */
function inferParamType(schema: z.ZodTypeAny): ActionParamType {
  const typeName = (schema._def as { typeName?: string }).typeName;
  switch (typeName) {
    case "ZodNumber":
      return "number";
    case "ZodArray":
      return "array";
    case "ZodOptional":
      return inferParamType((schema as z.ZodOptional<z.ZodTypeAny>).unwrap());
    case "ZodDefault":
      return inferParamType((schema as z.ZodDefault<z.ZodTypeAny>).removeDefault());
    case "ZodNullable":
      return inferParamType((schema as z.ZodNullable<z.ZodTypeAny>).unwrap());
    case "ZodEffects":
      return inferParamType((schema._def as { schema: z.ZodTypeAny }).schema);
    default:
      return "string";
  }
}

/** 检测 schema 是否已经是 ZodEffects（带 preprocess）。 */
function isZodEffects(schema: z.ZodTypeAny): boolean {
  return (schema._def as { typeName?: string }).typeName === "ZodEffects";
}

/** 检测 schema 是否为 optional。 */
function isOptional(schema: z.ZodTypeAny): boolean {
  const typeName = (schema._def as { typeName?: string }).typeName;
  return typeName === "ZodOptional" || typeName === "ZodDefault";
}

/**
 * 将 clean Zod schema 包装为带 coercion 的 runtime schema。
 *
 * 目的：保持 sandbox buildActionParamSchema 的现有 coercion 行为。
 * 已有 preprocess（如 TelegramReactionSchema）不重复包装。
 */
function wrapCoercion(
  schema: z.ZodTypeAny,
  type: ActionParamType,
  required: boolean,
): z.ZodTypeAny {
  // 已有 preprocess → 不重复包装
  if (isZodEffects(schema)) return schema;

  switch (type) {
    case "number":
      return required
        ? z.preprocess((v) => (v == null ? 0 : Number(v)), z.number())
        : z.preprocess((v) => (v == null ? undefined : Number(v)), z.number().optional());
    case "array":
      return z.preprocess(
        (v) => (Array.isArray(v) && v.length > 0 ? v : undefined),
        z.array(z.unknown()).optional(),
      );
    default:
      return required
        ? z.preprocess(
            (v) => (v == null ? "" : typeof v === "object" ? undefined : String(v)),
            z.string(),
          )
        : z.preprocess(
            (v) => (v == null ? undefined : typeof v === "object" ? undefined : String(v)),
            z.string().optional(),
          );
  }
}

/**
 * z.object shape + inject → [name, ActionParamDef][] params tuple。
 *
 * 输出的 tuple 与手写的 params 完全兼容：
 * - description 从 .describe() 提取
 * - type 从 schema 推断
 * - required 从 optional 推断
 * - schema 带 coercion 包装
 * - inject 从 InjectMap 映射
 */
function shapeToParams<T extends z.ZodRawShape>(
  zodObj: z.ZodObject<T>,
  inject?: InjectMap<T>,
): [string, ActionParamDef][] {
  const shape = zodObj.shape;
  return Object.entries(shape).map(([name, fieldSchema]) => {
    const s = fieldSchema as z.ZodTypeAny;
    const type = inferParamType(s);
    const required = !isOptional(s);
    const description = extractDescription(s);
    const injectKey = inject?.[name as keyof T & string];
    const runtimeSchema = wrapCoercion(s, type, required);

    return [
      name,
      {
        type,
        required,
        description,
        schema: runtimeSchema,
        ...(injectKey != null ? { inject: injectKey } : {}),
      },
    ];
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// 公开 API
// ═══════════════════════════════════════════════════════════════════════════

/** 定义写动作（无 contract）。 */
export function defineAction<T extends z.ZodRawShape>(
  config: WriteActionConfig<T>,
): TelegramActionDef;
/** 定义查询动作（有 contract + returnDoc）。 */
export function defineAction<T extends z.ZodRawShape, R extends z.ZodTypeAny>(
  config: QueryActionConfig<T, R>,
): TelegramActionDef;
/** 统一实现。 */
export function defineAction<T extends z.ZodRawShape, R extends z.ZodTypeAny>(
  config: WriteActionConfig<T> | QueryActionConfig<T, R>,
): TelegramActionDef {
  const params = shapeToParams(config.params, config.inject);

  const base = {
    name: config.name,
    category: config.category,
    description: config.description,
    usageHint: config.usageHint,
    affordance: config.affordance,
    params,
    // impl 签名转换：typed args → Record<string, unknown>
    // runtime 调用时 args 已经被 sandbox coerce 过，类型安全由编译期 defineAction 保证
    impl: config.impl as TelegramActionDef["impl"],
  };

  // 判断 Query vs Write
  if ("contract" in config && config.contract != null) {
    const q = config as QueryActionConfig<T, R>;
    return {
      ...base,
      ...q.contract,
      returnDoc: q.returnDoc,
    };
  }

  return base;
}
