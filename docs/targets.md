# Targets: ffmpeg-build.yml

A folder's `ffmpeg-build.yml` lists its builds. Each **target** is one build: one platform, one license, one FFmpeg
series, and the complete list of what it gets. **Bases** hold what several targets share; a target takes its bases
left to right, then its own lists. Nothing is added by itself, not by an engine release and not by a new FFmpeg
version, so a tight target (a streaming server's five libraries) stays tight.

```yaml
pin: # npm-style ranges, for every target that builds the library
  dav1d: '~1.5.4'
bases:
  streaming: { with: [dav1d, opus, srt, openssl] }
targets:
  linux-x64: # the name is also the build's: ffmpeg-<version>-linux-x64
    platform: linux-x64
    license: lgplv3 # lgplv2, lgplv3, gplv2, gplv3 or nonfree
    ffmpeg: 9 # 9, 9.0 or latest
    base: [streaming]
    with: [vaapi] # by FFmpeg's own names
  linux-arm64:
    platform: linux-arm64
    license: lgplv3
    ffmpeg: 9
    base: [streaming]
    without: [opus] # turn down what a base gives; never suggested again
```

The editor schema is [`schema/ffmpeg-build.schema.json`](../schema/ffmpeg-build.schema.json); `init` starts the file
with a `# yaml-language-server: $schema=...` line, so editors with the YAML language server (VS Code's YAML extension,
for one) complete and check it. Add that line to a file you wrote by hand to get the same.

## Starting and editing

- **Start from the shipped targets.** You don't need to work out what each license allows on each platform yourself.
  [`profiles/devenvy.yml`](../profiles/devenvy.yml) is everything devenvy/ffmpeg publishes, one target per platform,
  license and FFmpeg series. `ffmpeg-build init --license <list> --platforms <list> [--ffmpeg <list>]` takes the
  targets you select (both lists are required; `all` takes every license or platform) and factors what they share into bases. `--empty` gives bare targets.
- **Edit with the helpers, or by hand.** Each helper keeps your comments and checks every target the edit reaches
  first: an edit that would give one a problem (x264 on an lgplv3 target) is refused, and nothing is written:

      ffmpeg-build profile add x265 srt --to gpl           # a base: every target using it
      ffmpeg-build profile add vaapi --to linux-x64        # one target
      ffmpeg-build profile remove opus --from linux-arm64  # a target turns down what its base gives it
      ffmpeg-build profile missing                         # what targets could add but don't list (exit 1 if any)

- **Look before you build.** `check` says whether every target is possible, `plan` what each builds,
  `show <target>` what one target gets and which base gave it, and `show --has <name>` which targets get something
  and why the others don't.

## Some targets at a time, and where they build

One file holds every build; a run can take some of them. `build`, `test`, `check`, `plan`, `targets` and `releases`
take `--target a,b` (names) and `--platform 'linux-*,win-x64'` (platform patterns, as the file writes them); both
together mean targets that match both. `build` builds each chosen target in turn:

    ffmpeg-build build --platform 'osx-*,ios-*,maccatalyst-*'   # on the Mac
    ffmpeg-build build --platform 'linux-*,win-*'               # on the Linux box

The optional `build:` section says where (a CI `runner`: a GitHub `runs-on` label, or a list of labels) and how
(`in: docker`, the pinned image; `in: here`, natively on that machine) a platform's targets build. Keys are platform
patterns; later entries override earlier ones, key by key. Without it, each platform builds where and how
`platforms.yml` says: Linux, Windows and Android in Docker on Linux runners, Apple natively on macOS runners.

```yaml
build:
  win-*: { runner: windows-2025, in: here } # native Windows builds on a Windows runner
  osx-*: { runner: [self-hosted, macOS, ARM64] } # your own Mac
```

- `check` refuses what can't work, before anything builds: Apple off a Mac or in Docker, Docker off Linux, `here` for
  another machine than the runner (`in: here` is for linux-x64, linux-arm64, win-* and Apple). A runner label it
  can't read (most self-hosted ones) is trusted, and `check` says so.
- A native build depends on its machine, so `in: here` and its runner are part of the target's toolchain: changing
  them makes its release due, and its libraries are cached apart. A Docker build is the same wherever it runs.
- A release is published with all its targets. Builds that come from somewhere else (another machine, another
  workflow) get their own `release-group:`, so they are their own release.

## Slimmer builds: components

`with:` picks libraries. FFmpeg's own components (its built-in decoders, encoders, demuxers, muxers, parsers,
bitstream filters, protocols, devices and filters) are all built unless a target says otherwise. `components:` says
otherwise, kind by kind: a kind it lists is built with only those names; a kind it leaves out keeps FFmpeg's defaults.
Leave `components:` out and nothing changes.

