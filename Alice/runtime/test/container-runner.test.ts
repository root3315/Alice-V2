import { describe, expect, it, vi } from "vitest";
import {
  ALICE_CONTAINER_PATHS,
  executeAliceSandboxCommand,
} from "../src/skills/container-runner.js";

vi.mock("../src/skills/backends/docker.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/skills/backends/docker.js")>();
  return {
    ...original,
    executeDockerCommand: vi.fn().mockResolvedValue("ok"),
  };
});

describe("container runner", () => {
  it("builds a centralized sandbox contract with fixed container paths", async () => {
    const { executeDockerCommand } = await import("../src/skills/backends/docker.js");
    const mockDocker = executeDockerCommand as ReturnType<typeof vi.fn>;

    await executeAliceSandboxCommand({
      command: "echo hi",
      skillName: "alice-system",
      enginePort: 3380,
      network: false,
      memory: "256m",
      timeout: 10,
      includeAliceHome: true,
    });

    expect(mockDocker).toHaveBeenCalledWith(
      expect.objectContaining({
        skillName: "alice-system",
        enginePort: 3380,
        isolation: "sandboxed",
        env: expect.objectContaining({
          ALICE_SYSTEM_BIN_DIR: ALICE_CONTAINER_PATHS.bin,
          ALICE_HOME: ALICE_CONTAINER_PATHS.home,
          HOME: ALICE_CONTAINER_PATHS.home,
        }),
        extraMounts: expect.arrayContaining([
          expect.objectContaining({ target: ALICE_CONTAINER_PATHS.bin, readOnly: true }),
          expect.objectContaining({ target: ALICE_CONTAINER_PATHS.home, readOnly: false }),
        ]),
      }),
    );
  });
});
