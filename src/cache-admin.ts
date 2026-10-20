// The library cache (FFMPEG_BUILD_CACHE, else ~/.cache/ffmpeg-build) from the host's side: who is using it, and the
// housekeeping the `cache` command and a starting build do.
//
// Layout: libs/<key>.tar.gz (one built library each), sources/<library>/<file> (the sources they were built from),
// and locks/. Each running build registers itself with a lock file of its own in locks/ (any number may run); `cache
// prune` and `cache clear` take locks/cache.lock and refuse while a build is registered, and a build refuses to start
// while one of them holds it. Each side takes its own lock before looking for the other's, so one always sees the other.
import { createHash, randomBytes } from 'node:crypto';
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { keptPath, parseSourceRecord } from './build/cache.ts';
import { keptFiles } from './build/fetch.ts';
import { acquireLock, type HeldLock, isAlive, LockBusyError, readHolder } from './file-lock.ts';
import { readTarGzMember } from './untar.ts';

/** The cache folder: FFMPEG_BUILD_CACHE, else ~/.cache/ffmpeg-build (absolute: Docker mounts it). */
export function cacheRoot(): string {
  return resolve(process.env['FFMPEG_BUILD_CACHE'] ?? join(homedir(), '.cache', 'ffmpeg-build'));
}

/** The cache is busy: a build is using it, or a prune or clear is under way. */
export class CacheBusyError extends Error {}

/** A day, in milliseconds. */
export const DAY_MS = 86_400_000;
/** Random bytes in a build registration's name, beside the pid. */
const REGISTRATION_BYTES = 6;

const locksDir = (root: string) => join(root, 'locks');
const adminLock = (root: string) => join(locksDir(root), 'cache.lock');

/** The pids of the builds registered in the cache now (a registration whose process is gone is removed). */
export function liveBuilds(root: string, except?: string): number[] {
  const dir = locksDir(root);
  if (!existsSync(dir)) {
    return [];
  }
  const pids: number[] = [];
  for (const f of readdirSync(dir).filter((x) => /^build-.*\.lock$/.test(x))) {
    const path = join(dir, f);
    const holder = path === except ? undefined : readHolder(path);
    if (holder && isAlive(holder.pid)) {
      pids.push(holder.pid);
    } else if (holder) {
      rmSync(path, { force: true });
    } // its build died without unregistering
  }
  return pids;
}

/** Registers a build in the cache; CacheBusyError while a prune or clear runs. Release it when the build ends. */
export function registerBuild(root: string): HeldLock {
  mkdirSync(locksDir(root), { recursive: true });
  const held = acquireLock(
    join(
      locksDir(root),
      `build-${String(process.pid)}-${randomBytes(REGISTRATION_BYTES).toString('hex')}.lock`,
    ),
    'a build registration',
  );
  const admin = readHolder(adminLock(root));
  if (admin && isAlive(admin.pid)) {
    held.release();
    throw new CacheBusyError(
      `the cache ${root} is being pruned or cleared (pid ${admin.pid}); build again when that's done`,
    );
  }
  return held;
}

/** Takes the cache for a prune or clear; CacheBusyError while a build is registered (or another prune runs). */
export function takeCache(root: string, what: string): HeldLock {
  mkdirSync(locksDir(root), { recursive: true });
  let held: HeldLock;
  try {
    held = acquireLock(adminLock(root), `the cache ${root}`);
  } catch (e) {
    if (e instanceof LockBusyError) {
      throw new CacheBusyError(
        `another \`ffmpeg-build cache\` command is changing ${root}${e.pid ? ` (pid ${e.pid})` : ''}; wait for it`,
      );
    }
    throw e;
  }
  const builds = liveBuilds(root);
  if (builds.length) {
    held.release();
    throw new CacheBusyError(
      `not ${what}: ${builds.length === 1 ? 'a build is' : `${builds.length} builds are`} using the cache ${root} (pid ${builds.join(', ')}); try again when ${builds.length === 1 ? 'it ends' : 'they end'}`,
    );
  }
  return held;
}

