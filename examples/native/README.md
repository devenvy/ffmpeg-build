# Native builds

The engine's test of native builds (`build: in: here`): dav1d and Opus with FFmpeg 9,
built with each runner's own toolchain instead of a pinned Docker image.

- `linux-x64-lgplv3` builds with the Linux runner's distribution compilers.
- `win-x64-gplv3` also builds x265 on a Windows runner in MSYS2's MinGW environment.
  Its owned HEVC encode/decode test exercises a C++ dependency; archive validation rejects compiler-runtime DLL imports.

The `build:` section in `ffmpeg-build.yml` says where and how each platform builds; `ffmpeg-build check` refuses a
combination that can't work (see [targets](../../docs/targets.md#some-targets-at-a-time-and-where-they-build)).
`.github/workflows/toolchains.yml` builds and tests them with the engine from source when a toolchain changes.

A native build depends on its machine: its runner and `in: here` are part of the toolchain a release records, and its
libraries are cached apart from the Docker builds'. To build one by hand on a matching machine, from this folder:

    node ../../src/cli.ts build --target linux-x64-lgplv3     # Linux x64, with build-essential, cmake, meson, nasm ...
