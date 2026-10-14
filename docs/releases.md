# Releases, CI and products

## Releases

Targets with the same `release-group:` (by default, all of them) and FFmpeg version release together, tagged
`[<group>-]<ffmpeg>.<build>` (e.g. `9.0.2.3`, or `studio-9.1.0.0`). The FFmpeg version always has three parts, so a
tag always has four: FFmpeg 10.0 releases as `10.0.0.0`, with archives named `ffmpeg-10.0.0-<target>.tar.gz`. Each
release publishes every target's archives (and a win-x64 target's debug symbols, `symbols-<version>-<target>.tar.gz`),
`manifest.yml` (fixed name: what each target is made of, with every asset's sha256), `SHA256SUMS`, release notes and
the sources archive.

- **`ffmpeg-build releases [--due] [--json]`** lists them: the next tag (one past the last published build), whether
  each release is **due** (anything a build is made of changed since its last release: versions, toolchain, patches,
  the target itself, the engine) and why, and the CI runners of each target (`runner`, and `testRunner`, which runs
  it). It finds the last releases on GitHub, from `GITHUB_REPOSITORY` or the folder's git remote; `--offline` treats
  every release as new.
- **Nothing disappears silently.** A target that would lose a component its last release had stops `update` and the
  release, until you say so with `allow-removal: [x264]` (on the target, or at the top for every target).
- **Where releases go is checked before anything builds.** A public repository takes no nonfree target. A private
  one takes releases only when `ffmpeg-build.yml` says `private-release: internal` at the top: its builds, and the
  source their `THIRD-PARTY-NOTICES.txt` links to, then reach only people with access to that repository. `releases`
  checks this in CI's plan step, so nothing is built (or uploaded as a workflow artifact) that couldn't be published,
  and `bundle` checks it again.

### iOS and Mac Catalyst: the xcframework bundle

A licence's four framework builds (ios-arm64, ios-sim-arm64, maccatalyst-arm64 and maccatalyst-x64) ship as one
archive, `ffmpeg-<version>-ios-<license>.tar.gz`, as devenvy/ffmpeg published them: one `<lib>.xcframework` per FFmpeg
library, each with three slices (`ios-arm64`, `ios-arm64-simulator`, and `ios-arm64_x86_64-maccatalyst`, the two
Catalyst builds fused with `lipo` and signed again ad hoc), and one `THIRD-PARTY-NOTICES.txt` at the root that holds
each of the four builds' notices in full, after a header saying which build went into which slice.

    ffmpeg-build bundle --apple --release 9.0.2.3 --dist dist   # on a Mac with Xcode, after building the four
    ffmpeg-build bundle --release 9.0.2.3 --dist dist           # anywhere: the release, with the bundle in it

A licence with some but not all four targets (or two of one) in a release is refused by `check` and `releases`, so CI
stops before building anything; `bundle --apple` applies the same rule. It also refuses off macOS, when a slice's
archive is missing, and when a slice's binaries aren't that slice's architectures and platform. Beside each bundle it
writes `ffmpeg-<version>-ios-<license>.slices.json`: the bundle's sha256 and each slice archive's, with each slice's
components.

Plain `bundle` then publishes the bundle in place of the four builds' archives, as one `manifest.yml` entry named
`ios-<license>` with platform `ios`; its runtime and dev assets are the same file (the xcframeworks carry the headers).
The entry's components are the four builds' together, and its toolchain and definition change when any build's do.
The four builds' sources are in the sources archive, each with its own section in `SOURCES.md`. Plain `bundle`
refuses a release whose bundle or `.slices.json` isn't in `--dist`, and a stale bundle: one whose slice archives were
built again after `bundle --apple` made it. It publishes the `.slices.json` with the release, and the next release's
removal guard compares each slice with it, so a component dropped from one slice only stops the release too (allow it
with `allow-removal:` on that slice's target).

## CI (GitHub Actions)

The engine ships reusable workflows, called at the engine's major version tag (`uses:
devenvy/ffmpeg-build/.github/workflows/build.yml@v0`). Their `folder` input (where `ffmpeg-build.yml` is; default `.`)
names their concurrency groups and `update-lock.yml`'s branch, so it has one spelling: `.` or a relative path like
`builds/linux`. A leading `./` or `/`, a trailing `/`, `.` or `..` parts and backslashes stop the run at once.

- **`build.yml`**: plan (`releases --json`), then each target of each due release on its runner (`platforms.yml`
  `runner:`; Linux images through buildx and the Actions cache, the library cache per target), tested there, and
  the builds that runner can't run tested on one that can (`test-runner:`: Windows); the iOS bundle on macOS, and the
  release (`bundle`, then a GitHub release with every asset), which needs every test to pass.
  `publish: changed-only | always | never`; `never` is a pull-request check, and builds every release unless
  `due: true` narrows it to the releases that changed since they were last published (the example `ci.yml` does;
  `due` with any other `publish` stops the run). `tests: all | build-runner | none`
  (default `all`): `build-runner` skips the Windows test runners, `none` every test (in a private repository Windows
  minutes cost twice and macOS ten times Linux's; [what CI tests](building.md#what-ci-tests)). Any other value of
  either stops the run before anything builds. `platforms: 'linux-*,win-*'` builds only those targets (default every
  target); a release is published with all its targets, so when the run publishes, a choice that leaves a due
  release part-built stops it (`releases --whole`), saying which targets are missing. Where each target builds is
  `ffmpeg-build.yml`'s `build:` section, else `platforms.yml` ([targets](targets.md#some-targets-at-a-time-and-where-they-build)).
  One `all-builds` job to require. Its caller grants `contents: write` even with
  `never`: GitHub won't start a run whose called workflow has a job (the skipped release job) asking for more than
  the caller grants.
- **`update-lock.yml`**: `ffmpeg-build update` in `folder`, then one pull request with the update summary, on the
  `branch` input: by default one per folder, `ffmpeg-build/update-lock/<folder slug>` (`root` for `.`, `builds-linux`
  for `builds/linux`), so two folders in one repository get two pull requests. Opening the pull request needs the
  repository setting _Allow GitHub Actions to create and approve pull requests_ (Settings, Actions, General), or a
  `token` secret.
- **`update-pin.yml`**: for products (below); the same PR handling, on `ffmpeg-build/update-pin/<pin file slug>` by
  default (`ffmpeg-version` for `ffmpeg.version`).

A `branch` you choose must start with `ffmpeg-build/`, the branches `automerge.yml` merges. Runs for the same
repository and branch queue (`concurrency:`) rather than race on one pull request; a run under way is never cancelled.

- **`automerge.yml`**: the last job of your CI; merges the PR of `update-lock.yml` or `update-pin.yml` with
  `automerge: true` once the CI's other jobs pass.

**The PR's CI starts without any token.** Pushes made with `GITHUB_TOKEN` start no workflows, so after pushing,
`update-lock.yml` and `update-pin.yml` dispatch the CI workflow named by their `ci-workflow` input (default `ci.yml`;
empty dispatches nothing) on the PR's branch. That workflow needs a `workflow_dispatch:` trigger, and the caller must
grant `actions: write` (with `contents: write` and `pull-requests: write`). The `token` secret stays optional: a token
whose pushes start CI by themselves (then nothing is dispatched).

Without a token, GitHub also lists a `pull_request` run of your CI on such a PR that it won't start (shown as a failed
run, "a workflow file issue", or as waiting for approval): a PR the Actions bot opened gets a restricted token that
can't grant the write permissions the build workflow declares. It's a duplicate; the dispatched run is the PR's check,
and the one automerge waits for. A `token` secret avoids it.

**As a GitHub App:** give `update-lock.yml` or `update-pin.yml` an app's client ID (`app-client-id` input) and private
key (`app-private-key` secret), with contents, pull-requests and issues write. The PR is then pushed and opened as the
app, so it starts your CI and any code scanning like a person's PR, with nothing dispatched and no duplicate run. A
repository whose ruleset requires code scanning results needs this: a PR opened with `GITHUB_TOKEN` never gets them.

**Automerge needs no repository settings** (no auto-merge, branch protection or required checks, which free private
repositories can't have). With `automerge: true` the PR is labelled `ffmpeg-build:automerge`. Your CI calls
`automerge.yml` as its last job, which merges the labelled `ffmpeg-build/` PR whose head is still the commit the
passing run tested (`gh pr merge --squash --match-head-commit`). Where a ruleset does require checks (the example CI's
`result` job is the one to require) and some are still running, it turns on auto-merge instead, and GitHub merges the
PR once they pass; the repository must allow auto-merge for that. A merge made with
`GITHUB_TOKEN` starts no workflows on the default branch; the scheduled release train picks it up. (Not from a `workflow_run`
workflow: CI runs started with `GITHUB_TOKEN` trigger none.)

`build.yml`, `update-lock.yml` and `update-pin.yml` take an `engine` input: the ffmpeg-build to run. A version, range
or npm dist-tag installs that npm release; a git or npm spec (one with `:` or `/`) is installed from it, and `source`
builds the calling repository itself (the engine's own tests). Left out, it is:

- **`build.yml`:** exactly the version the folder's `ffmpeg.lock` records (`engine:`), so a release is built by the
  engine its lock names, and building it again gives the same result. It stops if the lock has none.
- **`update-lock.yml`:** npm's newest release of the lock's engine major (`@devenvy/ffmpeg-build@0` for `engine: 0.0.1`), or
  of the workflows' own major when the lock names none. `update` records the engine that ran it, so this is how the
  lock's engine moves forward (below).
- **`update-pin.yml`:** `0`, npm's newest 0.x release (a product has no `ffmpeg.lock` to read one from).

`automerge.yml` runs no engine. A git spec runs an unreleased engine, e.g. `engine: github:devenvy/ffmpeg-build#main`
(or a tag or commit to pin it). npm builds `dist/` from a git spec when it packs it (the `prepare` script). The
workflows run `npm pack "<spec>"` and install the package it makes, because `npm install --global <git spec>` runs
`prepare` without the devDependencies it needs (TypeScript). By hand, the same:

    npm install --global "$(npm pack --silent github:devenvy/ffmpeg-build#main | tail -1)"

### Upgrading the engine

The engine a folder builds with is the one its `ffmpeg.lock` records (`engine: 0.0.1`), so builds and releases don't
change underneath you when a new engine comes out. It moves with the lock's other versions:

- **In CI**, `update-lock.yml` installs the newest engine of the lock's major and runs `update`, which records that
  engine in the lock. When it is newer, the update pull request says so (`Engine: ffmpeg-build 0.0.1 -> 0.0.4`). Once
  it merges, `build.yml` runs the new engine, and every release is due: the engine is part of what each build is made
  of.
- **By hand**, install the engine you want (`npm install --global @devenvy/ffmpeg-build@0`) and run `ffmpeg-build update` (or
  `lock`) in the folder: either records the engine that ran it.

The engine is released when something it ships changes (a patch release overnight; minor and major releases by
hand), so a new engine is rarer than a new library version, and each one is meant to reach every consumer.

**Compatibility:** the reusable workflows at `@v0` run any 0.x engine. Their first job checks the engine's major and
stops, saying what to change, when it isn't 0. A new major of the engine comes with its own workflows (`@v1` after 0.x): change the
`uses: ...@v0` lines to `@v1`, install a 1.x engine and run `ffmpeg-build update` in the same pull request. Within a
major, a newer engine reads every lock and `ffmpeg-build.yml` an older one wrote.

Copy-ready callers are in [`examples/workflows/`](../examples/workflows): a daily release train, a pull-request check,
lock updates, a product's FFmpeg bumps and their automerge. [`examples/dependabot.yml`](../examples/dependabot.yml)
is a `.github/dependabot.yml` that keeps the actions they use current.

## Products: using a build without building FFmpeg

A product commits one line, `owner/repo@tag`, in a pin file (`ffmpeg.version`):

    ffmpeg-build fetch ffmpeg.version --target linux-x64-lgplv3 --out vendor/ffmpeg   # --dev adds headers and libraries
    ffmpeg-build fetch --update ffmpeg.version --target linux-x64-lgplv3            # newest build, same FFmpeg major

`fetch` reads the release's `manifest.yml`, downloads the target's archives, checks each sha256 and unpacks them
(every entry must stay inside the folder). `--out` is replaced whole, so it must be new, empty or an earlier fetch,
and a repeat run is a no-op. `GITHUB_TOKEN` or `GH_TOKEN` reach private repositories; the token goes only to the
GitHub API. Exit codes: 0 fetched or up to date, 1 a checksum mismatch, missing target or unsafe archive, 2 usage,
network or data problems.
