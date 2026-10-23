#!/usr/bin/env bash
set -euo pipefail
checks=$(cd "$(dirname "$0")" && pwd)
node "$checks/torch.mjs"
exec node "$checks/ml-native-linkage.mjs" torch
