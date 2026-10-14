// The read-only commands on a folder of targets (ffmpeg-build.yml): check, plan, show, targets.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { parseDocument } from 'yaml';

import { writeFileAtomic } from '../atomic-write.ts';
import { buildSettingProblems, buildSettings } from '../build-settings.ts';
import { checkProfile, type ProfileReport } from '../check.ts';
import { EXIT_PROBLEM, EXIT_USAGE, type ExitCode } from '../cli-errors.ts';
import { type EngineData, recipeForPin, resolveName } from '../engine-data.ts';
import { collectLibraryRequirements, folderLockMatches } from '../folder-choose.ts';
import { addTo, missingByTarget, removeFrom, targetsReached } from '../folder-edit.ts';
import { initFolder, type Selection, shippedFolder } from '../folder-init.ts';
import { formatPlan, formatReport, formatSummary, planJson, problemLines } from '../format.ts';
import { type FolderLock, LOCK_FILE, type LockedProfile, readFolderLock } from '../lockfile.ts';
import { schemaUrl } from '../paths.ts';
import { EditError } from '../profile-edit.ts';
import { looksLikeProfileFile } from '../profile.ts';
import { frameworkSliceProblems, runnerOf } from '../release.ts';
import { availability, type CellPlan, planProfile } from '../resolve.ts';
import { unpinnedSources } from '../source-pins.ts';
import {
  type Folder,
  FOLDER_FILE,
  loadFolder,
  parseFolderText,
  releaseVersion,
  type Target,
  targetProfile,
} from '../targets.ts';
import { JSON_INDENT } from '../text.ts';

interface Result {
  output: string;
  exitCode: number;
}

/** A usage problem with the folder or a target name: exit 2. */
export class FolderError extends Error {}

/** Whether `dir` holds a folder file (the targets format). */
export function hasFolder(dir = '.'): boolean {
  return existsSync(join(dir, FOLDER_FILE));
}

/** Whether this folder's ffmpeg-build.yml is really an old matrix profile (a profile's keys and no targets:). */
export function oldFormatFolderFile(dir = '.'): boolean {
  if (!hasFolder(dir)) {
    return false;
  }
  try {
    const raw = parseDocument(readFileSync(join(dir, FOLDER_FILE), 'utf8'), {
      schema: 'failsafe',
    }).toJSON() as unknown;
    return (
      typeof raw === 'object' &&
      raw !== null &&
      !('targets' in raw) &&
      ['name', 'platforms', 'license'].some((k) => k in raw)
    );
  } catch {
    return false;
  }
}

/** The old matrix profiles in a folder: *.yml files with a profile's keys (ffmpeg-build.yml only when it is one). */
export function oldProfiles(dir = '.'): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter(
      (d) =>
        d.isFile() &&
        /\.ya?ml$/.test(d.name) &&
        (d.name === FOLDER_FILE
          ? oldFormatFolderFile(dir)
          : looksLikeProfileFile(join(dir, d.name))),
    )
    .map((d) => d.name)
    .sort();
}

/** The folder's ffmpeg-build.yml, loaded and checked for shape; without one, old profiles here get the migrate hint. */
export function openFolder(dir = '.'): Folder {
  if (!hasFolder(dir) || oldFormatFolderFile(dir)) {
    const old = oldProfiles(dir);
    if (old.length) {
      throw new FolderError(
        `${old.join(', ')} ${old.length > 1 ? 'are old matrix profiles' : 'is an old matrix profile'}: ffmpeg-build now reads ${FOLDER_FILE}, one target per build. Run \`ffmpeg-build migrate\` here to convert (the old files are kept as *.old).`,
      );
    }
  }
  const r = loadFolder(dir);
  if (!r.ok) {
    throw new FolderError([`${r.file}:`, ...r.errors.map((e) => `  ✗ ${e}`)].join('\n'));
  }
  return r.folder;
}

/** The folder problem that is the lock's (a data problem: exit 2, not a target problem). */
const LOCK_STALE = `${LOCK_FILE} doesn't match the targets; run ffmpeg-build lock`;

/** Spaces between the columns of `targets`. */
const COLUMN_GAP = 2;

const header = (t: Target, lock?: FolderLock) =>
  `target ${t.name} (${t.platform}, ${t.license}, FFmpeg ${t.ffmpeg}${lock?.ffmpeg[t.ffmpeg] ? `: ${lock.ffmpeg[t.ffmpeg]!}` : ''})`;

