/**
 * Skill 编译器 — manifest → TelegramActionDef[]。
 *
 * 编译产物必须和手写 defineAction 完全等价：
 * - params → [name, ActionParamDef][] tuple
 * - impl → 根据 backend 生成（shell: 子进程, mcp: 预留）
 * - contract → 自动生成 resultContract（resultAttrKey = `last_{name}_result`）
 * - affordance → 从 manifest 的 whenToUse/whenNotToUse 生成
 *
 * @see docs/adr/200-skill-package-format.md
 * @see src/telegram/action-builder.ts — 手写 defineAction 的等价物
 */

import { z } from "zod";
import { PromptBuilder } from "../core/prompt-style.js";
import type { ToolCategory } from "../engine/tick/types.js";
import { resultContract } from "../telegram/action-contracts.js";
import type {
  ActionCategory,
  ActionImplContext,
  ActionParamDef,
  ActionParamType,
  TelegramActionDef,
} from "../telegram/action-types.js";
import { DEFAULT_DOCKER_IMAGE } from "./backends/docker.js";
import { executeAliceSandboxCommand } from "./container-runner.js";
import type { ManifestAction, ManifestParam, SkillManifest, SkillRuntime } from "./manifest.js";

// ═══════════════════════════════════════════════════════════════════════════
// Param 编译
// ═══════════════════════════════════════════════════════════════════════════

