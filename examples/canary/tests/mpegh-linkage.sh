#!/usr/bin/env bash
set -euo pipefail
fixture_dir=$(mktemp -d)
trap 'rm -rf "$fixture_dir"' EXIT
if [[ -z "${MPEGH_SAMPLE:-}" ]]; then
  export MPEGH_SAMPLE="$fixture_dir/sample.mp4"
  curl --fail --location --retry 3 --output "$MPEGH_SAMPLE" \
    'https://media.githubusercontent.com/media/Fraunhofer-IIS/mpegh-test-content/405e2ef0366e837ca8ebf5a20b4b9863861d9a96/TRI_Fileset_17_514H_D1_D2_D3_O1_24bit2160p50.audio.mp4'
fi
node "$(dirname "$0")/mpegh-linkage.mjs"
