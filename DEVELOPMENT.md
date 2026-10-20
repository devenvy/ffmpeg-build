# Development

Thanks for helping. Issues and pull requests are welcome; for anything large (a new platform, a change to the
`ffmpeg-build.yml` format), open an issue first so the design can be agreed before the work.

## Setup

Node 24 and pnpm (the version `packageManager` names; `corepack enable` provides it).

    pnpm install
    pnpm test                 # vitest; the Docker test is skipped by default
    pnpm run dev <command>    # the CLI from source (Node 24 runs the .ts directly)

Before a pull request, the checks CI runs:

    pnpm run guidelines:check # the @devenvy/code-guidelines baseline is in place, and nothing weakens it
    pnpm run lint             # ESLint, no warnings
    pnpm run format:check     # Prettier (`pnpm run format` fixes it)
    pnpm run typecheck
    pnpm run knip             # unused files, exports and dependencies
    pnpm run test:ci          # the tests with coverage, which fails under its thresholds

`pnpm run dev` runs the command in the folder you typed it in, so `pnpm --dir <engine> run dev check` works in a build
folder. So do `node <engine>/src/cli.ts check`, and, after `npm link` in the engine once, plain `ffmpeg-build check`
(`npm link` runs the compiled `dist/`: `pnpm run build` after a change).

`FFMPEG_BUILD_DOCKER_TESTS=1 pnpm exec vitest run tests/build-docker.test.ts` runs a real linux-x64 build (slow; needs
Docker and network). `pnpm run schema` regenerates `schema/ffmpeg-build.schema.json` after a schema change (a test
fails when it is stale).

## How the engine is laid out

| Path                                                            | What it is                                                                                                            |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `src/`                                                          | the CLI (TypeScript, run directly by Node 24; `pnpm run build` compiles it to `dist/` for npm)                        |
| `ffmpeg/<major>.yml`                                            | what each FFmpeg major offers: options, the library each needs, its license class, platforms                          |
| `ffmpeg/offered/`, `ffmpeg/unsupported.yml`                     | what FFmpeg's configure offers to turn on (generated), and what of it the engine doesn't build, with why              |
| `recipes/<name>/`                                               | how to build one library: `recipe.yml` (source, versions, licence, build system/steps, deps)                          |
| `platforms.yml`, `src/build/toolchain.ts`, `src/build/stage.ts` | platform image/data, compiler environments, cross files, packaging and checks                                         |
| `images/`                                                       | the toolchain Dockerfiles (base images pinned by digest, downloads and pip packages by sha256, git sources by commit) |
| `licenses.yml`                                                  | which build licenses each SPDX licence may go into                                                                    |
| `profiles/devenvy.yml`                                          | the shipped targets that `init` starts from                                                                           |
| `scripts/compare-published*.sh`                                 | compare a build with a published devenvy/ffmpeg archive                                                               |
| `docs/`                                                         | the user documentation (targets, building, releases)                                                                  |

## Recipe format

A recipe is data: `recipes/<name>/recipe.yml`, with no shell in it. Node runs every command itself, as an argument
list, in the library's source folder, with the platform's environment. (The schema turns a `shell:` step away.)

```yaml
name: zimg
provides: zimg # the FFmpeg option it is for (ffmpeg/<major>.yml)
license: WTFPL # SPDX; licenses.yml says which build licenses it may go into
license-files: [COPYING] # the texts THIRD-PARTY-NOTICES.txt carries; { recipe: LICENSE } for one kept here
configure: [--enable-libzimg] # FFmpeg's configure flags when the option is on; { flag: { platforms: [...] } } for some
needs: [zlib] # recipes built first; { name: { platforms: [win-*] } } for some platforms
uses: [mbedtls] # optional: built in where the build's license and platform allow it
source: { git: https://github.com/sekrit-twc/zimg.git, ref: 'release-{version}', submodules: true }
versions: { git-tags: '^release-(\d+\.\d+\.\d+)$' }
platforms: all
build: { ... }
```

`runtime:` lists files under the deps folder that ship next to FFmpeg's libraries (`lib/libvulkan.so*`); like
`configure:` and `needs:`, an entry can be limited to some platforms (`'lib/libvulkan*.dylib': { platforms: [osx-*] }`).

