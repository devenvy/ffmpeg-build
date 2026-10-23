#!/usr/bin/env bash
set -euo pipefail
checks=$(cd "$(dirname "$0")" && pwd)
node "$checks/tensorflow.mjs"
exec node "$checks/ml-native-linkage.mjs" tensorflow
