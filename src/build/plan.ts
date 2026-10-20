import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import { parseDocument } from 'yaml';

import { androidApiFor, androidApiProblems, isAndroid } from '../android-api.ts';
import { type About, aboutSchema, patchAdditions } from '../check.ts';
import { versionInCell } from '../choose.ts';
import { componentFlags } from '../component-lists.ts';
import { depsOn, type EngineData, optionRecipe, optionsOf, valuesOn } from '../engine-data.ts';
import { COMPONENT_KINDS, type Components } from '../ffmpeg-components.ts';
import { allowedBy } from '../licenses.ts';
import { packageVersion } from '../paths.ts';
import { availability, type CellPlan } from '../resolve.ts';
import { releaseVersion } from '../targets.ts';
import { unique } from '../text.ts';
import { treeHash } from '../tree-hash.ts';
import { buildModules } from './modules.ts';
import { rustLinkProblem } from './rust-archive.ts';
import { parseYaml } from '../yaml.ts';

import type { LockedProfile, SourcePin } from '../lockfile.ts';
import type { Profile } from '../profile.ts';
import type { LicenseFile, Recipe, Submodules } from '../schema/engine.ts';
import type { License } from '../schema/profile.ts';

/**
 * The libraries' install prefix inside every build container; fixed, so absolute paths in .pc files stay valid. A
 * native (macOS) build uses its own fixed folder instead and passes it as `depsDir`.
 */
const DEPS_DIR = '/opt/ffmpeg-build/deps';

/** {version}, {major}, {minor}, {patch}, and {version_} / {version-} for tags that use _ or - between numbers. */
export function expandTemplate(template: string, version: string): string {
  const [major = '', minor = '', patch = ''] = version.split('.');
  return template
    .replaceAll('{version_}', version.replaceAll('.', '_'))
    .replaceAll('{version-}', version.replaceAll('.', '-'))
    .replaceAll('{version}', version)
    .replaceAll('{major}', major)
    .replaceAll('{minor}', minor)
    .replaceAll('{patch}', patch);
}

/**
 * Where a source comes from: a git ref (with `commit`, the commit ffmpeg.lock pins it to, which the fetch must give),
 * a commit (a branch library's version), or tarballs in order (with `sha256`, the pinned content each must have).
 */
export type Source =
  | { git: string; ref: string; commit?: string; mirror?: string; submodules?: Submodules }
  | { git: string; commit: string; mirror?: string; submodules?: Submodules }
  | { archives: string[]; sha256?: string };

/**
 * Where to fetch `recipe` at `version`: a git tag/branch ref, a commit (branch libraries), or tarballs in order; with
 * the content ffmpeg.lock pins (`pin`) when it has a pin of the kind the source needs.
 */
export function sourceOf(
  data: EngineData,
  recipe: string,
  version: string,
  pin?: SourcePin,
): Source {
  const r = data.recipes.get(recipe)!;
  const s = r.source;
  if ('url' in s) {
    return {
      archives: [s.url, ...(s.mirrors ?? [])].map((u) => expandTemplate(u, version)),
      ...(pin?.sha256 ? { sha256: pin.sha256 } : {}),
    };
  }
  const mirror = {
    ...(s.mirror ? { mirror: s.mirror } : {}),
    ...(s.submodules ? { submodules: s.submodules } : {}),
  };
  if ('git-branch' in r.versions) {
    return { git: s.git, commit: version, ...mirror };
  }
  return {
    git: s.git,
    ref: expandTemplate(s.ref, version),
    ...(pin?.commit ? { commit: pin.commit } : {}),
    ...mirror,
  };
}

// Upstream devenvy/ffmpeg scripts/steps/07_build_ffmpeg.sh: shared FFmpeg libraries, static dependencies,
// nothing picked up from the build machine by accident (--disable-autodetect). What differs by platform (programs,
// threads, PIC, cross-compiling) is in platforms.yml.
const COMMON_FLAGS = [
  '--enable-shared',
  '--disable-static',
  '--disable-doc',
  '--disable-debug',
  '--disable-autodetect',
  '--pkg-config-flags=--static',
];
// Explicit --disable-gpl / --disable-nonfree as upstream passes them, so `ffmpeg -buildconf` matches today's builds.
export const LICENSE_FLAGS: Record<License, string[]> = {
  lgplv2: ['--disable-gpl', '--disable-nonfree'],
  lgplv3: ['--disable-gpl', '--enable-version3', '--disable-nonfree'],
  gplv2: ['--enable-gpl', '--disable-nonfree'],
  gplv3: ['--enable-gpl', '--enable-version3', '--disable-nonfree'],
  nonfree: ['--enable-gpl', '--enable-version3', '--enable-nonfree'],
};

