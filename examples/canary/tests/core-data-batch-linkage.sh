#!/usr/bin/env bash
set -euo pipefail
FFB_CORE_DATA_TESTS=1 node "$(dirname "$0")/system-core.mjs"
