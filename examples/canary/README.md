# Canary

The engine's own check against upstream: the shipped lgplv3, gplv3 and gplv2 targets for linux-x64 and win-x64, and
a small osx-arm64 one with Vulkan and libplacebo (for MoltenVK, which only Apple builds) and iconv (GNU libiconv, which
only Apple and Windows build), which between them build
every recipe the engine has (`tests/example-folders.test.ts` checks). (Platform-specific pieces, Android's and
Apple's setup and packaging, and MoltenVK linked statically for iOS and Mac Catalyst, are covered by the
examples/test-builds targets, which `.github/workflows/toolchains.yml` builds.)

- `.github/workflows/recipes.yml` builds a changed recipe (and what it builds against, not FFmpeg) on each canary
  target that uses it, at this lock's versions.
- `.github/workflows/canary.yml` moves this lock to the newest upstream versions every week, in the run only, and
  builds every target in full.
