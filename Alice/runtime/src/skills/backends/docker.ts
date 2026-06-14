/**
 * Бэкенд изолированного выполнения в Docker-контейнере.
 *
 * Контейнер общается с Engine API хоста по TCP (host.docker.internal).
 * Основной путь — постоянный session-контейнер + `docker exec`, чтобы избежать холодного старта при каждом вызове shell.
 * Одноразовый `docker run --rm` сохранён для отладки и резервного построения команд.
 *
 * @see docs/adr/201-os-for-llm.md
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { interpolateShell } from "./shell.js";

export const DEFAULT_DOCKER_IMAGE = "alice-skill-runner:bookworm";
const CONTAINER_SHELL = "/bin/sh";
const SESSION_ENTRYPOINT = "sleep";
const SESSION_ENTRYPOINT_ARGS = ["infinity"];
const DEFAULT_SANDBOX_RUNTIME = process.env.ALICE_SANDBOX_RUNTIME ?? "runsc";
const DEFAULT_PROFILE = process.env.ALICE_CONTAINER_DEFAULT_PROFILE ?? "sandboxed";
const TMPFS_MOUNTS = [
  "/tmp:rw,noexec,nosuid,nodev,size=64m",
  "/run:rw,noexec,nosuid,nodev,size=16m",
];
const SESSION_LABEL = "alice.sandbox.managed=true";
const SESSION_SIGNATURE_LABEL = "alice.sandbox.signature";
const SESSION_PREFIX = "alice-sbx";
const DEFAULT_MAX_BUFFER = 1024 * 1024;
const ALLOW_RUNC_FALLBACK = process.env.ALICE_SANDBOX_ALLOW_RUNC_FALLBACK !== "false";

export const DockerIsolationSchema = [
  "container",
  "container_compat",
  "container_hardened",
  "sandboxed",
] as const;

export type DockerIsolationMode = (typeof DockerIsolationSchema)[number];

interface ResolvedDockerIsolationProfile {
  name: Exclude<DockerIsolationMode, "container">;
  runtime?: string;
  readOnlyRootfs: boolean;
  tmpfs: readonly string[];
}

function normalizeDefaultProfile(): Exclude<DockerIsolationMode, "container"> {
  switch (DEFAULT_PROFILE) {
    case "container_compat":
    case "container_hardened":
    case "sandboxed":
      return DEFAULT_PROFILE;
    default:
      return "sandboxed";
  }
}

export function resolveDockerIsolationProfile(
  mode: DockerIsolationMode = "container",
): ResolvedDockerIsolationProfile {
  const effective = mode === "container" ? normalizeDefaultProfile() : mode;

  switch (effective) {
    case "container_compat":
      return {
        name: effective,
        readOnlyRootfs: false,
        tmpfs: [],
      };
    case "container_hardened":
      return {
        name: effective,
        readOnlyRootfs: true,
        tmpfs: TMPFS_MOUNTS,
      };
    case "sandboxed":
      return {
        name: effective,
        runtime: DEFAULT_SANDBOX_RUNTIME,
        readOnlyRootfs: true,
        tmpfs: TMPFS_MOUNTS,
      };
  }
}

export interface DockerExecOptions {
  /** Шаблон команды для выполнения внутри контейнера (поддерживает подстановку переменных {{param}}). */
  command: string;
  /** Дополнительные позиционные аргументы, передаваемые в `sh -c`. */
  args?: string[];
  /** Параметры шаблона. */
  params: Record<string, unknown>;
  /** Имя Docker-образа. */
  image: string;
  /** TCP-порт Engine API. Доступен внутри контейнера по адресу host.docker.internal:port. */
  enginePort?: number;
  /** Переменная окружения ALICE_SKILL. */
  skillName: string;
  /** Разрешён ли контейнеру сетевой доступ. */
  network: boolean;
  /** Ограничение памяти контейнера (например, "512m"). */
  memory: string;
  /** Таймаут (в секундах). */
  timeout: number;
  /** Рабочая директория внутри контейнера. */
  cwd?: string;
  /** Дополнительные переменные окружения. */
  env?: Record<string, string>;
  /** Дополнительные монтирования. По умолчанию монтируются только для чтения (source:target). */
  extraMounts?: Array<{ source: string; target?: string; readOnly?: boolean }>;
  /** Уровень изоляции контейнера. `container` — исторический псевдоним, разрешается в profile по умолчанию. */
  isolation?: DockerIsolationMode;
}

export interface DockerProcessResult {
  stdout: string;
  stderr: string;
  code: number;
}

interface DockerSessionSpec {
  signature: string;
  name: string;
}

interface DockerInspectState {
  running: boolean;
  signature?: string;
}

const sessionLocks = new Map<string, Promise<DockerSessionSpec>>();

/**
 * Формирует массив аргументов для docker run (без самого "docker").
 *
 * Экспортируется для тестовой проверки корректности построения команды.
 */
