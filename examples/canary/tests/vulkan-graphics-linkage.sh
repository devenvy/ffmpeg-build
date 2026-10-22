#!/usr/bin/env bash
set -euo pipefail
checks=$(cd "$(dirname "$0")" && pwd)
runtime=$(cd "$(dirname "$FFMPEG")" && pwd)
docker build --quiet -f "$checks/vulkan-runtime.Dockerfile" -t ffmpeg-build-vulkan-runtime:fedora44 "$checks"
docker run --rm \
  -v "$runtime:/runtime:ro" -v "$checks:/checks:ro" \
  -e FFMPEG=/runtime/ffmpeg -e LD_LIBRARY_PATH=/runtime \
  -e VK_DRIVER_FILES=/usr/share/vulkan/icd.d/lvp_icd.x86_64.json \
  ffmpeg-build-vulkan-runtime:fedora44 node /checks/vulkan-graphics-linkage.mjs