/**
 * Each option's FFmpeg flags: its own `configure:` (for a library behind several options), else its recipe's;
 * a built-in option without either is `--enable-<name>`.
 */
function optionFlags(data: EngineData, plan: CellPlan): string[] {
  const options = optionsOf(data, plan.cell.major);
  return unique(
    plan.options.flatMap((o) => {
      const info = options.get(o);
      if (info?.configure) {
        return info.configure;
      }
      const lib = info && optionRecipe(info, plan.cell.platform);
      return lib
        ? valuesOn(data.recipes.get(lib)!, 'configure', plan.cell.platform)
        : [`--enable-${o}`];
    }),
  );
}

/**
 * FFmpeg's configure flags for a cell. A target's components: come first (src/component-lists.ts: each kind it lists
 * turned off, then on for its names, what its options bring and what its patch sets add, `adds`), so the platform's,
 * the options' and the patch sets' own enables come after them.
 */
export function configureFlags(
  data: EngineData,
  plan: CellPlan,
  depsDir = DEPS_DIR,
  adds: Partial<Components> = {},
): string[] {
  return unique([
    ...COMMON_FLAGS,
    ...componentFlags(
      data,
      {
        major: plan.cell.major,
        license: plan.cell.license,
        platform: plan.cell.platform,
        options: plan.options,
        ...(plan.components ? { components: plan.components } : {}),
      },
      adds,
    ),
    `--extra-cflags=-I${depsDir}/include`,
    `--extra-ldflags=-L${depsDir}/lib`,
    ...(data.platforms.get(plan.cell.platform)?.configure ?? []),
    ...LICENSE_FLAGS[plan.cell.license],
    ...optionFlags(data, plan),
  ]);
}

/** `--enable-libx265` → `LIBX265`: what must read `CONFIG_LIBX265=yes` in ffbuild/config.mak after configure. */
export function verifyNames(data: EngineData, plan: CellPlan): string[] {
  return optionFlags(data, plan)
    .filter((f) => f.startsWith('--enable-'))
    .map((f) => {
      // --enable-hwaccel=h264_mediacodec is CONFIG_H264_MEDIACODEC_HWACCEL; --enable-libx265 is CONFIG_LIBX265
      const [what, name] = f.slice('--enable-'.length).split('=') as [string, string | undefined];
      return (name ? `${name}_${what}` : what).replaceAll('-', '_').toUpperCase();
    });
}

function filesUnder(dir: string, prefix = ''): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => (a.name < b.name ? -1 : 1))
    .flatMap((d) =>
      d.isDirectory()
        ? filesUnder(join(dir, d.name), `${prefix}${d.name}/`)
        : [`${prefix}${d.name}`],
    );
}

/**
 * A hash of every file in recipes/<name>. `withoutLicenses`
 * leaves out what only says which licence texts it ships (recipe.yml's license-files and the texts kept beside it),
 * which can't change what a library that builds against it gets.
 */
function recipeFilesHash(
  root: string,
  recipe: string,
  withoutLicenses?: readonly LicenseFile[],
): string {
  const hash = createHash('sha256');
  const dir = join(root, 'recipes', recipe);
  const beside = new Set((withoutLicenses ?? []).filter((f) => f.recipe).map((f) => f.path));
  for (const file of filesUnder(dir).filter((f) => !beside.has(f))) {
    let content: string | Buffer = readFileSync(join(dir, file));
    if (withoutLicenses && file === 'recipe.yml') {
      // parsed, not matched: the list may be on one line, wrapped over several, or a block
      const doc = parseDocument(content.toString('utf8'));
      doc.delete('license-files');
      content = doc.toString();
    }
    hash.update(`${file}\0`).update(content).update('\0');
  }
  return hash.digest('hex');
}