/** The named targets (one name, or a comma-separated list as --target and --platform give it), in the file's order. */
const pick = (folder: Folder, name?: string): Target[] => {
  if (!name) {
    return folder.targets;
  }
  const names = name
    .split(',')
    .map((n) => n.trim())
    .filter(Boolean);
  const unknown = names.filter((n) => !folder.targets.some((x) => x.name === n));
  if (unknown.length) {
    throw new FolderError(
      `no target ${unknown.join(', ')} in ${FOLDER_FILE} (targets: ${folder.targets.map((x) => x.name).join(', ')})`,
    );
  }
  return folder.targets.filter((x) => names.includes(x.name));
};

/** A target's locked FFmpeg release, as planProfile takes it (none: the newest the data knows). */
const lockedVersion = (t: Target, lock?: FolderLock): Record<string, string> =>
  lock?.ffmpeg[t.ffmpeg] ? { [t.ffmpeg]: lock.ffmpeg[t.ffmpeg]! } : {};

/** The pins that bind a target's libraries (the folder's, then its own), by library: `13.0`, or `13.0 and ~13.0.19`. */
function pinsOf(
  folder: Folder,
  t: Target,
  data: EngineData,
  cell: CellPlan,
): Record<string, string> {
  const by: Record<string, string[]> = {};
  for (const [name, range] of [...Object.entries(folder.pin), ...Object.entries(t.pin)]) {
    const pinned = recipeForPin(data, name);
    if ('recipe' in pinned && cell.recipes.includes(pinned.recipe)) {
      (by[pinned.recipe] ??= []).push(range);
    }
  }
  return Object.fromEntries(
    Object.entries(by).map(([recipe, ranges]) => [recipe, ranges.join(' and ')]),
  );
}

/** The one build of a target, at its locked FFmpeg release when the lock has it (else the newest the data knows). */
function buildOf(
  folder: Folder,
  t: Target,
  data: EngineData,
  lock?: FolderLock,
): CellPlan | undefined {
  return planProfile(targetProfile(folder, t), data, lockedVersion(t, lock)).cells[0];
}

/** Problems of the folder as a whole, the lock included: what stops any build. */
export function folderErrors(
  folder: Folder,
  data: EngineData,
  lock: FolderLock | undefined,
): string[] {
  return folderProblems(folder, data, lock, true);
}

/** Problems of the folder as a whole: pins that match no build, and (when it must match) a lock that no longer fits. */
function folderProblems(
  folder: Folder,
  data: EngineData,
  lock: FolderLock | undefined,
  lockMustMatch: boolean,
): string[] {
  const errors: string[] = [];
  const builds = folder.targets.flatMap((t) => {
    const cell = buildOf(folder, t, data, lock);
    return cell ? [{ target: t, cell }] : [];
  });
  collectLibraryRequirements(folder, data, builds, errors);
  // what releases together (release group, FFmpeg version): each licence's framework targets make one xcframework
  // bundle, so all four slices or none, before anything is built
  const releases = new Map<string, Target[]>();
  for (const t of folder.targets) {
    const ffmpeg = lock?.ffmpeg[t.ffmpeg];
    const key = `${t.releaseGroup ? `${t.releaseGroup}-` : ''}${ffmpeg ? releaseVersion(ffmpeg) : t.ffmpeg}`;
    releases.set(key, [...(releases.get(key) ?? []), t]);
  }
  for (const [key, targets] of releases) {
    for (const p of frameworkSliceProblems(targets)) {
      errors.push(releases.size > 1 ? `${key}: ${p}` : p);
    }
  }
  if (lock && lockMustMatch && !errors.length && !folderLockMatches(folder, data, lock)) {
    errors.push(LOCK_STALE);
  }
  return errors;
}

/** Exit code for folder-wide problems: 2 when the only one is a stale lock, else 1. */
export function folderExitCode(errors: readonly string[]): 0 | ExitCode {
  if (errors.length === 1 && errors[0] === LOCK_STALE) {
    return EXIT_USAGE;
  }
  return errors.length ? EXIT_PROBLEM : 0;
}

/** check's verdict: each report, the problems one line each (`<header>: <problem>`), and the exit code. */
export interface FolderCheck {
  reports: ProfileReport[];
  problems: string[];
  exitCode: 0 | ExitCode;
}