export function buildDockerArgs(opts: DockerExecOptions): string[] {
  const cmd = interpolateShell(opts.command, opts.params);
  const args: string[] = [
    "run",
    "--rm",
    ...buildDockerContainerFlags(opts),
    ...buildDockerExecConfig(opts),
  ];
  if (opts.cwd) {
    args.push("-w", opts.cwd);
  }
  args.push(opts.image, CONTAINER_SHELL, "-c", cmd);
  if (opts.args?.length) {
    args.push("alice-docker-cmd", ...opts.args);
  }

  return args;
}

export function buildDockerCreateArgs(
  opts: DockerExecOptions,
  sessionName: string,
  signature: string,
): string[] {
  return [
    "create",
    "--name",
    sessionName,
    "--label",
    SESSION_LABEL,
    "--label",
    `${SESSION_SIGNATURE_LABEL}=${signature}`,
    ...buildDockerContainerFlags(opts),
    opts.image,
    SESSION_ENTRYPOINT,
    ...SESSION_ENTRYPOINT_ARGS,
  ];
}

export function buildDockerExecArgs(opts: DockerExecOptions, sessionName: string): string[] {
  const cmd = interpolateShell(opts.command, opts.params);
  const args = ["exec", ...buildDockerExecConfig(opts)];

  // Рабочая директория
  if (opts.cwd) {
    args.push("-w", opts.cwd);
  }

  args.push(sessionName, CONTAINER_SHELL, "-c", cmd);
  if (opts.args?.length) {
    args.push("alice-docker-cmd", ...opts.args);
  }

  return args;
}

function buildDockerContainerFlags(opts: DockerExecOptions): string[] {
  const profile = resolveDockerIsolationProfile(opts.isolation);
  const args: string[] = [
    ...(profile.runtime ? [`--runtime=${profile.runtime}`] : []),
    `--network=${opts.network ? "bridge" : "none"}`,
    `--memory=${opts.memory}`,
    "--cpus=1",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges=true",
    "--pids-limit=128",
    ...(profile.readOnlyRootfs ? ["--read-only"] : []),
  ];

  for (const mount of profile.tmpfs) {
    args.push("--tmpfs", mount);
  }

  if (opts.enginePort) {
    args.push("--add-host=host.docker.internal:host-gateway");
  }

  if (opts.extraMounts) {
    const seenTargets = new Set<string>();
    for (const mount of opts.extraMounts) {
      const target = mount.target ?? mount.source;
      // На Windows монтирование без явного target даёт target=Windows-путь (C:\...),
      // что невалидно как путь внутри Linux-контейнера и ломает docker -v ("too many
      // colons"). Такое монтирование не может работать → пропускаем.
      if (/^[A-Za-z]:[\\/]/.test(target)) continue;
      // Дедуп по target: один и тот же контейнерный путь нельзя смонтировать дважды
      // (Docker: "Duplicate mount point").
      if (seenTargets.has(target)) continue;
      seenTargets.add(target);
      const suffix = mount.readOnly === false ? "" : ":ro";
      args.push("-v", `${mount.source}:${target}${suffix}`);
    }
  }

  return args;
}

function buildDockerExecConfig(opts: DockerExecOptions): string[] {
  const args: string[] = ["-e", `ALICE_SKILL=${opts.skillName}`];

  if (opts.enginePort) {
    args.push("-e", `ALICE_ENGINE_URL=http://host.docker.internal:${opts.enginePort}`);
  }

  if (opts.env) {
    for (const [key, value] of Object.entries(opts.env)) {
      // ALICE_ENGINE_URL / ALICE_SKILL управляются этой функцией централизованно —
      // пропускаем одноимённые ключи из env вызывающей стороны, чтобы пути хоста не перекрыли пути контейнера
      if (key === "ALICE_ENGINE_URL" || key === "ALICE_SKILL") continue;
      args.push("-e", `${key}=${value}`);
    }
  }

  return args;
}

function getDockerSessionSpec(opts: DockerExecOptions): DockerSessionSpec {
  // enginePort не входит в signature: он динамически инжектируется при docker exec (-e ALICE_ENGINE_URL)
  // и не влияет на идентичность контейнера. Если включить, каждый перезапуск (port 0 — случайный)
  // порождал бы новый контейнер, а старые никогда бы не убирались.
  const signaturePayload = JSON.stringify({
    image: opts.image,
    network: opts.network,
    memory: opts.memory,
    isolation: opts.isolation ?? "container",
    mounts: (opts.extraMounts ?? [])
      .map((mount) => ({
        source: mount.source,
        target: mount.target ?? mount.source,
        readOnly: mount.readOnly !== false,
      }))
      .sort((a, b) =>
        `${a.source}:${a.target}:${a.readOnly}`.localeCompare(
          `${b.source}:${b.target}:${b.readOnly}`,
        ),
      ),
  });
  const signature = createHash("sha256").update(signaturePayload).digest("hex");
  return {
    signature,
    name: `${SESSION_PREFIX}-${signature.slice(0, 12)}`,
  };
}