/** A temporary file or folder a cache write makes (`<final>.tmp.<...>`): left behind only by a run that crashed. */
const isTemp = (name: string) => name.includes('.tmp.');
/** How old a temporary file must be to be taken for a crashed run's while another build may still be writing it. */
const STALE_MS = DAY_MS;

/** How long ago `path` was last written; undefined when it can't be read (gone already). */
function ageMs(path: string): number | undefined {
  try {
    return Date.now() - statSync(path).mtimeMs;
  } catch {
    return undefined;
  }
}

/**
 * Removes what crashed runs left in the cache: every `*.tmp.*` under libs/ and sources/ when `all` (no other build is
 * running), else only those older than a day. Returns what it removed.
 */
export function cleanTemps(root: string, options: { all: boolean }): string[] {
  const removed: string[] = [];
  const consider = (dir: string) => {
    if (!existsSync(dir)) {
      return;
    }
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, e.name);
      if (isTemp(e.name)) {
        const age = ageMs(path);
        if (age !== undefined && (options.all || age > STALE_MS)) {
          rmSync(path, { recursive: true, force: true });
          removed.push(path);
        }
      } else if (e.isDirectory() && dir !== join(root, 'libs')) {
        consider(path);
      }
    }
  };
  consider(join(root, 'libs'));
  consider(join(root, 'sources'));
  return removed;
}

/** What a library entry says it was built from (share/ffmpeg-build/sources/<library>.json in it). */
interface EntryRecord {
  name: string;
  version: string;
  origin: string;
  file: string;
  sha256: string;
  commit?: string;
  crates?: { name: string; file?: string; sha256?: string }[]; // a Rust library's, kept under sources/crates/
}

export interface CacheEntry {
  key: string;
  path: string;
  bytes: number;
  /** Last written or used by a build. */
  usedMs: number;
  record?: EntryRecord;
  /** Why the record couldn't be read: the archive is unreadable, or holds none. */
  unreadable?: string;
}

const RECORD = /^share\/ffmpeg-build\/sources\/[^/]+\.json$/;

/** The library entries in the cache (libs/<key>.tar.gz), with their records, oldest use first. */
export async function cacheEntries(root: string): Promise<CacheEntry[]> {
  const dir = join(root, 'libs');
  if (!existsSync(dir)) {
    return [];
  }
  const out: CacheEntry[] = [];
  for (const f of readdirSync(dir)
    .filter((x) => x.endsWith('.tar.gz') && !isTemp(x))
    .sort()) {
    const path = join(dir, f);
    const st = statSync(path);
    const entry: CacheEntry = {
      key: f.slice(0, -'.tar.gz'.length),
      path,
      bytes: st.size,
      usedMs: st.mtimeMs,
    };
    try {
      const member = await readTarGzMember(path, (name) => RECORD.test(name));
      if (member) {
        // trusted only as a build would trust it (build/cache.ts): for its library, naming a kept source inside sources/
        const name = member.name.slice(member.name.lastIndexOf('/') + 1, -'.json'.length);
        const record = parseSourceRecord(
          JSON.parse(member.data.toString('utf8')),
          name,
          join(root, 'sources'),
        );
        if (record) {
          entry.record = record;
        } else {
          entry.unreadable = "a source record that isn't valid";
        }
      } else {
        entry.unreadable = 'no source record';
      }
    } catch (e) {
      entry.unreadable = `unreadable (${(e as Error).message})`;
    }
    out.push(entry);
  }
  return out.sort((a, b) => a.usedMs - b.usedMs);
}

async function fileSha256(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk as Buffer);
  }
  return hash.digest('hex');
}

