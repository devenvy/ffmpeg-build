#!/usr/bin/env bash
set -euo pipefail
checks=$(cd "$(dirname "$0")" && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
curl --fail --location --retry 3 --connect-timeout 30 --max-time 180 \
  --output "$work/eng.traineddata" \
  https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/65727574dfcd264acbb0c3e07860e4e9e9b22185/eng.traineddata
echo '7d4322bd2a7749724879683fc3912cb542f19906c83bcc1a52132556427170b2  eng.traineddata' > "$work/SHA256SUMS"
(cd "$work" && sha256sum --check SHA256SUMS)
FFB_OCR_MODEL="$work/eng.traineddata" node "$checks/ocr-linkage.mjs"
