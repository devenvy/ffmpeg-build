#!/usr/bin/env bash
set -euo pipefail
checks=$(cd "$(dirname "$0")" && pwd)
node "$checks/openvino.mjs"
exec node "$checks/ml-native-linkage.mjs" openvino
