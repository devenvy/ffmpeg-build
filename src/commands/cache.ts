// `ffmpeg-build cache`: the library cache (path, list, verify, prune, clear). Reading it is always fine; changing it
// waits for no build: prune, clear and verify --fix refuse while a build is using the cache (cache-admin.ts).
import { rmSync } from 'node:fs';

import {
  cacheEntries,
  type CacheEntry,
  cacheRoot,
  clearCache,
  DAY_MS,
  entryProblem,
  pruneCache,
  takeCache,
} from '../cache-admin.ts';
import { CliError } from '../cli-errors.ts';

interface Result {
  output: string;
  exitCode: number;
}

const KIB = 1024;
/** Sizes below this many units are shown with one decimal. */
const ONE_DECIMAL_BELOW = 10;
/** How much of an entry's key names it where it has no record. */
const KEY_SHOWN = 12;
const JSON_INDENT = 2;
/** The list's columns: the gap after the name, the size's and the age's widths. */
const NAME_GAP = 2;
const SIZE_WIDTH = 8;
const AGE_WIDTH = 9;
/** What `prune` removes when `--older-than` doesn't say: unused for a month. */
const DEFAULT_PRUNE_DAYS = 30;

function formatBytes(n: number): string {
  if (n < KIB) {
    return `${String(n)} B`;
  }
  const units = ['KB', 'MB', 'GB', 'TB'] as const;
  let v = n / KIB;
  let u = 0;
  while (v >= KIB && u < units.length - 1) {
    v /= KIB;
    u++;
  }
  return `${v < ONE_DECIMAL_BELOW ? v.toFixed(1) : String(Math.round(v))} ${units[u] ?? ''}`;
}

const ageDays = (e: CacheEntry) => Math.floor((Date.now() - e.usedMs) / DAY_MS);
const age = (days: number) => {
  if (days === 0) {
    return 'today';
  }
  return days === 1 ? '1 day' : `${String(days)} days`;
};
const label = (e: CacheEntry) =>
  e.record ? `${e.record.name} ${e.record.version}` : e.key.slice(0, KEY_SHOWN);

export function runCachePath(): Result {
  return { output: cacheRoot(), exitCode: 0 };
}

export async function runCacheList(options: { json?: boolean } = {}): Promise<Result> {
  const root = cacheRoot();
  const entries = (await cacheEntries(root)).sort((a, b) => label(a).localeCompare(label(b)));
  if (options.json) {
    return {
      output: JSON.stringify(
        entries.map((e) => ({
          key: e.key,
          library: e.record?.name ?? null,
          version: e.record?.version ?? null,
          bytes: e.bytes,
          ageDays: ageDays(e),
          ...(e.unreadable ? { problem: e.unreadable } : {}),
        })),
        null,
        JSON_INDENT,
      ),
      exitCode: 0,
    };
  }
  if (!entries.length) {
    return { output: `${root}: no libraries cached`, exitCode: 0 };
  }
  const width = Math.max(...entries.map((e) => label(e).length)) + NAME_GAP;
  const total = entries.reduce((n, e) => n + e.bytes, 0);
  return {
    output: [
      `${root}: ${entries.length} ${entries.length === 1 ? 'library' : 'libraries'}, ${formatBytes(total)} (age: since last used)`,
      ...entries.map(
        (e) =>
          `  ${label(e).padEnd(width)}${formatBytes(e.bytes).padStart(SIZE_WIDTH)}  ${age(ageDays(e)).padEnd(AGE_WIDTH)} ${e.key.slice(0, KEY_SHOWN)}${e.unreadable ? `  ✗ ${e.unreadable}` : ''}`,
      ),
    ].join('\n'),
    exitCode: 0,
  };
}

/** Each entry's record and kept source; exit 1 when any is bad. With `fix`, the bad entries are removed. */
export async function runCacheVerify(options: { fix?: boolean } = {}): Promise<Result> {
  const root = cacheRoot();
  const held = options.fix ? takeCache(root, 'removing bad entries') : undefined;
  try {
    const entries = await cacheEntries(root);
    const bad: { entry: CacheEntry; problem: string }[] = [];
    for (const entry of entries) {
      const problem = await entryProblem(root, entry);
      if (problem) {
        bad.push({ entry, problem });
      }
    }
    if (!bad.length) {
      return {
        output: `${root}: ${entries.length} ${entries.length === 1 ? 'entry' : 'entries'}, all good`,
        exitCode: 0,
      };
    }
    const lines = bad.map((b) => `  ✗ ${label(b.entry)}: ${b.problem}`);
    if (options.fix) {
      for (const b of bad) {
        rmSync(b.entry.path, { force: true });
      }
      return {
        output: [
          `${root}: removed ${bad.length} bad ${bad.length === 1 ? 'entry' : 'entries'} (the next build builds them again):`,
          ...lines,
        ].join('\n'),
        exitCode: 0,
      };
    }
    return {
      output: [
        `${root}: ${bad.length} of ${entries.length} entries are bad:`,
        ...lines,
        '`ffmpeg-build cache verify --fix` removes them; the next build builds them again',
      ].join('\n'),
      exitCode: 1,
    };
  } finally {
    held?.release();
  }
}

export async function runCachePrune(options: { olderThan?: string } = {}): Promise<Result> {
  const days = options.olderThan === undefined ? DEFAULT_PRUNE_DAYS : Number(options.olderThan);
  if (!Number.isFinite(days) || days < 0) {
    throw new CliError(`--older-than takes a number of days, not ${String(options.olderThan)}`);
  }
  const root = cacheRoot();
  const held = takeCache(root, 'pruning');
  try {
    const r = await pruneCache(root, days);
    const n = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
    return {
      output: `${root}: removed ${n(r.entries.length, 'library entry', 'library entries')}, ${n(r.sources.length, 'source', 'sources')} and ${n(r.temps.length, 'temporary file', 'temporary files')} (entries and sources not used in ${days} days; what crashed runs left); ${formatBytes(r.bytes)} freed`,
      exitCode: 0,
    };
  } finally {
    held.release();
  }
}

export function runCacheClear(): Result {
  const root = cacheRoot();
  const held = takeCache(root, 'clearing');
  try {
    clearCache(root);
    return { output: `${root}: emptied (the next build builds every library again)`, exitCode: 0 };
  } finally {
    held.release();
  }
}
