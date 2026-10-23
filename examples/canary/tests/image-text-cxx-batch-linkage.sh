#!/usr/bin/env bash
set -euo pipefail
checks=$(cd "$(dirname "$0")" && pwd)
bash "$checks/image-text-batch-linkage.sh"
bash "$checks/tracker-linkage.sh"
FFB_TRANSPORT_PROTOCOLS=srt node "$checks/transport-linkage.mjs"
exec node "$checks/rubberband-linkage.mjs"