`source:` is `git:` (with `ref:`, an optional `mirror:`, and `submodules:`) or `url:` (a tarball, with `mirrors:`).
`version-group: <name>` gives recipes released together one version in the lock: `lock` and `update` pick the newest
version every member of the group has and allows (the Vulkan SDK's `vulkan-headers`, `vulkan-loader` and
`spirv-headers` are `version-group: vulkan-sdk`), and a lock whose members differ isn't current.
`submodules: true` runs `git submodule update --init --recursive` right after the checkout;
`submodules: { depth: 1, paths: [a, b] }` runs `git submodule update --init --depth 1 a b`. Both are retried like the
clone (six attempts, 4 s doubling).

### build:

| Key                                                      | What it does                                                                                                                                                                        |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `system:`                                                | `cmake`, `meson`, `autotools` or `none` (then `steps:` does the build)                                                                                                              |
| `args:`                                                  | the build system's arguments (or, with `none`, what `{args}` holds)                                                                                                                 |
| `source-dir:`                                            | where CMakeLists.txt / meson.build / configure is                                                                                                                                   |
| `configure-script:`, `make-targets:`, `install-targets:` | autotools: the script, `make -j<n> <targets>`, `make <install targets>` (`[]`: none)                                                                                                |
| `bootstrap:`                                             | before anything else: `autogen` (`./autogen.sh`), `autoreconf` (`autoreconf -fi`) or a script in the source; a list tries each in turn, quietly, and the first that works wins      |
| `env:`                                                   | environment variables: a value, or `+= ...` to append to the toolchain's                                                                                                            |
| `unset:`                                                 | environment variables to remove (YAML's `null` is read as text here, so it can't do that)                                                                                           |
| `vars:`                                                  | recipe variables for placeholders: text, or a list                                                                                                                                  |
| `before:`, `steps:`, `after:`                            | steps around (or, with `steps:`, instead of) the standard build                                                                                                                     |
| `platforms:`                                             | per platform glob (`win-*`, `linux-x64`): `args`, `env`, `unset`, `vars`, `before`, `after` added for the platforms it matches, in the order written; a later match's variable wins |

The standard builds:

- **cmake**: `cmake -DCMAKE_POLICY_VERSION_MINIMUM=3.5 -B _build -S <source-dir> -DCMAKE_BUILD_TYPE=Release
-DCMAKE_INSTALL_PREFIX=<deps> -DCMAKE_INSTALL_LIBDIR=lib -DCMAKE_PREFIX_PATH=<deps> -DBUILD_SHARED_LIBS=OFF
-DCMAKE_POSITION_INDEPENDENT_CODE=ON <cross args> <args>`, then `cmake --build _build -j<n>` and `cmake --install _build`.
- **meson**: `meson setup _build <source-dir> --prefix=<deps> --libdir=lib --default-library=static
--buildtype=release <cross args> <args>`, then `meson compile` and `meson install`.
- **autotools**: `./configure --prefix=<deps> <args> [--host=<triple>]` (`--host` only when cross-compiling), then
  `make -j<n> <make-targets>` and `make <install-targets>`. Everything else is the recipe's: say `--disable-shared
