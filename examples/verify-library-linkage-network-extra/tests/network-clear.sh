#!/usr/bin/env bash
set -euo pipefail
export FFB_CRYPTO=off
exec node "$(dirname "$0")/network-extra.mjs"
