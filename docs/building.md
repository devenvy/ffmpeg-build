# Building

`ffmpeg-build build --target <name>` builds one target in its platform's pinned toolchain and writes
`ffmpeg-<version>-<target>.tar.gz` (the runtime: programs and shared libraries) and `-dev.tar.gz` (headers,
import libraries, pkg-config files) to `--out` (default `dist`). It needs `ffmpeg.lock` (`ffmpeg-build lock`).

A win-x64 build also writes `symbols-<version>-<target>.tar.gz`: the unstripped `ffmpeg_g.exe`, `ffprobe_g.exe` and
FFmpeg DLLs (FFmpeg and whisper.cpp are compiled with `-g` there), to symbolize a crash dump's module+offset frames
(`x86_64-w64-mingw32-addr2line -f -C -i -e avfilter-11.dll <address>`). What ships stays stripped; staging checks that
it carries no DWARF and that FFmpeg's (and, with whisper, ggml's) functions resolve to their source in the symbols. A
release publishes it beside the build's archives.

## What you need

`openvino` builds a static CPU-only OpenVINO runtime on Linux x64. Models must be in OpenVINO IR format
(`.xml` plus a `.bin` file when the model has weights). GPU/NPU devices and the other model frontends are disabled.
Its sequential CPU backend needs no separately installed OpenVINO, TBB or OpenMP libraries.

`onnxruntime` selects static CPU inference on Linux x64 with FFmpeg 9. It accepts ONNX models through FFmpeg's
DNN filters; it does not include GPU execution providers, training or a Python runtime. ONNX Runtime and its
transitive source commits are pinned together in the recipe. Apache-2.0 dependencies require a version 3 or
nonfree profile. The source archive retains the dependency repositories and upstream patches used to build them.

`ffmpeg-build doctor` (`--target`/`--platform` to narrow it, `--json` for scripts) says how each target builds and is
tested on this machine, checks what that needs, and prints the install command for what's missing (exit 1 then). It lists each requirement
once, with the targets that need it; one target (`--target <name>`) gets its own list, and `--json` has every
target's. It
is offline and quick: it only asks the local tools.

| Host    | `in: docker` (the default, except Apple)                                             | `in: here`                                                                                                                                       |
| ------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Linux   | Docker Engine, running, and usable by you; on x64, qemu for the arm64 images (below) | linux-x64/arm64 of its own CPU, glibc: compilers and build tools from the distribution (apt-get, dnf, zypper or pacman; `doctor` gives the line) |
| Windows | Docker Desktop, running                                                              | win-x64 in an MSYS2 MINGW64, UCRT64 or CLANG64 shell (not Git Bash), win-arm64 in CLANGARM64, with that environment's packages (below)           |
| macOS   | Docker Desktop, running                                                              | Apple targets (always this way): Xcode and the Homebrew tools in `platforms/apple-brew.txt`                                                      |

`lock` and `update` need git. Testing needs, besides: Docker for musl builds (Alpine) and linux-armhf (Debian armhf,
with qemu for 32-bit ARM on x64: `--install arm`, below); the Android NDK (`ANDROID_NDK_HOME`, on Linux or macOS) for
Android builds, and `adb` with a device or emulator to run them; Xcode for iOS and Mac Catalyst; Rosetta for x64
builds on Apple silicon; Git Bash for `.sh` tests on Windows. A build or test that stops for want of one of these says
to run `doctor`.

## Testing a build