```yaml
bases:
  server: # what the services use, nothing else
    components:
      decoders: [h264, hevc, aac, pcm_s16le, mjpeg]
      demuxers: [mov, matroska, mpegts, rtsp]
      muxers: [mp4, matroska, mpegts, image2]
      filters: [scale, fps, aresample]
      protocols: [file, pipe, tcp, udp, rtp]
targets:
  linux-x64:
    platform: linux-x64
    license: gplv3
    ffmpeg: 9
    base: [server]
    with: [x264, vaapi, whisper]
    components:
      filters: [scale, fps, aresample, drawbox] # replaces the base's filters; its other kinds stay
```

- **Kinds:** `decoders`, `encoders`, `hwaccels`, `demuxers`, `muxers`, `parsers`, `bsfs`, `protocols`, `indevs`,
  `outdevs`, `filters`. Names are FFmpeg's, as `ffmpeg -decoders` (and the rest) lists them.
- **What the target's options need comes along.** `x264` keeps the `libx264` encoder, `whisper` its filter, `vaapi`
  its hwaccels and filters, whatever the lists say; a patch set's `configure:` flags enable what it adds. FFmpeg's
  configure then brings in what each component it builds depends on (the parsers and bitstream filters a decoder or
  muxer uses).
- **Checked.** `check` refuses a name FFmpeg doesn't have in that major (the engine keeps each major's lists, from its
  newest release, in `ffmpeg/components/<major>.yml`), and a library's component whose option is off (`libx264` needs
  `x264` in `with:`). `test` fails a build missing a listed decoder, encoder, demuxer, muxer, protocol or filter.
- **A layer replaces a kind.** A target takes each kind from the last of its bases and itself that lists it.
- **Releases.** Changing a target's `components:` makes its release due (its definition changed).

## Patches

A target can carry your own changes to FFmpeg: `patches:` names patch sets, each a folder inside the build folder
(the one holding `ffmpeg-build.yml`; a path outside it is refused, because the folder goes into the release's sources
archive at the same path).

```
ffmpeg-build.yml
patches/
  acme-muxer/
    about.yml          # what the set is, and its licence
    LICENSE            # the licence text the archives carry
    9/                 # the patches for FFmpeg 9
      0001-add-acme-muxer.patch
      0002-acme-muxer-docs.patch
    10/                # and for FFmpeg 10, when the set supports it
      0001-add-acme-muxer.patch
```

```yaml
# patches/acme-muxer/about.yml
name: acme-muxer
license: proprietary # SPDX, or proprietary; licenses.yml says which build licenses it may go into
license-files: [LICENSE] # at least one, relative to this folder
ffmpeg: [9, 10] # the FFmpeg majors it has patches for (a major, or a list of them)
```

```yaml
# ffmpeg-build.yml
targets:
  linux-x64-nonfree:
    platform: linux-x64
    license: nonfree # a proprietary patch set can only go into nonfree builds
    ffmpeg: 9
    patches: [patches/acme-muxer]
```

- **Applying.** Before FFmpeg is configured, each set the target names (in the order `patches:` lists them) has the
  `.patch` and `.diff` files of its `<major>/` folder applied to FFmpeg's source, in name order, with
  `git apply -p1` (so `git format-patch` output works as it is). A patch that doesn't apply stops the build, naming the
  set and the file: update it for that FFmpeg version.
- **Checked first.** `check` refuses a set without `about.yml` or with a malformed one, a licence file that isn't
  there, an `ffmpeg:` entry that isn't a major (`9`, not `9.1`), a licence the target's license doesn't allow (the
  same table as libraries), a major the target builds that `ffmpeg:` doesn't list, and a listed major without its
  `<major>/` folder. `about.yml` may also hold `configure:`, FFmpeg configure flags what the patches add needs (say
  `--enable-muxer=acme`): they go on the configure line of every target that uses the set, after the target's own.
