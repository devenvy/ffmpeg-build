#!/usr/bin/env bash
set -euo pipefail
checks=$(cd "$(dirname "$0")" && pwd)
bash "$checks/media-filters.sh"
bash "$checks/lv2-linkage.sh"
