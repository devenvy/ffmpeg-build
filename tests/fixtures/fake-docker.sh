#!/bin/bash
# A stand-in docker for build tests: `version` and `image inspect` answer; `run` writes a fake build into the /out
# mount (FAKE_DOCKER_MODE: ok, fail, hang); `stop`, `kill` and `rm` are recorded in $FAKE_DOCKER_CALLS.
calls=${FAKE_DOCKER_CALLS:-/dev/null}
echo "$*" >> "$calls"
case "$1" in
  version) echo 27.0.0; exit 0 ;;
  image) echo sha256:fakeimage; exit 0 ;;
  stop|kill|rm) exit 0 ;;
  run) ;;
  *) exit 0 ;;
esac
shift
out=""
cidfile=""
while [ $# -gt 0 ]; do
  case "$1" in
    --mount)
      case "$2" in
        *target=/out*) out=$(printf '%s' "$2" | sed -E 's/^type=bind,"?source=([^,"]*)"?,target=\/out.*$/\1/') ;;
      esac
      shift 2 ;;
    --cidfile) cidfile=$2; shift 2 ;;
    *) shift ;;
  esac
done
[ -n "$cidfile" ] && printf 'fakecontainer123' > "$cidfile"
name=${FAKE_DOCKER_NAME:?}
label=${FAKE_DOCKER_LABEL:-new}
case "${FAKE_DOCKER_MODE:-ok}" in
  ok)
    echo "building $name"
    printf '%s' "$label" > "$out/$name.tar.gz"
    printf '%s' "$label" > "$out/$name-dev.tar.gz"
    printf '%s' "$label" > "$out/$name.sources.json"
    mkdir -p "$out/$name.sources/ffmpeg" && printf '%s' "$label" > "$out/$name.sources/ffmpeg/ffmpeg.tar.xz"
    exit 0 ;;
  fail)
    printf 'half' > "$out/$name.tar.gz"
    echo "ERROR: building x265 4.3 failed (see above)" >&2
    exit 1 ;;
  hang)
    trap 'echo "got TERM" >> "$calls"; exit 143' TERM
    trap 'echo "got INT" >> "$calls"; exit 130' INT
    echo started >> "$calls"
    while true; do sleep 0.1; done ;;
esac
