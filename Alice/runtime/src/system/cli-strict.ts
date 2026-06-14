/**
 * CLI строгая валидация аргументов.
 *
 * citty 0.2.x внутри использует `node:util.parseArgs(..., { strict: false })`,
 * необъявленные флаги молча проглатываются. Для Alice — CLI на базе LLM —
 * это маскирует “ошибку в команде” под “успешное выполнение”,
 * поэтому на входном уровне необходим дополнительный строгий слой валидации.
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
 * Найти первый неизвестный флаг.
 *
 * - `--flag=value` трактуется как `--flag`
 * - `-abc` проверяется посимвольно как кластер коротких флагов
 * - `-100...` и подобные числа считаются значениями аргументов, не флагами
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
