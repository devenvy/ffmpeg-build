#!/usr/bin/env bash
set -euo pipefail
checks=$(cd "$(dirname "$0")" && pwd)
bash "$checks/network-linkage.sh"
exec node "$checks/network-extra.mjs"
