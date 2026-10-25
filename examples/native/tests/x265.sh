#!/usr/bin/env bash
set -euo pipefail
: "${FFMPEG:?}" "${FFPROBE:?}"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
"$FFMPEG" -nostdin -hide_banner -loglevel error \
  -f lavfi -i 'testsrc2=size=64x64:rate=3:duration=1' -frames:v 3 -an \
  -c:v libx265 -preset ultrafast -x265-params 'pools=none:frame-threads=1:log-level=error' \
  -f matroska "$work/owned.mkv"
frames=$("$FFPROBE" -v error -select_streams v:0 -count_frames \
  -show_entries stream=nb_read_frames -of csv=p=0 "$work/owned.mkv" | tr -d '\r')
test "$frames" = 3
"$FFMPEG" -nostdin -hide_banner -loglevel error -i "$work/owned.mkv" -f null -