export function folderCheck(
  folder: Folder,
  data: EngineData,
  options: { target?: string; ignoreLock?: boolean } = {},
): FolderCheck {
  const { reports, lockStale } = folderReports(folder, data, options);
  // a stale lock is a data problem (2), whatever else is wrong; a target's problems are 1
  let exitCode: 0 | ExitCode = 0;
  if (lockStale) {
    exitCode = EXIT_USAGE;
  } else if (reports.some((r) => r.problems)) {
    exitCode = EXIT_PROBLEM;
  }
  const problems = reports.flatMap((r) =>
    r.problems ? problemLines(r).map((p) => `${r.header}: ${p}`) : [],
  );
  return { reports, problems, exitCode };
}

/**
 * The --json body of a failure, as docs/getting-started.md promises it: `{"error", "problems"}`, with what the command found beside
 * them under its own key; never a bare list that could pass for the answer. A success never has `error`.
 */
export function jsonFailure(
  error: string,
  problems: readonly string[],
  detail: Record<string, unknown> = {},
): string {
  return JSON.stringify({ error, problems, ...detail }, null, JSON_INDENT);
}

export function runFolderCheck(
  folder: Folder,
  data: EngineData,
  options: { target?: string; json?: boolean; ignoreLock?: boolean } = {},
): Result {
  const { reports, problems, exitCode } = folderCheck(folder, data, options);
  if (!options.json) {
    return { output: reports.map(formatReport).join('\n\n'), exitCode };
  }
  if (!exitCode) {
    return { output: JSON.stringify({ ok: true, targets: reports }, null, JSON_INDENT), exitCode };
  }
  const error =
    exitCode === EXIT_USAGE
      ? LOCK_STALE
      : `check found ${problems.length} problem${problems.length === 1 ? '' : 's'}`;
  return { output: jsonFailure(error, problems, { targets: reports }), exitCode };
}

/** One target's check, at its locked FFmpeg release. */
function targetReport(
  folder: Folder,
  t: Target,
  data: EngineData,
  lock: FolderLock | undefined,
): ProfileReport {
  return checkProfile({ ok: true, profile: targetProfile(folder, t) }, data, {
    target: { header: header(t, lock) },
    versions: lockedVersion(t, lock),
  });
}

/** The folder's own problems and notes (when there are any), then each chosen target's check; and whether the lock is stale. */
function folderReports(
  folder: Folder,
  data: EngineData,
  options: { target?: string; ignoreLock?: boolean } = {},
): { reports: ProfileReport[]; lockStale: boolean } {
  // the lock's FFmpeg releases are what the targets are judged by, even when lock/update is about to rewrite it
  const lock = readFolderLock(join(folder.dir, LOCK_FILE));
  const reports: ProfileReport[] = [];
  const general = options.target ? [] : folderProblems(folder, data, lock, !options.ignoreLock);
  // where and how the chosen targets' platforms build (the build: section): what can't work, and runners taken on trust
  const platforms = [...new Set(pick(folder, options.target).map((t) => t.platform))];
  const settings = platforms.map((p) =>
    buildSettingProblems(p, buildSettings(folder, p), runnerOf(data, p)),
  );
  const errors = [...general, ...settings.flatMap((s) => s.errors)];
  const notes = settings.flatMap((s) => s.notes);
  // a lock from before pins still builds, fetching by version alone: say how to pin it
  const unpinned = lock && !options.ignoreLock ? unpinnedSources(data, lock) : [];
  if (unpinned.length) {
    notes.push(
      `${LOCK_FILE} doesn't pin the content of ${unpinned.join(', ')}; run ffmpeg-build lock to pin sources`,
    );
  }
  if (errors.length || notes.length) {
    reports.push({
      file: folder.file,
      header: folder.file,
      blocks: [
        {
          lines: [
            ...errors.map((text) => ({ mark: '✗' as const, text })),
            ...notes.map((text) => ({ mark: '-' as const, text })),
          ],
        },
      ],
      problems: errors.length,
    });
  }
  for (const t of pick(folder, options.target)) {
    reports.push(targetReport(folder, t, data, lock));
  }
  return { reports, lockStale: general.includes(LOCK_STALE) };
}

