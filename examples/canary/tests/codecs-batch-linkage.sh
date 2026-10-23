#!/usr/bin/env bash
set -euo pipefail
checks=$(cd "$(dirname "$0")" && pwd)
for suite in codecs-extra specialized-linkage uavs3d-linkage mpegh-linkage; do
  bash "$checks/$suite.sh"
done
