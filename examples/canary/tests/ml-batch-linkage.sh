#!/usr/bin/env bash
set -euo pipefail
checks=$(cd "$(dirname "$0")" && pwd)
configuration=$("$FFMPEG" -buildconf 2>&1)
# FFmpeg 8 predates its ONNX backend; the other four backends run in both majors.
if [[ "$configuration" == *--enable-libonnxruntime* ]]; then
  bash "$checks/onnxruntime-linkage.sh"
fi
for suite in tensorflow-linkage torch-linkage openvino-linkage; do
  bash "$checks/$suite.sh"
done
exec node "$checks/whisper-linkage.mjs"
