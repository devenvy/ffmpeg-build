#!/usr/bin/env bash
set -euo pipefail
tests=$(cd "$(dirname "$0")" && pwd)
runtime=$(cd "$(dirname "$FFMPEG")" && pwd)
exec docker run --rm --cpus 2 \
  --mount "type=bind,src=$runtime,dst=/ffmpeg,readonly" \
  --mount "type=bind,src=$tests,dst=/tests,readonly" \
  -e FFMPEG=/ffmpeg/ffmpeg \
  mirror.gcr.io/library/node:24-bookworm@sha256:14078204b6bb268c107ceff6d3c43f45a888105e5c2b18b14c32b3409d93a1b0 \
  bash /tests/network-server.sh
