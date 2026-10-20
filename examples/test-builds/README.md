# Test builds

The engine's own end-to-end test: one small target (dav1d and Opus, lgplv3, FFmpeg 9) per kind of runner and
toolchain, so every platform's setup, packaging and tests run in CI without building every library.

| Targets                                                      | What they cover                                                          |
| ------------------------------------------------------------ | ------------------------------------------------------------------------ |
| linux-x64, linux-arm64                                       | the glibc Linux images, on x64 and arm64 runners                         |
| linux-armhf                                                  | a cross build, tested in Debian armhf under qemu                         |
| linux-musl-arm64                                             | the musl (Alpine) image, tested in Alpine                                |
| win-x64, win-arm64                                           | the Windows cross builds, tested on Windows and Windows on Arm runners   |
| android-arm64                                                | the Android NDK build for API 24 (`android-api:`), tested on an emulator |
| osx-arm64                                                    | a native macOS build                                                     |
| ios-arm64, ios-sim-arm64, maccatalyst-arm64, maccatalyst-x64 | the four slices of one iOS / Mac Catalyst xcframework bundle             |

ios-arm64 and maccatalyst-arm64 also build Vulkan and libplacebo, with MoltenVK linked statically into their frameworks
(the canary builds macOS's MoltenVK dylib). The Linux, Windows and macOS targets also take the GPU options their
platform offers (cuda-llvm, opencl, d3d12va, vdpau, rkmpp): only a full build and its test show FFmpeg took them.

`.github/workflows/toolchains.yml` builds and tests them through the reusable `build.yml`, with the engine from this
repository's source (`engine: source`), whenever a toolchain changes (`platforms/`, `images/`, `platforms.yml`,
`src/build/`). It never publishes. The `package` job of `ci.yml` also builds dav1d for linux-x64 here with the packed
npm package, as a user would install it.

To build one by hand, from this folder:

    node ../../src/cli.ts build --target linux-x64-lgplv3
    node ../../src/cli.ts test --target linux-x64-lgplv3
