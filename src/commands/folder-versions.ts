// lock / update / outdated on a folder of targets: one ffmpeg.lock for the folder, one version per library.
import { join } from 'node:path';

import { CliError } from '../cli-errors.ts';
import { FetchError } from '../fetch.ts';
import { chooseFolder, type FolderChoice, type FolderRow } from '../folder-choose.ts';
import { type FolderLock, formatFolderLock, LOCK_FILE, readFolderLock } from '../lockfile.ts';
import { packageVersion } from '../paths.ts';
import { defaultPinSource, pinLock, type PinSource } from '../source-pins.ts';
import { JSON_INDENT } from '../text.ts';
import { compareVersions } from '../versions.ts';
import { cacheRoot } from './build.ts';
import { folderCheck, jsonFailure, runFolderCheck } from './folder.ts';
import { releaseRows } from './releases.ts';
import { type Fetch, shortVersion, stageAndSwap, upstreamFetcher } from './versions.ts';

import type { Mode, Upstreams } from '../choose.ts';
import type { EngineData } from '../engine-data.ts';
import type { Folder } from '../targets.ts';

/** Rounds of lookups before giving up: each can reveal more to look up (FFmpeg's version decides the libraries). */
const MAX_LOOKUP_ROUNDS = 4;
/** Spaces after the widest entry of a column. */
const COLUMN_GAP = 3;

interface Result {
  output: string;
  exitCode: number;
  notes?: string[];
}

/** Choose, look up whatever is still missing, choose again: FFmpeg first, then the libraries the builds use. */
async function chooseWithLookups(
  folder: Folder,
  data: EngineData,
  old: FolderLock | undefined,
  mode: Mode,
  upstreams: Upstreams,
  fetch: Fetch,
): Promise<FolderChoice> {
  for (let round = 0; round < MAX_LOOKUP_ROUNDS; round++) {
    const choice = chooseFolder(folder, data, old, upstreams, mode);
    if (!choice.missing.length) {
      return choice;
    }
    await fetch(choice.missing, upstreams);
  }
  throw new Error('ffmpeg-build: versions still missing after four lookups (this is a bug)');
}

/** The one line for an FFmpeg major newer than every series the targets build (when the folder wants it). */
function newMajorNote(
  folder: Folder,
  choice: FolderChoice,
  upstreams: Upstreams,
): string | undefined {
  if (!folder.notify.newFfmpeg || !upstreams.ffmpeg?.length) {
    return undefined;
  }
  const top = [...upstreams.ffmpeg].sort(compareVersions).at(-1)!;
  // a `latest` target moves to a new major by itself (or says why it can't), so only numbered series count
  const built = Object.entries(choice.lock.ffmpeg)
    .filter(([series]) => series !== 'latest')
    .map(([, v]) => Number(v.split('.')[0]));
  const topMajor = Number(top.split('.')[0]);
  if (!built.length || topMajor <= Math.max(...built)) {
    return undefined;
  }
  return `FFmpeg ${topMajor} is out; your targets build ${[...new Set(built)].sort((a, b) => a - b).join(', ')} (add targets for ${topMajor}, or use ffmpeg: latest)`;
}

const fold = (folder: Folder, r: FolderRow) =>
  r.targets && r.targets.length < folder.targets.length ? r.targets.join(', ') : '';

/** The engine's move in the lock, when the update runs a different ffmpeg-build than the lock recorded. */
export interface EngineChange {
  from: string;
  to: string;
}