/** Toolchain names implemented by the Node build engine. `fake` is the end-to-end test fixture. */
const TOOLCHAIN_SETUPS = [
  'linux',
  'linux-musl',
  'linux-armhf',
  'android',
  'windows',
  'apple-macos',
  'apple-ios',
  'fake',
] as const;
// every build module but the host-side ones (Docker, native-machine checks): anything that runs inside the build, or
// shapes a recipe's commands, changes the libraries it makes
// (the modules as this engine runs them: TypeScript in a checkout, the compiled JavaScript in an installed package)
const HOST_SIDE = new Set(['docker', 'native', 'host', 'modules']);
export const toolchainDefinitionFiles = (engineRoot: string): string[] => {
  const m = buildModules(engineRoot);
  const dir = join(engineRoot, ...m.dir.split('/'));
  return readdirSync(dir)
    .filter((f) => f.endsWith(m.ext) && !HOST_SIDE.has(f.slice(0, -m.ext.length)))
    .sort()
    .map((name) => join(dir, name));
};

/**
 * What builds every library besides its recipe: image digest, platform data and the Node modules that materialize
 * compiler flags/cross files and invoke/stage the build.
 */
export function toolchainIdentity(engineRoot: string, imageId: string, setup: string): string {
  if (!(TOOLCHAIN_SETUPS as readonly string[]).includes(setup)) {
    throw new Error(`unknown platform toolchain ${setup}`);
  }
  const hash = createHash('sha256')
    .update(`${imageId}\0${setup}\0`)
    .update(readFileSync(join(engineRoot, 'platforms.yml')));
  for (const file of toolchainDefinitionFiles(engineRoot)) {
    hash.update(`\0${file.slice(engineRoot.length)}\0`).update(readFileSync(file));
  }
  return hash.digest('hex');
}

/**
 * One key per library: its facts, its files, the toolchain, and the keys of the libraries it builds against
 * (`needs`, plus any `uses` member that is in this build), so a changed dependency rebuilds its dependents. What a
 * dependent counts of a dependency leaves out the dependency's licence files: changing which texts a library ships
 * rebuilds that library only.
 */
export function cacheKeys(
  data: EngineData,
  recipes: readonly string[],
  versionOf: (recipe: string) => string,
  platform: string,
  toolchain: string,
  pinOf: (recipe: string) => SourcePin | undefined = () => undefined,
  androidApi?: number,
): Map<string, string> {
  const ids = new Map<string, { key: string; asDependency: string }>();
  const inBuild = new Set(recipes);
  const sha = (fact: object) => createHash('sha256').update(JSON.stringify(fact)).digest('hex');
  const idOf = (recipe: string): { key: string; asDependency: string } => {
    const known = ids.get(recipe);
    if (known) {
      return known;
    }
    const r = data.recipes.get(recipe)!;
    const against = [
      ...depsOn(r, 'needs', platform),
      ...depsOn(r, 'uses', platform).filter((n) => inBuild.has(n)),
    ].map((n) => idOf(n).asDependency);
    // the pinned commit or content too: a tag moved upstream at the same version rebuilds the library and what builds
    // against it (no pin, as in a lock without pins, adds nothing: the key it always had)
    const pin = pinOf(recipe);
    const fact = {
      recipe,
      version: versionOf(recipe),
      platform,
      toolchain,
      against,
      ...(pin ? { pin } : {}),
      // android: the API level it is compiled for (a library built for 28 may call what 24 lacks)
      ...(androidApi !== undefined ? { androidApi } : {}),
    };
    const id = {
      key: sha({ ...fact, files: recipeFilesHash(data.root, recipe) }),
      asDependency: sha({ ...fact, files: recipeFilesHash(data.root, recipe, r['license-files']) }),
    };
    ids.set(recipe, id);
    return id;
  };
  for (const recipe of recipes) {
    idOf(recipe);
  }
  return new Map(recipes.map((r) => [r, ids.get(r)!.key]));
}

function setupOf(data: EngineData, platform: string): string {
  const entry = data.platforms.get(platform);
  if (!entry) {
    throw new Error(`${platform} isn't in platforms.yml`);
  } // runBuild checks first; this is a guard
  return entry.setup;
}

/**
 * A patch set the target names: its folder's name, its licence (about.yml), a hash of the whole set (as releases
 * compare it), its patches for this FFmpeg major (in name order, applied in that order) and its licence texts.
 */
export interface PlannedPatchSet {
  name: string;
  license: string;
  sha256: string;
  files: { name: string; text: string }[];
  licenses: { path: string; text: string }[];
  configure: string[];
  adds?: Partial<Components>; // the components its patches add (about.yml's adds:), by kind
}

/** Where the build's definition came from: the repository URL and commit (`-dirty` when it had local changes). */
export interface BuildSource {
  repo?: string;
  ref?: string;
}