export function runFolderPlan(
  folder: Folder,
  data: EngineData,
  options: { target?: string; json?: boolean } = {},
): Result {
  const lock = readFolderLock(join(folder.dir, LOCK_FILE));
  const locked: LockedProfile | undefined = lock
    ? { ffmpeg: lock.ffmpeg, libraries: lock.libraries, pinned: [] }
    : undefined;
  const texts: string[] = [];
  const json: unknown[] = [];
  const problems: string[] = [];
  let exitCode = 0;
  for (const t of pick(folder, options.target)) {
    const profile = targetProfile(folder, t);
    const report = checkProfile({ ok: true, profile }, data, {
      target: { header: header(t, lock) },
      versions: lockedVersion(t, lock),
    });
    if (report.problems) {
      exitCode = 1;
      problems.push(...problemLines(report).map((p) => `${t.name}: ${p}`));
      texts.push(formatReport(report));
    } else {
      const plan = planProfile(profile, data, lockedVersion(t, lock));
      for (const c of plan.cells) {
        c.pins = pinsOf(folder, t, data, c);
      }
      if (options.json) {
        json.push({ target: t.name, ...planJson(profile, plan, data, locked) });
      } else {
        texts.push(formatPlan(profile, plan, data, locked));
      }
    }
  }
  if (options.json && exitCode) {
    return {
      output: jsonFailure(
        `${problems.length} problem${problems.length === 1 ? '' : 's'} in the targets: nothing planned for those (ffmpeg-build check says more)`,
        problems,
      ),
      exitCode,
    };
  }
  return {
    output: options.json ? JSON.stringify(json, null, JSON_INDENT) : texts.join('\n\n'),
    exitCode,
  };
}

/** One line of `show`: an entry, the layer that gave it, and why it isn't built when it isn't. */
interface ShowEntry {
  name: string;
  label: string;
  from: string;
  included: boolean;
  notBuilt?: string;
}

/** What one target gets: each entry with the layer that put it there, what it turns down, and its libraries. */
export function runShow(folder: Folder, data: EngineData, name: string, json = false): Result {
  const [t] = pick(folder, name);
  const lock = readFolderLock(join(folder.dir, LOCK_FILE));
  const cell = buildOf(folder, t!, data, lock);
  const entries: ShowEntry[] = [
    ...t!.with.map((n) => {
      const option = resolveName(data, n);
      const absence = cell && option ? availability(data, cell.cell, option) : undefined;
      return {
        name: n,
        label: n,
        from: t!.origin.get(n)!,
        included: true,
        ...(absence ? { notBuilt: absence.reason } : {}),
      };
    }),
    ...t!.without.map((n) => ({
      name: n,
      label: `not ${n}`,
      from: `${t!.origin.get(n)!}: without`,
      included: false,
    })),
  ];
  const libraries = (cell?.recipes ?? []).map((r) =>
    lock?.libraries[r] ? `${r} ${lock.libraries[r]}` : r,
  );
  if (json) {
    return {
      output: JSON.stringify(
        {
          target: t!.name,
          platform: t!.platform,
          license: t!.license,
          ffmpeg: t!.ffmpeg,
          entries,
          libraries,
          leftOut: cell?.leftOut ?? [],
        },
        null,
        JSON_INDENT,
      ),
      exitCode: 0,
    };
  }
  const width = Math.max(...entries.map((e) => e.label.length)) + 1;
  const out = [header(t!, lock)];
  for (const e of entries) {
    out.push(`  ${e.label.padEnd(width)}(${e.from})${e.notBuilt ? `   ✗ ${e.notBuilt}` : ''}`);
  }
  if (libraries.length) {
    out.push(`  libraries: ${libraries.join(', ')}`);
  }
  for (const l of cell?.leftOut ?? []) {
    out.push(`  - ${l.recipe} without ${l.uses}: ${l.reason}`);
  }
  return { output: out.join('\n'), exitCode: 0 };
}

/** Which targets get `name`, and why the others don't. */
export function runShowHas(folder: Folder, data: EngineData, name: string, json = false): Result {
  const option = resolveName(data, name);
  if (!option) {
    throw new FolderError(
      `ffmpeg-build doesn't know "${name}". Use the name FFmpeg gives it, like nvenc, x265 or whisper.`,
    );
  }
  const lock = readFolderLock(join(folder.dir, LOCK_FILE));
  const rows = folder.targets.map((t) => {
    if (t.without.includes(name)) {
      return { target: t.name, has: false, why: `turned down by ${t.origin.get(name)!}` };
    }
    if (!t.with.includes(name)) {
      return { target: t.name, has: false, why: 'not listed' };
    }
    const cell = buildOf(folder, t, data, lock);
    const absence = cell ? availability(data, cell.cell, option) : undefined;
    return absence
      ? {
          target: t.name,
          has: false,
          why: `listed by ${t.origin.get(name)!}, but ${absence.reason}`,
        }
      : { target: t.name, has: true, why: t.origin.get(name)! };
  });
  if (json) {
    return { output: JSON.stringify(rows, null, JSON_INDENT), exitCode: 0 };
  }
  return {
    output: rows.map((r) => `${r.target}: ${r.has ? 'yes' : 'no'} (${r.why})`).join('\n'),
    exitCode: 0,
  };
}

