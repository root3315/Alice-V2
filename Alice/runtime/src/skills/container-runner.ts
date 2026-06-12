import { resolve } from "node:path";
import {
  DEFAULT_DOCKER_IMAGE,
  type DockerExecOptions,
  type DockerIsolationMode,
  type DockerProcessResult,
  ensureDockerSession,
  executeDockerCommand,
  executeDockerProcess,
} from "./backends/docker.js";
import { buildInstalledSkillContainerEnv, getAliceBinDir, getAliceStoreRoot } from "./registry.js";

export const ALICE_CONTAINER_PATHS = {
  bin: "/opt/alice/bin",
  store: "/opt/alice/store",
  home: "/home/alice",
} as const;

/** Alice 持久家目录（宿主侧路径）。容器内挂载为 /home/alice。 */
export const ALICE_HOME = process.env.ALICE_HOME
  ? resolve(process.env.ALICE_HOME)
  : resolve(import.meta.dirname ?? ".", "../../home");

type Mount = { source: string; target?: string; readOnly?: boolean };

export interface AliceSandboxExecOptions {
  command: string;
  params?: Record<string, unknown>;
  args?: string[];
  image?: string;
  skillName: string;
  enginePort?: number;
  network: boolean;
  memory: string;
  timeout: number;
  cwd?: string;
  env?: Record<string, string>;
  isolation?: DockerIsolationMode;
  extraMounts?: Mount[];
  includeAliceHome?: boolean;
}

function buildBaseMounts(includeAliceHome: boolean): Mount[] {
  const mounts: Mount[] = [
    { source: getAliceBinDir(), target: ALICE_CONTAINER_PATHS.bin, readOnly: true },
    { source: getAliceStoreRoot(), target: ALICE_CONTAINER_PATHS.store, readOnly: true },
  ];

  if (includeAliceHome) {
    mounts.push({
      source: ALICE_HOME,
      target: ALICE_CONTAINER_PATHS.home,
      readOnly: false,
    });
  }
  return mounts;
}

function buildRunnerOptions(opts: AliceSandboxExecOptions): DockerExecOptions {
  return {
    command: opts.command,
    params: opts.params ?? {},
    args: opts.args,
    image: opts.image ?? DEFAULT_DOCKER_IMAGE,
    enginePort: opts.enginePort,
    skillName: opts.skillName,
    network: opts.network,
    memory: opts.memory,
    timeout: opts.timeout,
    cwd: opts.cwd,
    isolation: opts.isolation ?? "sandboxed",
    env: buildInstalledSkillContainerEnv({
      skillName: opts.skillName,
      extraEnv: {
        ...(opts.includeAliceHome
          ? {
              ALICE_HOME: ALICE_CONTAINER_PATHS.home,
              HOME: ALICE_CONTAINER_PATHS.home,
            }
          : {}),
        ...(opts.env ?? {}),
      },
      binDir: ALICE_CONTAINER_PATHS.bin,
    }),
    extraMounts: [...buildBaseMounts(opts.includeAliceHome ?? false), ...(opts.extraMounts ?? [])],
  };
}

export function executeAliceSandboxCommand(opts: AliceSandboxExecOptions): Promise<string> {
  return executeDockerCommand(buildRunnerOptions(opts));
}

export function executeAliceSandboxProcess(
  opts: AliceSandboxExecOptions,
): Promise<DockerProcessResult> {
  return executeDockerProcess(buildRunnerOptions(opts));
}

/**
 * 预热 Alice 系统 sandbox session container。
 *
 * 在启动时调用，确保第一个 tick 不需要等待容器冷启动。
 * 使用与 shell-executor 相同的参数构建 session spec，
 * 这样 ensureDockerSession 会复用同一个容器。
 */
export async function warmupSandboxSession(enginePort: number): Promise<void> {
  const opts = buildRunnerOptions({
    command: "true",
    skillName: "alice-system",
    enginePort,
    network: true,
    memory: "1g",
    timeout: 35,
    // TCP 通信不依赖 socket 挂载 → 回归 gVisor (sandboxed)
    includeAliceHome: true,
  });
  await ensureDockerSession(opts);
}
