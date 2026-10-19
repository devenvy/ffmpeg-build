#!/usr/bin/env bash
# test-env: reaches a target's test script, natively and in a test container (docs/building.md, "Tests that need a
# secret"). toolchains.yml passes FFB_TEST_ENV_CHECK=<run id>-ok through build.yml's test-env secret; a run without it
# (by hand, or `ffmpeg-build test` here) skips, as a consumer's script skips what needs a key it wasn't given.
set -euo pipefail
if [ -z "${FFB_TEST_ENV_CHECK:-}" ]; then
  echo "FFB_TEST_ENV_CHECK not set: nothing to check"
  exit 0
fi
case "${FFB_TEST_ENV_CHECK}" in
  *[0-9]-ok) ;;
  *) echo "FFB_TEST_ENV_CHECK isn't the value toolchains.yml passes"; exit 1 ;;
esac
# the secret's own variable never reaches a script: only the names the target lists
if [ -n "${FFMPEG_BUILD_TEST_ENV:-}" ]; then
  echo "FFMPEG_BUILD_TEST_ENV reached the script"
  exit 1
fi
echo "test-env: FFB_TEST_ENV_CHECK arrived"