export interface BuildPlan {
  platform: string;
  setup: string; // the platform toolchain definition implemented by src/build/toolchain.ts
  image: string; // platforms.yml image: the toolchain image's folder, or macos
  toolchain: string; // the toolchain identity: part of every library's cache key
  engine: string; // the ffmpeg-build version that made the plan
  name: string;
  target: string; // the target (or profile variant) this build is
  license: License;
  release?: string; // the release tag it ships in; none for a build outside a release
  repository?: string; // owner/repo the release is published in
  sourcesArchive: string; // the release's sources archive
  libraries: {
    name: string;
    version: string;
    license: string;
    key: string;
    cached: boolean;
    source: Source;
    licenseFiles: LicenseFile[];
    build: Recipe['build'];
  }[];
  runtime: string[]; // globs under DEPS_DIR that ship next to FFmpeg's libraries (e.g. lib/libvulkan.so*)
  ships: { file: string; license: string; notice: string }[]; // platform files the archives carry, with their notice's path in the toolchain
  patches: PlannedPatchSet[];
  // THIRD-PARTY-NOTICES.txt: the governing COPYING texts of FFmpeg to include, and the sections the plan can write
  notices: { governing: string[]; header: string; build: string; source: string };
  // a build with a Rust library (a recipe with cargo:): licenses.yml, which its crates are checked against, and the
  // standard licence texts (license-texts/) for crates reviewed to ship none
  cargo?: { licenses: Record<string, License[]>; texts: Record<string, string> };
  ffmpeg?: {
    version: string;
    archives: string[];
    sha256?: string;
    configure: string[];
    verify: string[];
  }; // none: build the libraries only
  androidApi?: number; // android-*: the Android API level the libraries and FFmpeg are compiled for
}

// How upstream devenvy/ffmpeg 10_write_legal.sh names each licence, and which of FFmpeg's COPYING texts govern it.
const LICENSE_LABEL: Record<License, string> = {
  lgplv2: 'LGPLv2.1',
  lgplv3: 'LGPLv3',
  gplv2: 'GPLv2',
  gplv3: 'GPLv3',
  nonfree: 'nonfree',
};
const LICENSE_NAME: Record<License, string> = {
  lgplv2: 'GNU Lesser General Public License, version 2.1',
  lgplv3: 'GNU Lesser General Public License, version 3',
  gplv2: 'GNU General Public License, version 2',
  gplv3: 'GNU General Public License, version 3',
  nonfree: 'not redistributable: configured with --enable-nonfree',
};
export const GOVERNING_TEXTS: Record<License, [string, ...string[]]> = {
  lgplv2: ['COPYING.LGPLv2.1', 'COPYING.GPLv2'],
  lgplv3: ['COPYING.LGPLv3', 'COPYING.GPLv3'],
  gplv2: ['COPYING.GPLv2'],
  gplv3: ['COPYING.GPLv3'],
  nonfree: ['COPYING.GPLv3'],
};
// the version 2 licence a v3 build would otherwise be: what its libraries are measured against
const V2_OF: Partial<Record<License, License>> = { lgplv3: 'lgplv2', gplv3: 'gplv2' };

/**
 * The effective licence, and why (what upstream's LICENSE-NOTICE.txt said). A v3 build names the libraries whose own
 * licence the version 2 licence doesn't allow (the Apache-2.0 parts); a v2 build names its TLS member (or says it has
 * none); a nonfree build says it isn't redistributable and names what makes it nonfree.
 */
