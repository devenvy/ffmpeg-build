// `ffmpeg-build releases`: the folder's releases, each with its next tag, whether it is due (anything in it changed
// since its last release) and why, and its targets with the runner each builds on. CI turns `--due --json` into its
// build matrix.
import { createHash } from 'node:crypto';
import { join } from 'node:path';

import { type BuildIn, buildSettings, defaultIn } from '../build-settings.ts';
import { publishingNotes } from '../bundle.ts';
import { CliError } from '../cli-errors.ts';
import { FetchError } from '../fetch.ts';
import { type FolderLock, LOCK_FILE, readFolderLock } from '../lockfile.ts';
import { packageRoot } from '../paths.ts';
import { type Previous, previousReleases, publishingRepo } from '../release-remote.ts';
import {
  changesSince,
  type PlannedRelease,
  planReleases,
  removals,
  type TargetFacts,
} from '../release.ts';
import { JSON_INDENT } from '../text.ts';
import { folderCheck, FolderError, jsonFailure, runFolderCheck } from './folder.ts';

import type { EngineData } from '../engine-data.ts';
import type { Folder } from '../targets.ts';

/** How many hex digits of the components' sha256 a cache key carries. */
const CACHE_KEY_HASH_LENGTH = 24;

interface Result {
  output: string;
  exitCode: number;
  notes?: string[];
}

export interface ReleaseRow {
  tag: string;
  group: string;
  ffmpeg: string;
  previous?: string;
  /** the group's last release of a lower major, when it has none in this one: what removals are judged against */
  lastBefore?: string;
  due: boolean;
  reasons: string[];
  removals: string[];
  /** runner: the CI runner it builds on; testRunner: the one that runs it (the same, unless that one can't) */
  /** testHere: testRunner is runner (GitHub's expressions can't compare label lists); in: how it builds (docker | here) */
  targets: {
    name: string;
    platform: string;
    runner: string | string[];
    testRunner: string | string[];
    testHere: boolean;
    in: BuildIn;
    cacheKey: string;
  }[];
  /** the release's targets a --target/--platform choice left out (it is published only with all of them) */
  missing: string[];
}

/**
 * The CI library-cache key of a target: its platform, component versions, toolchain and engine. Anything that changes
 * a library's build changes it, so a stale cache is never restored under the key (restore keys fall back per platform).
 */
const cacheKey = (platform: string, f: TargetFacts) =>
  `ffmpeg-build-libs-${platform}-${createHash('sha256')
    .update(JSON.stringify([f.components, f.toolchain, f.engine]))
    .digest('hex')
    .slice(0, CACHE_KEY_HASH_LENGTH)}`;

/** Each release with its last published one (when a repository is known and can be read). */
export async function releaseRows(
  folder: Folder,
  data: EngineData,
  options: { offline?: boolean; lock?: FolderLock; skipUnbuildable?: boolean } = {},
): Promise<{
  rows: ReleaseRow[];
  plans: PlannedRelease[];
  previous: Map<string, Previous | undefined>;
}> {
  const lock = options.lock ?? readFolderLock(join(folder.dir, LOCK_FILE));
  if (!lock) {
    throw new FolderError(`no ${LOCK_FILE} here; run ffmpeg-build lock first`);
  }
  const { releases, errors } = planReleases(folder, data, lock, packageRoot);
  if (errors.length && !options.skipUnbuildable) {
    throw new FolderError(errors.join('\n'));
  }
  const repo = options.offline ? undefined : publishingRepo(folder.dir);
  const previous = new Map<string, Previous | undefined>();
  const rows: ReleaseRow[] = [];
  for (const rel of releases) {
    const found = repo ? await previousReleases(repo, rel.group, rel.ffmpeg) : {};
    // the build number counts within this FFmpeg version; what changed, and what disappeared, is judged against the
    // release this one follows on from: the newest of the same group and FFmpeg major
    const prev = found.sameBase;
    const follows = found.lastInMajor;
    previous.set(rel.base, follows);
    const reasons =
      follows && !follows.manifest
        ? [`${follows.tag} has no manifest.yml (made before ffmpeg-build)`]
        : changesSince(rel, follows?.manifest);
    // the first release on a new major is judged for removals against the group's last one before it
    const judged = follows ?? found.lastBefore;
    rows.push({
      tag: `${rel.base}.${prev ? prev.build + 1 : 0}`,
      group: rel.group,
      ffmpeg: rel.ffmpeg,
      ...(follows ? { previous: follows.tag } : {}),
      ...(found.lastBefore ? { lastBefore: found.lastBefore.tag } : {}),
      due: reasons.length > 0,
      reasons,
      removals: removals(rel, judged?.manifest, folder, judged?.slices),
      targets: rel.targets.map((t) => ({
        name: t.target.name,
        platform: t.target.platform,
        runner: t.runner,
        testRunner: t.testRunner,
        testHere: JSON.stringify(t.testRunner) === JSON.stringify(t.runner),
        in: buildSettings(folder, t.target.platform).in ?? defaultIn(t.target.platform),
        cacheKey: cacheKey(t.target.platform, t.facts),
      })),
      missing: [],
    });
  }
  return { rows, plans: releases, previous };
}

