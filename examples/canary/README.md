# Canary

The engine's own check against upstream: the shipped lgplv3, gplv3 and gplv2 targets for linux-x64 and win-x64, and
a small osx-arm64 one with Vulkan and libplacebo (for MoltenVK, which only Apple builds), iconv (GNU libiconv, which
only Apple and Windows build) and OpenCL (macOS's own), and a small linux-arm64 one with rkmpp (Rockchip MPP, which only
ARM Linux builds), which between them build
every recipe the engine has (`tests/example-folders.test.ts` checks). (Platform-specific pieces, Android's and
Apple's setup and packaging, and MoltenVK linked statically for iOS and Mac Catalyst, are covered by the
examples/test-builds targets, which `.github/workflows/toolchains.yml` builds.)

- `.github/workflows/recipes.yml` builds a changed recipe (and what builds against it, not FFmpeg) on every platform it
  claims, at this lock's versions (`ffmpeg-build recipe-check`, which seeds its own lock from this one).
- `.github/workflows/canary.yml` moves this lock to the newest upstream versions every week, in the run only, and
  builds every target in full.