export function licenseNotice(data: EngineData, cell: CellPlan): string {
  const license = cell.cell.license;
  const spdx = (r: string) => data.recipes.get(r)!.license;
  const allows = (r: string, l: License) => {
    const verdict = allowedBy(spdx(r), data.licenses);
    return 'allowed' in verdict && verdict.allowed.includes(l);
  };
  const tls = cell.groups['tls'];
  // with none chosen: whether any TLS option was open to this build, or none is under this licence and platform
  const tlsOpen = [...optionsOf(data, cell.cell.major).values()].some(
    (o) => o.group === 'tls' && !availability(data, cell.cell, o.name),
  );
  let tlsLine: string;
  if (!tls) {
    tlsLine = tlsOpen
      ? 'This build has no TLS library.'
      : `This build has no TLS: no TLS library ${LICENSE_LABEL[license]} allows is available for ${cell.cell.platform}.`;
  } else {
    tlsLine = data.recipes.has(tls)
      ? `TLS is ${tls} (${spdx(tls)}).`
      : `TLS is the operating system's ${tls} backend, which bundles no library.`;
  }
  const governing = GOVERNING_TEXTS[license];
  const lines = [
    `EFFECTIVE LICENSE:  ${LICENSE_LABEL[license]} (${LICENSE_NAME[license]})`,
    '',
    `Governing license text: ${governing[0]}${governing[1] ? ` (plus ${governing[1]}, which it extends)` : ''}${license === 'nonfree' ? ", for FFmpeg's own code" : ''}; in full under FFMPEG below.`,
    '',
  ];
  const list = (rs: string[]) => rs.map((r) => `  ${r} (${spdx(r)})`);
  const v2 = V2_OF[license];
  if (license === 'nonfree') {
    // no version paragraph: a nonfree build isn't under any version of the (L)GPL as a whole
    const parts = cell.recipes.filter((r) => !allows(r, 'gplv3'));
    // FFmpeg's own options that configure only accepts with --enable-nonfree (no library of their own)
    const all = optionsOf(data, cell.cell.major);
    const nonfreeOptions = cell.options.filter(
      (o) => all.get(o)?.builtin && all.get(o)?.ffmpegLicense === 'nonfree',
    );
    lines.push(
      ...(parts.length || nonfreeOptions.length
        ? [
            'This build is NOT REDISTRIBUTABLE. It uses --enable-nonfree: it combines FFmpeg with code whose licence is',
            'incompatible with the GPL, so it may not be distributed to anyone. It is for internal use only.',
            ...(parts.length ? ['The libraries that make it nonfree:', ...list(parts)] : []),
            ...(nonfreeOptions.length
              ? ['The FFmpeg options that make it nonfree:', ...nonfreeOptions.map((o) => `  ${o}`)]
              : []),
          ]
        : [
            'This build is NOT REDISTRIBUTABLE. It is configured with --enable-nonfree because it was asked to be',
            '(license: nonfree), though nothing in it needs that. It is for internal use only.',
          ]),
      tlsLine,
    );
  } else if (v2) {
    const parts = cell.recipes.filter((r) => allows(r, license) && !allows(r, v2));
    lines.push(
      ...(parts.length
        ? [
            'This build uses --enable-version3 because it links libraries (the Apache-2.0 parts) whose licences are',
            'compatible with version 3 of the (L)GPL but not with version 2.1/2:',
            ...list(parts),
            'Its effective license is therefore version 3.',
          ]
        : ['This build uses --enable-version3, though none of its libraries needs it.']),
      tlsLine,
    );
  } else {
    lines.push(
      `This is a version 2 build: it doesn't use --enable-version3 and links no library that needs version 3.`,
      tlsLine,
    );
  }
  return `${lines.join('\n')}\n`;
}

/** The top of THIRD-PARTY-NOTICES.txt: what this is, its effective licence and why, and FFmpeg's modifications. */
export function noticesHeader(a: {
  version: string;
  target: string;
  platform: string;
  engine: string;
  licence: string;
  patches: readonly PlannedPatchSet[];
}): string {
  const lines = [
    `FFmpeg ${a.version} — ${a.target} (${a.platform}), built by ffmpeg-build ${a.engine}`,
    '',
    a.licence.trimEnd(),
    '',
  ];
  if (a.patches.length) {
    lines.push(
      'FFmpeg was modified by these patch sets (applied to its source before it was configured; see PATCH SETS below):',
      ...a.patches.map(
        (p) =>
          `  ${p.name}: ${p.files.length} patch${p.files.length === 1 ? '' : 'es'} (${p.files.map((f) => f.name).join(', ') || 'none for this FFmpeg version'}), sha256 ${p.sha256}`,
      ),
      '',
    );
  }
  lines.push(
    "This file holds every licence and notice this build carries: FFmpeg's own texts first, then each bundled",
    "library's, with where its source comes from. Sections: BUILD, SOURCE, FFMPEG, COMPONENTS, then PATCH SETS and",
    'FILES THE PLATFORM SHIPS when the build has them. Each opens with a rule of = signs, its title in capitals and a',
    'rule (a licence text may hold a rule of its own); each component with "== <name> <version> ==", each text with',
    '"--- <file> ---".',
  );
  return `${lines.join('\n')}\n`;
}

