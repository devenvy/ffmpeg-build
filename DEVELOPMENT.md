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

## Upstream support and patches

The engine builds upstream projects; it does not maintain FFmpeg or dependency code. Add support only for
combinations of FFmpeg version, dependency version, platform, toolchain and linking mode that the relevant upstream
projects support. An FFmpeg configure flag alone does not establish support for every such combination.

- Check FFmpeg's dependency requirements and the dependency's build documentation, configure options and CI as
  references. Record the upstream references and compatible versions in the pull request, then verify a full FFmpeg
  build and relevant runtime behavior on every platform and linking mode claimed. Passing a patched build is not
  evidence that the upstream combination works.
- Use upstream build procedures and supported options, compiler/linker flags and configuration tools. Normal
  generated configuration, cross-compilation files, installation/staging and package metadata handling belong here.
- Do not add or carry patches to FFmpeg or dependencies, including source/header edits, upstream build-script edits,
  injected compatibility code or backports of fixes awaiting an upstream release. Do not use `replace-in-file`,
  scripts, generated replacement files, forks or another mechanism to work around this rule. Patches that an
  upstream project ships and applies as part of its own supported build procedure remain upstream's responsibility;
  the engine must not introduce or maintain additional ones.
- When a combination fails, first check compatible upstream versions, toolchains and supported build options.
  If it still requires our patch, omit that combination and document why. A library may be static-only, shared-only,
  restricted to particular platforms or versions, or unsupported. Prefer static by default where upstream supports
  it and we have verified it; never force static or shared support by changing upstream code or build logic.
- Report upstream defects with reproduction steps and wait for a compatible upstream release before claiming the
  affected support. A successful build alone does not resolve a known failure in the runtime behavior being claimed.

This rule applies to engine code, recipes and helper scripts. Existing workarounds are cleanup work, not precedent
or an exception for new contributions. Contributor-maintained patches must not be added to the repository or applied
automatically by the engine. User-supplied patches explicitly selected in a consumer's build profile are separate
from the engine's supported upstream builds and do not establish support here.

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

An option or recipe's FFmpeg `configure:` flags may use `{deps}` for the dependency installation folder, for example
`'--extra-cxxflags=-I{deps}/include'` when FFmpeg compiles a C++ device. The build fills it for its actual folder,
including native builds; it is not a fixed path into a Docker image.

Recipes may declare `linkage: { default: static, modes: { static: {}, shared: { vars: {...}, runtime: [...] } } }`.
Each mode sets recipe variables after platform-specific variables and may replace its runtime globs; `platforms:`
limits a mode to platforms where it was verified. Targets and bases select modes with `link: { recipe: shared }`.
The selected mode affects the library cache, its consumers, release identity, plan output and build notices.
Dependencies retain their own modes. Verify full builds, dependency closure, relocation and real runtime use
before declaring a selectable mode. Recipes without this declaration retain their existing behavior.

A mode may require a dependency to use a compatible library owner, for example
`requires-link: { libxcb: [shared] }` under `linkage.modes.shared`. Use this for APIs
that pass opaque handles or depend on one implementation's global state. Each key
must name a direct `needs` dependency and each accepted mode must be declared by
that provider. Requirements can form a chain through the dependency graph. They
are checked against the complete resolved selection before building: incompatible
choices produce an error, while dependencies keep their defaults until the target
explicitly selects another mode. Verify the accepted combinations; matching source
versions alone do not make separate hidden implementations safe.

`linkage.defaults: { linux-x64: static }` can override a recipe's fallback `default:` on verified platform
patterns. When patterns overlap, the last matching entry wins, as with `build.platforms:`; an explicit target or
base `link:` choice wins over recipe defaults. Every default must name a declared mode supported on that platform.
A mode's optional `configure:` adds FFmpeg flags using the same platform-limited syntax as recipe `configure:`.
These additions apply even when the library is a dependency only, and do not replace an option's own flags.
Configure checks, caches, plans and release identity use the resolved choice. Keep shared defaults on platforms
whose static mode has not yet passed a full build and runtime verification.

