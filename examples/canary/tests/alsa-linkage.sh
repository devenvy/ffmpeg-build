#!/usr/bin/env bash
set -euo pipefail
if command -v node >/dev/null 2>&1; then
  exec node "$(dirname "$0")/alsa-linkage.mjs"
fi

# The musl runtime image has Bash and FFmpeg but no Node or compiler. Exercise the
# device paths there; the Node canary additionally checks a compiled external plugin.
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
export ALSA_CONFIG_PATH="$work/alsa.conf" ALSOFT_CONF="$work/alsoft.conf" ALSOFT_DRIVERS=alsa
printf '%s\n' 'pcm.null { type null }' 'pcm.plugnull { type plug slave.pcm null }' \
  'pcm_type.ffb_external { lib "/ffb-nonexistent-plugin.so" }' \
  'pcm.external { type ffb_external }' >"$ALSA_CONFIG_PATH"
printf '%s\n' '[alsa]' 'capture = null' >"$ALSOFT_CONF"
for device in null plugnull; do
  "$FFMPEG" -nostdin -hide_banner -loglevel error -f lavfi -i sine=frequency=440:sample_rate=48000 \
    -t 0.1 -f alsa "$device"
  "$FFMPEG" -nostdin -hide_banner -loglevel error -f alsa -sample_rate 48000 -ch_layout mono \
    -i "$device" -af asetpts=N/SR/TB -t 0.1 -f s16le -y "$work/capture.raw"
  test "$(wc -c <"$work/capture.raw")" -eq 9600
done
"$FFMPEG" -nostdin -hide_banner -loglevel error -f openal -sample_rate 48000 -channels 1 -i '' \
  -af asetpts=N/SR/TB -t 0.1 -f s16le -y "$work/openal.raw"
test "$(wc -c <"$work/openal.raw")" -eq 9600
if ! test -e "$(dirname "$FFMPEG")/libasound.so.2"; then
  if "$FFMPEG" -nostdin -hide_banner -loglevel error -f lavfi -i anullsrc -t 0.1 \
    -f alsa external >"$work/external.log" 2>&1; then
    exit 1
  fi
  grep -F 'External plugins are disabled in this static ALSA build' "$work/external.log"
fi
printf '%s\n' 'ALSA/OpenAL portable capture, playback and static plugin diagnostic passed'
