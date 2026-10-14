# ffmpeg-build

Build FFmpeg your way: the FFmpeg version, platforms, license, libraries and your own patches, from one YAML file.
Every library version is locked, every license is checked before anything builds, and every archive says what it
was made from.

```yaml
# ffmpeg-build.yml
bases:
  common: { with: [dav1d, opus, srt] }
targets:
  linux-x64-lgplv3:
    { platform: linux-x64, license: lgplv3, ffmpeg: 9, base: [common], with: [vaapi] }
  win-x64-gplv3:
    { platform: win-x64, license: gplv3, ffmpeg: 9, base: [common], with: [x264, x265] }
```

    ffmpeg-build check                          # is every target possible? (offline)
    ffmpeg-build lock                           # pick and lock the versions (asks upstream)
    ffmpeg-build build --target win-x64-gplv3   # ffmpeg-9.x.y-win-x64-gplv3.tar.gz and -dev.tar.gz

**Status: 0.x, early.** Every platform below builds and reproduces the published devenvy/ffmpeg builds, and releases
are built, published and fetched end to end in CI. Until 1.0 the
`ffmpeg-build.yml` format, `ffmpeg.lock` and the `@v0` workflow inputs may still change; a release that changes them
says so in its notes.

## Platforms

|                      |                                                              |
| -------------------- | ------------------------------------------------------------ |
| Linux (glibc 2.28+)  | linux-x64, linux-arm64, linux-armhf                          |
| Linux (musl)         | linux-musl-x64, linux-musl-arm64                             |
| Windows              | win-x64, win-arm64                                           |
| Android              | android-arm64, android-x64                                   |
| macOS                | osx-arm64, osx-x64                                           |
| iOS and Mac Catalyst | ios-arm64, ios-sim-arm64, maccatalyst-arm64, maccatalyst-x64 |

Linux, Windows and Android build in pinned Docker images on any host; Apple platforms build on a Mac with Xcode.
Each one reproduces the builds devenvy/ffmpeg publishes (files, configure flags, components and dependencies, with
every difference listed and explained). Vulkan on Apple runs on MoltenVK, as devenvy/ffmpeg's does (v3 only: it is
Apache-2.0): macOS archives carry the Vulkan loader, `libMoltenVK.dylib` and `MoltenVK_icd.json` (point
`VK_ICD_FILENAMES` at it); on iOS and Mac Catalyst MoltenVK is linked into the libav* frameworks, and an app links
`-framework Metal -framework IOSurface -framework Foundation -framework QuartzCore -framework CoreGraphics -framework
UIKit` (and `-framework IOKit` on Mac Catalyst).

## Install

    npm install --global @devenvy/ffmpeg-build      # Node 24+

Building also needs Docker (Linux, Windows, Android targets) or Xcode (Apple targets); `lock`, `update` and
`outdated` need `git`.

## Quick start

    mkdir my-ffmpeg && cd my-ffmpeg
    ffmpeg-build init --license lgplv3 --platforms linux-x64,win-x64   # from the shipped targets
    ffmpeg-build profile remove whisper --from linux-x64-lgplv3        # make it yours
    ffmpeg-build check && ffmpeg-build lock
    ffmpeg-build build --target linux-x64-lgplv3

[Getting started](docs/getting-started.md) walks through a small first build, then CI that builds and publishes
releases, and a product that downloads them.

## Commands

    init         write ffmpeg-build.yml from the shipped targets
    check        is every target possible? (offline)
    plan         what each target builds: options, libraries, versions (offline)
    show         what one target gets and which base gave it; --has <name>: which targets get it
    targets      the targets (--json for CI matrices)
    options      what a target can list: library, licenses, platforms (offline)
    profile      add | remove | missing: edit ffmpeg-build.yml in place, keeping its comments
    lock         write ffmpeg.lock, looking up only what is missing
    outdated     what is newer upstream (read-only)
    update       move ffmpeg.lock to the newest allowed versions (and write the PR text)
    build        build one target in its pinned toolchain
    test         run a build where this machine can (a library build: link a program against it, run that where it can)
    releases     each release's next tag, and whether it changed since it was last published
    bundle       write a release's sources archive, manifest.yml, SHA256SUMS and notes (--apple: the iOS bundle)
    fetch        take a published build (for products that don't build FFmpeg)
    migrate      convert a folder of old matrix profiles
    guide        the step-by-step guide, for people, scripts and AI agents

Most take `--json`. Nothing prompts. Exit codes: 0 fine, 1 a target has problems, 2 a usage, data, network or tool
problem (the message says which).

## Documentation

- [Getting started](docs/getting-started.md): a first build, CI and releases, a product; environment variables
- [Targets](docs/targets.md): `ffmpeg-build.yml`, bases, licenses, pins, patches, updates
- [Building](docs/building.md): toolchains, caching, `THIRD-PARTY-NOTICES.txt`, what a build was made from
- [Releases, CI and products](docs/releases.md): release tags, workflows, `fetch`
- [The commands](docs/getting-started.md#the-commands) (`ffmpeg-build guide`): in the order you'd use them, with exit codes

## Development

    pnpm install
    pnpm test                                                 # vitest
    pnpm run dev check                                        # the CLI from source, in the folder you are in
    node <path to the engine>/src/cli.ts check                # the same, from anywhere (or `npm link` once)

See [DEVELOPMENT.md](DEVELOPMENT.md) for the checks CI runs, how recipes and platforms fit together, and how releases
go out.

## License

The engine is [MIT](LICENSE). The FFmpeg builds it produces are under the license each target chooses (LGPL or GPL,
or nonfree for internal use), and carry every component's license in `THIRD-PARTY-NOTICES.txt` at their root.
