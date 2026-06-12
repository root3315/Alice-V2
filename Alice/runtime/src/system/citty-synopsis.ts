interface SynopsisArgDef {
  type?: string;
  required?: boolean;
  hidden?: boolean;
  valueHint?: string;
}

interface SynopsisCommand {
  meta?: unknown;
  args?: unknown;
}

function getCommandMeta(command: SynopsisCommand): { name?: string; hidden?: boolean } | null {
  const { meta } = command;
  if (!meta || typeof meta !== "object") return null;
  return meta as { name?: string; hidden?: boolean };
}

function getCommandArgs(command: SynopsisCommand): Record<string, SynopsisArgDef> {
  const { args } = command;
  if (!args || typeof args !== "object") return {};
  return args as Record<string, SynopsisArgDef>;
}

function renderValue(name: string, def: SynopsisArgDef): string {
  return `<${def.valueHint ?? name}>`;
}

function renderArg(name: string, def: SynopsisArgDef): string | null {
  if (def.hidden) return null;

  if (def.type === "positional") {
    const value = renderValue(name, def);
    return def.required ? value : `[${value}]`;
  }

  const flag = `--${name}`;
  if (def.type === "boolean") {
    return def.required ? flag : `[${flag}]`;
  }

  const value = `${flag} ${renderValue(name, def)}`;
  return def.required ? value : `[${value}]`;
}

export function renderSubCommandSynopsis(
  binaryName: string,
  subCommands: Record<string, SynopsisCommand>,
  options?: {
    omitArgs?: ReadonlySet<string>;
  },
): string[] {
  const lines: string[] = [];

  for (const command of Object.values(subCommands)) {
    const meta = getCommandMeta(command);
    if (meta?.hidden) continue;
    const commandName = meta?.name;
    if (!commandName) continue;

    const parts = [binaryName, commandName];
    for (const [argName, argDef] of Object.entries(getCommandArgs(command))) {
      if (options?.omitArgs?.has(argName)) continue;
      const rendered = renderArg(argName, argDef);
      if (rendered) parts.push(rendered);
    }

    lines.push(parts.join(" "));
  }

  return lines;
}