A verified `system-shared` mode builds the same kind of shared library but omits its `runtime:` files from the
archive. Give that mode the actual runtime globs and optional `packages: { debian: [...], fedora: [...] }`
suggestions. Staging inspects the resulting ELF requirements and writes `RUNTIME-DEPENDENCIES.json`; package
suggestions are advisory. Verify the archive against distribution-installed libraries separately from the build's
own dependency folder before exposing this mode on a platform.

`source:` is `git:` (with `ref:`, an optional `mirror:`, and `submodules:`) or `url:` (a tarball, with `mirrors:`).
`version-group: <name>` gives recipes released together one version in the lock: `lock` and `update` pick the newest
version every member of the group has and allows (the Vulkan SDK's `vulkan-headers`, `vulkan-loader` and
`spirv-headers` are `version-group: vulkan-sdk`), and a lock whose members differ isn't current.
`submodules: true` runs `git submodule update --init --recursive` right after the checkout;
`submodules: { depth: 1, paths: [a, b] }` runs `git submodule update --init --depth 1 a b`. Both are retried like the
clone (six attempts, 4 s doubling).

### build:

| Key                                                             | What it does                                                                                                                                                                        |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `system:`                                                       | `cmake`, `meson`, `autotools` or `none` (then `steps:` does the build)                                                                                                              |
| `args:`                                                         | the build system's arguments (or, with `none`, what `{args}` holds)                                                                                                                 |
| `source-dir:`                                                   | where CMakeLists.txt / meson.build / configure is                                                                                                                                   |
| `configure-script:`, `make-targets:`, `install-targets:`        | autotools: the script, `make -j<n> <targets>`, `make <install targets>` (`[]`: none)                                                                                                |
| `bootstrap:`                                                    | before anything else: `autogen` (`./autogen.sh`), `autoreconf` (`autoreconf -fi`) or a script in the source; a list tries each in turn, quietly, and the first that works wins      |
| `cargo: { target, package, features, standard-texts, exports }` | a Rust library: its crates, after `before:`, and its C API (below)                                                                                                                  |
| `env:`                                                          | environment variables: a value, or `+= ...` to append to the toolchain's                                                                                                            |
| `unset:`                                                        | environment variables to remove (YAML's `null` is read as text here, so it can't do that)                                                                                           |
| `vars:`                                                         | recipe variables for placeholders: text, or a list                                                                                                                                  |
| `before:`, `steps:`, `after:`                                   | steps around (or, with `steps:`, instead of) the standard build                                                                                                                     |
| `platforms:`                                                    | per platform glob (`win-*`, `linux-x64`): `args`, `env`, `unset`, `vars`, `before`, `after` added for the platforms it matches, in the order written; a later match's variable wins |

The standard builds:

- **cmake**: `cmake -DCMAKE_POLICY_VERSION_MINIMUM=3.5 -B _build -S <source-dir> -DCMAKE_BUILD_TYPE=Release
-DCMAKE_INSTALL_PREFIX=<deps> -DCMAKE_INSTALL_LIBDIR=lib -DCMAKE_PREFIX_PATH=<deps> -DBUILD_SHARED_LIBS=OFF
-DCMAKE_POSITION_INDEPENDENT_CODE=ON <cross args> <args>`, then `cmake --build _build -j<n>` and `cmake --install _build`.
  Optional `build-targets:` selects native build targets with `--target`. `install-components:` selects native
  install components with `--component`; `install-args:` passes additional native install arguments, such as
  `[--prefix, '{deps}']` for relocating an installation configured with a fixed runtime prefix.
- **meson**: `meson setup _build <source-dir> --prefix=<deps> --libdir=lib --default-library=static
--buildtype=release <cross args> <args>`, then `meson compile` and `meson install`.
- **autotools**: `./configure --prefix=<deps> <args> [--host=<triple>]` (`--host` only when cross-compiling), then
  `make -j<n> <make-targets>` and `make <install-targets>`.
  Everything else is the recipe's: say `--disable-shared
