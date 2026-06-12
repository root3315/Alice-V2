/**
 * Docker 容器隔离执行后端测试。
 *
 * 重点验证命令构建正确性（mock execFile），不需要真正启动 Docker。
 */

import { describe, expect, it } from "vitest";
import {
  buildDockerArgs,
  buildDockerCreateArgs,
  buildDockerExecArgs,
  DEFAULT_DOCKER_IMAGE,
  type DockerExecOptions,
  getDockerSessionName,
  resolveDockerIsolationProfile,
} from "../src/skills/backends/docker.js";

function makeOpts(overrides?: Partial<DockerExecOptions>): DockerExecOptions {
  return {
    command: "echo {{query}}",
    params: { query: "hello world" },
    image: DEFAULT_DOCKER_IMAGE,
    enginePort: 3380,
    skillName: "test-skill",
    network: true,
    memory: "512m",
    timeout: 30,
    ...overrides,
  };
}

describe("buildDockerArgs", () => {
  it("构建基本 docker run 参数", () => {
    const args = buildDockerArgs(makeOpts());

    expect(args[0]).toBe("run");
    expect(args[1]).toBe("--rm");

    // TCP: --add-host + ALICE_ENGINE_URL env
    expect(args).toContain("--add-host=host.docker.internal:host-gateway");
    expect(args).toContain("ALICE_ENGINE_URL=http://host.docker.internal:3380");
    expect(args).toContain("ALICE_SKILL=test-skill");

    // 镜像
    expect(args).toContain(DEFAULT_DOCKER_IMAGE);

    expect(args).toContain("--cap-drop=ALL");
    expect(args).toContain("--security-opt=no-new-privileges=true");
    expect(args).toContain("--pids-limit=128");
    expect(args).toContain("--runtime=runsc");
    expect(args).toContain("--read-only");
    expect(args).toContain("--tmpfs");

    // 命令（最后三个元素：/bin/sh -c "..."）
    const shIdx = args.indexOf("/bin/sh");
    expect(shIdx).toBeGreaterThan(0);
    expect(args[shIdx + 1]).toBe("-c");
    // interpolateShell 会单引号包裹参数
    expect(args[shIdx + 2]).toContain("hello world");
  });

  it("network=false → --network=none", () => {
    const args = buildDockerArgs(makeOpts({ network: false }));
    expect(args).toContain("--network=none");
    expect(args).not.toContain("--network=bridge");
  });

  it("container_compat keeps writable rootfs and skips runsc", () => {
    const args = buildDockerArgs(makeOpts({ isolation: "container_compat" }));
    expect(args).not.toContain("--runtime=runsc");
    expect(args).not.toContain("--read-only");
  });

  it("container_hardened keeps read-only rootfs without forcing runsc", () => {
    const args = buildDockerArgs(makeOpts({ isolation: "container_hardened" }));
    expect(args).toContain("--read-only");
    expect(args).not.toContain("--runtime=runsc");
  });

  it("network=true → --network=bridge", () => {
    const args = buildDockerArgs(makeOpts({ network: true }));
    expect(args).toContain("--network=bridge");
    expect(args).not.toContain("--network=none");
  });

  it("memory 限制传递正确", () => {
    const args = buildDockerArgs(makeOpts({ memory: "256m" }));
    expect(args).toContain("--memory=256m");
  });

  it("CPU 限制固定为 1", () => {
    const args = buildDockerArgs(makeOpts());
    expect(args).toContain("--cpus=1");
  });

  it("cwd 映射到 -w 参数", () => {
    const args = buildDockerArgs(makeOpts({ cwd: "/skill/scripts" }));
    const wIdx = args.indexOf("-w");
    expect(wIdx).toBeGreaterThan(0);
    expect(args[wIdx + 1]).toBe("/skill/scripts");
  });

  it("无 cwd 时不含 -w", () => {
    const args = buildDockerArgs(makeOpts({ cwd: undefined }));
    expect(args).not.toContain("-w");
  });

  it("额外环境变量注入", () => {
    const args = buildDockerArgs(makeOpts({ env: { FOO: "bar", BAZ: "qux" } }));
    expect(args).toContain("FOO=bar");
    expect(args).toContain("BAZ=qux");
  });

  it("额外挂载映射到 -v 参数", () => {
    const args = buildDockerArgs(
      makeOpts({
        extraMounts: [
          { source: "/opt/alice/bin" },
          { source: "/opt/alice/man", target: "/srv/man", readOnly: true },
        ],
      }),
    );
    expect(args).toContain("/opt/alice/bin:/opt/alice/bin:ro");
    expect(args).toContain("/opt/alice/man:/srv/man:ro");
  });

  it("参数中的特殊字符被 shell 安全转义", () => {
    const args = buildDockerArgs(
      makeOpts({
        command: "echo {{input}}",
        params: { input: 'it\'s a "test"' },
      }),
    );
    const shIdx = args.indexOf("/bin/sh");
    const cmd = args[shIdx + 2];
    // interpolateShell 用单引号包裹，内部单引号用 '\'' 转义
    expect(cmd).toContain("'it'\\''s a \"test\"'");
  });

  it("null 参数替换为空字符串", () => {
    const args = buildDockerArgs(
      makeOpts({
        command: "echo {{missing}}",
        params: {},
      }),
    );
    const shIdx = args.indexOf("/bin/sh");
    const cmd = args[shIdx + 2];
    expect(cmd).toContain("''");
  });

  it("legacy container alias resolves to sandboxed by default", () => {
    expect(resolveDockerIsolationProfile("container")).toMatchObject({
      name: "sandboxed",
      runtime: "runsc",
      readOnlyRootfs: true,
    });
  });

  it("builds a stable session name from container policy", () => {
    const a = getDockerSessionName(makeOpts());
    const b = getDockerSessionName(makeOpts({ skillName: "other-skill" }));
    const c = getDockerSessionName(makeOpts({ memory: "1g" }));

    expect(a).toBe(b);
    expect(c).not.toBe(a);
    expect(a).toMatch(/^alice-sbx-/);
  });

  it("builds docker create args for a persistent session container", () => {
    const args = buildDockerCreateArgs(makeOpts(), "alice-sbx-test", "sig-123");

    expect(args[0]).toBe("create");
    expect(args).toContain("--name");
    expect(args).toContain("alice-sbx-test");
    expect(args).toContain("--label");
    expect(args).toContain("alice.sandbox.managed=true");
    expect(args).toContain("alice.sandbox.signature=sig-123");
    expect(args).toContain(DEFAULT_DOCKER_IMAGE);
    expect(args.slice(-2)).toEqual(["sleep", "infinity"]);
  });

  it("builds docker exec args against a persistent session container", () => {
    const args = buildDockerExecArgs(
      makeOpts({
        env: { FOO: "bar" },
        cwd: "/work",
      }),
      "alice-sbx-test",
    );

    expect(args[0]).toBe("exec");
    expect(args).toContain("-w");
    expect(args).toContain("/work");
    expect(args).toContain("alice-sbx-test");
    expect(args).toContain("ALICE_SKILL=test-skill");
    expect(args).toContain("ALICE_ENGINE_URL=http://host.docker.internal:3380");
    expect(args).toContain("FOO=bar");
    expect(args).toContain("/bin/sh");
  });

  it("no enginePort → no --add-host, no ALICE_ENGINE_URL", () => {
    const args = buildDockerArgs(makeOpts({ enginePort: undefined }));
    expect(args).not.toContain("--add-host=host.docker.internal:host-gateway");
    const engineUrlArgs = args.filter((a) => a.includes("ALICE_ENGINE_URL"));
    expect(engineUrlArgs).toHaveLength(0);
  });
});
