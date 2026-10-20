#!/usr/bin/env bash
# ocio: FFmpeg's OpenColorIO filter (a C++ source of FFmpeg's own, which on macOS compiles only once the engine has
# taken the release's VERSION file out of the way of libc++'s <version>: devenvy/ffmpeg-build#41) converts a test
# pattern with OpenColorIO's built-in config. A colour space the config hasn't got must fail, so the config was read.
set -euo pipefail
ocio() {
  "${FFMPEG}" -hide_banner -loglevel error -f lavfi -i testsrc2=duration=0.2:size=64x48:rate=10 \
    -vf "ocio=config='ocio\://default':input='sRGB - Texture':output=$1" -f null -
}
ocio ACEScg
if ocio NoSuchSpace 2>/dev/null; then
  echo "ocio: a colour space the built-in config hasn't got didn't fail"
  exit 1
fi
echo "ocio: sRGB to ACEScg through OpenColorIO's built-in config"
