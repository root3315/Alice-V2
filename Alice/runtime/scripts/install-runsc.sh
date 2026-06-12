#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Install gVisor runsc using the official release binaries.

Usage:
  ./runtime/scripts/install-runsc.sh [options]

Options:
  --set-default-runtime   Set Docker default-runtime=runsc (default: keep current default)
  --no-restart            Do not restart Docker after registration
  --no-verify             Skip docker runtime verification
  --version VERSION       Install a specific gVisor release (default: latest)
  -h, --help              Show this help

Notes:
  - Idempotent: safe to rerun; binaries are replaced only when content changes.
  - Safe default: registers runsc without changing Docker's default runtime.
  - Uses official gVisor release artifacts and checksum verification.
EOF
}

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "error: required command not found: $1" >&2
    exit 1
  }
}

run_privileged() {
  if [[ "${EUID}" -eq 0 ]]; then
    "$@"
  else
    sudo "$@"
  fi
}

arch_name() {
  local raw
  raw="$(uname -m)"
  case "$raw" in
    x86_64|amd64) echo "x86_64" ;;
    aarch64|arm64) echo "aarch64" ;;
    *)
      echo "error: unsupported architecture: $raw" >&2
      exit 1
      ;;
  esac
}

install_if_changed() {
  local src="$1"
  local dst="$2"
  if [[ -f "$dst" ]] && cmp -s "$src" "$dst"; then
    echo "unchanged: $dst"
    return 0
  fi
  run_privileged install -m 0755 "$src" "$dst"
  echo "installed: $dst"
}

SET_DEFAULT_RUNTIME=0
RESTART_DOCKER=1
VERIFY_RUNTIME=1
GVISOR_VERSION="latest"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --set-default-runtime)
      SET_DEFAULT_RUNTIME=1
      ;;
    --no-restart)
      RESTART_DOCKER=0
      ;;
    --no-verify)
      VERIFY_RUNTIME=0
      ;;
    --version)
      shift
      [[ $# -gt 0 ]] || {
        echo "error: --version requires a value" >&2
        exit 1
      }
      GVISOR_VERSION="$1"
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "error: unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
  shift
done

need_cmd curl
need_cmd sha512sum
need_cmd docker

ARCH="$(arch_name)"
TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

BASE_URL="https://storage.googleapis.com/gvisor/releases/release/${GVISOR_VERSION}/${ARCH}"
RUNSC_BIN="$TMPDIR/runsc"
RUNSC_SUM="$TMPDIR/runsc.sha512"
SHIM_BIN="$TMPDIR/containerd-shim-runsc-v1"
SHIM_SUM="$TMPDIR/containerd-shim-runsc-v1.sha512"

echo "Downloading official gVisor artifacts from:"
echo "  $BASE_URL"

curl --http1.1 --retry 8 --retry-delay 2 --retry-all-errors -fLso "$RUNSC_BIN" \
  "$BASE_URL/runsc"
curl --http1.1 --retry 8 --retry-delay 2 --retry-all-errors -fLso "$RUNSC_SUM" \
  "$BASE_URL/runsc.sha512"
curl --http1.1 --retry 8 --retry-delay 2 --retry-all-errors -fLso "$SHIM_BIN" \
  "$BASE_URL/containerd-shim-runsc-v1"
curl --http1.1 --retry 8 --retry-delay 2 --retry-all-errors -fLso "$SHIM_SUM" \
  "$BASE_URL/containerd-shim-runsc-v1.sha512"

(cd "$TMPDIR" && sha512sum -c "$(basename "$RUNSC_SUM")" -c "$(basename "$SHIM_SUM")")
chmod 0755 "$RUNSC_BIN" "$SHIM_BIN"

install_if_changed "$RUNSC_BIN" /usr/local/bin/runsc
install_if_changed "$SHIM_BIN" /usr/local/bin/containerd-shim-runsc-v1

if [[ "$SET_DEFAULT_RUNTIME" -eq 1 ]]; then
  echo "Registering runsc and setting Docker default-runtime=runsc"
  run_privileged /usr/local/bin/runsc install --runtime=runsc --experimental --clobber
else
  echo "Registering runsc without changing Docker default-runtime"
  run_privileged /usr/local/bin/runsc install --runtime=runsc --clobber
fi

if [[ "$RESTART_DOCKER" -eq 1 ]]; then
  echo "Restarting Docker"
  run_privileged systemctl restart docker
else
  echo "Skipping Docker restart (--no-restart)"
fi

echo
echo "runsc version:"
/usr/local/bin/runsc --version

echo
echo "Docker runtimes:"
docker info --format '{{json .Runtimes}} {{.DefaultRuntime}}'

if [[ "$VERIFY_RUNTIME" -eq 1 ]]; then
  echo
  echo "Verifying runsc with hello-world"
  docker run --rm --runtime=runsc hello-world
fi
