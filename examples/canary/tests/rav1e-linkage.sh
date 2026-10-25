#!/usr/bin/env bash
set -euo pipefail
# The musl smoke runner starts from plain Alpine; Node is test tooling only.
if ! command -v node >/dev/null 2>&1 && command -v apk >/dev/null 2>&1; then
  apk add --no-cache -q nodejs binutils >/dev/null
fi
exec node "$(dirname "$0")/rav1e-linkage.mjs"