`ffmpeg-build test --target <name>` runs a build where this machine can run it: a smoke test (the programs start, the
configure line matches the license, a one-second test pattern encodes, and the build has what its configure line asked
for, below), then each script the target lists in `tests:`, with `FFMPEG`, `FFPROBE` and `FFMPEG_DIR` set to the
unpacked build (and the variables its `test-env:` lists: [below](#tests-that-need-a-secret)). A non-zero exit fails it. A build this
machine can't run is skipped, and says why; with `--must-run` (as CI uses it, on the runner meant to run the build)
it fails instead.

What it tests is the archive as it will be published: `<name>.tar.gz` in `--dist`, unpacked into a fresh folder, never
the folder it was packed from. The smoke test's ffmpeg runs with nothing that points the loader elsewhere
(`LD_LIBRARY_PATH`, `DYLD_*`; on Windows, `PATH` is only Windows' own folders), so a library the archive lacks, or a run
path or install name that points at the build, fails the test as it would fail for whoever unpacks it.

Configure taking an option proves only that it was asked for: FFmpeg leaves out a component whose own needs aren't met
without a word (FFmpeg 8.1.2's Vulkan builds had no Vulkan filters: the glslc was too old). So for each option the
build's configure line has on, `test` checks the build has the components that option adds, as `ships:` names them in
[`ffmpeg/<major>.yml`](../ffmpeg/9.yml): in `ffmpeg -encoders`, `-decoders`, `-filters`, `-hwaccels`, `-protocols`,
`-muxers` or `-demuxers` (a Vulkan build lists `scale_vulkan` and the `vulkan` hwaccel, a TLS build `https` and
`tls`, a build with x264 the `libx264` encoder, and so on), and the soxr resampler by starting it. A component missing
fails the test, naming the option. So does any component the configure line asked for by name: a target's
`components:` lists, what came along with its options, and what its patch sets add. Each is looked for by the name the
build lists it under, which isn't always configure's (configure's `libvpx_vp8` is `libvpx` in `ffmpeg -encoders`;
`ffmpeg/components/<major>.yml` keeps those names).

On a glibc Linux machine with Docker, some other Linux builds run in a container of the image their toolchain starts
from, pinned by the same digest: a musl build of the machine's architecture in plain Alpine (which has no bash, so a
`.sh` test installs it in the container first), and a linux-armhf build in Debian bookworm for `linux/arm/v7`. On an
x64 machine (and on arm64 CPUs without 32-bit ARM, like GitHub's arm64 runners) the armhf container needs qemu for
32-bit ARM, which the test says how to register when it is missing:

    docker run --privileged --rm mirror.gcr.io/tonistiigi/binfmt:qemu-v8.1.5@sha256:2d2918e86e5327d0661f7083d67a95280b0f7be8f77ed79a8418f81d7d90ce6f --install arm

Android, iOS and Mac Catalyst builds are libraries, with no programs to run. For them `test` links a small C program
([`platforms/test/smoke.c`](../platforms/test/smoke.c)) against the build with the platform's own toolchain (the
Android NDK from `ANDROID_NDK_HOME`, or Xcode's SDK), which proves a consumer can link every library, then runs it
where the platform can run: on the Android device or emulator `adb` sees (the libraries are pushed beside it; needs
`patchelf`), in the iOS simulator (it boots one, and deletes it afterwards, when none is booted), or as a process on
this Mac (Mac Catalyst; x86_64 under Rosetta on Apple silicon). The program prints the version and configure line,
checked as `ffmpeg -version` and `-buildconf` are, checks every library answers, encodes and decodes a frame, and lists
what the build registered (as ffmpeg's `-encoders`, `-decoders`, `-muxers`, `-demuxers`, `-bsfs`, `-filters` and
`-protocols` would). What the build must have follows from its own configure line, so its `components:` is checked as
a program build's is, and a slim build is asked only for what it was built with:

- the frame round trip uses the first of mpeg4, mpeg2video, mpeg1video, ffv1 and rawvideo the build has as both encoder
  and decoder (a decode-only build makes none, and `test` says so);
- in each kind `components:` doesn't restrict, the decoders (h264, hevc, aac, mp3, flac, pcm_s16le, mjpeg), formats
  (mp4, matroska, mpegts, wav, and the null muxer) and bitstream filters (h264_mp4toannexb, aac_adtstoasc) an
  unrestricted build has;
- what each option on ships, and every component configure was asked for by name.

A build it can't run anywhere here (an iOS device build) has those components' names looked for in its libraries
instead: weaker (a name compiled in, not its registration), and only for the codecs, filters, formats and bitstream
filters. A target's `tests:` scripts don't run for these builds.

On Windows, `.sh` tests run with Git Bash (`BASH`, else the one beside `git`, else the usual install folders; never
WSL's `bash.exe`), `.cmd` and `.bat` with `cmd.exe`, and `.ps1` with `pwsh` (or Windows PowerShell). Elsewhere every
test runs with `bash`.

### Tests that need a secret

A target's `test-env:` names the environment variables its `tests:` scripts get
([targets](targets.md#tests)). In CI, the workflow that calls `build.yml` passes their values in one secret,
`test-env`, as `NAME=value` lines, and names only the repository secrets it means to share:

```yaml
jobs:
  release:
    uses: devenvy/ffmpeg-build/.github/workflows/build.yml@v0
    permissions:
      contents: write
    with:
      publish: changed-only
    secrets:
      test-env: |
        DECRYPT_KEY=${{ secrets.DECRYPT_KEY }}
```

- **Only the tests get it.** `build.yml` hands the secret to its test steps alone, never to a build step.
  `ffmpeg-build test` takes it out of its own environment before it starts anything (so the smoke test's `ffmpeg`, and
  every other process, never sees it), masks each value in the log (`::add-mask::`), and gives each target's scripts
  only the names that target's `test-env:` lists. A script in a container (musl in Alpine, linux-armhf in Debian) gets
  it as `docker run -e DECRYPT_KEY`: docker takes the value from its own environment, so it is never on a command line.
  Natively, the scripts keep the rest of the environment as before.
- **One line per value.** Everything after the first `=` is the value, as written; blank lines and `#` comments are
  skipped. A value that spans lines (a PEM key) goes in base64, and the script decodes it (a decoded value isn't
  masked: don't print it). A line that isn't `NAME=value`, a name given twice, or one `test` sets itself (`FFMPEG`,
  `FFPROBE`, `FFMPEG_DIR`, `FFMPEG_TARGET`, `FFMPEG_PLATFORM`) stops the test, naming the line by its number only.
- **Without the secret, the tests still run.** A run that has no secrets (a pull request from a fork; a repository
  without the secret) passes `DECRYPT_KEY=` with nothing after it, and an empty value counts as not given: the variable
  isn't set, and `test` says so (`- test-env: DECRYPT_KEY not set, ...`). Write the script to skip what needs it:

  ```bash
  if [ -z "${DECRYPT_KEY:-}" ]; then
    echo "DECRYPT_KEY not set (no secrets in this run): skipping the encrypted sample"
    exit 0
  fi
  ```

  A name `test-env` doesn't give comes from the environment `test` runs in, so locally `DECRYPT_KEY=... ffmpeg-build
test --target <name>` works the same way.

- **What it doesn't protect against.** Whoever can change the folder's scripts, `ffmpeg-build.yml` or the workflow can
  read the secret: a test script is the repository's own code. Never pass `test-env` from a `pull_request_target`
  workflow (it would run a fork's scripts with your secrets); a `pull_request` run from a fork gets none, by GitHub's
  rules. The test steps run on the same runner as the build that came before them, so the build's inputs (the recipes,
  the engine, the libraries' sources) are trusted as much as the secret is.
- **Engine version.** `test-env:` needs an engine newer than v0.0.9 (the lock's `engine:`): an older one refuses the
  key in `ffmpeg-build.yml`, and ignores the secret.

### What CI tests

`build.yml` tests each target right after building it, on the runner it builds on (`platforms.yml` `runner:`), and
a build that runner can't run in a `test` job on the runner that can (`test-runner:`). The release, and `all-builds`,
need both. Exactly:

| Platform                           | Executed                               | Where                                                                                                               |
| ---------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| linux-x64, linux-arm64             | `ffmpeg`, `ffprobe` and `tests:`       | its build runner (ubuntu-24.04, ubuntu-24.04-arm)                                                                   |
| linux-musl-x64, linux-musl-arm64   | the same, in plain Alpine              | its build runner (ubuntu-24.04, ubuntu-24.04-arm)                                                                   |
| linux-armhf                        | the same, in Debian armhf under qemu   | its build runner (ubuntu-24.04)                                                                                     |
| osx-arm64, osx-x64                 | the same (osx-x64 under Rosetta)       | its build runner (macos-15)                                                                                         |
| win-x64, win-arm64                 | the same (`.exe`)                      | the test job: windows-2025, windows-11-arm                                                                          |
| android-x64, android-arm64         | the smoke program, linked with the NDK | an x86_64 Android 15 emulator (KVM) on its build runner; android-arm64 through the system image's arm64 translation |
| ios-sim-arm64                      | the smoke program                      | the iOS simulator on its build runner (macos-15)                                                                    |
| maccatalyst-arm64, maccatalyst-x64 | the smoke program                      | its build runner (macos-15; x64 under Rosetta)                                                                      |

**Link-checked only:** ios-arm64 (the smoke program links against its frameworks with the iPhoneOS SDK; it runs only
on a device; what its options ship is looked for by name in the frameworks). The xcframework bundle a release makes from the four Apple builds is not tested again; its slices are
the archives tested above.

**Not tested:** the `-dev` archives of the platforms with programs (nothing links against their headers and import
libraries in CI), hardware acceleration (VAAPI, NVENC, VideoToolbox, MediaCodec, Vulkan: runners have no such
devices; that the build has them is checked), and anything a target's `tests:` don't cover. The checks above prove
each library a target adds is in the build, not that it works; `tests:` are where a target says what it needs to
work.

The `tests:` input of `build.yml` limits this: `all` (the default) runs everything above; `build-runner` runs only
what the build runners run (no Windows test runners: in a private repository GitHub bills Windows minutes at twice and
macOS at ten times the Linux rate, and the Apple builds already run on macOS); `none` runs nothing. A test step on a
build runner adds a few minutes (the Android emulator and the iOS simulator boot each time).

## Toolchains

| Platforms                                                    | Where it builds                    | Notes                                                                                                                                                             |
| ------------------------------------------------------------ | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| linux-x64, linux-arm64                                       | manylinux_2_28 image               | runs on glibc 2.28+                                                                                                                                               |
| linux-musl-x64, linux-musl-arm64                             | Alpine image                       | libstdc++ and libgcc linked statically: runs on any musl system                                                                                                   |
| linux-armhf                                                  | Debian bookworm cross image        |                                                                                                                                                                   |
| win-x64, win-arm64                                           | Ubuntu with mingw-w64 / llvm-mingw | cross-compiled; C and C++ runtimes static; an MSVC import `.lib` per DLL                                                                                          |
| android-arm64, android-x64                                   | Ubuntu with the Android NDK        | API 28+, or the target's `android-api:` ([older Android](targets.md#older-android-android-api)); 16 KB page alignment checked; ships the NDK's `libc++_shared.so` |
| osx-arm64, osx-x64                                           | natively on a Mac (Xcode)          | flat, relocatable dylibs (macOS 11.0+); osx-x64 cross-compiles on Apple silicon                                                                                   |
| ios-arm64, ios-sim-arm64, maccatalyst-arm64, maccatalyst-x64 | natively on a Mac (Xcode)          | one `.framework` per FFmpeg library; a release ships the four as xcframeworks ([iOS bundle](releases.md#ios-and-mac-catalyst-the-xcframework-bundle))             |

[`platforms.yml`](../platforms.yml) says which platforms build, in which image, and on which CI runner. Node creates
each compiler environment and CMake/Meson cross file in `src/build/toolchain.ts`, while `src/build/stage.ts` lays out
and checks the archives. Images are built locally the first time from `images/<name>/Dockerfile` (base images pinned
by digest, downloads and pip packages by sha256, git sources by commit, checked after the fetch).

Each library is cached under `~/.cache/ffmpeg-build` (`FFMPEG_BUILD_CACHE`), keyed by its recipe, version, platform,
toolchain and the libraries it builds against, so a rebuild only compiles what changed. On Linux hosts the build hands the archives
and cache files back to your user when it ends (the container runs as root).

A build writes its archives, `<name>.sources.json`, the `<name>.sources/` folder and its log into a staging folder of
its own inside `--out`, and they replace the previous ones only when it succeeds: a failed or stopped build (Ctrl-C,
SIGTERM) leaves the previous complete set in place, with the failed build's log. Two builds of the same target into
the same `--out` don't run at once; the second says so.

### The library cache: `ffmpeg-build cache`

| Command                             | What it does                                                                                                                                                                              |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cache path`                        | prints the cache folder                                                                                                                                                                   |
| `cache list [--json]`               | each cached library: version, size, and how long since a build last used it                                                                                                               |
| `cache verify [--fix]`              | checks every entry's source record, and that the source it kept matches the sha256 it records; exit 1 when one is bad. `--fix` removes the bad entries (the next build builds them again) |
| `cache prune [--older-than <days>]` | removes entries and kept sources no build used in that many days (default 30), and what crashed runs left (`*.tmp.*`)                                                                     |
| `cache clear`                       | empties it: the next build builds every library again                                                                                                                                     |

`prune`, `clear` and `verify --fix` never delete under a running build: each build registers itself in the cache while
it runs, and they refuse (exit 2) until it ends; a build doesn't start while one of them runs. A starting build also
removes what crashed runs left in the cache. When a download no longer matches the copy the cache kept (upstream
replaced a release file), delete that file under `sources/` and run `cache verify --fix`, which removes the entries
built from it.

### Without Docker: `--in here`

`ffmpeg-build build --in here` builds on this machine with its own toolchain instead of the platform's image:

| Platforms                   | On                                                                                    | Needs                                                                                                                                                                                                                                                |
| --------------------------- | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| linux-x64, linux-arm64      | a glibc Linux machine of that architecture                                            | its compilers and build tools (`apt-get install build-essential cmake meson ninja-build nasm pkg-config git curl autoconf automake libtool binutils patchelf xxd python3 gperf xz-utils diffutils`; Vulkan builds also a glslc that does Vulkan 1.4) |
| win-x64, win-arm64          | Windows, run from an MSYS2 shell: MINGW64 or UCRT64 (win-x64), CLANGARM64 (win-arm64) | MSYS2's MinGW compiler, cmake, meson, ninja, nasm, pkgconf, tools-git and llvm (and shaderc for Vulkan), plus make, git, autotools, perl, vim (xxd), python, gperf, xz and diffutils                                                                 |
| osx-_, ios-_, maccatalyst-* | a Mac                                                                                 | Xcode and the Homebrew tools in `platforms/apple-brew.txt` (Apple always builds this way)                                                                                                                                                            |

It checks the tools before building and names what's missing, with the install line. The default is `ffmpeg-build.yml`'s
`build:` section (`in: here`), else Docker (Xcode for Apple); `--in docker` or `--in here` overrides it. A native
build is only as reproducible as the machine: its library cache key holds the compiler and tools' versions (an upgrade
rebuilds), and releases record it as a different toolchain from the Docker build. The Docker images stay the
recommended way to make releases; `examples/native` is what CI builds natively (`toolchains.yml`).

### arm64 Linux on an x64 host

linux-arm64 and linux-musl-arm64 build in arm64 images. On an x64 host Docker runs them under qemu (slowly; CI uses
arm64 runners instead), with qemu 8.1.5: under qemu 9.2 the manylinux image's tar can't create nested folders.
Register it (again after every Docker restart, which forgets it), replacing any arm64 emulator already there
(`--install` fails with "file exists" when qemu-user-static or Docker Desktop registered one, and the old one stays):

    BINFMT=mirror.gcr.io/tonistiigi/binfmt:qemu-v8.1.5@sha256:2d2918e86e5327d0661f7083d67a95280b0f7be8f77ed79a8418f81d7d90ce6f
    docker run --privileged --rm $BINFMT --uninstall qemu-aarch64
    docker run --privileged --rm $BINFMT --install arm64
    # Registered? ("enabled" and its interpreter; the qemu version isn't shown)
    docker run --privileged --rm mirror.gcr.io/library/alpine:3.24.2 sh -c \
      'mount -t binfmt_misc binfmt_misc /proc/sys/fs/binfmt_misc; cat /proc/sys/fs/binfmt_misc/qemu-aarch64'
    # A qemu that works: prints ok (qemu 9.2 prints "Cannot mkdir: Invalid argument")
    docker run --rm --platform linux/arm64 quay.io/pypa/manylinux_2_28_aarch64:2026.09.30-1 \
      sh -c 'mkdir -p /a/b/c && tar -cf /t.tar /a && mkdir /x && tar -xf /t.tar -C /x && echo ok'

### Apple

Apple platforms build natively on a Mac with Xcode, not in a container. Install Xcode (and select it with
`sudo xcode-select -s /Applications/Xcode.app/Contents/Developer`) and the Homebrew build tools in
[`platforms/apple-brew.txt`](../platforms/apple-brew.txt). Libraries are built into `~/ffmpeg-build-work`
(`FFMPEG_BUILD_WORK`), one build per platform at a time. Checking an osx-x64 build on Apple silicon runs it under
Rosetta (`softwareupdate --install-rosetta --agree-to-license`); without it, the check says so and skips running.

## OpenCL and the machine a build runs on

A build with `opencl` on starts on any machine of its platform, GPU or not. On Linux and Windows, the Khronos OpenCL
ICD loader is linked into libavutil statically, and finds the GPU vendors' OpenCL drivers at run time as the system's
loader would (`/etc/OpenCL/vendors` on Linux, the registry on Windows). So an OpenCL build needs no OpenCL loader installed, only a driver to have a device to use;
without one, OpenCL lists no platforms and everything else works. On macOS it uses the system's OpenCL framework.

Khronos recommends the shared loader instead (`libOpenCL.so.1`, `OpenCL.dll`, which GPU drivers install), so that
vendors and users can update it. It isn't used here because FFmpeg links OpenCL at load time: an ffmpeg linked to the
shared loader would refuse to start on a machine without one, even for work that never touches a GPU. The built-in
loader is the one Khronos publishes (Apache-2.0, so in v3 builds only) and is updated with the lock like any library.

## What's in an archive: `THIRD-PARTY-NOTICES.txt`

Both archives carry one plain-text file at their root, `THIRD-PARTY-NOTICES.txt`, with every licence and notice the
build needs. FFmpeg comes first:

- **The header:** FFmpeg's version, the target and platform, the ffmpeg-build version; the effective license and why
  (what needs version 3, which TLS library a v2 build uses, or that a nonfree build is not redistributable); and, when
  the target has patch sets, that FFmpeg was modified and by which.
- **BUILD:** FFmpeg's configure line as built (what `ffmpeg -buildconf` prints), the platform and the toolchain
  identity.
- **SOURCE:** where the complete corresponding source is. A build in a release of a public repository names the
  release's sources archive by its download URL. One in a release of a private repository (nobody outside it can open
  that URL) names the archive and makes a written offer of it instead; so does a build in no release, whose source is
  recorded in `<name>.sources.json` and kept in the cache (keep its sources archive while the offer holds). The offer
  names who to ask: `source-offer:` at the top of `ffmpeg-build.yml` (an email address, say), else whoever
  distributed the build. With `source-offer:` set, a public release makes the offer too. A nonfree build makes none:
  it isn't distributed. The build reads the release repository's visibility as it builds, and fails if it can't. It
  also links the build definition at its commit (`FFMPEG_BUILD_SOURCE_REPO` and
  `FFMPEG_BUILD_SOURCE_REF` when set, as CI does, else the folder's git remote and HEAD, `-dirty` with local changes),
  and FFmpeg's upstream tarball. The release and its repository come from `FFMPEG_BUILD_RELEASE` (the build workflow
  sets it) and `GITHUB_REPOSITORY` or the folder's remote.
- **FFMPEG:** its `LICENSE.md` and `CREDITS`, then the COPYING texts that govern the build's license, in full.

Then the rest, each part under its own `=====` rule:

- **COMPONENTS:** one section per library, sorted by name: `== <recipe> <version> ==`, its SPDX licence, its upstream
  origin and commit, and every file its recipe declares in `license-files:` in full, each headed `--- <path> ---` (a
  build fails when one is missing);
- **PATCH SETS:** each set's name, licence, sha256 and patches, and its licence texts;
- **FILES THE PLATFORM SHIPS:** what the toolchain contributes (Android's libc++_shared.so, Windows' winpthreads), each
  with its licence and notice.

The libraries' texts are captured into each library's install tree when it is built, so a library from the cache
brings them along. devenvy/ffmpeg's archives had a `legal/` folder instead; the owner chose one file.

## What a build was made from

What a build fetches is what `ffmpeg.lock` pins ([targets](targets.md#rules)): a git source is checked out by its
tag and must be at the commit the lock records, and a tarball must have the lock's sha256 before it is unpacked,
whichever mirror it came from (one `lock` already downloaded is taken from the cache, not downloaded again). A
mismatch stops the build, naming the library, the pin and what came instead. A lock written before pins builds
without these checks, and `check` says to run `ffmpeg-build lock`.

Every source a build fetches is kept in the cache under `sources/` (a tarball as downloaded, a git checkout as
`git archive` of its exact commit with its submodules), and `<name>.sources.json` beside the archives lists FFmpeg,
every library and the patch sets, each with its origin, sha256 and commit. A cached library whose kept source is gone,
or that was built from other content than the lock pins, is built again, so a build can always say exactly what it was
made from. A release bundles these into its sources archive ([releases](releases.md)).

A cache entry is trusted only after it is checked: its source record must name that library, a sha256 and (for git) a
full commit, and a kept source inside `sources/`; and every member must stay inside the dependency folder (no absolute
path, no `..`, no link out of it, nothing written through a link) before tar unpacks it. An entry that fails is
deleted (the entry only, never a path it names) and the library built again.

## Comparing with published builds

`scripts/compare-published*.sh` compare a build with a published devenvy/ffmpeg archive: files, configure flags,
registered components, sonames and dependencies (or DLL imports, or Mach-O facts) and symlinks. The published
archives' `legal/` against our `THIRD-PARTY-NOTICES.txt` is one expected difference per platform.
Differences that are understood are listed, each with its reason, in `scripts/compare-published.expected` and
`scripts/compare-published-apple.expected`; anything else fails.