/** The update PR text: new-minor callouts, the new-major note, the engine's move, and one table for the folder. */
export function formatFolderSummary(
  folder: Folder,
  choice: FolderChoice,
  note?: string,
  engine?: EngineChange,
): string {
  const out = [
    '# ffmpeg: update ffmpeg.lock',
    '',
    '_Written by `ffmpeg-build update`. Only `ffmpeg.lock` changed._',
  ];
  if (engine) {
    out.push(
      '',
      `## Engine: ffmpeg-build ${engine.from} -> ${engine.to}`,
      `The lock now records ffmpeg-build ${engine.to}; the builds and releases run it from here on, so every release is due once this merges (its builds are made again with the new engine).`,
    );
  }
  for (const r of choice.rows.filter((x) => x.newMinor)) {
    const m = r.newMinor!;
    out.push(
      '',
      `## ⚠ New FFmpeg minor: ${m.from} -> ${m.to}`,
      `Targets on \`ffmpeg: ${r.what.replace(/^FFmpeg /, '')}\` move to it. To stay on ${m.from}.x, write \`ffmpeg: "${m.from}"\` on them.`,
    );
    const shown = (a: string) =>
      m.missingIn[a]
        ? `\`${a}\` (not in ${m.missingIn[a].join(', ')}: \`ffmpeg-build profile add ${a} --to <base or target>\`)`
        : `\`${a}\``;
    if (m.adds.length) {
      out.push(`- new: ${m.adds.map(shown).join(', ')}`);
    }
  }
  if (note) {
    out.push('', `## ${note}`);
  }
  const changes = choice.rows.filter((r) => r.from !== r.to);
  if (!changes.length) {
    out.push('', engine ? 'No FFmpeg or library changes.' : 'Nothing to update.');
  } else {
    out.push('', '| | from | to | targets |', '|---|---|---|---|');
  }
  for (const r of changes) {
    const who = fold(folder, r);
    out.push(
      `| ${r.what} | ${r.from ? shortVersion(r.from) : '-'} | ${r.newMinor ? `**${r.to}**` : shortVersion(r.to)} |${who ? ` ${who} ` : ' '}|`,
    );
  }
  const skipped = choice.rows.filter((r) => r.skipped);
  if (skipped.length) {
    out.push('', '### Not applied');
    for (const r of skipped) {
      out.push(
        `- **${r.what === r.what.replace(/^FFmpeg /, '') ? r.what : 'FFmpeg'} ${shortVersion(r.skipped!.version)}**: ${r.skipped!.reason}${r.skipped!.note ? ` - ${r.skipped!.note}` : ''}`,
      );
    }
  }
  return `${out.join('\n')}\n`;
}

/**
 * Removals since each release's last published one. When the last releases can't be read (no repository known, no
 * token, offline), that is a note, not a stop: bundle checks again, strictly, before anything is published.
 */
async function removalGuard(
  folder: Folder,
  data: EngineData,
  lock: FolderLock,
): Promise<{ errors: string[]; notes: string[] }> {
  try {
    // targets that can't build yet have no releases to compare with
    const { rows } = await releaseRows(folder, data, { lock, skipUnbuildable: true });
    return { errors: rows.flatMap((r) => r.removals), notes: [] };
  } catch (e) {
    if (e instanceof FetchError) {
      return {
        errors: [],
        notes: [`note: couldn't read the last releases to check for removals (${e.message})`],
      };
    }
    throw e;
  }
}

/** `lock` (keep) and `update`: check every target, choose for the folder, write ffmpeg.lock only if all went well. */
export async function runFolderLockOrUpdate(
  folder: Folder,
  data: EngineData,
  options: { mode: Mode; summary?: string },
  fetch: Fetch = upstreamFetcher(data),
  pinSource: PinSource = defaultPinSource(join(cacheRoot(), 'sources')),
): Promise<Result> {
  const checked = runFolderCheck(folder, data, { ignoreLock: true });
  if (checked.exitCode) {
    return { output: `${checked.output}\n\nNothing was written.`, exitCode: 1 };
  }
  const lockPath = join(folder.dir, LOCK_FILE);
  const old = readFolderLock(lockPath);
  const upstreams: Upstreams = { libraries: new Map() };
  // an upstream that can't be read is thrown (UpstreamFailure: exit 2, said on stderr)
  const choice = await chooseWithLookups(folder, data, old, options.mode, upstreams, fetch);
  if (choice.errors.length) {
    return {
      output: [
        folder.file,
        ...choice.errors.map((e) => `  ✗ ${e}`),
        '',
        'Nothing was written.',
      ].join('\n'),
      exitCode: 1,
    };
  }
  const versions: FolderLock = { engine: packageVersion(), ...choice.lock };
  // the removal guard: nothing a target had in its last release may disappear unless the folder allows it
  const guard = await removalGuard(folder, data, versions);
  if (guard.errors.length) {
    return {
      output: [
        folder.file,
        ...guard.errors.map((e) => `  ✗ ${e}`),
        '',
        'Nothing was written.',
      ].join('\n'),
      exitCode: 1,
    };
  }
  // the content each version stands for: kept from the old lock where the version is the same, else asked upstream
  // a source that can't be pinned is thrown (UpstreamFailure: exit 2, said on stderr)
  const pins = await pinLock(data, choice.lock, old, pinSource);
  const lock: FolderLock = { ...versions, pins };
  const text = formatFolderLock(lock);
  const changed = !old || formatFolderLock(old) !== text;
  const writes = changed ? [{ path: lockPath, text }] : [];
  // update records the engine running it (update-lock.yml installs the newest of the lock's major), so it can move
  const engine =
    old?.engine && old.engine !== lock.engine ? { from: old.engine, to: lock.engine } : undefined;
  const note = newMajorNote(folder, choice, upstreams);
  if (options.summary) {
    writes.push({
      path: options.summary,
      text: formatFolderSummary(folder, choice, note, engine),
    });
  }
  stageAndSwap(writes);
  return {
    output: `${LOCK_FILE}: ${changed ? 'updated' : 'no changes'}${engine ? ` (engine ffmpeg-build ${engine.from} -> ${engine.to})` : ''}`,
    exitCode: 0,
    // a new major changes no lock, so it is said whether or not the lock changed (and a CI log shows it)
    notes: [...guard.notes, ...(note ? [`note: ${note}`] : [])],
  }; // notes: stderr
}

