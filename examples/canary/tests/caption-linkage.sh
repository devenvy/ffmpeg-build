#!/usr/bin/env bash
set -euo pipefail
exec node "$(dirname "$0")/caption-linkage.mjs"
