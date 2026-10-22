#!/usr/bin/env bash
set -euo pipefail
checks=$(cd "$(dirname "$0")" && pwd)
runtime=$(cd "$(dirname "$FFMPEG")" && pwd)
docker build --quiet -f "$checks/vulkan-runtime.Dockerfile" -t ffmpeg-build-vulkan-runtime:fedora44 "$checks"
exec docker run --rm --cpus 2 \
  -v "$runtime:/runtime:ro" -v "$checks:/checks:ro" \
  -e FFMPEG=/runtime/ffmpeg \
  -e VK_DRIVER_FILES=/usr/share/vulkan/icd.d/lvp_icd.x86_64.json \
  -e GGML_VK_VISIBLE_DEVICES=0 -e XDG_RUNTIME_DIR=/tmp \
  ffmpeg-build-vulkan-runtime:fedora44 node /checks/whisper-linkage.mjs
