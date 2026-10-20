# Getting started

From nothing to a published FFmpeg build that a product downloads: a small first build on your machine, then the
same folder in a GitHub repository that builds, tests and releases it, then the product side.

## 1. Install

    npm install --global @devenvy/ffmpeg-build      # Node 24 or later
    ffmpeg-build --version

Building needs Docker for Linux, Windows and Android targets (on any host; on Windows and macOS, Docker Desktop), or a
Mac with Xcode for macOS, iOS and Mac Catalyst targets. `lock` and `update` need `git` on PATH.
`ffmpeg-build doctor --platform <patterns>` checks this machine and says what to install
([what you need](building.md#what-you-need)).

## 2. A first, small build

Start with bare targets and a couple of libraries: the first build then takes minutes rather than hours.

    mkdir my-ffmpeg && cd my-ffmpeg
    ffmpeg-build init --license lgplv3 --platforms linux-x64 --empty
    ffmpeg-build profile add dav1d opus --to linux-x64-lgplv3
    ffmpeg-build check
    ffmpeg-build lock

`init` writes `ffmpeg-build.yml` with one target, `linux-x64-lgplv3`; `profile add` gives it the dav1d (AV1) decoder
and the Opus codec; `check` says the target is possible; `lock` looks up the newest FFmpeg 9 release and library
versions and writes them to `ffmpeg.lock`. The target says `ffmpeg: 9`; write `ffmpeg: latest` instead to follow
each new FFmpeg major as the engine supports it: the daily lock update (below) then moves it, in a pull request your
CI checks ([targets](targets.md#always-the-newest-ffmpeg-ffmpeg-latest)). `ffmpeg-build options` lists every name a target can take, with the
licenses and platforms each allows.

    ffmpeg-build build --target linux-x64-lgplv3
    ffmpeg-build test --target linux-x64-lgplv3

The first build makes the platform's toolchain image (a few minutes, once), then builds the two libraries and FFmpeg.
Expect around a quarter of an hour on a recent 8-core machine, and a few GB of disk (the image, the work folder and
the library cache). It writes `dist/ffmpeg-<version>-linux-x64-lgplv3.tar.gz` (the shared libraries and the `ffmpeg`
and `ffprobe` programs, with `THIRD-PARTY-NOTICES.txt` at the root) and a `-dev.tar.gz` with the headers and
pkg-config files. `test` runs a smoke test of the build.

**A full build** of a shipped target (`init` without `--empty`: around fifty libraries, with the codecs, filters and
hardware support the license allows) takes much longer: plan on one to several hours per target on a laptop, and
tens of GB of disk. Libraries are cached (`~/.cache/ffmpeg-build`), so a second build of the same versions only
builds FFmpeg again, and CI keeps the cache between runs.

## 3. In CI: build, test and release on GitHub

1. **Create a repository** for the folder and push `ffmpeg-build.yml` and `ffmpeg.lock` (and any `patches/` or test
   scripts the targets name). Its releases are where your builds will be published. A public repository can't take
   nonfree targets. Builds released from a private one carry a written offer of their source rather than a link
   nobody outside could open; `source-offer: support@example.com` at the top of `ffmpeg-build.yml` says who it
   names ([building](building.md#whats-in-an-archive-third-party-noticestxt)).
2. **Repository setting:** Settings, Actions, General, Workflow permissions: tick "Allow GitHub Actions to create and
   approve pull requests", so the lock updates can open their pull requests. Nothing else is needed: no tokens,
   branch protection or auto-merge.
3. **Copy the example workflows** from [`examples/workflows/`](../examples/workflows) into `.github/workflows/`:
   - `ci.yml`: the pull-request check. It checks `ffmpeg-build.yml` and `ffmpeg.lock` in a minute (building nothing) and merges ffmpeg-build's
     own update pull requests once they pass.
   - `release.yml`: the daily release train. It publishes every release whose builds changed since it was last
     published.
   - `update-lock.yml`: the daily lock update. It opens one pull request with newer FFmpeg, library and engine
     versions, which `ci.yml` checks and merges.

   And [`examples/dependabot.yml`](../examples/dependabot.yml) as `.github/dependabot.yml`, to keep the actions they
   use current. Each example's header says which permissions it grants and why.

   A test script that needs a secret (a key to decrypt a sample) lists the variable in its target's `test-env:`, and
   `release.yml` passes the repository secret to `build.yml` as `secrets: { test-env: "DECRYPT_KEY=..." }` (commented
   out in the example): only the test steps get it, masked, and only that target's scripts
   ([tests that need a secret](building.md#tests-that-need-a-secret)).

4. **The first release:** run `release` by hand from the Actions tab (or wait for its schedule). With nothing
   released yet, every release is due: it builds each target on its runner, tests it, and publishes a GitHub release
   tagged `<ffmpeg version>.0` (e.g. `9.0.2.0`) with each target's archives, `manifest.yml`, `SHA256SUMS`, release
   notes and the sources archive. `ffmpeg-build releases` shows locally what the next run would do. From then on, a
   release is published only when something its builds are made of changes (a version in the lock, a patch, the
   target, the engine), and its build number goes up by one.

## 4. Use the build in a product

A product that uses FFmpeg without building it pins one release, in a file such as `ffmpeg.version`:

    my-org/my-ffmpeg@9.0.2.0

and takes the build it needs, checked against the release's sha256s:

    ffmpeg-build fetch ffmpeg.version --target linux-x64-lgplv3 --dev --out vendor/ffmpeg

(`GITHUB_TOKEN` or `GH_TOKEN` reaches a private release repository.) [`examples/workflows/update-pin.yml`](../examples/workflows/update-pin.yml)
moves the pin to the newest release of the same FFmpeg major and opens a pull request for the product's own CI to
test; by hand, `ffmpeg-build fetch --update ffmpeg.version --target linux-x64-lgplv3`.

## Next

- [Targets](targets.md): bases, licenses, pins, patches, where each target builds.
- [Building](building.md): the toolchains, caching, what CI tests, what a build was made from.
- [Releases, CI and products](releases.md): tags, the workflows' inputs, upgrading the engine.

## The commands

In the order you'd use them. Every command is non-interactive, and edits keep the file's comments and are checked
before they are written. `ffmpeg-build guide` prints this page.

1. `ffmpeg-build options --json`: every name a target can list, with its library, SPDX licence, the licenses that
   allow it and the platforms it builds on. Read this instead of guessing what a license allows.
2. `ffmpeg-build init --license <list> --platforms <list> [--ffmpeg <list>] [--empty]`: write `ffmpeg-build.yml` from
   the shipped targets, narrowed to that selection (the newest FFmpeg unless `--ffmpeg` says otherwise). Both lists
   are required; `all` takes every license or platform. With `--empty`, bare targets only. It also writes the
   `# yaml-language-server: $schema=...` line that points editors at `schema/ffmpeg-build.schema.json`.
3. `ffmpeg-build profile add <names...> --to <base or target>`: a base reaches every target using it; a target, just
   itself. `ffmpeg-build profile remove <names...> --from <base or target>`: from a target, it also turns down what a
   base still gives it. An edit that would give a target a problem (x264 on an lgplv3 target) is refused: nothing is
   written, and the output says which target and why (exit 1).
4. `ffmpeg-build check --json`: is every target possible? `profile missing --json [--target T]` lists what targets
   could add but neither list nor turn down.
5. `ffmpeg-build show <target>` says what a target gets and which base gave it; `show --has <name>` says which targets
   get something and why the others don't. `ffmpeg-build targets --json` lists them (for CI matrices).
6. `ffmpeg-build lock`: write `ffmpeg.lock`, one version per library for the whole folder, each pinned to its git
   commit or tarball sha256, which the build checks (asks upstream; needs git). `ffmpeg-build update` moves it to the
   newest versions allowed; `outdated` shows what update would do. `ffmpeg-build plan --json` shows each target's
   options, libraries and versions.
7. `ffmpeg-build releases --json` lists the releases (targets released together: same `release-group:` and FFmpeg
   version), each with its next tag, whether it is due and why, and each target's CI runner. A component a target had
   in its last release and would now lose stops `update` and the release; `allow-removal: [<name>]` allows it.
8. `ffmpeg-build build --target <names>` or `--platform <patterns>` (e.g. `'linux-*,win-*'`): build those targets in
   turn. `check`, `plan`, `targets`, `test` and `releases` take the same `--target`/`--platform`. `build --in here`
   builds natively (linux-x64/arm64 on Linux, win-\* in MSYS2, Apple on a Mac); `--in docker` in the platform's image.
9. `ffmpeg-build test --target <names>` runs a build (smoke test, then the target's `tests:` scripts) where this
   machine can run it; an Android, iOS or Mac Catalyst build gets a small program linked against it, run where it
   can. `--must-run` fails a build this machine can't run instead of skipping it.
10. `ffmpeg-build doctor [--target <names> | --platform <patterns>] [--json]`: is this machine ready to build and
    test those targets (without `ffmpeg-build.yml`, those platforms)? Each target's way of building and testing here,
    what that needs, and the install command for what's missing. Offline; exit 1 when something is missing.
11. `ffmpeg-build cache path | list [--json] | verify [--fix] | prune [--older-than <days>] | clear`: the library cache
    builds share. None of them deletes while a build is running.

A product pins a release with `ffmpeg-build fetch` ([above](#4-use-the-build-in-a-product)). A folder that still has
old matrix profiles gets one answer from every command: run `ffmpeg-build migrate`
([targets](targets.md#old-matrix-profiles)).

### Reading `check`

- `✓` is there; `-` is reported, not an error (e.g. not available on that platform); `✗` is a problem.
- Each `✗` comes with its fix, e.g. "Remove it from this target (it needs license: lgplv3, gplv3 or nonfree)":
  `profile remove <name> --from <target>`.
- Two TLS libraries in one build are a conflict: keep one, and turn the other down with `without:`.

### Output and exit codes

0: fine. 1: a target has problems (or `profile missing` found something, or `doctor` something this machine lacks), or a build ran and failed. 2: usage, data,
network or tool problem (a missing or stale `ffmpeg.lock`, Docker missing or stopped, a release without a manifest);
the message says which. 130 or 143: stopped by Ctrl-C or SIGTERM (the build's previous outputs stay in place).

Results go to stdout; errors, warnings and notes go to stderr. With `--json`, every exit 1 or 2 prints
`{"error": "...", "problems": [...]}` on stdout (`problems` one line each, empty when there is only the error), never
a list that could pass for the answer; what the command found may sit beside them (`check`: `targets`; `releases`:
`releases`; `profile missing`: `missing`; `doctor`: `ok`, `host`, `needs`, `targets`). A success never has `error`: `check --json` is
`{"ok": true, "targets": [...]}`, `doctor --json` is
`{"ok": true, "host": "...", "needs": [...], "targets": [{"name", "platform", "buildsIn", "testsIn", "needs": [{"what", "ok", "have"?, "install"?}]}]}`, `profile missing --json` is `{"ok": true, "missing": {}}`, and the others print
their answer itself. `FFMPEG_BUILD_DEBUG=1` adds the stack to an unexpected error.

## Environment variables

None are needed; these change where ffmpeg-build works or what it talks to.

| Variable                                              | What it does                                                                                                                                                               |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FFMPEG_BUILD_CACHE`                                  | The library cache (and kept sources). Default `~/.cache/ffmpeg-build`.                                                                                                     |
| `FFMPEG_BUILD_WORK`                                   | Where native builds (`build --in here`) keep their libraries and scratch space. Default `~/ffmpeg-build-work`; it must have no spaces in it.                               |
| `FFMPEG_BUILD_DOCKER`                                 | The Docker command to run (a full path, say, when `docker` is not on PATH). Default `docker`.                                                                              |
| `FFMPEG_BUILD_IMAGE_CACHE`                            | `gha`: build the toolchain images with buildx and the GitHub Actions cache (the build workflow sets it).                                                                   |
| `FFMPEG_BUILD_DATA`                                   | Read FFmpeg's options, the recipes and the platforms from this folder instead of the installed package (engine development and tests).                                     |
| `FFMPEG_BUILD_GITHUB_API`                             | The GitHub API `fetch`, `releases`, `update` and `bundle` talk to. Default `https://api.github.com` (GitHub Enterprise: `https://<host>/api/v3`).                          |
| `GITHUB_TOKEN`, `GH_TOKEN`                            | A token for the GitHub API: private release repositories, and fewer rate limits. Sent only to the GitHub API.                                                              |
| `GITHUB_REPOSITORY`                                   | The `owner/repo` whose releases `releases` and `bundle` read (Actions sets it); else the folder's `origin` remote.                                                         |
| `FFMPEG_BUILD_SOURCE_REPO`, `FFMPEG_BUILD_SOURCE_REF` | The repository and commit `THIRD-PARTY-NOTICES.txt` names as the build definition (the build workflow sets them); else the folder's git remote and commit.                 |
| `FFMPEG_BUILD_RELEASE`                                | The release tag the notices name, when the build is being published (the build workflow sets it).                                                                          |
| `FFMPEG_BUILD_REPO_PRIVATE`                           | `true` or `false`: whether the release's repository is private, which decides where the notices say the source is. The build workflow reads it once; else GitHub is asked. |
| `ANDROID_NDK_HOME`                                    | The Android NDK `test` links its program with, for an Android build (also `ANDROID_NDK_LATEST_HOME`, `ANDROID_NDK_ROOT`).                                                  |
