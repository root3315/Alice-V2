/**
 * createMod Builder — плоский API для определения Mod.
 *
 * Заменяет вложенное дерево объектов `defineMod<S>()` на scoped builder `createMod<S>()`,
 * обеспечивая вывод типов Zod + плоское цепочечное объявление.
 *
 * Использование:
 * ```typescript
 * export const diaryMod = createMod<DiaryState>("diary", {
 *   category: "mechanic",
 *   description: "...",
 *   topics: ["diary"],
 *   initialState: { turnWriteCount: 0 },
 * })
 *   .instruction("diary", {
 *     params: z.object({
 *       content: z.string().trim().min(1).max(200).describe("日记内容"),
 *     }),
 *     description: "写一条私人日记",
 *     impl(ctx, args) {
 *       // args.content: string ← выводится автоматически
 *     },
 *   })
 *   .contribute((ctx) => [...])
 *   .build();
 * ```
 *
 * @see docs/adr/ACTIVE.md — createMod Builder ADR
 */
import type { z } from "zod";
import type { AffordanceDeclaration } from "../engine/tick/types.js";
import type {
  ContributionItem,
  InstructionDefinition,
  ListenHandler,
  ModContext,
  ModDefinition,
  ModMeta,
  ParamDefinition,
  QueryDefinition,
} from "./types.js";

// ── Zod → преобразование в ParamDefinition ──────────────────────────────────────────────

/**
 * Извлекает описание .describe() из Zod schema.
 * Поддерживает unwrap: describe в z.string().describe("x").optional() находится во внутреннем слое.
 */
export function extractDescription(schema: z.ZodTypeAny): string {
  if (schema.description) return schema.description;
  const typeName = (schema._def as { typeName?: string }).typeName;
  if (typeName === "ZodOptional")
    return extractDescription((schema as z.ZodOptional<z.ZodTypeAny>).unwrap());
  if (typeName === "ZodDefault")
    return extractDescription((schema as z.ZodDefault<z.ZodTypeAny>).removeDefault());
  if (typeName === "ZodNullable")
    return extractDescription((schema as z.ZodNullable<z.ZodTypeAny>).unwrap());
  if (typeName === "ZodEffects")
    return extractDescription((schema._def as { schema: z.ZodTypeAny }).schema);
  return "";
}

/** z.object shape → Record<string, ParamDefinition>. */
export function zodToParamDefs(shape: z.ZodRawShape): Record<string, ParamDefinition> {
  const result: Record<string, ParamDefinition> = {};
  for (const [key, schema] of Object.entries(shape)) {
    result[key] = { description: extractDescription(schema), schema };
  }
  return result;
}

// ── Типы конфигурации Builder ─────────────────────────────────────────────────────────

interface CreateModConfig<S> {
  category: ModMeta["category"];
  description?: string;
  depends?: string[];
  topics?: string[];
  initialState: S;
}

interface InstructionConfig<S, T extends z.ZodRawShape> {
  params: z.ZodObject<T>;
  description: string;
  examples?: string[];
  deriveParams?: Record<
    string,
    (contextVars: Record<string, unknown>, args?: Record<string, unknown>) => unknown
  >;
  perTurnCap?: number | { limit: number; group: string };
  affordance?: AffordanceDeclaration;
  impl: (ctx: ModContext<S>, args: z.output<z.ZodObject<T>>) => unknown;
}

interface QueryConfig<S, T extends z.ZodRawShape> {
  params: z.ZodObject<T>;
  description: string;
  returns?: string;
  /** Краткое описание возвращаемого значения для LLM. Рендерится как JSDoc @returns. */
  returnHint?: string;
  deriveParams?: Record<
    string,
    (contextVars: Record<string, unknown>, args?: Record<string, unknown>) => unknown
  >;
  affordance?: AffordanceDeclaration;
  format?: (result: unknown) => string[];
  impl: (ctx: ModContext<S>, args: z.output<z.ZodObject<T>>) => unknown;
}

// ── Класс Builder ───────────────────────────────────────────────────────────────

class ModBuilder<S> {
  private readonly _meta: ModMeta;
  private readonly _initialState: S;
  private readonly _instructions: Record<string, InstructionDefinition> = {};
  private readonly _queries: Record<string, QueryDefinition> = {};
  private readonly _listen: Record<string, ListenHandler> = {};
  private _contribute?: (ctx: ModContext<S>) => ContributionItem[];
  private _onTickStart?: (ctx: ModContext<S>) => void;
  private _onTickEnd?: (ctx: ModContext<S>) => void;
  private _onEvent?: (
    ctx: ModContext<S>,
    event: { kind: string; entityIds: string[]; summary: string; salience: number },
  ) => void;

  constructor(name: string, config: CreateModConfig<S>) {
    this._meta = {
      name,
      category: config.category,
      description: config.description,
      depends: config.depends,
      topics: config.topics,
    };
    this._initialState = config.initialState;
  }

  instruction<T extends z.ZodRawShape>(name: string, config: InstructionConfig<S, T>): this {
    this._instructions[name] = {
      params: zodToParamDefs(config.params.shape),
      description: config.description,
      examples: config.examples,
      deriveParams: config.deriveParams,
      perTurnCap: config.perTurnCap,
      affordance: config.affordance,
      impl: config.impl as InstructionDefinition["impl"],
    };
    return this;
  }

  query<T extends z.ZodRawShape>(name: string, config: QueryConfig<S, T>): this {
    this._queries[name] = {
      params: zodToParamDefs(config.params.shape),
      description: config.description,
      returns: config.returns,
      returnHint: config.returnHint,
      deriveParams: config.deriveParams,
      affordance: config.affordance,
      format: config.format,
      impl: config.impl as QueryDefinition["impl"],
    };
    return this;
  }

  listen(
    instruction: string,
    handler: (ctx: ModContext<S>, args: Record<string, unknown>, result: unknown) => void,
  ): this {
    this._listen[instruction] = handler as ListenHandler;
    return this;
  }

  contribute(fn: (ctx: ModContext<S>) => ContributionItem[]): this {
    this._contribute = fn;
    return this;
  }

  onTickStart(fn: (ctx: ModContext<S>) => void): this {
    this._onTickStart = fn;
    return this;
  }

  onTickEnd(fn: (ctx: ModContext<S>) => void): this {
    this._onTickEnd = fn;
    return this;
  }

  /** Хук событий потока сознания (точка входа метапознания C2). Зарезервировано для Wave 4, пока не подключено. */
  onEvent(
    handler: (
      ctx: ModContext<S>,
      event: { kind: string; entityIds: string[]; summary: string; salience: number },
    ) => void,
  ): this {
    this._onEvent = handler;
    return this;
  }

  build(): ModDefinition {
    return {
      meta: this._meta,
      initialState: this._initialState,
      instructions: Object.keys(this._instructions).length > 0 ? this._instructions : undefined,
      queries: Object.keys(this._queries).length > 0 ? this._queries : undefined,
      listen: Object.keys(this._listen).length > 0 ? this._listen : undefined,
      onTickStart: this._onTickStart as ModDefinition["onTickStart"],
      onTickEnd: this._onTickEnd as ModDefinition["onTickEnd"],
      onEvent: this._onEvent as ModDefinition["onEvent"],
      contribute: this._contribute as ModDefinition["contribute"],
    } as ModDefinition;
  }
}

// ── Публичный API ─────────────────────────────────────────────────────────────────

export function createMod<S>(name: string, config: CreateModConfig<S>): ModBuilder<S> {
  return new ModBuilder(name, config);
}
