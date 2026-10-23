#!/usr/bin/env bash
set -euo pipefail
checks=$(cd "$(dirname "$0")" && pwd)
exec node "$checks/moltenvk-linkage.mjs"
