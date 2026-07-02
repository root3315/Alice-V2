/**
 * Компилятор скиллов — manifest → TelegramActionDef[].
 *
 * Результат компиляции должен быть полностью эквивалентен ручному defineAction:
 * - params → [name, ActionParamDef][] tuple
 * - impl → генерируется по типу backend (shell: дочерний процесс, mcp: зарезервировано)
 * - contract → автогенерация resultContract (resultAttrKey = `last_{name}_result`)
 * - affordance → генерируется из whenToUse/whenNotToUse манифеста
 *
 * @see docs/adr/200-skill-package-format.md
 * @see src/telegram/action-builder.ts — ручной эквивалент defineAction
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
// Компиляция параметров
// ═══════════════════════════════════════════════════════════════════════════

/** manifest param type → Zod schema (эквивалент wrapCoercion из action-builder). */
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

/** manifest params → [name, ActionParamDef][] tuple (эквивалент вывода shapeToParams). */
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
// Форматирование: JSON dump (читаемо для LLM)
// ═══════════════════════════════════════════════════════════════════════════

/** Форматирование по умолчанию: прямой dump JSON. */
function formatResultAsJson(data: unknown): string[] | null {
  if (data == null) return null;
  const m = new PromptBuilder();
  // Компактный JSON одной строкой: PromptBuilder.line() схлопывает \n (H15), а потребители/тесты
  // ждут результат как ОДНУ строку (result[0]). Компактный — и читаемо, и контракт не ломается.
  m.line(JSON.stringify(data));
  return m.build();
}

// ═══════════════════════════════════════════════════════════════════════════
// Генерация impl (по типу backend)
// ═══════════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════
// Определение сетевой политики (политика безопасности per-Skill)
// @see docs/adr/201-os-for-llm.md
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Определяет сетевую политику скилла.
 *
 * В модели Alice OS все стандартные capabilities (telegram.*, llm.*, chat.*,
 * graph.*, config.* и т.д.) доступны через Engine API TCP — контейнеру Skill
 * внешняя сеть не нужна.
 *
 * По умолчанию network=false. Внешняя сеть включается только при явном
 * manifest.runtime.network = true (для скиллов, которым нужен прямой доступ
 * к внешним API, например запрос погоды).
 */
export function inferNetworkPolicy(manifest: Pick<SkillManifest, "runtime">): boolean {
  // Host-сеть (Linux-сервер за INPUT DROP): при ALICE_SANDBOX_HOST_NET=1 скилл общается
  // с Engine API по 127.0.0.1 (общий netns), а `--network=none` вообще отрезает сеть —
  // тогда даже Engine API TCP недоступен (skill "irc" виснет Engine API timeout).
  // Поэтому в host-net режиме принудительно даём скиллу сеть (она станет host в docker.ts).
  if (process.env.ALICE_SANDBOX_HOST_NET === "1") return true;
  return manifest.runtime?.network ?? false;
}

/** Компилирует impl для Shell-бэкенда. */
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

      // stdout → приоритет парсинга JSON, при неудаче сохраняем как plain text
      // Скрипты L2 по соглашению выводят JSON в stdout, шаблоны format могут обращаться к полям
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
// Публичный API компилятора
// ═══════════════════════════════════════════════════════════════════════════

export interface CompileOptions {
  /** @deprecated В контейнерном режиме хостовый cwd больше не используется. Поле сохранено для обратной совместимости. */
  installDir?: string;
  /** Порт Engine API TCP (инжектируется в переменную окружения ALICE_ENGINE_URL). */
  enginePort?: number;
}

/**
 * Компилирует один action манифеста → TelegramActionDef.
 *
 * Результат полностью эквивалентен ручной версии defineAction().
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
      network: false, // ADR-201: сеть отключена по умолчанию, включается явным объявлением
      isolation: "container" as const,
      memory: "512m",
    };
  const attrKey = `last_${action.name.replace(/^use_|_app$/g, "")}_result`;

  // params
  const params = compileParams(action.params);

  // affordance (cast category в ToolCategory — корректность гарантирует registerToolCategory в рантайме)
  const affordance = {
    whenToUse: action.whenToUse,
    whenNotToUse: action.whenNotToUse ?? "",
    priority: "capability" as const,
    category: action.category as ToolCategory,
  };

  // impl (по типу backend)
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

  // contract (автогенерация CQRS-контракта результата)
  const contract = resultContract(z.any(), "self", attrKey, formatResultAsJson);

  return {
    name: action.name,
    category: (action.category ?? "app") as ActionCategory,
    description: action.description,
    usageHint: action.usageHint,
    affordance,
    params,
    impl,
    // CQRS-поля (разворачиваем contract)
    ...contract,
    returnDoc:
      action.returns ?? `Results available in the next round as observation (\`self.${attrKey}\`).`,
  };
}

/**
 * Компилирует весь манифест → TelegramActionDef[].
 *
 * @param manifest разобранный SkillManifest
 * @param opts опции компиляции
 * @returns массив скомпилированных определений действий
 */
export function compileManifest(
  manifest: SkillManifest,
  opts?: CompileOptions,
): TelegramActionDef[] {
  const defs = manifest.actions.map((action) => compileAction(action, manifest, opts));

  // Проверка коллизий attrKey
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
