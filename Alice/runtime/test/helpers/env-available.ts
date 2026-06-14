/**
 * Env-availability probes for test gating.
 *
 * Some tests depend on host tools that are not present on every box (notably a
 * Windows dev machine without WSL): a POSIX `/bin/sh`, the `go` toolchain, the
 * `docker` CLI, or the OS permission to create symlinks. These helpers let such
 * tests SKIP (via `describe.skipIf(...)` / `it.skipIf(...)`) instead of FAILing,
 * while still running normally on Linux/CI where the tools exist.
 *
 * All probes are cheap and memoised — they run once per process.
 */
import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

/** True if a POSIX `/bin/sh` exists (absent on stock Windows). */
let _hasBinSh: boolean | undefined;
export function hasBinSh(): boolean {
  if (_hasBinSh === undefined) _hasBinSh = existsSync("/bin/sh");
  return _hasBinSh;
}

/** Probe a CLI by running `<cmd> <versionArg>` and checking it launched (status 0). */
function probeCli(cmd: string, versionArg: string): boolean {
  try {
    const res = spawnSync(cmd, [versionArg], { stdio: "ignore", timeout: 5000 });
    // res.error set (e.g. ENOENT) → not installed. status 0 → present.
    return !res.error && res.status === 0;
  } catch {
    return false;
  }
}

/** True if the `go` toolchain is on PATH. */
let _hasGo: boolean | undefined;
export function hasGo(): boolean {
  if (_hasGo === undefined) _hasGo = probeCli("go", "version");
  return _hasGo;
}

/** True if the `docker` CLI is on PATH (does not require the daemon to be running). */
let _hasDocker: boolean | undefined;
export function hasDocker(): boolean {
  if (_hasDocker === undefined) _hasDocker = probeCli("docker", "--version");
  return _hasDocker;
}

/**
 * True if `node_modules/.bin/<bin>` can be spawned directly via execFile/spawn.
 *
 * On Windows the extensionless shim (e.g. `node_modules/.bin/tsx`) is a POSIX
 * shell script that `child_process.spawn` cannot launch (only the `.CMD` variant
 * is runnable), so a test that spawns it the POSIX way ENOENTs. On Linux/CI the
 * extensionless shim runs fine. Probes by actually spawning `<bin> --version`.
 */
export function canSpawnNodeBin(bin: string): boolean {
  const path = `./node_modules/.bin/${bin}`;
  try {
    const res = spawnSync(path, ["--version"], {
      stdio: "ignore",
      timeout: 15000,
      cwd: process.cwd(),
    });
    return !res.error;
  } catch {
    return false;
  }
}

/**
 * True if this process can create symlinks. On Windows without Developer Mode
 * or admin rights `symlinkSync` throws EPERM — those tests must skip there.
 */
let _hasSymlink: boolean | undefined;
export function hasSymlink(): boolean {
  if (_hasSymlink !== undefined) return _hasSymlink;
  let dir: string | undefined;
  try {
    dir = mkdtempSync(join(tmpdir(), "alice-symlink-probe-"));
    const target = join(dir, "target");
    const link = join(dir, "link");
    writeFileSync(target, "probe");
    symlinkSync(target, link);
    _hasSymlink = true;
  } catch {
    _hasSymlink = false;
  } finally {
    if (dir) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* ignore cleanup failures */
      }
    }
  }
  return _hasSymlink;
}