/** The targets, for people and CI matrices: name, platform, license, FFmpeg series and its locked release. */
export function runTargets(folder: Folder, json = false, target?: string): Result {
  const lock = readFolderLock(join(folder.dir, LOCK_FILE));
  const rows = pick(folder, target).map((t) => ({
    name: t.name,
    platform: t.platform,
    license: t.license,
    ffmpeg: t.ffmpeg,
    ...(lock?.ffmpeg[t.ffmpeg] ? { version: lock.ffmpeg[t.ffmpeg] } : {}),
  }));
  if (json) {
    return { output: JSON.stringify(rows, null, JSON_INDENT), exitCode: 0 };
  }
  if (!rows.length) {
    return { output: `no targets in ${FOLDER_FILE}`, exitCode: 0 };
  }
  // columns: name, platform, license, FFmpeg series (and its locked release), each as wide as its longest entry
  const cells = [
    ['target', 'platform', 'license', 'ffmpeg'],
    ...rows.map((r) => [
      r.name,
      r.platform,
      r.license,
      `${r.ffmpeg}${r.version ? ` (${r.version})` : ''}`,
    ]),
  ];
  const widths = cells[0]!.map((_, i) => Math.max(...cells.map((c) => c[i]!.length)));
  return {
    output: cells
      .map((c) =>
        c
          .map((v, i) => (i < c.length - 1 ? v.padEnd(widths[i]! + COLUMN_GAP) : v))
          .join('')
          .trimEnd(),
      )
      .join('\n'),
    exitCode: 0,
  };
}

/**
 * `profile add|remove <names> --to|--from <base or target>`: make the edit in memory and check every target it
 * reaches; write it only when it gives none of them a problem it didn't have. A refused edit writes nothing and says
 * which targets it would break, and why.
 */
export function runFolderEdit(
  action: 'add' | 'remove',
  names: string[],
  layer: string,
  data: EngineData,
): Result {
  const unknown = names.filter((n) => !resolveName(data, n));
  if (unknown.length) {
    throw new FolderError(
      unknown
        .map(
          (n) =>
            `ffmpeg-build doesn't know "${n}". Use the name FFmpeg gives it, like nvenc, x265 or whisper.`,
        )
        .join('\n'),
    );
  }
  const path = join('.', FOLDER_FILE);
  const was = openFolder();
  const before = readFileSync(path, 'utf8');
  const edited = action === 'add' ? addTo(before, layer, names) : removeFrom(before, layer, names);
  if (edited === before) {
    return {
      output: `nothing changed: ${layer} ${action === 'add' ? 'already has' : "doesn't have"} ${names.join(', ')}`,
      exitCode: 0,
    };
  }
  const parsed = parseFolderText(edited, resolve('.'));
  if (!parsed.ok) {
    throw new EditError(
      `not saved: the edited file would have problems:\n${parsed.errors.map((e) => `  ${e}`).join('\n')}`,
    );
  }
  const folder = parsed.folder;
  const reached = targetsReached(folder, layer);
  const lock = readFolderLock(join(folder.dir, LOCK_FILE));
  const reports = reached.map((name) =>
    targetReport(
      folder,
      folder.targets.find((t) => t.name === name)!,
      data,
      lock,
    ),
  );
  const what = `${action === 'add' ? 'adding' : 'removing'} ${names.join(', ')} ${action === 'add' ? 'to' : 'from'} ${layer}`;
  // the problems the edit brings: a target's problems now that it didn't have before (one it already had isn't the edit's)
  const broken = reports.flatMap((r, i) => {
    const previous = was.targets.find((t) => t.name === reached[i]);
    const had = new Set(previous ? problemLines(targetReport(was, previous, data, lock)) : []);
    const fresh = problemLines(r).filter((p) => !had.has(p));
    return fresh.length ? [{ target: reached[i]!, problems: fresh }] : [];
  });
  if (broken.length) {
    const out = [
      `not saved: ${what} would give ${broken.map((b) => b.target).join(', ')} ${broken.length > 1 || broken[0]!.problems.length > 1 ? 'problems' : 'a problem'}:`,
    ];
    for (const b of broken) {
      for (const p of b.problems) {
        out.push(`  ✗ ${b.target}: ${p}`);
      }
    }
    out.push(
      '',
      `${FOLDER_FILE} is unchanged. \`ffmpeg-build options\` says which licenses and platforms each name allows.`,
    );
    return { output: out.join('\n'), exitCode: 1 };
  }
  writeFileAtomic(path, edited);
  const lines = [
    `${action === 'add' ? 'added' : 'removed'} ${names.join(', ')} ${action === 'add' ? 'to' : 'from'} ${layer}${reached.length ? ` (reaches ${reached.join(', ')})` : ''}`,
  ];
  // a target's own without: still wins over what its base now gives it
  for (const n of action === 'add' ? names : []) {
    const declining = folder.targets
      .filter((t) => reached.includes(t.name) && t.without.includes(n))
      .map((t) => t.name);
    if (declining.length) {
      lines.push(
        `  ${n} stays out of ${declining.join(', ')}: ${declining.length > 1 ? 'they turn' : 'it turns'} it down (without:)`,
      );
    }
  }
  return {
    output: [...lines, '', ...reports.map(formatSummary)].join('\n'),
    exitCode: reports.some((r) => r.problems) ? 1 : 0,
  };
}