--enable-static --with-pic` (and `--libdir={deps}/lib` if the library wants it) in `args:`, in the order you want.

### Rust libraries

A library built with cargo (rav1e, librsvg) compiles in crates from crates.io, which its notices and sources must
carry too. `cargo:` names how its build selects them: the Rust `target` (`'{target}'`), the `package` cargo-c builds,
and its `features` (besides the default ones). After `before:` (which may install Rust), the engine runs
`cargo fetch --locked` (every crate Cargo.lock names, each checked against its checksum), lists what is linked into
the library for the target (`cargo tree -e normal,no-proc-macro`), and builds offline from then on
(`CARGO_NET_OFFLINE`). Then:

- every crate linked in must be under a licence the recipe's `license:` names (so `check`, which reads only the
  recipe, stays true; it may not let the recipe into builds the crate may not go in) and the build's licence allows
  (licenses.yml): otherwise the build stops before compiling, naming the crate. A library taken from the cache is
  checked again.
- each linked crate's licence files go into THIRD-PARTY-NOTICES.txt under the library (each distinct text once), and
  the Rust standard library's notices (the toolchain's COPYRIGHT-library) once for the build. A crate that ships no
  licence file fails the build until someone checks it and lists it in `standard-texts:`; it then gets the engine's
  standard text of its licence (`license-texts/`), marked so.
- every crates.io crate of Cargo.lock is kept as crates.io serves it (`sources/crates/<name>-<version>.crate` in the
  cache, `.sources/` and the release's sources archive, as `cargo vendor` would hold them; SOURCES.md lists each and
  says how to build offline from them).

Rust static libraries include their Rust dependencies, so combinations need native link and runtime verification.
Rav1e uses its upstream `release-no-lto` profile. Its LTO release archive merged Rust standard-library definitions
into codec objects, causing duplicate definitions with librsvg in native CI. Verify the combined build after
changes to compiler versions, profiles or dependencies; a passing individual build does not establish compatibility.
Preserve the outputs produced by upstream's Cargo build; the engine does not rename private symbols or reconstruct
archives. Use ordinary archive extraction/link ordering and upstream static/shared outputs. If a combination fails
with unmodified libraries, restrict that combination after verifying an upstream-supported alternative. Planning a
target successfully is not proof that its native Rust archives can link or run together.

### Steps

A step is a command, or one of the operations below. A command is a list: `[make, '-j{jobs}', install]`. Any
operation, and `run:`, can take `when:`.

| Step                                                                                                  | What it does                                                                                                                                                                                                                                                                               |
| ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `[cmd, arg, ...]`                                                                                     | runs the command in the source folder                                                                                                                                                                                                                                                      |
| `run: [cmd, ...]` with `env:`, `unset:`, `cwd:`                                                       | the same, with this command's own environment additions and folder                                                                                                                                                                                                                         |
| `when: { platforms: [...], exists: <glob>, missing: <glob>, set: '{x}', unset: '{x}' }`               | runs the step only if all that are given hold (`set`: the text is not empty once filled in)                                                                                                                                                                                                |
| `vars: { name: value }`                                                                               | sets recipe variables (a list stays a list)                                                                                                                                                                                                                                                |
| `find: { var, glob: [...], dirname, basename, ignore-case, required: <message> }`                     | the first path the globs match (in order); empty, or an error with `required:`                                                                                                                                                                                                             |
| `read: { file, pattern, var, last, message }`                                                         | a variable from a file: the regex's first group, of its first (or `last`) match                                                                                                                                                                                                            |
| `check: { ..., message }`                                                                             | fails the build with the message unless it holds: `exists:`/`missing:` a glob, `file:` with `contains:` or `line:`, `command:` on PATH, or `output: [cmd, ...]` matching `matches:` (with `min-version:` for its first group; `cwd:`)                                                      |
| `copy: { from, to \| into, recursive, preserve }`                                                     | `from` is a path, glob or list of them; `to` is the copy's path, `into` a folder                                                                                                                                                                                                           |
| `move: { from, to }`                                                                                  | renames a file                                                                                                                                                                                                                                                                             |
| `remove: { path, recursive }`                                                                         | deletes a path, or everything a glob matches                                                                                                                                                                                                                                               |
| `write-file: { path, text }`                                                                          | writes a file                                                                                                                                                                                                                                                                              |
| `pkg-config: { name, description, version, libs, libs-private, requires, cflags, exec-prefix, file }` | writes `{deps}/lib/pkgconfig/<file or name>.pc` in the usual layout: `prefix=`, `libdir=` (when there are `libs`), `includedir=`, then the fields; `Libs: -L${libdir} <libs>`, `Cflags: -I${includedir} <cflags>`                                                                          |
| `edit-pkg-config: { path, optional, variables, <field>: { <edit>, missing } }`                        | edits installed `.pc` metadata (a path or glob). Fields: `libs`, `libs-private`, `requires`, `requires-private`, `cflags`, `cflags-private`. Edits: `append`, `prepend`, `add`, `set`, `remove`, `tokens`, `remove-library-paths`. `missing:` is `end` (default), `after-libs`, or `skip`. |
| `sync-shaderc-deps: true`                                                                             | shaderc's `utils/git-sync-deps`, verified and retried                                                                                                                                                                                                                                      |

File paths are relative to the source, or start with `{src}`, `{deps}` or a variable holding a path; a step can't
reach outside the source and deps folders.

`edit-pkg-config` accepts only `.pc` paths and globs. Its `variables:` relocates existing installation variables
(`prefix`, `exec_prefix`, `libdir`, `includedir`) without changing source or installed headers. `append` and
`prepend` add the given words at the end or start of a field; `add` adds only missing words, `set` sets its value,
and `remove` removes whole words. `tokens: { '-l-lpthread': -lpthread }` maps exact metadata words, without regexes
or substring matches. `remove-library-paths: [mbedcrypto]` removes file inputs naming that library from a field;
retain the appropriate `-l` flags and dependency order for cache relocation. These are packaging operations and
must not be used to introduce source, header or build-script patches.

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

First establish the upstream-supported combinations under [Upstream support and patches](#upstream-support-and-patches).

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

Apply [Upstream support and patches](#upstream-support-and-patches) before adding an option or extending its
platforms, versions or linking modes. Coverage bookkeeping does not establish upstream support.

Everything FFmpeg's configure can turn on (its external library and hardware options: configure's
`EXTERNAL_LIBRARY_LIST`, `EXTERNAL_AUTODETECT_LIBRARY_LIST`, `HWACCEL_LIBRARY_LIST` and
`HWACCEL_AUTODETECT_LIBRARY_LIST`, and the `--enable-`/`--disable-` lines of `--help`'s library section) is in
`ffmpeg/offered/<major>.yml`, with its licence class, as the major's newest release has it. The nightly support check
writes it (`node scripts/ffmpeg-support.ts --write`); it is never edited by hand. Each name there is either:

- **supported**: an option of `ffmpeg/<major>.yml` turns it on, through its own `configure:`, its library's
  `configure:` (on some platform the engine builds), or as `--enable-<option>` when it is `builtin: true`; or
- **listed** in `ffmpeg/unsupported.yml` with a reason: `pending` (with the open `issue:` that tracks it, and its
  `batch:` there), `sdk-not-redistributable`, `needs-hardware-sdk`, `platform-not-built`, `deprecated-upstream`, or
  `upstream-incompatible` (current releases or toolchains need an upstream fix), `alternative-built` (with
  `instead:`, the option that does the job) or `shared-only` (its library needs a shared
  dependency chain that has not been integrated and verified), and a `note:`. Shared-only libraries can be supported
  once that chain is verified; Samba is an example. `majors:` limits an entry to
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
