#!/usr/bin/env sh
set -eu

IMAGE="${1:-alice-skill-runner:bookworm}"
RUNTIME="${ALICE_SANDBOX_RUNTIME:-runsc}"

echo "[smoke-runner] image=$IMAGE runtime=$RUNTIME"

docker run --rm --runtime="$RUNTIME" "$IMAGE" /bin/sh -c \
  'node --version && python3 --version && tsx --version && id && printf "PATH=%s\n" "$PATH"'
