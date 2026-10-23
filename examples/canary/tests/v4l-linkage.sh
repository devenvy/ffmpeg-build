#!/usr/bin/env bash
set -euo pipefail
checks=$(cd "$(dirname "$0")" && pwd)
exec node "$checks/v4l-linkage.mjs"