/** manifest param type → Zod schema（与 action-builder 的 wrapCoercion 等价）。 */
function paramToZodSchema(param: ManifestParam): z.ZodTypeAny {
  switch (param.type) {
    case "number":
      return param.required
        ? z.preprocess((v) => (v == null ? 0 : Number(v)), z.number())
        : z.preprocess((v) => (v == null ? undefined : Number(v)), z.number().optional());
    case "array":
      return param.required
        ? z.preprocess((v) => (Array.isArray(v) && v.length > 0 ? v : []), z.array(z.unknown()))
        : z.preprocess(
            (v) => (Array.isArray(v) && v.length > 0 ? v : undefined),
            z.array(z.unknown()).optional(),
          );
    default:
      // string
      return param.required
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

/** manifest params → [name, ActionParamDef][] tuple（与 shapeToParams 等价输出）。 */
function compileParams(params: ManifestParam[]): [string, ActionParamDef][] {
  return params.map((p) => [
    p.name,
    {
      type: p.type as ActionParamType,
      required: p.required,
      description: p.description,
      schema: paramToZodSchema(p),
    },
  ]);
}

// ═══════════════════════════════════════════════════════════════════════════
// 格式化：JSON dump（LLM 可读）
// ═══════════════════════════════════════════════════════════════════════════

/** 默认格式化：直接 dump JSON。 */
function formatResultAsJson(data: unknown): string[] | null {
  if (data == null) return null;
  const m = new PromptBuilder();
  m.line(JSON.stringify(data, null, 2));
  return m.build();
}

// ═══════════════════════════════════════════════════════════════════════════
// impl 生成（根据 backend 类型）
// ═══════════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════
// 网络策略推导（per-Skill 安全策略）
// @see docs/adr/201-os-for-llm.md
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 推导 Skill 的网络策略。
 *
 * 在 Alice OS 模型中，所有标准 capabilities（telegram.*, llm.*, chat.*,
 * graph.*, config.* 等）都通过 Engine API TCP 访问——Skill 容器
 * 本身不需要外网。
 *
 * 默认 network=false。只有 manifest.runtime.network 显式声明 true 时
 * 才启用外网（用于 Skill 自身需要直连外部 API 的场景，如天气查询）。
 */
export function inferNetworkPolicy(manifest: Pick<SkillManifest, "runtime">): boolean {
  return manifest.runtime?.network ?? false;
}

/** 编译 Shell 后端 impl。 */
function compileShellImpl(
  action: ManifestAction,
  runtime: SkillRuntime,
  manifest: SkillManifest,
  attrKey: string,
  skillName?: string,
  enginePort?: number,
): TelegramActionDef["impl"] {
  const shell = runtime.shell ?? action.runtime?.shell;
  if (!shell) {
    throw new Error(`Action ${action.name}: Shell backend requires shell config`);
  }
  const timeout = action.runtime?.timeout ?? runtime.timeout ?? 30;

  const network = inferNetworkPolicy(manifest);
  const memory = action.runtime?.memory ?? runtime.memory ?? "512m";

  return async (ctx: ActionImplContext, args: Record<string, unknown>) => {
    try {
      const stdout = await executeAliceSandboxCommand({
        command: shell.command,
        params: args,
        image: DEFAULT_DOCKER_IMAGE,
        enginePort,
        skillName: skillName ?? "unknown",
        network,
        memory,
        timeout,
        cwd: shell.cwd,
        env: {},
        isolation: runtime.isolation,
      });

      // stdout → JSON 优先解析，失败则存纯文本
      // L2 脚本约定输出 JSON 到 stdout，format 模板可按字段访问
      let data: unknown;
      try {
        data = JSON.parse(stdout);
      } catch {
        data = { stdout };
      }
      if (ctx.G.has("self")) {
        ctx.G.setDynamic("self", attrKey, data);
      }
      ctx.log.info(`${action.name} executed`, {
        stdoutLen: stdout.length,
        jsonParsed: data !== null && typeof data === "object" && !("stdout" in (data as object)),
      });
      return true;
    } catch (e) {
      ctx.log.warn(`${action.name} failed`, {
        error: e instanceof Error ? e.message : String(e),
      });
      return false;
    }
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// 编译器公开 API
// ═══════════════════════════════════════════════════════════════════════════

export interface CompileOptions {
  /** @deprecated 容器模式下不再使用宿主 cwd。保留字段以避免破坏现有调用者。 */
  installDir?: string;
  /** Engine API TCP 端口（注入 ALICE_ENGINE_URL 环境变量）。 */
  enginePort?: number;
}

/**
 * 编译单个 manifest action → TelegramActionDef。
 *
 * 产物与 defineAction() 手写版完全等价。
 */
export function compileAction(
  action: ManifestAction,
  manifest: SkillManifest,
  opts?: CompileOptions,
): TelegramActionDef {
  const runtime = action.runtime ??
    manifest.runtime ?? {
      backend: "shell" as const,
      timeout: 30,
      network: false, // ADR-201: 默认禁用网络，显式声明才启用
      isolation: "container" as const,
      memory: "512m",
    };
  const attrKey = `last_${action.name.replace(/^use_|_app$/g, "")}_result`;

  // params
  const params = compileParams(action.params);

  // affordance（cast category 为 ToolCategory — 运行时 registerToolCategory 保证有效性）
  const affordance = {
    whenToUse: action.whenToUse,
    whenNotToUse: action.whenNotToUse ?? "",
    priority: "capability" as const,
    category: action.category as ToolCategory,
  };

  // impl（根据 backend 类型）
  let impl: TelegramActionDef["impl"];
  switch (runtime.backend) {
    case "shell":
      impl = compileShellImpl(action, runtime, manifest, attrKey, manifest.name, opts?.enginePort);
      break;
    case "mcp":
      throw new Error(`Action ${action.name}: MCP backend is not yet implemented (Phase 1)`);
    default:
      throw new Error(`Action ${action.name}: unknown backend "${runtime.backend}"`);
  }

  // contract（自动生成 CQRS 结果契约）
  const contract = resultContract(z.any(), "self", attrKey, formatResultAsJson);

  return {
    name: action.name,
    category: (action.category ?? "app") as ActionCategory,
    description: action.description,
    usageHint: action.usageHint,
    affordance,
    params,
    impl,
    // CQRS 字段（展开 contract）
    ...contract,
    returnDoc:
      action.returns ?? `Results available in the next round as observation (\`self.${attrKey}\`).`,
  };
}

/**
 * 编译整个 manifest → TelegramActionDef[]。
 *
 * @param manifest 解析后的 SkillManifest
 * @param opts 编译选项
 * @returns 编译后的动作定义数组
 */
export function compileManifest(
  manifest: SkillManifest,
  opts?: CompileOptions,
): TelegramActionDef[] {
  const defs = manifest.actions.map((action) => compileAction(action, manifest, opts));

  // attrKey 碰撞检测
  const attrKeys = new Set<string>();
  for (const def of defs) {
    const key = def.resultAttrKey;
    if (key && attrKeys.has(key)) {
      throw new Error(
        `Manifest "${manifest.name}": duplicate resultAttrKey "${key}" — ` +
          `two actions resolve to the same attribute key. Use distinct action names.`,
      );
    }
    if (key) attrKeys.add(key);
  }

  return defs;
}
