# Targets: ffmpeg-build.yml

Some libraries offer a verified choice of linking mode. A target or base can use `link: { libgcrypt: shared }`,
keyed by recipe name. Unspecified libraries keep their existing defaults; selecting a shared library does not
change its dependencies' modes. `ffmpeg-build plan` shows the resolved choices. At present, libgcrypt and
libgpg-error, zlib, xz (liblzma), aom, dav1d, soxr and libbs2b offer static and bundled shared modes on Linux x64,
with static as their default. Shared libraries
are included beside FFmpeg; this setting does not link to an arbitrary system installation. Other recipes reject
linking overrides until a mode has been verified for them.

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
    ffmpeg: 9 # 9, 9.0 or latest (the newest major: see below)
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

`with:` takes the options of [`ffmpeg/<major>.yml`](../ffmpeg/9.yml). Everything else FFmpeg's configure can turn on is
in [`ffmpeg/unsupported.yml`](../ffmpeg/unsupported.yml) with the reason it isn't built: most are still to come
(tracked in [issue #21](https://github.com/devenvy/ffmpeg-build/issues/21)), a few never will be (deprecated
upstream, or for a platform the engine doesn't build).

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

## Always the newest FFmpeg: `ffmpeg: latest`

`ffmpeg:` is a major (`9`: its newest release), a minor (`9.0`: its newest 9.0.x) or `latest`: the newest FFmpeg
major this engine supports. A base can say it too, for every target that takes the base and doesn't say its own (a
target's own `ffmpeg:` wins; otherwise the last of its bases that has one):

```yaml
bases:
  newest: { ffmpeg: latest }
targets:
  linux-x64: { platform: linux-x64, license: lgplv3, base: [newest, streaming] }
  win-x64: { platform: win-x64, license: lgplv3, base: [newest, streaming] }
  legacy: { platform: linux-x64, license: lgplv3, base: [newest, streaming], ffmpeg: 8 } # held back
```

- **What latest is.** The newest major with an `ffmpeg/<major>.yml` in the engine (added, with its component list,
  once someone has gone through that major's configure) that has a release upstream. A new FFmpeg major therefore
  reaches `latest` through an engine release, never straight from upstream.
- **The lock says which major.** `ffmpeg.lock` records the release `latest` stands for (`latest: 9.0.2`), so every
  build is reproducible and `lock` never moves it. `update` does: when the engine knows a newer major, the lock
  update's pull request moves every `latest` target to it (with the engine release that brought the major), and the
  lock's diff is the move (`latest: 9.0.2` -> `latest: 10.0.1`).
- **The PR says what it means.** Its text opens with `⚠ FFmpeg latest is now 10: a and b move from 9.0.2 to 10.0.1`,
  lists what `check` finds wrong with them on FFmpeg 10 (a `components:` name FFmpeg 10 doesn't have, a patch set
  without a `10/` folder or not declaring 10 in its `about.yml`, a `with:` FFmpeg 10 dropped) and what their releases
  would lose, and says how to stay: `ffmpeg: 9` on a target. `update` and `outdated` print the same on the terminal.
- **CI decides.** The move is one more change in the lock update's PR, which your CI checks like any other. The
  example `ci.yml` runs `check.yml`: `check` and `releases` stop it on everything the PR text lists. To stop it on
  the builds too (a patch that no longer applies fails the build, naming the patch and the file and line of the hunk
  that failed), `ffmpeg-build test` and your own tests, have the PR's CI call `build.yml` with `publish: never` and
  `due: true` ([CI](releases.md#ci-github-actions)); otherwise the release builds after the merge, and a failing
  build keeps that release a draft. Fix the folder on your default branch (add the `10/` patches, change the
  `components:`, or keep a target with `ffmpeg: 9`); the next update refreshes the PR. Automerge merges only a green
  PR; making CI's `result` a required check stops a merge by hand too.
- **When no lock fits.** If no lock can be chosen for the folder on the new major at all (a pin on a library no
  target builds any more there), `latest` stays where it is, the rest of the update goes ahead, and the PR text and
  `update-lock.yml`'s run say why (`FFmpeg latest stays on 9: on FFmpeg 10.0.1, pin ...`), every run until it's fixed.
- **Releases.** A release is one release group at one FFmpeg version, so `latest` targets moving to 10 make new
  releases, tagged `10.x.y.<build>`, and the group's 9.x releases stay as they were. The first release on the new
  major is judged against the group's last release on the old one: a library it no longer has stops it unless
  `allow-removal:` says so.

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

## Older Android: `android-api`

An Android build is compiled for API level 28 (Android 9): the oldest Android its libraries load on. An app with a
lower `minSdk` sets the level on its android targets, from 21 to 35:

```yaml
targets:
  android-arm64:
    platform: android-arm64
    license: lgplv3
    ffmpeg: 9
    with: [dav1d, opus, mediacodec, jni]
    android-api: 24 # loads on Android 7.0+
```

- **What can't go lower.** Some options and libraries need Android 9's APIs, and `check` refuses a target that has one
  and a lower level, naming it: `iconv` (Bionic's iconv is API 28's), `whisper` (whisper.cpp links Android's Vulkan
  1.1 library directly), and `vulkan` and `placebo` (they build for any level, but FFmpeg's Vulkan needs a Vulkan 1.3
  device, and Android has Vulkan 1.1 only from Android 9). Their `android-api:` in
  [`ffmpeg/<major>.yml`](../ffmpeg/9.yml) and the recipes says so.
- **iconv.** FFmpeg finds the C library's iconv by itself on Android 9 and up, whether or not a target lists `iconv`;
  a build for an older level has none (no `-sub_charenc`).
- **What it changes.** The NDK's compilers for that level build FFmpeg and every library (`aarch64-linux-android24-clang`,
  CMake's `ANDROID_PLATFORM=android-24`), and `ffmpeg-build test` links its smoke program for that level, so a library
  that calls what that Android lacks fails the link. The libraries are cached per level, and setting `android-api:`
  makes the target's release due. Leaving it out keeps 28, and the build it always had.
- **What CI runs.** The tests run the build on an Android 15 emulator; a level below 28 is checked by the compile and
  that link, not on an old Android.

## Slimmer builds: components

`with:` picks libraries. FFmpeg's own components (its built-in decoders, encoders, demuxers, muxers, parsers,
bitstream filters, protocols, devices and filters) are all built unless a target says otherwise. `components:` says
otherwise, kind by kind: a kind it lists is built with only those names, and what comes with them; a kind it leaves out
keeps FFmpeg's defaults. Leave `components:` out and nothing changes.

```yaml
bases:
  slim: # what every platform's services use, and what `ffmpeg-build test` needs (wrapped_avframe, null, testsrc2)
    components:
      decoders: [h264, hevc, aac, pcm_s16le, mjpeg, wrapped_avframe]
      encoders: [aac, mjpeg, wrapped_avframe]
      demuxers: [mov, matroska, mpegts, rtsp]
      muxers: [mp4, matroska, mpegts, image2, null]
      filters: [scale, fps, aresample, testsrc2]
      protocols: [file, pipe, tcp, udp, rtp]
targets:
  linux-x64:
    platform: linux-x64
    license: gplv3
    ffmpeg: 9
    base: [slim]
    with: [x264, vpx, vaapi, nvenc, whisper] # libx264, libvpx_vp8/vp9, the VAAPI and NVENC encoders, whisper come along
    patches: [patches/acme-format] # and the demuxer, muxer and codec it adds
  win-x64:
    platform: win-x64
    license: gplv3
    ffmpeg: 9
    base: [slim]
    with: [x264, mediafoundation, amf, d3d11va]
    components:
      filters: { add: [drawbox] } # the base's filters, and drawbox
```

- **Kinds:** `decoders`, `encoders`, `hwaccels`, `demuxers`, `muxers`, `parsers`, `bsfs`, `protocols`, `indevs`,
  `outdevs`, `filters`. **Names are configure's**, as `./configure --list-decoders` (and the rest) lists them, and as
  the engine keeps them in `ffmpeg/components/<major>.yml`. Most are what `ffmpeg -decoders` lists too; where a build
  lists a component by another name (configure's `libvpx_vp8` is `libvpx` in `ffmpeg -encoders`, the `pcm_s16le`
  demuxer is `s16le`, the `libsrt` protocol is `srt`), `check` says which name to write.
- **What the target's options need comes along.** For the options that are the components they bring (the codec
  libraries, the hardware APIs, whisper: the major's `auto-components:` in `ffmpeg/<major>.yml`), every component of a
  listed kind that needs the option stays: `vaapi` keeps `h264_vaapi`, `hevc_vaapi`, `av1_vaapi`, the VAAPI hwaccels
  and filters; `nvenc` the NVENC encoders, NVDEC hwaccels and CUVID decoders; `vpx` `libvpx_vp8` and `libvpx_vp9`. What
  needs what is configure's own rules, read from each release (`needs:` in `ffmpeg/components/<major>.yml`; that includes
  its licence switches: a GPL-only filter comes only in a gpl build). A support
  library brings nothing by itself: with `zlib` on, list `png` if you want it; with `openssl`, list `https` and `tls`;
  with `xml2`, `dash`. FFmpeg's configure then brings in what each component it builds depends on (the parsers and
  bitstream filters a decoder or muxer uses).
- **What the target's patch sets add comes along**, as each set's `about.yml` declares it (`adds:`, under Patches).
- **Checked.** `check` refuses a name FFmpeg doesn't have in that major (or that no patch set of the target adds), and
  a component whose option isn't on: `libx264 comes with x264: add x264 to with:`,
  `https comes with gnutls or openssl: add one of them to with:`. `test` fails a build missing any decoder, encoder,
  demuxer, muxer, protocol or filter configure was asked for by name, the listed ones and what came along, looked for by
  the name the build lists it under. (`-hwaccels` lists device types, not hwaccels, so those are configure's to check.)
- **What `test` needs.** `ffmpeg-build test` (which `build.yml` runs on every build) encodes a test pattern with the
  ffmpeg program: `ffmpeg -f lavfi -i testsrc2 -f null -`. That needs the `lavfi` input device, the `testsrc2` filter,
  `wrapped_avframe` as decoder and encoder, and the `null` muxer, so for a build with programs (not Android, iOS or Mac
  Catalyst, whose test links a program against the libraries instead), `check` refuses a `components:` kind that lists
  names but leaves its one out: `components: encoders: add wrapped_avframe`. A library build's smoke program needs
  nothing of `components:`: it round-trips a frame with a codec the build has (none, for a decode-only build) and
  checks only what the configure line says the build has ([building](building.md)).
- **Layers.** A target takes each kind from the last of its bases and itself that lists it: a list replaces the one
  before it. `{ add: [drawbox] }` adds to the list the layers before it gave instead; with no list before it, it is
  refused (it would quietly make the kind just those names).
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
adds: # the components the patches add, by kind, as configure names them (optional)
  demuxers: [acme]
  muxers: [acme]
  decoders: [adpcm_acme]
  encoders: [{ adpcm_acme: { listed-as: acme_adpcm } }] # the build lists it as acme_adpcm (its .p.name)
  filters: [acme_drawbox]
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
  `<major>/` folder. `about.yml` may also hold `configure:`, FFmpeg configure flags what the patches add needs: they
  go on the configure line of every target that uses the set, after the target's own.
- **What a set adds.** `adds:` names the components the patches add, kind by kind, in configure's spelling (a
  component `ff_acme_demuxer` in `libavformat/allformats.c` is the demuxer `acme`). A target applying the set may list
  them in `components:`, and they are built whatever its lists say: in a kind it restricts they join its list, and in
  one it doesn't they are still asked for by name. `test` then checks each is in the build, by the name the build lists
  it under: configure's, or the entry's `listed-as:` (the definition's `.p.name`, when it differs). `check` refuses an
  addition stock FFmpeg already has in that major.
- **Recorded.** `THIRD-PARTY-NOTICES.txt` says FFmpeg was modified, lists each set with its patches and a sha256 of
  the whole set, and carries each set's licence texts in a PATCH SETS section; its source section points at the
  sources archive, which holds the patch set folders beside `ffmpeg-build.yml` and `ffmpeg.lock`.
  `<name>.sources.json` and the release's `manifest.yml` record each set's name and sha256.
- **Releases.** Changing anything in a set (a patch, `about.yml`, a licence file, any major's folder) makes the
  releases of the targets using it due, and `bundle` refuses a build made with other patches than the folder has now.

## Tests

`tests:` lists scripts in the folder that `ffmpeg-build test` runs against the build, after its own smoke test, with
`FFMPEG`, `FFPROBE` and `FFMPEG_DIR` set ([testing a build](building.md#testing-a-build); not for Android, iOS and
Mac Catalyst builds, which have no programs). A script that needs a secret (a key to decrypt a sample, a token)
names the variable in `test-env:`, and gets it only there:

```yaml
targets:
  linux-x64:
    platform: linux-x64
    license: lgplv3
    ffmpeg: 9
    with: [dav1d]
    tests: [tests/decrypt.sh]
    test-env: [DECRYPT_KEY] # the variables its tests: get; build.yml's test-env secret gives the values
```

In CI the values come from `build.yml`'s `test-env` secret; locally, from your environment
(`DECRYPT_KEY=... ffmpeg-build test --target linux-x64`). How it is passed, and what a run without secrets does:
[tests that need a secret](building.md#tests-that-need-a-secret).

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
  targets don't list it. When a new major is out and targets name an older one, it says so (`notify: { new-ffmpeg:
false }` turns that off): in the PR text, on stderr, and, in `update-lock.yml`, as a warning on every run until the
  folder builds it, even when the lock didn't change and there is no PR. You decide; nothing is opted in, except by
  `ffmpeg: latest`, which follows new majors by itself ([above](#always-the-newest-ffmpeg-ffmpeg-latest)).
- **Versions come from upstream.** `lock`, `outdated` and `update` read upstream git tags, branches and release
  pages (they need `git` on PATH, and no API tokens).

## Old matrix profiles

Before targets, a profile was one file with `platforms:` and `license:` lists and conditional entries.
`ffmpeg-build migrate` turns a folder of them, and its lock, into `ffmpeg-build.yml` and one lock that build exactly
the same, with the same asset names. The old files are kept as `*.old`. Every other command in such a folder says to
run `migrate`.