/** The BUILD section, including the FFmpeg configure line recorded from the build. */
export function noticesBuild(a: {
  platform: string;
  setup: string;
  image: string;
  toolchain: string;
}): string {
  const where =
    a.image === 'macos'
      ? 'natively on macOS with Xcode'
      : `in the toolchain image images/${a.image}`;
  return [
    `Platform: ${a.platform}, built ${where}, using the ${a.setup} toolchain definition`,
    `Toolchain identity: ${a.toolchain}`,
    "  (a hash of the toolchain image, platform data and Node build modules; part of every library's cache key)",
    '',
  ].join('\n');
}

/** A repository URL at a commit, as a link where the host has one (GitHub's /tree/<commit>). */
function atCommit(repo: string, ref: string): string {
  const commit = ref.replace(/-dirty$/, '');
  const link = /^https:\/\/github\.com\/[^/]+\/[^/]+$/.test(repo)
    ? `${repo}/tree/${commit}`
    : `${repo} at commit ${commit}`;
  return ref.endsWith('-dirty')
    ? `${link}\n  (built with local changes to that commit, so it isn't the whole build definition)`
    : link;
}

/**
 * The SOURCE section: where the complete corresponding source is. A public release links its sources archive; a
 * release in a private repository, and a build in no release, can't be pointed at, so they make a written offer of
 * it instead, through the folder's source-offer: contact, or else whoever distributed the build. A public release
 * makes the offer as well when there is a contact. A nonfree build isn't distributed, so it makes none.
 */
export function noticesSource(a: {
  name: string;
  version: string;
  license: License;
  release?: string;
  repository?: string;
  privateRepo?: boolean; // the release's repository is private: nobody outside it can open a link into it
  sourceOffer?: string; // who the written offer names to ask for the source (ffmpeg-build.yml's source-offer:)
  sourcesArchive: string;
  source: BuildSource;
  ffmpegTarball: string;
  patchSets?: string[];
}): string {
  const publicRelease = Boolean(a.release) && !a.privateRepo;
  const offer = a.license !== 'nonfree' && (Boolean(a.sourceOffer) || !publicRelease);
  const lines: string[] = [];
  if (a.release && a.repository && !a.privateRepo) {
    lines.push(
      'Complete corresponding source, as required by the licences above:',
      `  https://github.com/${a.repository}/releases/download/${a.release}/${a.sourcesArchive}`,
      `This archive, published with release ${a.release}, holds the complete corresponding source for this build: FFmpeg's`,
      'release tarball, every library at the exact version (and commit) it was built from, the patches applied, and the',
      "build scripts and toolchain definitions (ffmpeg-build.yml, ffmpeg.lock, the engine's recipes, Node platform modules and",
      'toolchain image Dockerfiles).',
    );
  } else if (a.release) {
    lines.push(
      `Complete corresponding source: ${a.sourcesArchive}, published with release ${a.release}${a.privateRepo ? ' in a private' : '.'}`,
      ...(a.privateRepo ? ['repository, which only people with access to it can open.'] : []),
      "It holds FFmpeg's release tarball, every library at the exact version (and commit) it was built from, the patches",
      'applied, and the build scripts and toolchain definitions.',
    );
  } else {
    lines.push(
      'This build was not published in a release (a local or unreleased build). Its source is recorded in',
      `${a.name}.sources.json beside it, every source with its sha256 (and commit), and kept in the build cache`,
      'under sources/.',
      offer
        ? `Keep its sources archive (${a.sourcesArchive}) for as long as the written offer below holds.`
        : `It must be published together with its sources archive (${a.sourcesArchive}) before it is\ndistributed.`,
    );
  }
  lines.push('');
  let definition = 'not recorded (the build had no FFMPEG_BUILD_SOURCE_REPO and no git remote)';
  if (a.source.repo && a.source.ref) {
    // a private repository's tree is no link anyone could open: its files are in the sources archive
    definition = a.privateRepo
      ? `${a.source.repo} at commit ${a.source.ref.replace(/-dirty$/, '')} (private: its ffmpeg-build.yml and ffmpeg.lock are in the sources archive)`
      : atCommit(a.source.repo, a.source.ref);
  } else if (a.source.repo) {
    definition = a.source.repo;
  }
  lines.push(
    `Build definition: ${definition}`,
    a.patchSets?.length
      ? `FFmpeg ${a.version}, upstream release, modified by the patch sets ${a.patchSets.join(', ')} (in the sources archive): ${a.ffmpegTarball}`
      : `FFmpeg ${a.version}, unmodified upstream: ${a.ffmpegTarball}`,
    'Each component below names its upstream origin, exact version and commit, so it can also be fetched from upstream',
    // a release publishes the list inside its sources archive; an unreleased build has it beside its archives
    a.release
      ? `directly. SOURCES.md in ${a.sourcesArchive} lists every source with its sha256.`
      : `directly. ${a.name}.sources.json lists every source with its sha256.`,
  );
  if (publicRelease) {
    lines.push(
      '',
      'Everything is public; no request to the distributor is necessary to obtain it.',
    );
  }
  if (offer) {
    lines.push(
      '',
      'This is a written offer, valid for at least three years after this build was last distributed and for as long as',
      'spare parts or customer support are offered for the product it came with: anyone who has this build may obtain',
      `its complete corresponding source (${a.sourcesArchive}), on a medium customarily used for software interchange or`,
      'by download, for no more than the cost of physically performing that distribution, by asking',
      `${a.sourceOffer ?? 'whoever distributed this build to you'}.`,
    );
  }
  if (a.license === 'nonfree') {
    lines.push(
      '',
      ...(a.privateRepo && a.repository
        ? [
            `${a.repository} is a private repository: this build, and its source, are only for people with access to it.`,
          ]
        : []),
      'This is a nonfree build (--enable-nonfree): it is for internal use only and is not offered for redistribution.',
    );
  }
  return `${lines.join('\n')}\n`;
}

