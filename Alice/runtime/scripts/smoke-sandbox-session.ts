import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import {
  DEFAULT_DOCKER_IMAGE,
  type DockerExecOptions,
  executeDockerCommand,
  getDockerSessionName,
} from "../src/skills/backends/docker.js";

const execFile = promisify(execFileCb);

function makeBaseOptions(): DockerExecOptions {
  return {
    command: "true",
    params: {},
    image: process.argv[2] ?? DEFAULT_DOCKER_IMAGE,
    skillName: "alice-system",
    network: false,
    memory: "256m",
    timeout: 20,
    env: {
      PATH: "/opt/alice/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    },
  };
}

async function main() {
  const base = makeBaseOptions();
  const sessionName = getDockerSessionName(base);

  const first = await executeDockerCommand({
    ...base,
    command: "node --version && python3 --version && tsx --version",
  });
  const second = await executeDockerCommand({
    ...base,
    command: 'id && printf "PATH=%s\\n" "$PATH"',
  });

  const inspect = await execFile("docker", [
    "inspect",
    "--type",
    "container",
    sessionName,
    "--format",
    "{{.State.Running}}",
  ]);
  const running = inspect.stdout.trim();

  console.log("== Alice sandbox session smoke ==");
  console.log(`session=${sessionName}`);
  console.log(`running=${running}`);
  console.log("-- first exec --");
  console.log(first.trim());
  console.log("-- second exec --");
  console.log(second.trim());

  if (running !== "true") {
    throw new Error(`sandbox session ${sessionName} is not running`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
