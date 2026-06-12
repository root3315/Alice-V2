# gVisor `runsc` rollout

This is the runtime-side rollout guide for ADR-207.

## Goal

Alice should execute LLM-controlled shell and third-party skills with:

- Docker as the orchestration surface
- `runsc` as the default OCI runtime
- `sandboxed` as the default Alice isolation profile

## Install `runsc`

Follow the current gVisor installation instructions for your distro, then register it with Docker.

Typical Debian/Ubuntu flow:

```bash
sudo apt-get update
sudo apt-get install -y runsc
sudo runsc install
sudo systemctl restart docker
```

If your distro package is unavailable, install `runsc` from the official gVisor release artifacts, then run:

```bash
sudo runsc install
sudo systemctl restart docker
```

## Verify Docker runtime registration

```bash
docker info | rg runsc
docker run --rm --runtime=runsc hello-world
```

You should see `runsc` in the Docker runtimes list before moving Alice to the default `sandboxed` profile.

## Build Alice runner image

```bash
pnpm -C runtime docker:build-runner
```

## Project helper script

This repo now includes an idempotent installer that follows the same official binary flow:

```bash
./runtime/scripts/install-runsc.sh
```

Safe default behavior:

- installs official `runsc` + `containerd-shim-runsc-v1`
- registers Docker runtime `runsc`
- restarts Docker
- verifies with `docker run --runtime=runsc hello-world`
- does not change Docker `default-runtime`

If you want Docker itself to default to gVisor:

```bash
./runtime/scripts/install-runsc.sh --set-default-runtime
```

## Smoke test Alice under `runsc`

```bash
ALICE_SANDBOX_RUNTIME=runsc pnpm -C runtime docker:smoke-runner
ALICE_SANDBOX_RUNTIME=runsc pnpm -C runtime docker:smoke-session
```

Expected checks:

- `node --version`
- `python3 --version`
- `tsx --version`
- runner UID is non-root (`alice`)
- container `PATH` starts with `/opt/alice/bin`
- sandbox session stays alive between execs

## Turn on the default profile

Set these environment variables in the runtime service:

```bash
ALICE_SANDBOX_RUNTIME=runsc
ALICE_CONTAINER_DEFAULT_PROFILE=sandboxed
```

That makes all manifest entries that still say `container` resolve to the hardened sandbox policy.

## Fallback policy

If a skill proves incompatible with `runsc`, downgrade as narrowly as possible:

1. prefer `container_hardened`
2. only use `container_compat` as the escape hatch
3. never weaken the global default just for one misbehaving skill

## Rollout checklist

- `runsc` installed and visible in `docker info`
- `alice-skill-runner:bookworm` rebuilt on the target host
- smoke test passes with `ALICE_SANDBOX_RUNTIME=runsc`
- host runtime service uses the hardened systemd unit
- any downgraded skill is explicitly annotated in its manifest
