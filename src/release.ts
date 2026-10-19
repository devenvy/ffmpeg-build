// Releases: which targets ship together, what each one is made of, and whether a release is due. A release is one
// release group at one resolved FFmpeg version; its tag is `[<group>-]<ffmpeg>.<build>`.
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import { toolchainDefinitionFiles } from './build/plan.ts';
import { buildSettings, defaultIn, settingsIdentity } from './build-settings.ts';
import { versionInCell } from './choose.ts';
import { packageVersion } from './paths.ts';
import { type CellPlan, planProfile } from './resolve.ts';
import { type Folder, releaseVersion, type Target, targetProfile } from './targets.ts';
import { sha, treeHash } from './tree-hash.ts';

import type { EngineData } from './engine-data.ts';
import type { FolderLock } from './lockfile.ts';
import type { Manifest, ManifestTarget } from './manifest.ts';

/** What a target's build is made of: if any of it differs from the last release, the release is due. */
export interface TargetFacts {
  ffmpeg: string;
  components: Record<string, string>;
  /** each pinned component's source: the commit, or the sha256 of the tarball, ffmpeg.lock pins for its version */
  pins: Record<string, string>;
  patches: { name: string; sha256: string }[];
  toolchain: string;
  definition: string;
  engine: string;
}

/** runner: where it builds (a runs-on label or labels); testRunner: where it runs (the same, unless that one can't) */
export interface PlannedTarget {
  target: Target;
  cell: CellPlan;
  facts: TargetFacts;
  runner: string | string[];
  testRunner: string | string[];
}
export interface PlannedRelease {
  group: string;
  /** the FFmpeg version the release is named by: three parts (releaseVersion), 10.0.0 for FFmpeg 10.0 */
  ffmpeg: string;
  base: string;
  targets: PlannedTarget[];
}

/**
 * The iOS / Mac Catalyst framework builds of one licence ship as one xcframework bundle (bundle --apple): these four
 * slices, published as one entry named ios-<license> with platform ios.
 */
export const APPLE_SLICES = [
  'ios-arm64',
  'ios-sim-arm64',
  'maccatalyst-arm64',
  'maccatalyst-x64',
] as const;
export const isFrameworkPlatform = (platform: string): boolean =>
  /^(ios|maccatalyst)-/.test(platform);

/**
 * Why the framework targets released together can't make their xcframework bundles: each licence needs exactly one
 * target of each of the four slices (the xcframeworks have exactly three slices, the two Catalyst builds fused into
 * one). check, releases and bundle --apple all use this rule, so a release that can't be bundled stops before CI
 * builds anything.
 */
export function frameworkSliceProblems(
  targets: Pick<Target, 'name' | 'platform' | 'license'>[],
): string[] {
  const problems: string[] = [];
  const sets = new Map<string, Map<string, string>>(); // licence -> slice -> target name
  for (const t of targets.filter((x) => isFrameworkPlatform(x.platform))) {
    if ((APPLE_SLICES as readonly string[]).includes(t.platform)) {
      const set = sets.get(t.license) ?? new Map<string, string>();
      const other = set.get(t.platform);
      if (other) {
        problems.push(
          `${t.license} has two ${t.platform} targets (${other}, ${t.name}); an xcframework bundle takes one of each`,
        );
      } else {
        set.set(t.platform, t.name);
      }
      sets.set(t.license, set);
    } else {
      problems.push(
        `${t.name}: ${t.platform} isn't one of the xcframework slices (${APPLE_SLICES.join(', ')})`,
      );
    }
  }
  for (const [license, set] of sets) {
    const missing = APPLE_SLICES.filter((s) => !set.has(s));
    if (missing.length) {
      problems.push(
        `${license} has no ${missing.join(' or ')} target: an xcframework bundle needs ${APPLE_SLICES.slice(0, -1).join(', ')} and ${String(APPLE_SLICES.at(-1))} (it has ${[...set.values()].join(', ')})`,
      );
    }
  }
  return problems;
}

/**
 * Beside each xcframework bundle, bundle --apple writes ffmpeg-<version>-ios-<license>.slices.json: the bundle's
 * sha256 and, per slice, the archive it was made from with its sha256 and components. Plain bundle refuses a bundle
 * whose slices were rebuilt since (a stale bundle), and publishes the file, so the next release's removal guard can
 * compare slice by slice.
 */
export interface AppleSlices {
  bundle: { name: string; sha256: string };
  slices: Record<
    string,
    { target: string; archive: string; sha256: string; components: Record<string, string> }
  >;
}
export const appleSlicesName = (bundleName: string): string =>
  bundleName.replace(/\.tar\.gz$/, '.slices.json');

