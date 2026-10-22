#!/usr/bin/env bash
set -euo pipefail
checks=$(cd "$(dirname "$0")" && pwd)
bash "$checks/processing-linkage.sh"
bash "$checks/media-linkage.sh"
bash "$checks/tracker-linkage.sh"
bash "$checks/pulse-linkage.sh"