--enable-static --with-pic` (and `--libdir={deps}/lib` if the library wants it) in `args:`, in the order you want.

### Steps

A step is a command, or one of the operations below. A command is a list: `[make, '-j{jobs}', install]`. Any
operation, and `run:`, can take `when:`.

| Step                                                                                                  | What it does                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `[cmd, arg, ...]`                                                                                     | runs the command in the source folder                                                                                                                                                                                                                                                                                                                                                                                                     |
| `run: [cmd, ...]` with `env:`, `unset:`, `cwd:`                                                       | the same, with this command's own environment additions and folder                                                                                                                                                                                                                                                                                                                                                                        |
| `when: { platforms: [...], exists: <glob>, missing: <glob>, set: '{x}', unset: '{x}' }`               | runs the step only if all that are given hold (`set`: the text is not empty once filled in)                                                                                                                                                                                                                                                                                                                                               |
| `vars: { name: value }`                                                                               | sets recipe variables (a list stays a list)                                                                                                                                                                                                                                                                                                                                                                                               |
| `find: { var, glob: [...], dirname, basename, ignore-case, required: <message> }`                     | the first path the globs match (in order); empty, or an error with `required:`                                                                                                                                                                                                                                                                                                                                                            |
| `read: { file, pattern, var, last, message }`                                                         | a variable from a file: the regex's first group, of its first (or `last`) match                                                                                                                                                                                                                                                                                                                                                           |
| `check: { ..., message }`                                                                             | fails the build with the message unless it holds: `exists:`/`missing:` a glob, `file:` with `contains:` or `line:`, `command:` on PATH, or `output: [cmd, ...]` matching `matches:` (with `min-version:` for its first group; `cwd:`)                                                                                                                                                                                                     |
| `copy: { from, to \| into, recursive, preserve }`                                                     | `from` is a path, glob or list of them; `to` is the copy's path, `into` a folder                                                                                                                                                                                                                                                                                                                                                          |
| `move: { from, to }`                                                                                  | renames a file                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `remove: { path, recursive }`                                                                         | deletes a path, or everything a glob matches                                                                                                                                                                                                                                                                                                                                                                                              |
| `replace-in-file: { path, from, to, regex, optional }`                                                | every occurrence; `regex: true` is a JavaScript regex (multiline, `$1` in `to`). It fails the build, naming the recipe, file and text, when there is nothing to replace (upstream moved the text): `optional: true` lets it find no file or no match, for an edit only some versions or platforms need                                                                                                                                    |
| `write-file: { path, text }`                                                                          | writes a file                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `pkg-config: { name, description, version, libs, libs-private, requires, cflags, exec-prefix, file }` | writes `{deps}/lib/pkgconfig/<file or name>.pc` in the usual layout: `prefix=`, `libdir=` (when there are `libs`), `includedir=`, then the fields; `Libs: -L${libdir} <libs>`, `Cflags: -I${includedir} <cflags>`                                                                                                                                                                                                                         |
| `edit-pkg-config: { path, optional, <field>: { <edit>, missing } }`                                   | edits an installed .pc. Fields: `libs`, `libs-private`, `requires`, `requires-private`, `cflags`. Edits: `append` (at the end of the line), `prepend` (right after `Field:`), `add` (the words not already there; for the link fields, on Libs or Libs.private), `set` (the whole value), `remove` (these words). `missing:` says what to do when the file has no such line: `end` (add it at the end, the default), `after-libs`, `skip` |
| `sync-shaderc-deps: true`                                                                             | shaderc's `utils/git-sync-deps`, verified and retried                                                                                                                                                                                                                                                                                                                                                                                     |

File paths are relative to the source, or start with `{src}`, `{deps}` or a variable holding a path; a step can't
reach outside the source and deps folders.

### Placeholders

`{deps}` (also `{prefix}`), `{src}`, `{jobs}`, `{version}`, `{platform}`, `{host}` (the cross triple, empty when
native), `{cxx-runtime}` (the C++ runtime a static link needs: `-lc++` on Apple and Android, `-l:libc++.a` on win-arm64,
`-l:libstdc++.a` on musl, `-lstdc++` elsewhere), `{args}`, `{cmake-cross-args}`, `{meson-cross-args}`, the recipe's
variables, and the platform's environment (`{CC}`, `{CROSS_PREFIX}`, `{TOOLCHAIN}`, ...).

- `{name|fallback}`: the value, or the fallback when it is unset or empty (`{CC|{tools}gcc}`, `{CFLAGS|}`).
- `{name?}`: the argument or environment variable holding it is left out when it is empty (`'--host={host?}'`,
  `CHOST: '{host?}'`).
- A list placeholder alone in an argument (`'{args}'`, `'{cmake-cross-args}'`) becomes its items; elsewhere its items
  are joined with spaces.
- An unknown `{name}` stays as written.

### Adding a library

1. Write `recipes/<name>/recipe.yml`: the source and versions, the licence and its files, `provides:` and `configure:`
   if FFmpeg has an option for it (and the option in `ffmpeg/<major>.yml`), `needs:`/`uses:`, the platforms. Where
   the system provides the library on some platforms (iconv, in glibc's, musl's and Android's C library), the option
   is `builtin: true` with `needs:` naming the library for the other platforms only:
   `iconv: { builtin: true, needs: [{ libiconv: { platforms: [win-*, osx-*, ...] } }] }`.
2. Pick the build system and give it `args:`. Per-platform differences go under `platforms:`; anything around the build
   (a .pc to fix, a file to drop, a check) goes in `before:`/`after:` as operations. Only a library with its own build
   tooling needs `system: none` and `steps:`.
3. Add a test to `tests/recipes-*.test.ts`: run it with `build(h, '<name>')` on every platform it builds on
   (`platformsOf`), with the process runner stubbed (see `tests/recipe-harness.ts`), and compare the commands and files
   with what the library needs. The suite (`pnpm test`) also loads every recipe, so a schema mistake fails it.
4. Build it for real (`node scripts/try-recipes.ts <name>@<version>`, then a target that uses it), as below.
5. Check it the way CI will: `ffmpeg-build recipe-check <name>` (below).

### Checking a recipe on every platform

    pnpm run dev recipe-check zlib --plan              # what would build where, without building
    pnpm run dev recipe-check zlib --platform linux-*  # build it on the Linux platforms
    pnpm run dev recipe-check zlib                     # every platform this machine can build

`recipe-check` builds the recipes you name, and every recipe that builds against them (needs or uses them there), on
every platform each claims (`platforms:`) that `platforms.yml` builds, without FFmpeg, in the same Docker images (and,
for Apple, natively on a Mac) as every build, at the canary lock's versions (`--lock` names another). It writes a
throwaway folder (a temporary one, or `--dir`): `ffmpeg-build.yml` with one `nonfree` target per platform and FFmpeg
option (nonfree, so every library and every `uses:` may go in), chosen as the fewest options that build everything
on the platform, and `ffmpeg.lock` seeded from the canary's (only what it lacks is looked up). Then it runs
`ffmpeg-build build --target <t> --only <recipes>` for each target, carrying on past a failure, and says which failed
(the logs are in `<dir>/dist`, or `--out`). Apple platforms need a Mac; on Linux or Windows, `--platform` leaves them
out (`--dry-run` says what would build).

A recipe that claims a platform no FFmpeg option builds it on fails the check: narrow its `platforms:` (or offer the
option there). One that no option builds on any platform is only noted.

### Adding support for an FFmpeg option

Everything FFmpeg's configure can turn on (its external library and hardware options: configure's
`EXTERNAL_LIBRARY_LIST`, `EXTERNAL_AUTODETECT_LIBRARY_LIST`, `HWACCEL_LIBRARY_LIST` and
`HWACCEL_AUTODETECT_LIBRARY_LIST`, and the `--enable-`/`--disable-` lines of `--help`'s library section) is in
`ffmpeg/offered/<major>.yml`, with its licence class, as the major's newest release has it. The nightly support check
writes it (`node scripts/ffmpeg-support.ts --write`); it is never edited by hand. Each name there is either:

- **supported**: an option of `ffmpeg/<major>.yml` turns it on, through its own `configure:`, its library's
  `configure:` (on some platform the engine builds), or as `--enable-<option>` when it is `builtin: true`; or
- **listed** in `ffmpeg/unsupported.yml` with a reason: `pending` (with the open `issue:` that tracks it, and its
  `batch:` there), `sdk-not-redistributable`, `needs-hardware-sdk`, `platform-not-built`, `deprecated-upstream`, or
  `alternative-built` (with `instead:`, the option that does the job), and a `note:`. `majors:` limits an entry to
  some FFmpeg majors; without it, it is for every major that offers the name.

`tests/ffmpeg-coverage.test.ts` (part of `pnpm run test:ci`, so the required `result` check) fails, naming each, when
an offered name is neither; when an entry is stale (an option turns it on now, or no major the engine knows offers
it); when an option turns on a flag configure doesn't take, or its `ffmpeg-license:` isn't configure's class for what
it turns on; when an option's library builds on no platform the engine builds; and when a recipe is built for no
option. `node scripts/ffmpeg-coverage.ts` prints the same, with each major's counts.

To support one: write the recipe (above) with `configure: [--enable-<name>]`, add the option to each
`ffmpeg/<major>.yml` that offers it (with `ffmpeg-license:` when configure classes it), and remove its
`ffmpeg/unsupported.yml` entry; the test says if anything is left. To decide not to, give it an entry with the
reason. `node scripts/ffmpeg-coverage.ts --issue` prints the pending entries as the checklist of issue #21, which
tracks them; tick or remove the item there when its option lands.

The check reads each major's newest release only: an option an older release had and the newest dropped isn't
offered any more, and being accounted for says nothing about whether a build of it works (that is `recipe-check`'s
and `ships:`'s).

## What CI checks

- **Every pull request, and weekly** (`ci.yml`): `lint` (the code-guidelines check, ESLint, Prettier, types, knip,
  actionlint and zizmor), `test` (Linux and Windows, coverage on Linux), `build` (the package as npm will publish it),
  `audit`, `dependency-review`, `shellcheck` over the remaining shell scripts, and `package` (the packed package
  installed globally builds a library natively). `result` needs them all and is the one required check.
- **A change to a recipe** (`recipes.yml`, which `ci.yml` calls on every pull request, so `result` needs it; and on a
  push to `main` touching `recipes/`, which keeps main's library caches warm): `ffmpeg-build recipe-check` (above)
  plans the changed recipes' check targets once, and one job per platform builds them: Linux, Windows, Android and
  armhf in their Docker images on Linux runners, Apple natively on macOS runners. A pull request that changes no recipe
  builds nothing. A failed build on any platform, or a recipe claiming a platform nothing builds it on, fails `result`.
- **A change to a toolchain** (`toolchains.yml`, on a pull request or a push to `main` touching `platforms/`,
  `images/`, `platforms.yml` or `src/build/`, or by hand from the Actions tab): the small targets in
  `examples/test-builds` build and test in full, on every kind of runner, through the reusable `build.yml` with the
  engine from source. It never publishes. A pull request that changes both a recipe and a toolchain runs both, and
  nothing builds twice.
- **Every week** (`canary.yml`): the canary lock moves to the newest upstream versions, in the run only, and every
  canary target builds in full. A failure there is a new upstream release that broke a recipe, found before any
  consumer's update PR meets it.
- **Every night** (`ffmpeg-support.yml`): `scripts/ffmpeg-support.ts` keeps `ffmpeg/<major>.yml`'s releases equal to
  FFmpeg's tags and reports what a new release's configure adds, drops or reclassifies. It also writes
  `ffmpeg/components/<major>.yml` from each major's newest release (its sources archive): the component lists, the
  runtime names that differ from configure's (read through FFmpeg's macros by `src/c-macros.ts`), and what each
  component needs of configure's options; and `ffmpeg/offered/<major>.yml`, what its configure offers to turn on. When
  `ffmpeg/` changed it opens or refreshes one pull request on `ffmpeg-build/ffmpeg-support`. An option a new release
  adds that nothing accounts for fails that pull request's `result` (the coverage gate, above) until a person supports
  it or lists it in `ffmpeg/unsupported.yml`, on the pull request's branch: the nightly run never pushes over a
  person's commits there, only refreshes the text, until it merges. The report also names pending entries whose issue
  has closed. A new major is only reported: adding its `ffmpeg/<major>.yml` (and `ffmpeg/components/<major>.yml` and
  `ffmpeg/offered/<major>.yml`, which `scripts/ffmpeg-support.ts --write` writes once the major's file exists) is a person's review, and the engine release that ships it moves every consumer's
  `ffmpeg: latest` targets to that major in their next lock update. It runs as the devenvy-bot app when the
  organization has it, and the app's push starts the pull request's CI; without it, `GITHUB_TOKEN` pushes and then
  dispatches `ci.yml` on the branch.
- **Every night** (`release.yml`, below): the next patch release, when anything the package ships changed.
- **Dependabot** (`.github/dependabot.yml`): one weekly pull request for the npm packages and one for the actions, each
  release a week old first; `ci.yml` merges them once they pass. A third keeps the images' base images (`FROM` tag and
  digest) current; it changes every toolchain, so it isn't merged by itself: merge it once `toolchains.yml` passes.
  What an image downloads (NDK, llvm-mingw, shaderc, meson) is pinned in its Dockerfile and moves by hand.

The reusable `update-lock.yml` and `update-pin.yml` aren't run here: separate consumer test repositories call them for
real.

## Releasing the engine

`release.yml` publishes every release; nothing in the repository is bumped by hand.

- **Patch releases are nightly.** When anything the npm package ships changed since the newest `vX.Y.Z` release (the
  code, the engine data, the images, a runtime dependency: `scripts/release-due.ts` says what; docs, tests and CI
  don't count), it runs CI on `main`, cuts the next patch (`v1.2.3` after `v1.2.2`: the tag and a GitHub release with
  generated notes) and publishes it. `node scripts/release-due.ts` shows what tonight's run would do.
- **Minor and major releases are by hand**, and so is the first: publish a GitHub release on a commit of `main`, e.g.
  `gh release create v1.3.0 --target main --generate-notes`, or from the Releases page. The run it starts publishes
  that version. A prerelease (`v1.3.0-rc.1`, marked as a prerelease) goes to npm's `next` dist-tag.

Publishing runs CI on the release commit, sets the package's version from the tag, publishes to
npm with provenance, attests the tarball, attaches it and an SPDX SBOM to the release, and moves the major tag (`v0`
for `v0.2.3`) to the release: consumers call the reusable workflows `@v0`, so that is what they run next. Moving it
runs as the devenvy-bot app when the organization has it (`GITHUB_TOKEN` may not move a tag across commits that change
workflow files). If publishing fails, fix it on `main` and run `release.yml` by hand with the release's tag: it
publishes that tag's code again, and a version already on npm is skipped.

Every engine release reaches every consumer: their daily `update-lock` moves `ffmpeg.lock`'s engine to the newest
release of its major, and a new engine makes all their releases due (built again, and published).

### npm: Trusted Publishing

The workflow publishes without an npm token: npm's [Trusted Publishing](https://docs.npmjs.com/trusted-publishers)
lets the job's GitHub OIDC token (`id-token: write`) stand in for one, and adds provenance. It needs npm 11.5.1 or
later, which Node 24 has. Setting it up, once:

1. **The first publish of a new package is by hand**, because a trusted publisher can only be configured on a package
   that exists. On npmjs.com, create a granular access token with read and write access to packages and a short
   expiry, put it in your `~/.npmrc` as `//registry.npmjs.org/:_authToken=<token>`, and from a clean checkout of the
   commit of `main` to release, with `package.json`'s version set to the one you publish:

       pnpm install --frozen-lockfile && npm publish --access public

   Then remove the line from `~/.npmrc` and revoke the token. Publish the GitHub release `v<that version>` on the same
   commit: `release.yml` sees the version is already on npm, skips publishing it, and attaches the assets and moves the
   major tag.