- **Recorded.** `THIRD-PARTY-NOTICES.txt` says FFmpeg was modified, lists each set with its patches and a sha256 of
  the whole set, and carries each set's licence texts in a PATCH SETS section; its source section points at the
  sources archive, which holds the patch set folders beside `ffmpeg-build.yml` and `ffmpeg.lock`.
  `<name>.sources.json` and the release's `manifest.yml` record each set's name and sha256.
- **Releases.** Changing anything in a set (a patch, `about.yml`, a licence file, any major's folder) makes the
  releases of the targets using it due, and `bundle` refuses a build made with other patches than the folder has now.

## Rules

- **Saying no is explicit.** `without:` turns something down for good: `profile missing` and the update PR text stop
  suggesting it.
- **Licenses are checked, never guessed.** An option whose library a target's license doesn't allow is an error that
  says which licenses would allow it. Which licenses each library may go into is in
  [`licenses.yml`](../licenses.yml): an SPDX table, applied to the library and everything it needs. Optional pieces
  are built in only where their license allows, and `check` says where they are left out (SRT's encryption uses
  mbedTLS, which lgplv2 builds can't take).
- **One version per library.** `ffmpeg.lock` holds one FFmpeg release per series and one version per library for the
  whole folder. Pins (`pin:` at the top for every target, or on a target) are constraints the chosen version must
  meet, all of them. Pins use npm's range syntax: `"4.3"`, `"~1.5.4"`, `"^1.5.4"`, `">=3.6 <4"`; a library that
  follows a branch is pinned to a full commit hash.
- **The lock pins content, not just versions.** Beside each version, `ffmpeg.lock` records what it stands for: a
  library released as git tags gets the full commit its tag names (`git ls-remote`, through an annotated tag), and a
  tarball (FFmpeg's own too) its sha256. A library that follows a branch needs nothing more: its version is a commit.
  `lock` downloads each tarball once to hash it, into the build cache's `sources/` (`FFMPEG_BUILD_CACHE`), so the
  build doesn't download it again. A pin is kept as long as its version is; `update` pins each version it moves to.

  ```yaml
  ffmpeg:
    '9':
      { version: 9.0.2, sha256: 8c3850283eb25fa026482078a04051e0be17347b09ef81a0849bec15a96e002e }
  libraries:
    dav1d: { version: 1.5.4, commit: 54706fc6bc0cdecab7e9593974a4039cc038fca7 }
    gmp:
      { version: 6.3.0, sha256: a3c2b80201b89e68616f4ad30bc66aee4927c3ce50e33929ca819d5c43538898 }
    x264: b35605ace3ddf7c1a5d67a2eb553f034aef41d55 # follows a branch: the version is the commit
  ```

  A build fetches by the version, then checks: a git checkout must be at the pinned commit, and a tarball, from any
  mirror, must have the pinned sha256 before it is unpacked. Anything else stops the build with the library, the pin
  and what came instead (a mirror whose archive differs is passed over for the next; FFmpeg's fallbacks are copies of
  ffmpeg.org's own tarball, so they can stand in for it).
  A cached library built from other content than the pin is built again. A lock written before pins (versions only)
  still builds, unchecked, and `check` notes `run ffmpeg-build lock to pin sources`; `lock` adds the pins without
  moving a version.

- **New FFmpeg versions.** When `update` moves to a new FFmpeg minor, the PR text lists what it adds and which
  targets don't list it. When a new major is out, it says so (`notify: { new-ffmpeg: false }` turns that off): in
  the PR text, on stderr, and, in `update-lock.yml`, as a warning on every run until the folder builds it, even when
  the lock didn't change and there is no PR.
  You decide; nothing is opted in.
- **Versions come from upstream.** `lock`, `outdated` and `update` read upstream git tags, branches and release
  pages (they need `git` on PATH, and no API tokens).

## Old matrix profiles

Before targets, a profile was one file with `platforms:` and `license:` lists and conditional entries.
`ffmpeg-build migrate` turns a folder of them, and its lock, into `ffmpeg-build.yml` and one lock that build exactly
the same, with the same asset names. The old files are kept as `*.old`. Every other command in such a folder says to
run `migrate`.