/** Reads and shape-checks a .slices.json; undefined when it isn't one. */
export function parseAppleSlices(text: string): AppleSlices | undefined {
  try {
    // anything at all until checked: JSON that parses may still be the wrong shape, or null
    const v = JSON.parse(text) as {
      bundle?: { name?: unknown; sha256?: unknown } | null;
      slices?: Record<
        string,
        { archive?: unknown; sha256?: unknown; components?: unknown } | null | undefined
      > | null;
    } | null;
    const ok =
      typeof v?.bundle?.name === 'string' &&
      typeof v.bundle.sha256 === 'string' &&
      typeof v.slices === 'object' &&
      v.slices !== null &&
      Object.values(v.slices).every(
        (s) =>
          typeof s?.archive === 'string' &&
          typeof s.sha256 === 'string' &&
          typeof s.components === 'object' &&
          s.components !== null,
      );
    return ok ? (v as AppleSlices) : undefined;
  } catch {
    return undefined;
  }
}

/** What a release publishes: a target as it is, or a licence's framework slices as one ios-<license> entry. */
export interface PublishedTarget {
  name: string;
  platform: string;
  license: Target['license'];
  facts: TargetFacts;
  slices: PlannedTarget[]; // the builds behind it: one, or a licence's framework slices
  allowRemoval: string[];
}

/**
 * The toolchain as defined, before any image is built: image folder (or native host marker), platform data and the
 * Node modules that materialize and run it. The same on every machine, unlike a built image's ID.
 */
export function toolchainDefinition(
  engineRoot: string,
  data: EngineData,
  platform: string,
): string {
  const entry = data.platforms.get(platform)!;
  const image =
    entry.image === 'macos' ? 'macos' : treeHash(join(engineRoot, 'images', entry.image));
  const setup = toolchainDefinitionFiles(engineRoot).flatMap((f) => [
    relative(engineRoot, f).replaceAll('\\', '/'),
    readFileSync(f),
  ]);
  // where its builds are tested isn't part of the toolchain: changing it changes no build
  const built = { ...entry };
  delete built.testRunner;
  return sha(
    image,
    readFileSync(join(engineRoot, 'platforms.yml')),
    JSON.stringify(built),
    ...setup,
  );
}

/** The runner a platform builds on in CI (platforms.yml `runner:`). */
export const runnerOf = (data: EngineData, platform: string): string =>
  data.platforms.get(platform)?.runner ?? 'ubuntu-24.04';

/** The runner that runs a platform's builds in CI (platforms.yml `test-runner:`): the one it builds on, unless that can't. */
export const testRunnerOf = (data: EngineData, platform: string): string =>
  data.platforms.get(platform)?.testRunner ?? runnerOf(data, platform);

