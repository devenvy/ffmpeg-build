#!/usr/bin/env bash
set -euo pipefail
directory=$(dirname "$FFMPEG")
for library in zimg snappy; do
  path="$directory/lib$library.so"
  if [[ -f "$path" ]]; then
    dynamic=$(readelf -d "$path")
    if printf '%s\n' "$dynamic" | grep -E 'NEEDED.*(libstdc\+\+|libgcc_s)'; then
      echo "$library unexpectedly requires a shared compiler runtime" >&2
      exit 1
    fi
  fi
done
exec node "$(dirname "$0")/leaf-linkage.mjs"
