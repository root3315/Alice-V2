# Alice Runtime systemd deployment

This is the host-side hardening half of ADR-207.

## What it does

- moves mutable runtime state out of the repo tree with `ALICE_STATE_DIR`
- keeps the Engine API socket in `/run/alice-runtime/engine.sock`
- keeps the error log in `/var/log/alice-runtime/alice-errors.log`
- defaults the skill runner to `sandboxed` + `runsc`
- applies `systemd.exec` hardening around the Node runtime process

## Before enabling the service

1. Copy the repo to its final location and adjust the unit paths:
   - `WorkingDirectory=/srv/alice-telegram-bot/runtime`
   - `EnvironmentFile=-/srv/alice-telegram-bot/runtime/.env`
   - every `ReadWritePaths=/srv/alice-telegram-bot/...`
2. Ensure Node.js 22+, `pnpm`, Docker, and optionally Go 1.22+ are installed on the host.
3. Create the service account:

```bash
sudo useradd --system --home /var/lib/alice-runtime --shell /usr/sbin/nologin alice-runtime
sudo usermod -aG docker alice-runtime
```

That is the compatibility path. If you want the stricter host-side setup, point the unit at a dedicated rootless Docker socket instead of granting the service user `docker` group access.

4. Install JavaScript dependencies from the repo root with `pnpm`:

```bash
cd /srv/alice-telegram-bot
pnpm install --frozen-lockfile
```

5. Build the required runtime binaries inside `runtime/`:

```bash
cd /srv/alice-telegram-bot/runtime

# Required system-bin commands for runtime command space
pnpm run build:bin

# Build alice CLI and Go skills
mkdir -p dist/bin
CGO_ENABLED=0 go build -ldflags="-s -w" -o dist/bin/alice ./cmd/alice
for skill in cmd/skills/*/; do
  name=$(basename "$skill")
  CGO_ENABLED=0 go build -ldflags="-s -w" -o "dist/bin/$name" "./$skill"
done
```

6. Build the sandbox runner image:

```bash
cd /srv/alice-telegram-bot/runtime
pnpm docker:build-runner
```

## Pre-flight verification

Do not enable the unit until these checks pass:

```bash
cd /srv/alice-telegram-bot/runtime

test -x dist/bin/alice
test -x dist/bin/irc
test -x dist/bin/self
test -x dist/bin/alice-pkg

ALICE_RUNTIME_DIR=/srv/alice-telegram-bot/runtime ./dist/bin/alice doctor
```

If `alice doctor` reports missing `System bin`, you skipped `pnpm run build:bin` or built in the wrong directory.

## Install

```bash
sudo cp runtime/deploy/systemd/alice-runtime.service /etc/systemd/system/alice-runtime.service
sudo systemctl daemon-reload
sudo systemctl enable --now alice-runtime
```

## Verify

```bash
systemctl status alice-runtime
journalctl -u alice-runtime -n 100 --no-pager
ls -la /run/alice-runtime/engine.sock
ls -la /var/lib/alice-runtime
ls -la /var/log/alice-runtime/alice-errors.log
```

## Writable paths

The unit deliberately keeps only these locations writable:

- `/var/lib/alice-runtime` - SQLite state, caches, `ALICE_HOME`
- `/run/alice-runtime` - Engine API Unix socket
- `/var/log/alice-runtime` - error log
- `runtime/skills/store` - installed skill payloads
- `runtime/skills/system-bin` - exported skill command symlinks
- `runtime/skills/man` - exported manpage symlinks
- `runtime/skills/registry.json` - installed skill registry

If you later move skill exports out of the repo tree, tighten `ReadWritePaths` again.