/** What targets could add but don't list or turn down; exit 1 when there is any. */
export function runFolderMissing(
  folder: Folder,
  data: EngineData,
  options: { target?: string; json?: boolean } = {},
): Result {
  if (options.target) {
    pick(folder, options.target);
  }
  const found = missingByTarget(folder, data, options.target);
  if (options.json) {
    const missing = Object.fromEntries(found);
    if (!found.size) {
      return { output: JSON.stringify({ ok: true, missing }, null, JSON_INDENT), exitCode: 0 };
    }
    const lines = [...found].map(([option, targets]) => `${option}: ${targets.join(', ')}`);
    return {
      output: jsonFailure(
        `${found.size} option${found.size === 1 ? '' : 's'} could be added (\`ffmpeg-build profile add <name> --to <base or target>\`; \`without:\` turns one down for good)`,
        lines,
        { missing },
      ),
      exitCode: 1,
    };
  }
  if (!found.size) {
    return { output: 'nothing missing', exitCode: 0 };
  }
  const out = [
    'could be added (`ffmpeg-build profile add <name> --to <base or target>`; `without:` turns one down for good):',
  ];
  for (const [option, targets] of found) {
    out.push(`  ${option}: ${targets.join(', ')}`);
  }
  return { output: out.join('\n'), exitCode: 1 };
}

/** `init`: write ffmpeg-build.yml from the shipped targets the selection names (never over an existing one), then check it. */
export function runFolderInit(sel: Selection, from: string, data: EngineData): Result {
  if (hasFolder()) {
    throw new FolderError(
      `${FOLDER_FILE} already exists here; edit it with \`ffmpeg-build profile add --to\` / \`remove --from\``,
    );
  }
  // every shipped target is dozens of builds: say which, or `all` for that
  const missing = [
    ...(sel.license ? [] : ['--license <list>']),
    ...(sel.platforms ? [] : ['--platforms <list>']),
  ];
  if (missing.length) {
    throw new FolderError(
      `say what to build: ${missing.join(' and ')} (e.g. --license lgplv3 --platforms linux-x64,win-x64; \`all\` takes every one). \`ffmpeg-build options\` lists what each license and platform allows.`,
    );
  }
  writeFileAtomic(
    FOLDER_FILE,
    `# yaml-language-server: $schema=${schemaUrl()}\n${initFolder(shippedFolder(from), sel, from)}`,
  );
  const folder = openFolder();
  const { reports } = folderReports(folder, data);
  const problems = reports.filter((r) => r.problems).length;
  const out = [
    `wrote ${FOLDER_FILE}: ${folder.targets.length} target${folder.targets.length === 1 ? '' : 's'}${problems ? `, ${problems} with problems` : ''}`,
    ...reports.map(formatSummary),
  ];
  out.push(
    '',
    problems
      ? 'Fix the ✗ above (`ffmpeg-build check` shows everything), then `ffmpeg-build lock`.'
      : 'Next: `ffmpeg-build lock`, then `ffmpeg-build build --target <name>`. `ffmpeg-build show <target>` says what a target gets.',
  );
  return { output: out.join('\n'), exitCode: problems ? 1 : 0 };
}
