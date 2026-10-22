#!/usr/bin/env bash
set -euo pipefail
checks=$(cd "$(dirname "$0")" && pwd)
runtime=$(cd "$(dirname "$FFMPEG")" && pwd)
docker build --quiet -f "$checks/vulkan-runtime.Dockerfile" -t ffb-vulkan-runtime:fedora44 "$checks"
docker run --rm --cpus 2 \
  -v "$runtime:/runtime:ro" -v "$checks:/checks:ro" \
  -e FFMPEG=/runtime/ffmpeg \
  -e VK_DRIVER_FILES=/usr/share/vulkan/icd.d/lvp_icd.x86_64.json \
  -e XDG_RUNTIME_DIR=/tmp \
  ffb-vulkan-runtime:fedora44 node /checks/graphics-batch-linkage.mjs
docker build --quiet -f "$checks/compute-runtime.Dockerfile" -t ffb-compute-runtime:bookworm "$checks"
exec docker run --rm --cpus 2 \
  -v "$runtime:/runtime:ro" -v "$checks:/checks:ro" \
  -e FFMPEG=/runtime/ffmpeg -e POCL_DEVICES=pthread -e POCL_MAX_PTHREAD_COUNT=2 \
  ffb-compute-runtime:bookworm node /checks/compute-linkage.mjs
