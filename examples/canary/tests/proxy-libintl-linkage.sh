#!/usr/bin/env bash
set -euo pipefail
checks=$(cd "$(dirname "$0")" && pwd)
runtime=$(cd "$(dirname "$FFMPEG")" && pwd)
if command -v apk >/dev/null 2>&1; then
  apk add --no-cache -q nodejs binutils >/dev/null
  exec node "$checks/proxy-libintl-linkage.mjs"
fi
docker build --quiet -f "$checks/proxy-libintl-runtime.Dockerfile" -t ffmpeg-build-proxy-runtime:alpine324 "$checks"
exec docker run --rm -v "$runtime:/runtime:ro" -v "$checks:/checks:ro" -e FFMPEG=/runtime/ffmpeg ffmpeg-build-proxy-runtime:alpine324 node /checks/proxy-libintl-linkage.mjs