/** An entry's problem, if any: no readable record, its kept source gone, or not matching the sha256 it records. */
export async function entryProblem(root: string, e: CacheEntry): Promise<string | undefined> {
  if (!e.record) {
    return e.unreadable ?? 'no source record';
  }
  if (!e.record.file) {
    return 'its record names no kept source';
  }
  for (const { file, sha256 } of keptFiles(e.record)) {
    const kept = keptPath(join(root, 'sources'), file);
    if (!existsSync(kept)) {
      return `its kept source ${file} is gone`;
    }
    if ((await fileSha256(kept)) !== sha256) {
      return `its kept source ${file} doesn't match its sha256`;
    }
  }
  return undefined;
}

/** Marks entries as used now (a build that took them from the cache, or wrote them): prune keeps what is used. */
export function touchEntries(root: string, keys: readonly string[]): void {
  const now = new Date();
  for (const key of keys) {
    try {
      utimesSync(join(root, 'libs', `${key}.tar.gz`), now, now);
    } catch {
      // not cached (a failed build): nothing to mark
    }
  }
}

/** Marks the kept sources a build's <name>.sources.json lists (FFmpeg's among them) as used now. */
export function touchKeptSources(root: string, sourcesJson: string): void {
  let record: {
    ffmpeg?: { file?: string };
    libraries?: { file?: string; crates?: { file?: string }[] }[];
  };
  try {
    record = JSON.parse(readFileSync(sourcesJson, 'utf8')) as typeof record;
  } catch {
    return; // no build record (a failed build, or a libraries-only one)
  }
  const now = new Date();
  const files = [
    record.ffmpeg?.file,
    ...(record.libraries ?? []).flatMap((l) => [l.file, ...(l.crates ?? []).map((c) => c.file)]),
  ];
  for (const file of files.filter((f): f is string => Boolean(f))) {
    try {
      utimesSync(keptPath(join(root, 'sources'), file), now, now);
    } catch {
      // not kept here
    }
  }
}

/** Every kept source file under sources/, as its path relative to sources/ (forward slashes). */
function keptSources(root: string): string[] {
  const base = join(root, 'sources');
  const walk = (dir: string, rel: string): string[] =>
    existsSync(dir)
      ? readdirSync(dir, { withFileTypes: true })
          .filter((e) => !isTemp(e.name))
          .flatMap((e) =>
            e.isDirectory() ? walk(join(dir, e.name), `${rel}${e.name}/`) : [`${rel}${e.name}`],
          )
      : [];
  return walk(base, '');
}

/**
 * Removes library entries not used for `days`, the kept sources no remaining entry records and not used for `days`,
 * and every temporary file (no build is running: the caller holds the cache, takeCache). Returns what went.
 */
export async function pruneCache(
  root: string,
  days: number,
): Promise<{ entries: CacheEntry[]; sources: string[]; temps: string[]; bytes: number }> {
  const cutoff = Date.now() - days * DAY_MS;
  const entries = await cacheEntries(root);
  const old = entries.filter((e) => e.usedMs < cutoff);
  for (const e of old) {
    rmSync(e.path, { force: true });
  }
  const kept = new Set(
    entries
      .filter((e) => !old.includes(e))
      .flatMap((e) => (e.record?.file ? keptFiles(e.record).map((k) => k.file) : [])),
  );
  const sources: string[] = [];
  let bytes = old.reduce((n, e) => n + e.bytes, 0);
  for (const rel of keptSources(root)) {
    const path = join(root, 'sources', ...rel.split('/'));
    const st = statSync(path);
    if (!kept.has(rel) && st.mtimeMs < cutoff) {
      rmSync(path, { force: true });
      sources.push(rel);
      bytes += st.size;
    }
  }
  const temps = cleanTemps(root, { all: true });
  return { entries: old, sources, temps, bytes };
}

/** Empties the cache: every library entry and kept source (the caller holds the cache, takeCache). */
export function clearCache(root: string): void {
  for (const path of [join(root, 'libs'), join(root, 'sources')].filter((p) => existsSync(p))) {
    for (const f of readdirSync(path)) {
      rmSync(join(path, f), { recursive: true, force: true });
    }
  }
}