export function getDockerSessionName(opts: DockerExecOptions): string {
  return getDockerSessionSpec(opts).name;
}

function execDocker(
  args: string[],
  options?: { timeoutMs?: number; maxBuffer?: number; rejectOnError?: boolean },
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    execFile(
      "docker",
      args,
      {
        timeout: options?.timeoutMs,
        maxBuffer: options?.maxBuffer ?? DEFAULT_MAX_BUFFER,
      },
      (error, stdout, stderr) => {
        if (error && options?.rejectOnError) {
          reject(new Error(`Docker command failed: ${error.message}\nstderr: ${stderr}`));
          return;
        }
        resolve({
          stdout,
          stderr,
          code: typeof error?.code === "number" ? error.code : error ? 1 : 0,
        });
      },
    );
  });
}

async function inspectDockerSession(name: string): Promise<DockerInspectState | null> {
  const inspected = await execDocker(
    [
      "inspect",
      "--type",
      "container",
      name,
      "--format",
      '{{json .State}}\n{{ index .Config.Labels "alice.sandbox.signature" }}',
    ],
    { rejectOnError: false },
  );
  if (inspected.code !== 0) return null;

  const [stateLine, signature] = inspected.stdout.trimEnd().split("\n");
  if (!stateLine) return null;
  const state = JSON.parse(stateLine) as { Running?: boolean; Status?: string };
  return {
    running: state.Running === true || state.Status === "running",
    signature: signature?.trim() || undefined,
  };
}

export async function ensureDockerSession(opts: DockerExecOptions): Promise<DockerSessionSpec> {
  const spec = getDockerSessionSpec(opts);
  const inFlight = sessionLocks.get(spec.name);
  if (inFlight) return inFlight;

  const pending = (async () => {
    const current = await inspectDockerSession(spec.name);
    if (current?.signature && current.signature !== spec.signature) {
      await execDocker(["rm", "-f", spec.name], { rejectOnError: false });
    }

    const fresh = await inspectDockerSession(spec.name);
    if (!fresh) {
      await execDocker(buildDockerCreateArgs(opts, spec.name, spec.signature), {
        timeoutMs: opts.timeout * 1000,
        rejectOnError: true,
      });
      await execDocker(["start", spec.name], {
        timeoutMs: opts.timeout * 1000,
        rejectOnError: true,
      });
      return spec;
    }

    if (!fresh.running) {
      await execDocker(["start", spec.name], {
        timeoutMs: opts.timeout * 1000,
        rejectOnError: true,
      });
    }
    return spec;
  })();

  sessionLocks.set(spec.name, pending);
  try {
    return await pending;
  } finally {
    sessionLocks.delete(spec.name);
  }
}

async function recreateDockerSession(opts: DockerExecOptions): Promise<DockerSessionSpec> {
  const spec = getDockerSessionSpec(opts);
  await execDocker(["rm", "-f", spec.name], { rejectOnError: false });
  return ensureDockerSession(opts);
}

function shouldFallbackToHardened(error: unknown, opts: DockerExecOptions): boolean {
  if (!ALLOW_RUNC_FALLBACK) return false;
  const profile = resolveDockerIsolationProfile(opts.isolation);
  if (profile.name !== "sandboxed") return false;
  const message = error instanceof Error ? error.message : String(error);
  return /runsc|unknown runtime|invalid runtime|no such runtime|failed to find runtime/i.test(
    message,
  );
}

/**
 * Выполняет команду в Docker-контейнере.
 *
 * @returns текст stdout
 */
export function executeDockerCommand(opts: DockerExecOptions): Promise<string> {
  return executeDockerProcess(opts).then((result) => {
    if (result.code !== 0) {
      throw new Error(`Docker command failed with exit ${result.code}\nstderr: ${result.stderr}`);
    }
    return result.stdout.trim();
  });
}

export async function executeDockerProcess(opts: DockerExecOptions): Promise<DockerProcessResult> {
  const runExec = async (): Promise<DockerProcessResult> => {
    const session = await ensureDockerSession(opts);
    const result = await execDocker(buildDockerExecArgs(opts, session.name), {
      timeoutMs: opts.timeout * 1000,
      rejectOnError: false,
    });
    return {
      stdout: result.stdout,
      stderr: result.stderr,
      code: result.code,
    };
  };

  let first: DockerProcessResult;
  try {
    first = await runExec();
  } catch (error) {
    if (!shouldFallbackToHardened(error, opts)) throw error;
    return executeDockerProcess({
      ...opts,
      isolation: "container_hardened",
    });
  }
  if (first.code === 0) return first;

  const staleSession =
    /No such container|is not running|cannot exec/i.test(first.stderr) ||
    /No such container|is not running|cannot exec/i.test(first.stdout);
  if (!staleSession) return first;

  await recreateDockerSession(opts);
  return runExec();
}