/** What a patch set adds (about.yml's adds:), when it adds anything. */
function additions(about: About): { adds?: Partial<Components> } {
  const { adds } = patchAdditions(about);
  return Object.keys(adds).length ? { adds } : {};
}

/** The patch sets a profile names, read from their folders: about.yml (checked already), patches and licence texts. */
export function plannedPatches(profile: Profile, major: string): PlannedPatchSet[] {
  return profile.patches.map((p) => {
    const dir = join(profile.dir ?? '.', p);
    const about = aboutSchema.parse(
      parseYaml(readFileSync(join(dir, 'about.yml'), 'utf8'), `${p}/about.yml`),
    );
    const patchDir = join(dir, major);
    const files = existsSync(patchDir)
      ? filesUnder(patchDir)
          .filter((f) => /\.(patch|diff)$/.test(f))
          .sort()
      : [];
    return {
      name: basename(dir),
      license: about.license,
      sha256: treeHash(dir), // the whole set (about.yml, licences, every major's patches): what releases compare
      files: files.map((f) => ({ name: f, text: readFileSync(join(patchDir, f), 'utf8') })),
      licenses: about['license-files'].map((path) => ({
        path,
        text: readFileSync(join(dir, path), 'utf8'),
      })),
      configure: about.configure ?? [], // what FFmpeg needs to build what the patches add (e.g. --enable-muxer=...)
      ...additions(about), // only for a set that adds components: the plan is as it was for one that adds none
    };
  });
}

/**
 * What a build with a Rust library needs to check and credit its crates (BuildPlan's cargo): licenses.yml, and the
 * standard licence texts the engine has (license-texts/<SPDX id>.txt). None when no recipe in it has cargo:.
 */
export function cargoPlan(data: EngineData, recipes: readonly string[]): BuildPlan['cargo'] {
  if (!recipes.some((r) => data.recipes.get(r)?.build.cargo)) {
    return undefined;
  }
  const dir = join(data.root, 'license-texts');
  return {
    licenses: Object.fromEntries(data.licenses),
    texts: Object.fromEntries(
      readdirSync(dir)
        .filter((f) => f.endsWith('.txt'))
        .sort()
        .map((f) => [f.slice(0, -'.txt'.length), readFileSync(join(dir, f), 'utf8')]),
    ),
  };
}