const NO_REPOSITORY =
  'note: no GitHub repository found; every release counts as new (--offline to silence this)';

/** Exit 1 when check fails or a release would drop something its last release had (the removal guard). */
/**
 * Only the chosen targets (comma-separated names, as --target and --platform give them): each release keeps the chosen
 * ones and names the rest in `missing`; a release with none chosen is left out.
 */
function chooseInRows(rows: ReleaseRow[], names: string | undefined): ReleaseRow[] {
  if (!names) {
    return rows;
  }
  const chosen = new Set(names.split(','));
  return rows
    .map((r) => ({
      ...r,
      targets: r.targets.filter((t) => chosen.has(t.name)),
      missing: r.targets.filter((t) => !chosen.has(t.name)).map((t) => t.name),
    }))
    .filter((r) => r.targets.length);
}

/** A release is published whole: one a choice leaves part-built can't be (CI asks with --whole before publishing). */
function partReleases(rows: ReleaseRow[]): string[] {
  return rows
    .filter((r) => r.missing.length)
    .map(
      (r) =>
        `${r.tag} would be published without ${r.missing.join(', ')}: build every target of a release together, or give the ones built elsewhere their own release-group:`,
    );
}

export async function runReleases(
  folder: Folder,
  data: EngineData,
  options: {
    json?: boolean;
    due?: boolean;
    offline?: boolean;
    target?: string;
    whole?: boolean;
  } = {},
): Promise<Result> {
  const checked = folderCheck(folder, data);
  if (checked.exitCode) {
    // with --json, an error carrying check's problems: never a list that could pass for the releases
    if (options.json) {
      throw new CliError(
        'check found problems; fix them before releasing',
        checked.exitCode,
        checked.problems,
      );
    }
    return runFolderCheck(folder, data);
  }
  let rows: ReleaseRow[];
  try {
    rows = (await releaseRows(folder, data, options)).rows;
  } catch (e) {
    if (e instanceof FetchError) {
      throw new FolderError(
        `couldn't read the last releases: ${e.message} (--offline treats every release as new)`,
      );
    }
    throw e;
  }
  const repo = options.offline ? undefined : publishingRepo(folder.dir);
  // without a repository there are no last releases to compare with: say so, rather than call each one never released
  const notes = options.offline || repo ? [] : [NO_REPOSITORY];
  const shown = chooseInRows(options.due ? rows.filter((r) => r.due) : rows, options.target);
  const chosen = new Set(shown.flatMap((r) => r.targets.map((t) => t.name)));
  notes.push(
    ...(await publishingNotes(
      folder.targets.filter((t) => chosen.has(t.name)),
      repo,
    )),
  );
  const part = options.whole ? partReleases(shown) : [];
  if (part.length) {
    if (options.json) {
      return { output: jsonFailure(part.join('\n'), part), exitCode: 1 };
    }
    return { output: part.map((e) => `✗ ${e}`).join('\n'), exitCode: 1 };
  }
  const lost = shown.flatMap((r) => r.removals.map((e) => `${r.tag}: ${e}`));
  const exitCode = lost.length ? 1 : 0;
  // a success is the list of releases (the CI matrix reads it); a failure is {"error", "problems"}, the releases beside them
  if (options.json && lost.length) {
    return {
      output: jsonFailure(
        `${lost.length === 1 ? 'a target' : 'targets'} would lose what their last release had (allow-removal: allows it)`,
        lost,
        { releases: shown },
      ),
      exitCode,
      notes,
    };
  }
  if (options.json) {
    return { output: JSON.stringify(shown, null, JSON_INDENT), exitCode, notes };
  }
  const out: string[] = [];
  for (const r of shown) {
    out.push(
      `${r.tag}${r.previous ? ` (last: ${r.previous})` : ''}: ${r.due ? 'due' : 'unchanged'}, ${r.targets.length} target${r.targets.length === 1 ? '' : 's'}${r.missing.length ? ` (not chosen: ${r.missing.join(', ')})` : ''}`,
    );
    for (const why of r.reasons) {
      out.push(`  ${why}`);
    }
    for (const e of r.removals) {
      out.push(`  ✗ ${e}`);
    }
  }
  return { output: out.join('\n') || 'no releases', exitCode, notes };
}
