#!/usr/bin/env bash
set -euo pipefail
checks=$(cd "$(dirname "$0")" && pwd)
node "$checks/firewire-linkage.mjs"
node "$checks/cdio-linkage.mjs"
node "$checks/dvd-linkage.mjs"
node "$checks/bluray-linkage.mjs"
exec node "$checks/v4l-linkage.mjs"
