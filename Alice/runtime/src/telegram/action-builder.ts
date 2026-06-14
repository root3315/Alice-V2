/**
 * defineAction Builder — типизация Telegram-действий.
 *
 * Параметры задаются через z.object() → impl получает вывод типов на этапе компиляции,
 * внутри преобразуется в существующий tuple [name, ActionParamDef][], потребители не меняются.
 *
 * @see docs/adr/149-define-action-builder.md
 * @see src/core/mod-builder.ts — createMod builder (аналогичный прецедент)
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
// Типы конфигурации
// ═══════════════════════════════════════════════════════════════════════════

/** Карта inject: имя параметра → ключ в contextVars (например, `{ chatId: "TARGET_CHAT" }`). */
type InjectMap<T extends z.ZodRawShape> = Partial<Record<keyof T & string, string>>;

/** Конфигурация write-действия. */
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

/** Конфигурация query-действия (с contract + returnDoc). */
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
// Внутренние хелперы
// ═══════════════════════════════════════════════════════════════════════════

/** Определяет ActionParamType из Zod-схемы. */
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

/** Проверяет, является ли схема ZodEffects (с preprocess). */
function isZodEffects(schema: z.ZodTypeAny): boolean {
  return (schema._def as { typeName?: string }).typeName === "ZodEffects";
}

/** Проверяет, является ли схема optional. */
function isOptional(schema: z.ZodTypeAny): boolean {
  const typeName = (schema._def as { typeName?: string }).typeName;
  return typeName === "ZodOptional" || typeName === "ZodDefault";
}

/**
 * Оборачивает чистую Zod-схему в runtime-схему с coercion.
 *
 * Цель: сохранить существующее поведение coercion в sandbox buildActionParamSchema.
 * Схемы с уже имеющимся preprocess (например, TelegramReactionSchema) не оборачиваются повторно.
 */
function wrapCoercion(
  schema: z.ZodTypeAny,
  type: ActionParamType,
  required: boolean,
): z.ZodTypeAny {
  // Уже есть preprocess → не оборачиваем повторно
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
 * z.object shape + inject → tuple [name, ActionParamDef][].
 *
 * Получаемый tuple полностью совместим с params, написанными вручную:
 * - description извлекается из .describe()
 * - type выводится из схемы
 * - required выводится из optional
 * - schema оборачивается с coercion
 * - inject маппится из InjectMap
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
// Публичное API
// ═══════════════════════════════════════════════════════════════════════════

/** Определяет write-действие (без contract). */
export function defineAction<T extends z.ZodRawShape>(
  config: WriteActionConfig<T>,
): TelegramActionDef;
/** Определяет query-действие (с contract + returnDoc). */
export function defineAction<T extends z.ZodRawShape, R extends z.ZodTypeAny>(
  config: QueryActionConfig<T, R>,
): TelegramActionDef;
/** Единая реализация. */
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
    // Преобразование сигнатуры impl: typed args → Record<string, unknown>
    // При runtime-вызове args уже прошли coerce в sandbox; типобезопасность гарантирована defineAction на этапе компиляции
    impl: config.impl as TelegramActionDef["impl"],
  };

  // Определяем Query vs Write
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
