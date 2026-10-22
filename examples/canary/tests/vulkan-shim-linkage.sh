#!/usr/bin/env bash
set -euo pipefail
checks=$(cd "$(dirname "$0")" && pwd)
exec node "$checks/vulkan-shim-linkage.mjs"
