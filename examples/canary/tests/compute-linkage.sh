#!/usr/bin/env bash
set -euo pipefail
checks=$(cd "$(dirname "$0")" && pwd)
runtime=$(cd "$(dirname "$FFMPEG")" && pwd)
docker build --quiet -f "$checks/compute-runtime.Dockerfile" -t ffmpeg-build-compute-runtime:bookworm "$checks"
docker run --rm -v "$runtime:/runtime:ro" -v "$checks:/checks:ro" \
  -e FFMPEG=/runtime/ffmpeg -e LD_LIBRARY_PATH=/runtime \
  ffmpeg-build-compute-runtime:bookworm node /checks/compute-linkage.mjs