/** What update would do, read-only. */
export async function runFolderOutdated(
  folder: Folder,
  data: EngineData,
  options: { json?: boolean } = {},
  fetch: Fetch = upstreamFetcher(data),
): Promise<Result> {
  const checked = folderCheck(folder, data, { ignoreLock: true });
  // with --json, a failing check is an error with its problems, not a list that could pass for the answer
  if (checked.exitCode) {
    if (options.json) {
      throw new CliError(
        'check found problems; nothing was looked up',
        checked.exitCode,
        checked.problems,
      );
    }
    return runFolderCheck(folder, data, { ignoreLock: true });
  }
  const old = readFolderLock(join(folder.dir, LOCK_FILE));
  const upstreams: Upstreams = { libraries: new Map() };
  const choice = await chooseWithLookups(folder, data, old, 'update', upstreams, fetch);
  if (choice.errors.length) {
    if (options.json) {
      return { output: jsonFailure('no versions satisfy the targets', choice.errors), exitCode: 1 };
    }
    return {
      output: [folder.file, ...choice.errors.map((e) => `  ✗ ${e}`)].join('\n'),
      exitCode: 1,
    };
  }
  const note = newMajorNote(folder, choice, upstreams);
  if (options.json) {
    return {
      output: JSON.stringify({ rows: choice.rows, ...(note ? { note } : {}) }, null, JSON_INDENT),
      exitCode: 0,
    };
  }
  const from = (r: FolderRow) => (r.from ? shortVersion(r.from) : '-');
  const w = Math.max(...choice.rows.map((r) => r.what.length)) + COLUMN_GAP;
  const fw = Math.max(...choice.rows.map((r) => from(r).length)) + COLUMN_GAP;
  const out = [folder.file];
  for (const r of choice.rows) {
    const change = r.from === r.to ? 'up to date' : `-> ${shortVersion(r.to)}`;
    const who = fold(folder, r);
    out.push(`  ${r.what.padEnd(w)}${from(r).padEnd(fw)}${change}${who ? `   (${who})` : ''}`);
    const indent = `  ${''.padEnd(w)}`;
    if (r.newMinor) {
      const lacking = Object.entries(r.newMinor.missingIn).map(
        ([o, ts]) => `${o} not in ${ts.join(', ')}`,
      );
      out.push(
        `${indent}new FFmpeg minor ${r.newMinor.to}${r.newMinor.adds.length ? ` (adds ${r.newMinor.adds.join(', ')}${lacking.length ? `; ${lacking.join('; ')}` : ''})` : ''}`,
      );
    }
    if (r.skipped) {
      out.push(
        `${indent}${shortVersion(r.skipped.version)} exists - ${r.skipped.reason}${r.skipped.note ? ` (${r.skipped.note})` : ''}`,
      );
    }
  }
  if (note) {
    out.push('', note);
  }
  const anyChange = choice.rows.some((r) => r.from !== r.to);
  out.push(
    '',
    anyChange
      ? 'Run `ffmpeg-build update` to apply (writes ffmpeg.lock only).'
      : 'Everything is up to date.',
  );
  return { output: out.join('\n'), exitCode: 0 };
}