export function makeBuildPlan(args: {
  profile: Profile;
  data: EngineData;
  locked: LockedProfile;
  cell: CellPlan;
  variant: string;
  imageId: string;
  cacheDir: string;
  depsDir?: string;
  name?: string;
  release?: string;
  repository?: string;
  privateRepo?: boolean; // the release's repository is private
  group?: string;
  source?: BuildSource;
}): BuildPlan {
  const { profile, data, locked, cell } = args;
  const versionOf = (recipe: string) => versionInCell(profile, data, locked, cell.cell, recipe)!;
  // the lock's pins hold for the versions it locked, which are the versions built here
  const pinOf = (lib: string): SourcePin | undefined =>
    locked.libraries[lib] === versionOf(lib) ? locked.pins?.libraries[lib] : undefined;
  const platform = cell.cell.platform;
  // check refuses an android-api: older than the build's options and libraries support; this is its guard
  const tooOld = androidApiProblems(data, cell, profile.androidApi);
  if (tooOld.length) {
    throw new Error(tooOld.join('; '));
  }
  const rustProblem = rustLinkProblem(
    cell.recipes.filter((r) => data.recipes.get(r)?.build.cargo),
    platform,
  );
  if (rustProblem) {
    throw new Error(rustProblem);
  }
  const api = isAndroid(platform) ? androidApiFor(profile.androidApi) : undefined;
  const keys = cacheKeys(data, cell.recipes, versionOf, platform, args.imageId, pinOf, api);
  const version = cell.cell.version;
  const license = cell.cell.license;
  const setup = setupOf(data, platform);
  const image = data.platforms.get(platform)!.image;
  // named as the release names them: an x.y release is x.y.0 (releaseVersion); the tarball keeps upstream's name
  const name = args.name ?? `ffmpeg-${releaseVersion(version)}-${platform}-${args.variant}`;
  const sourcesArchive = `ffmpeg-${releaseVersion(version)}${args.group ? `-${args.group}` : ''}-sources.tar.gz`;
  const archives = [data.ffmpegSource.url, ...data.ffmpegSource.mirrors].map((u) =>
    expandTemplate(u, version),
  );
  const patches = plannedPatches(profile, cell.cell.major);
  const engine = packageVersion();
  // FFmpeg's pin is the target's own series' (the lock refuses one release pinned two ways, but a series is what a
  // target names); when the cell has no series of its own in the lock, the pin of the series that locked this version
  const series = cell.cell.series;
  const cargo = cargoPlan(data, cell.recipes);
  const ffmpegSha =
    locked.ffmpeg[series] === version
      ? locked.pins?.ffmpeg[series]?.sha256
      : Object.entries(locked.ffmpeg)
          .filter(([, v]) => v === version)
          .map(([s]) => locked.pins?.ffmpeg[s]?.sha256)
          .find(Boolean);
  return {
    platform,
    setup,
    image,
    toolchain: args.imageId,
    engine,
    ...(api !== undefined ? { androidApi: api } : {}),
    name,
    target: args.variant,
    license,
    ...(args.release ? { release: args.release } : {}),
    ...(args.repository ? { repository: args.repository } : {}),
    sourcesArchive,
    libraries: cell.recipes.map((lib) => {
      const key = keys.get(lib)!;
      const r = data.recipes.get(lib)!;
      return {
        name: lib,
        version: versionOf(lib),
        license: r.license,
        key,
        cached: existsSync(join(args.cacheDir, `${key}.tar.gz`)),
        source: sourceOf(data, lib, versionOf(lib), pinOf(lib)),
        licenseFiles: r['license-files'],
        build: r.build,
      };
    }),
    runtime: unique(
      cell.recipes.flatMap((r) => valuesOn(data.recipes.get(r)!, 'runtime', platform)),
    ),
    ships: Object.entries(data.platforms.get(platform)?.ships ?? {}).map(([file, s]) => ({
      file,
      license: s.license,
      notice: s.notice,
    })),
    patches,
    ...(cargo ? { cargo } : {}),
    notices: {
      governing: GOVERNING_TEXTS[license],
      header: noticesHeader({
        version,
        target: args.variant,
        platform,
        engine,
        licence: licenseNotice(data, cell),
        patches,
      }),
      build: noticesBuild({ platform, setup, image, toolchain: args.imageId }),
      source: noticesSource({
        name,
        version,
        license,
        ...(args.release ? { release: args.release } : {}),
        ...(args.repository ? { repository: args.repository } : {}),
        ...(args.privateRepo ? { privateRepo: true } : {}),
        ...(profile.sourceOffer ? { sourceOffer: profile.sourceOffer } : {}),
        sourcesArchive,
        source: args.source ?? {},
        ffmpegTarball: archives[0]!,
        patchSets: profile.patches.map((p) => basename(p)),
      }),
    },
    ffmpeg: {
      version,
      archives,
      ...(ffmpegSha ? { sha256: ffmpegSha } : {}),
      // the target's flags, then its patch sets' (in the order it names them)
      configure: [
        ...configureFlags(
          data,
          cell,
          args.depsDir,
          Object.fromEntries(
            COMPONENT_KINDS.map((k) => [k, unique(patches.flatMap((p) => p.adds?.[k] ?? []))]),
          ),
        ),
        ...patches.flatMap((p) => p.configure),
      ],
      verify: verifyNames(data, cell),
    },
  };
}