2. **Configure the trusted publisher** on npmjs.com: the package's Settings, Trusted Publisher, GitHub Actions, with
   the repository's owner and name, the workflow file `release.yml`, and the environment `npm` (the publish job
   runs in it; create the `npm` environment in the repository's Settings, Environments, and add reviewers there if
   releases should wait for approval). Allow it to **publish directly** (`npm publish`), not only to stage a release:
   the workflow publishes in one step. While there, set Publishing access to "Require two-factor authentication and
   disallow tokens", so only the workflow can publish. The publisher names the repository and the workflow file:
   after moving the repository, or renaming `release.yml`, change it to match.
3. **From then on, releases publish themselves**, nightly or when you publish one. No `NPM_TOKEN` secret is used;
   delete any left over.

## Changes that need more than tests

- **A recipe or platform change** should be built for real (`ffmpeg-build recipe-check <name>` for a recipe,
  `ffmpeg-build build --target ...` for a whole build) and, where a published
  counterpart exists, compared with it (`scripts/compare-published*.sh`). Say in the pull request what you built and
  paste the comparison's last lines. A difference you mean to keep goes in the matching `*.expected` file, with its
  reason.
- **A new library** needs its recipe's `license-files:` (the licence texts in its source, which `THIRD-PARTY-NOTICES.txt` carries) and its
  SPDX licence in `recipe.yml`; `check` and the licence table do the rest.
- **An image** (a Dockerfile's `FROM`, a container a workflow runs) is pinned by digest and never pulled from Docker
  Hub directly: CI runners share addresses and hit its anonymous pull limit. Use Docker Hub images through
  `mirror.gcr.io` (`mirror.gcr.io/library/alpine:...@sha256:...`); `tests/image-registry.test.ts` checks.
- **Anything else an image fetches** is pinned by content: a `curl` download is checked with `sha256sum -c`, `pip`
  installs with `--require-hashes`, and a git source is fetched by full commit (its tag in a comment) and `HEAD`
  checked against it; `tests/image-registry.test.ts` checks these too.
- **An action** a workflow uses is pinned by full commit SHA, with its version in a trailing comment
  (`uses: actions/checkout@<sha> # v7.0.1`; resolve it with `git ls-remote https://github.com/<owner>/<repo>
refs/tags/<tag>`, peeling an annotated tag with `^{}`). Dependabot keeps them current;
  `tests/workflow-pins.test.ts` checks.
- **The `ffmpeg-build.yml` format** is a public interface: describe the change in an issue first, and give it a
  `migrate` path if existing folders would break.

## Style

Match the code around you: plain names, comments that say why, messages that tell the user what to do next. Commit
messages say what changed and why in the first line.
