#!/usr/bin/env bash
set -euo pipefail
checks=$(cd "$(dirname "$0")" && pwd)
for suite in jxl caption ocr color-vision; do
  bash "$checks/$suite-linkage.sh"
done
