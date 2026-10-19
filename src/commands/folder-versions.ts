// lock / update / outdated on a folder of targets: one ffmpeg.lock for the folder, one version per library.
import { join } from 'node:path';

import { CliError } from '../cli-errors.ts';
import { FetchError } from '../fetch.ts';
import { chooseFolder, type FolderChoice, type FolderRow } from '../folder-choose.ts';
import { type FolderLock, formatFolderLock, LOCK_FILE, readFolderLock } from '../lockfile.ts';
import { packageVersion } from '../paths.ts';
import { defaultPinSource, pinLock, type PinSource } from '../source-pins.ts';
import { andList, JSON_INDENT } from '../text.ts';
import { compareVersions } from '../versions.ts';
import { cacheRoot } from './build.ts';
import { folderCheck, jsonFailure, runFolderCheck, targetProblemsAt } from './folder.ts';
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

/** "t moves" / "a and b move" */
const moving = (targets: string[]) =>
  `${andList(targets)} ${targets.length === 1 ? 'moves' : 'move'}`;

/** One line for `ffmpeg: latest` reaching a new major: the move, or why it stays (the PR heading, and a note). */
function newMajorLine(r: FolderRow): string {
  const m = r.newMajor!;
  if (m.held) {
    return `FFmpeg latest stays on ${m.from}: on FFmpeg ${m.held.version}, ${m.held.errors.join('; ')}`;
  }
  return `FFmpeg latest is now ${m.to}: ${moving(m.targets)} from ${r.from!} to ${r.to}`;
}

/** What the update PR's CI will stop on after a major move: check's problems, and what releases would lose. */
export interface MoveFindings {
  check: string[];
  removals: string[];
}

const count = (n: number, what: string) => `${n} ${what}${n === 1 ? '' : 's'}`;

/** The note on stderr for a major move: the move, and how much check finds on the new major. */
function newMajorNotes(choice: FolderChoice, findings: MoveFindings): string[] {
  const found = [
    `check finds ${findings.check.length ? count(findings.check.length, 'problem') : 'no problems'} there`,
    ...(findings.removals.length ? [count(findings.removals.length, 'removal')] : []),
  ].join(', and ');
  return choice.rows
    .filter((r) => r.newMajor)
    .map((r) =>
      r.newMajor!.held ? `note: ${newMajorLine(r)}` : `note: ${newMajorLine(r)}; ${found}`,
    );
}

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
  findings: MoveFindings = { check: [], removals: [] },
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
  for (const r of choice.rows.filter((x) => x.newMajor?.held)) {
    const m = r.newMajor!;
    out.push(
      '',
      `## ${newMajorLine(r)}`,
      `No lock fits this folder on FFmpeg ${m.to}, so the targets on \`ffmpeg: latest\` stay on ${m.from} and the rest of the update goes ahead. Fix the folder for FFmpeg ${m.to} and the next update moves them.`,
    );
  }
  for (const r of choice.rows.filter((x) => x.newMajor && !x.newMajor.held)) {
    const m = r.newMajor!;
    const stopping = [...findings.check, ...findings.removals];
    out.push(
      '',
      `## ⚠ ${newMajorLine(r)}`,
      `The targets on \`ffmpeg: latest\` build FFmpeg ${m.to} once this merges, as new releases (tagged ${m.to}.x).`,
      stopping.length
        ? "This PR's check fails until these are fixed (on the default branch: the next update refreshes this PR):"
        : `\`check\` finds nothing wrong with them on FFmpeg ${m.to}; this PR's builds, \`ffmpeg-build test\` and your own tests decide.`,
      ...stopping.map((p) => `- ${p}`),
      '',
      `To stay on FFmpeg ${m.from}, write \`ffmpeg: ${m.from}\` on a target (a target's own \`ffmpeg:\` wins over its base's).`,
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
      `| ${r.what} | ${r.from ? shortVersion(r.from) : '-'} | ${r.newMinor || r.newMajor ? `**${r.to}**` : shortVersion(r.to)} |${who ? ` ${who} ` : ' '}|`,
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
  moved: readonly string[],
): Promise<{ errors: string[]; findings: string[]; notes: string[] }> {
  try {
    // targets that can't build yet have no releases to compare with
    const { rows } = await releaseRows(folder, data, { lock, skipUnbuildable: true });
    // a release that `ffmpeg: latest` takes to a new major in this update goes to a PR whatever it loses: its CI
    // (`releases`) stops it there, saying what; any other removal stops the update, as always
    const movedHere = (r: (typeof rows)[number]) =>
      Boolean(r.lastBefore) && r.targets.some((t) => moved.includes(t.name));
    return {
      errors: rows.filter((r) => !movedHere(r)).flatMap((r) => r.removals),
      findings: rows.filter(movedHere).flatMap((r) => r.removals.map((e) => `${r.tag}: ${e}`)),
      notes: [],
    };
  } catch (e) {
    if (e instanceof FetchError) {
      return {
        errors: [],
        findings: [],
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
  // `ffmpeg: latest` moved to a new major: what the PR's CI will stop on there goes in its text
  const moved = choice.rows.flatMap((r) =>
    r.newMajor && !r.newMajor.held ? r.newMajor.targets : [],
  );
  // the removal guard: nothing a target had in its last release may disappear unless the folder allows it
  const guard = await removalGuard(folder, data, versions, moved);
  const findings: MoveFindings = {
    check: targetProblemsAt(folder, data, versions, moved),
    removals: guard.findings,
  };
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
      text: formatFolderSummary(folder, choice, note, engine, findings),
    });
  }
  stageAndSwap(writes);
  return {
    output: `${LOCK_FILE}: ${changed ? 'updated' : 'no changes'}${engine ? ` (engine ffmpeg-build ${engine.from} -> ${engine.to})` : ''}`,
    exitCode: 0,
    // a new major changes no lock, so it is said whether or not the lock changed (and a CI log shows it); so is
    // `ffmpeg: latest` moving to one, or staying where it is
    notes: [...guard.notes, ...newMajorNotes(choice, findings), ...(note ? [`note: ${note}`] : [])],
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
    if (r.newMajor) {
      out.push(
        `${indent}${r.newMajor.held ? `stays on ${r.newMajor.from}: on FFmpeg ${r.newMajor.held.version}, ${r.newMajor.held.errors.join('; ')}` : `new FFmpeg major ${r.newMajor.to}: ${moving(r.newMajor.targets)} to it (\`ffmpeg: ${r.newMajor.from}\` on a target keeps it on ${r.newMajor.from})`}`,
      );
    }
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