/** The facts of one target's build, at the lock's versions. */
export function targetFacts(
  folder: Folder,
  t: Target,
  data: EngineData,
  lock: FolderLock,
  engineRoot: string,
): { cell: CellPlan; facts: TargetFacts } | { error: string } {
  const version = lock.ffmpeg[t.ffmpeg];
  if (!version) {
    return { error: `ffmpeg.lock has no FFmpeg ${t.ffmpeg}; run ffmpeg-build lock` };
  }
  if (!data.platforms.has(t.platform)) {
    return { error: `${t.platform} doesn't build yet (platforms.yml has no entry for it)` };
  }
  const profile = targetProfile(folder, t);
  const cell = planProfile(profile, data, { [t.ffmpeg]: version }).cells[0];
  if (!cell) {
    return { error: `${t.name} plans no build; run ffmpeg-build check` };
  }
  const locked = { ffmpeg: lock.ffmpeg, libraries: lock.libraries, pinned: [] };
  const components = Object.fromEntries(
    [...cell.recipes]
      .sort()
      .map((r) => [r, versionInCell(profile, data, locked, cell.cell, r) ?? '?']),
  );
  const patches = t.patches.map((p) => ({
    name: p.replace(/^patches\//, ''),
    sha256: treeHash(join(folder.dir, p)),
  }));
  // what the target asks for, resolved: the same lists from different bases are the same definition
  const definition = sha(
    JSON.stringify({
      platform: t.platform,
      license: t.license,
      ffmpeg: t.ffmpeg,
      with: [...t.with].sort(),
      without: [...t.without].sort(),
      pin: { ...folder.pin, ...t.pin },
      tests: t.tests,
      // only when it has some: a target without components: keeps the definition it always had
      ...(Object.keys(t.components).length ? { components: t.components } : {}),
    }),
  );
  // how and where it builds, when that changes the build (a native build depends on its machine)
  const how = settingsIdentity(t.platform, buildSettings(folder, t.platform));
  const defined = toolchainDefinition(engineRoot, data, t.platform);
  return {
    cell,
    facts: {
      ffmpeg: version,
      components,
      // a tag moved (or a tarball replaced) upstream at the same version is a change, though no version moved
      pins: Object.fromEntries(
        Object.keys(components)
          .filter((r) => lock.libraries[r] === components[r])
          .flatMap((r) => {
            const p = lock.pins?.libraries[r];
            const pin = p?.commit ?? p?.sha256;
            return pin ? [[r, pin]] : [];
          }),
      ),
      patches,
      toolchain: how ? sha(defined, how) : defined,
      definition,
      engine: packageVersion(),
    },
  };
}

/** The folder's releases: its targets grouped by release group and resolved FFmpeg version. */
export function planReleases(
  folder: Folder,
  data: EngineData,
  lock: FolderLock,
  engineRoot: string,
): { releases: PlannedRelease[]; errors: string[] } {
  const errors: string[] = [];
  const by = new Map<string, PlannedRelease>();
  for (const t of folder.targets) {
    const r = targetFacts(folder, t, data, lock, engineRoot);
    if ('error' in r) {
      errors.push(`${t.name}: ${r.error}`);
    } else {
      const group = t.releaseGroup ?? '';
      const ffmpeg = releaseVersion(r.facts.ffmpeg);
      const base = `${group ? `${group}-` : ''}${ffmpeg}`;
      const rel = by.get(base) ?? { group, ffmpeg, base, targets: [] };
      // the build: section's runner builds it; it runs it too when the build is native, or when the platform's builds
      // run where they build anyway. A Docker build moved to another Linux runner keeps the platform's test runner
      // (Windows builds still run on Windows).
      const settings = buildSettings(folder, t.platform);
      const runner = settings.runner ?? runnerOf(data, t.platform);
      const nativeHere = (settings.in ?? defaultIn(t.platform)) === 'here';
      const testsWhereBuilt = testRunnerOf(data, t.platform) === runnerOf(data, t.platform);
      const testRunner =
        settings.runner !== undefined && (nativeHere || testsWhereBuilt)
          ? settings.runner
          : testRunnerOf(data, t.platform);
      rel.targets.push({ target: t, cell: r.cell, facts: r.facts, runner, testRunner });
      by.set(base, rel);
    }
  }
  for (const rel of folder.libraryOnly ? [] : by.values()) {
    for (const p of frameworkSliceProblems(rel.targets.map((x) => x.target))) {
      errors.push(`${rel.base}: ${p}`);
    }
  }
  return {
    releases: [...by.values()].sort((a, b) =>
      a.base.localeCompare(b.base, undefined, { numeric: true }),
    ),
    errors,
  };
}

/**
 * The release's published targets, in the order they first appear. A licence's framework slices become one entry:
 * components and patches are the slices' union (one lock, so one version each), toolchain and definition a hash of the
 * slices' own, so a change to any slice is a change to the entry.
 */
export function publishedTargets(rel: PlannedRelease): PublishedTarget[] {
  const out: (PublishedTarget | string)[] = [];
  const frameworks = new Map<string, PlannedTarget[]>();
  for (const p of rel.targets) {
    if (isFrameworkPlatform(p.target.platform)) {
      if (!frameworks.has(p.target.license)) {
        out.push(p.target.license);
      }
      frameworks.set(p.target.license, [...(frameworks.get(p.target.license) ?? []), p]);
    } else {
      out.push({
        name: p.target.name,
        platform: p.target.platform,
        license: p.target.license,
        facts: p.facts,
        slices: [p],
        allowRemoval: p.target.allowRemoval,
      });
    }
  }
  return out.map((o): PublishedTarget => {
    if (typeof o !== 'string') {
      return o;
    }
    const slices = [...frameworks.get(o)!].sort((a, b) =>
      a.target.platform.localeCompare(b.target.platform),
    );
    const components = Object.assign({}, ...slices.map((s) => s.facts.components)) as Record<
      string,
      string
    >;
    const patches = new Map(slices.flatMap((s) => s.facts.patches).map((x) => [x.name, x]));
    return {
      name: `ios-${o}`,
      platform: 'ios',
      license: slices[0]!.target.license,
      slices,
      facts: {
        ffmpeg: slices[0]!.facts.ffmpeg,
        engine: slices[0]!.facts.engine,
        components: Object.fromEntries(
          Object.keys(components)
            .sort()
            .map((k) => [k, components[k]!]),
        ),
        pins: Object.assign({}, ...slices.map((s) => s.facts.pins)) as Record<string, string>,
        patches: [...patches.values()].sort((a, b) => a.name.localeCompare(b.name)),
        toolchain: sha(...slices.map((s) => `${s.target.platform} ${s.facts.toolchain}`)),
        definition: sha(...slices.map((s) => `${s.target.platform} ${s.facts.definition}`)),
      },
      allowRemoval: [...new Set(slices.flatMap((s) => s.target.allowRemoval))],
    };
  });
}

/** Why a release differs from its last published manifest; empty when it doesn't. */
export function changesSince(rel: PlannedRelease, previous: Manifest | undefined): string[] {
  if (!previous) {
    return ['never released'];
  }
  const why: string[] = [];
  const was = new Map(previous.targets.map((t) => [t.name, t]));
  const published = publishedTargets(rel);
  for (const { name, facts } of published) {
    const p = was.get(name);
    const diff = p ? factDiff(facts, p, previous) : [];
    if (!p) {
      why.push(`${name}: new`);
    } else if (diff.length) {
      why.push(`${name}: ${diff.join(', ')}`);
    }
  }
  for (const name of was.keys()) {
    if (!published.some((t) => t.name === name)) {
      why.push(`${name}: removed`);
    }
  }
  return why;
}

function factDiff(now: TargetFacts, was: ManifestTarget, m: Manifest): string[] {
  const out: string[] = [];
  // the manifest names the release's version (10.0.0 for FFmpeg 10.0): compare like with like
  if (releaseVersion(now.ffmpeg) !== releaseVersion(m.ffmpeg)) {
    out.push(`FFmpeg ${m.ffmpeg} -> ${releaseVersion(now.ffmpeg)}`);
  }
  if (now.engine !== m.engine) {
    out.push(`engine ${m.engine} -> ${now.engine}`);
  }
  if (now.toolchain !== was.toolchain) {
    out.push('toolchain');
  }
  if (now.definition !== was.definition) {
    out.push('definition');
  }
  const names = new Set([...Object.keys(now.components), ...Object.keys(was.components)]);
  for (const n of [...names].sort()) {
    if (now.components[n] !== was.components[n]) {
      out.push(`${n} ${was.components[n] ?? '-'} -> ${now.components[n] ?? '-'}`);
    }
  }
  // pins only against a release that recorded them: one made before pins has none, and that changes nothing
  if (Object.keys(was.pins).length) {
    for (const n of Object.keys(now.pins).sort()) {
      if (was.pins[n] && now.pins[n] !== was.pins[n] && now.components[n] === was.components[n]) {
        out.push(`${n} pin`);
      }
    }
  }
  if (JSON.stringify(now.patches) !== JSON.stringify(was.patches)) {
    out.push('patches');
  }
  return out;
}

/** What each framework slice of a published ios-<license> entry had: entry name -> slice platform -> components. */
export type SliceComponents = Record<string, Record<string, Record<string, string>>>;

/** The components one published target lost since `release` (`was`) that nothing allows it to lose. */
function targetRemovals(
  { name, facts, allowRemoval, slices }: PublishedTarget,
  was: ManifestTarget,
  release: string,
  folder: Folder,
  recorded: Record<string, Record<string, string>> | undefined,
): string[] {
  const framework = slices.length > 1 || isFrameworkPlatform(slices[0]!.target.platform);
  const fix = (c: string, only?: PlannedTarget[]) =>
    framework
      ? `add allow-removal: [${c}] to ${(only ?? slices).map((s) => s.target.name).join(', ')} (the slice targets of ${name})`
      : `add allow-removal: [${c}] to the target`;
  if (framework && recorded) {
    return slices.flatMap((s) => {
      const allowed = new Set([...folder.allowRemoval, ...s.target.allowRemoval]);
      return Object.keys(recorded[s.target.platform] ?? {})
        .filter((c) => !(c in s.facts.components) && !allowed.has(c))
        .map(
          (c) =>
            `${name}: ${c} was in its ${s.target.platform} slice in ${release} and is gone now; if that is intended, ${fix(c, [s])}`,
        );
    });
  }
  const allowed = new Set([...folder.allowRemoval, ...allowRemoval]);
  return Object.keys(was.components)
    .filter((c) => !(c in facts.components) && !allowed.has(c))
    .map((c) => `${name}: ${c} was in ${release} and is gone now; if that is intended, ${fix(c)}`);
}

/**
 * The always-on guard: a component a target had in the last release that it no longer has stops the release, unless
 * the target (or the folder) allows that removal. An ios-<license> entry is compared slice by slice when the last
 * release recorded its slices (`previousSlices`, from its .slices.json), so a component dropped from one slice only
 * is caught too; otherwise by the union of its slices.
 */
export function removals(
  rel: PlannedRelease,
  previous: Manifest | undefined,
  folder: Folder,
  previousSlices: SliceComponents = {},
): string[] {
  if (!previous) {
    return [];
  }
  return publishedTargets(rel).flatMap((target) => {
    const was = previous.targets.find((t) => t.name === target.name);
    return was
      ? targetRemovals(target, was, previous.release, folder, previousSlices[target.name])
      : [];
  });
}
