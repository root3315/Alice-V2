/**
 * CLI 严格参数校验。
 *
 * citty 0.2.x 内部使用 `node:util.parseArgs(..., { strict: false })`，
 * 未声明的 flag 会被静默吞掉。对 Alice 这种 LLM 驱动 CLI，
 * 这会把“命令写错”伪装成“命令成功”，必须在入口层补一层严格校验。
 */

export interface StrictArgDef {
  alias?: string | readonly string[] | undefined;
}

interface KnownOptions {
  long: Set<string>;
  short: Set<string>;
}

function toAliasList(alias: StrictArgDef["alias"]): string[] {
  if (alias == null) return [];
  return typeof alias === "string" ? [alias] : Array.from(alias);
}

function toCamelCase(name: string): string {
  return name.replace(/-([a-z])/g, (_, ch: string) => ch.toUpperCase());
}

function toKebabCase(name: string): string {
  return name.replace(/[A-Z]/g, (ch) => `-${ch.toLowerCase()}`);
}

function registerOptionVariant(name: string, known: KnownOptions): void {
  if (!name) return;
  if (name.length === 1) {
    known.short.add(`-${name}`);
    return;
  }

  known.long.add(`--${name}`);
  known.long.add(`--${toCamelCase(name)}`);
  known.long.add(`--${toKebabCase(name)}`);
}

function collectKnownOptions(argsDef: Record<string, StrictArgDef>): KnownOptions {
  const known: KnownOptions = {
    long: new Set<string>(["--help"]),
    short: new Set<string>(["-h"]),
  };

  for (const [name, def] of Object.entries(argsDef)) {
    registerOptionVariant(name, known);
    for (const alias of toAliasList(def.alias)) {
      registerOptionVariant(alias, known);
    }
  }

  return known;
}

/**
 * 找出首个未知 flag。
 *
 * - `--flag=value` 视为 `--flag`
 * - `-abc` 按短 flag cluster 逐个检查
 * - `-100...` 这类负数视为参数值，不当作 flag
 */
export function findUnknownOption(
  rawArgs: readonly string[],
  argsDef: Record<string, StrictArgDef>,
): string | null {
  const known = collectKnownOptions(argsDef);

  for (const token of rawArgs) {
    if (token === "--") break;
    if (token === "-" || !token.startsWith("-")) continue;
    if (/^-\d/.test(token)) continue;

    if (token.startsWith("--")) {
      const option = token.split("=", 1)[0];
      if (!known.long.has(option)) {
        return option;
      }
      continue;
    }

    const shortFlags = token.slice(1);
    for (const ch of shortFlags) {
      const option = `-${ch}`;
      if (!known.short.has(option)) {
        return option;
      }
    }
  }

  return null;
}
