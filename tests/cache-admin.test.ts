// The library cache's housekeeping, in-process: what `ffmpeg-build cache` and a starting build call
// (tests/cache-cli.test.ts runs the command itself).
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { age, DAY, libraryCache, sha } from './cache-fixture.ts';
import { tarGz } from './github-fake.ts';
import {
  CacheBusyError,
  cacheEntries,
  type CacheEntry,
  cacheRoot,
  clearCache,
  entryProblem,
  liveBuilds,
  pruneCache,
  registerBuild,
  takeCache,
  touchEntries,
  touchKeptSources,
} from '../src/cache-admin.ts';

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const C = 'c'.repeat(64);
const D = 'd'.repeat(64);
/** A pid no process has: a lock file naming it was left by a process that is gone. */
const DEAD_PID = '999999999';

async function entry(root: string, key: string): Promise<CacheEntry> {
  const found = (await cacheEntries(root)).find((e) => e.key === key);
  if (!found) {
    throw new Error(`no entry ${key}`);
  }
  return found;
}

/** Writes an entry holding only `record`, as share/ffmpeg-build/sources/<name>.json. */
function writeEntry(root: string, key: string, name: string, record: unknown): void {
  writeFileSync(
    join(root, 'libs', `${key}.tar.gz`),
    tarGz([{ name: `share/ffmpeg-build/sources/${name}.json`, data: JSON.stringify(record) }]),
  );
}

const usedRecently = (path: string) => Date.now() - statSync(path).mtimeMs < DAY;

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('the cache folder', () => {
  it('is FFMPEG_BUILD_CACHE, made absolute', () => {
    vi.stubEnv('FFMPEG_BUILD_CACHE', 'some/cache');
    expect(cacheRoot()).toBe(resolve('some/cache'));
  });

  it('is ~/.cache/ffmpeg-build without it', () => {
    vi.stubEnv('FFMPEG_BUILD_CACHE', undefined);
    expect(cacheRoot()).toBe(join(homedir(), '.cache', 'ffmpeg-build'));
  });
});

describe('builds using the cache', () => {
  it('none are registered in a cache without a locks folder', () => {
    expect(liveBuilds(libraryCache([]))).toEqual([]);
  });

  it('lists a running build until it is released', () => {
    const root = libraryCache([]);
    const build = registerBuild(root);
    expect(liveBuilds(root)).toEqual([process.pid]);
    build.release();
    expect(liveBuilds(root)).toEqual([]);
  });

  it('removes the registration of a build that died without releasing it, and ignores other files', () => {
    const root = libraryCache([]);
    mkdirSync(join(root, 'locks'));
    writeFileSync(
      join(root, 'locks', 'build-1-abc.lock'),
      `${DEAD_PID} ${DEAD_PID}-0123456789abcdef\n`,
    );
    writeFileSync(join(root, 'locks', 'notes.txt'), 'not a registration');
    expect(liveBuilds(root)).toEqual([]);
    expect(readdirSync(join(root, 'locks'))).toEqual(['notes.txt']);
  });

  it('leaves out the registration it is told to, without removing it', () => {
    const root = libraryCache([]);
    const build = registerBuild(root);
    try {
      const own = readdirSync(join(root, 'locks'));
      expect(liveBuilds(root, join(root, 'locks', own[0]!))).toEqual([]);
      expect(readdirSync(join(root, 'locks'))).toEqual(own);
    } finally {
      build.release();
    }
  });

  it('a prune or clear is refused while builds run, naming them', () => {
    const root = libraryCache([]);
    const pid = String(process.pid);
    const first = registerBuild(root);
    const second = registerBuild(root);
    try {
      expect(() => takeCache(root, 'pruning')).toThrow(
        `not pruning: 2 builds are using the cache ${root} (pid ${pid}, ${pid}); try again when they end`,
      );
      second.release();
      expect(() => takeCache(root, 'clearing')).toThrow(
        `not clearing: a build is using the cache ${root} (pid ${pid}); try again when it ends`,
      );
    } finally {
      first.release();
      second.release();
    }
    takeCache(root, 'pruning').release(); // the refusals left the cache free
  });

  it('a build is refused while a prune or clear holds the cache, and leaves no registration', () => {
    const root = libraryCache([]);
    const held = takeCache(root, 'pruning');
    try {
      expect(() => registerBuild(root)).toThrow(CacheBusyError);
      expect(() => registerBuild(root)).toThrow(/is being pruned or cleared \(pid \d+\)/);
      expect(liveBuilds(root)).toEqual([]);
    } finally {
      held.release();
    }
    registerBuild(root).release();
  });

  it('a second prune is refused while one holds the cache', () => {
    const root = libraryCache([]);
    const held = takeCache(root, 'pruning');
    try {
      expect(() => takeCache(root, 'pruning')).toThrow(
        /another `ffmpeg-build cache` command is changing .* \(pid \d+\); wait for it/,
      );
    } finally {
      held.release();
    }
  });

  it('a prune that died holding the cache does not stop a build or the next prune', () => {
    const root = libraryCache([]);
    mkdirSync(join(root, 'locks'));
    writeFileSync(join(root, 'locks', 'cache.lock'), `${DEAD_PID}\n`);
    registerBuild(root).release();
    takeCache(root, 'pruning').release();
    expect(liveBuilds(root)).toEqual([]);
  });
});

describe('the entries in the cache', () => {
  it('are none without a libs folder', async () => {
    expect(await cacheEntries(mkdtempSync(join(tmpdir(), 'ffmpeg-build-empty-')))).toEqual([]);
  });

  it('are listed with their records, sizes and last use, oldest use first', async () => {
    const root = libraryCache([
      { key: A, name: 'opus', version: '1.6.1' },
      { key: B, name: 'dav1d', version: '1.5.4', ageDays: 3 },
    ]);
    writeFileSync(join(root, 'libs', `${C}.tar.gz.tmp.1.2`), 'half written'); // not an entry yet
    writeFileSync(join(root, 'libs', 'README'), 'not an entry');
    const entries = await cacheEntries(root);
    expect(entries.map((e) => [e.key, e.record?.name, e.record?.version])).toEqual([
      [B, 'dav1d', '1.5.4'],
      [A, 'opus', '1.6.1'],
    ]);
    const dav1d = join(root, 'libs', `${B}.tar.gz`);
    expect(entries[0]).toEqual({
      key: B,
      path: dav1d,
      bytes: statSync(dav1d).size,
      usedMs: statSync(dav1d).mtimeMs,
      record: {
        name: 'dav1d',
        version: '1.5.4',
        origin: 'https://example.com/dav1d/dav1d-1.5.4.tar.xz',
        file: 'dav1d/dav1d-1.5.4.tar.xz',
        sha256: sha('source of dav1d'),
      },
    });
    expect(entries[0]!.usedMs).toBeLessThan(Date.now() - 2 * DAY);
  });

  it('say why one has no record: none in it, not an archive, or one a build would not trust', async () => {
    const root = libraryCache([{ key: A, name: 'srt', version: '1.5.8', record: false }]);
    writeFileSync(join(root, 'libs', `${B}.tar.gz`), 'not an archive');
    const zlib = {
      name: 'zlib',
      version: '1.3',
      origin: 'https://zlib.net/zlib-1.3.tar.gz',
      file: 'zlib/zlib-1.3.tar.gz',
      sha256: sha('zlib'),
    };
    writeEntry(root, C, 'zlib', { ...zlib, file: '../../elsewhere/zlib-1.3.tar.gz' });
    writeEntry(root, D, 'zlib', { ...zlib, name: 'x264' });
    const why = Object.fromEntries((await cacheEntries(root)).map((e) => [e.key, e.unreadable]));
    expect(why).toEqual({
      [A]: 'no source record',
      [B]: expect.stringMatching(/^unreadable \(.+\)$/) as unknown,
      [C]: "a source record that isn't valid",
      [D]: "a source record that isn't valid",
    });
  });
});

describe('verifying an entry against its kept source', () => {
  it('finds nothing wrong when the kept source matches the sha256 its record names', async () => {
    const root = libraryCache([{ key: A, name: 'dav1d', version: '1.5.4' }]);
    expect(await entryProblem(root, await entry(root, A))).toBeUndefined();
  });

  it('reports a kept source that changed, or is gone', async () => {
    const root = libraryCache([
      { key: A, name: 'dav1d', version: '1.5.4' },
      { key: B, name: 'opus', version: '1.6.1' },
    ]);
    writeFileSync(join(root, 'sources', 'dav1d', 'dav1d-1.5.4.tar.xz'), 'something else');
    rmSync(join(root, 'sources', 'opus', 'opus-1.6.1.tar.xz'));
    expect(await entryProblem(root, await entry(root, A))).toBe(
      "its kept source dav1d/dav1d-1.5.4.tar.xz doesn't match its sha256",
    );
    expect(await entryProblem(root, await entry(root, B))).toBe(
      'its kept source opus/opus-1.6.1.tar.xz is gone',
    );
  });

  it('reports an entry without a usable record by why it has none', async () => {
    const root = libraryCache([{ key: A, name: 'srt', version: '1.5.8', record: false }]);
    writeFileSync(join(root, 'libs', `${B}.tar.gz`), 'not an archive');
    expect(await entryProblem(root, await entry(root, A))).toBe('no source record');
    expect(await entryProblem(root, await entry(root, B))).toMatch(/^unreadable/);
    const bare = { key: C, path: join(root, 'libs', `${C}.tar.gz`), bytes: 0, usedMs: 0 };
    expect(await entryProblem(root, bare)).toBe('no source record');
  });

  it('reports a record that names no kept source', async () => {
    const root = libraryCache([{ key: A, name: 'dav1d', version: '1.5.4' }]);
    const e = await entry(root, A);
    expect(await entryProblem(root, { ...e, record: { ...e.record!, file: '' } })).toBe(
      'its record names no kept source',
    );
  });
});

describe('marking what a build used', () => {
  it('marks the entries it took or wrote as used now, and skips those not cached', () => {
    const root = libraryCache([
      { key: A, name: 'dav1d', version: '1.5.4', ageDays: 40 },
      { key: B, name: 'opus', version: '1.6.1', ageDays: 40 },
    ]);
    touchEntries(root, [A, C]);
    expect(usedRecently(join(root, 'libs', `${A}.tar.gz`))).toBe(true);
    expect(usedRecently(join(root, 'libs', `${B}.tar.gz`))).toBe(false);
  });

  it('marks the kept sources its sources record lists, FFmpeg’s among them', () => {
    const root = libraryCache([
      { key: A, name: 'dav1d', version: '1.5.4', ageDays: 40 },
      { key: B, name: 'opus', version: '1.6.1', ageDays: 40 },
    ]);
    mkdirSync(join(root, 'sources', 'ffmpeg'));
    const ffmpeg = join(root, 'sources', 'ffmpeg', 'ffmpeg-9.1.0.tar.xz');
    writeFileSync(ffmpeg, 'ffmpeg');
    age(ffmpeg, 40);
    const record = join(mkdtempSync(join(tmpdir(), 'ffmpeg-build-out-')), 'x.sources.json');
    writeFileSync(
      record,
      JSON.stringify({
        ffmpeg: { file: 'ffmpeg/ffmpeg-9.1.0.tar.xz' },
        // a library built without keeping its source here, and one with no file at all
        libraries: [{ file: 'dav1d/dav1d-1.5.4.tar.xz' }, { file: 'srt/srt-1.5.8.tar.xz' }, {}],
      }),
    );
    touchKeptSources(root, record);
    expect(usedRecently(ffmpeg)).toBe(true);
    expect(usedRecently(join(root, 'sources', 'dav1d', 'dav1d-1.5.4.tar.xz'))).toBe(true);
    expect(usedRecently(join(root, 'sources', 'opus', 'opus-1.6.1.tar.xz'))).toBe(false);
  });

  it('marks nothing for a build that wrote no sources record', () => {
    const root = libraryCache([{ key: A, name: 'dav1d', version: '1.5.4', ageDays: 40 }]);
    touchKeptSources(root, join(root, 'no-such.sources.json'));
    expect(usedRecently(join(root, 'sources', 'dav1d', 'dav1d-1.5.4.tar.xz'))).toBe(false);
  });
});

describe('pruning the cache', () => {
  it('removes entries and kept sources not used for the days given, and every temporary file', async () => {
    const root = libraryCache([
      { key: A, name: 'dav1d', version: '1.5.4', ageDays: 40 },
      { key: B, name: 'opus', version: '1.6.1', ageDays: 2 },
    ]);
    const temp = join(root, 'sources', 'opus', 'opus-1.7.tar.xz.tmp.abc');
    writeFileSync(temp, 'half kept'); // young, but no build runs while the cache is pruned
    const old = await entry(root, A);
    const oldSource = statSync(join(root, 'sources', 'dav1d', 'dav1d-1.5.4.tar.xz')).size;
    const r = await pruneCache(root, 30);
    expect(r.entries.map((e) => e.key)).toEqual([A]);
    expect(r.sources).toEqual(['dav1d/dav1d-1.5.4.tar.xz']);
    expect(r.temps).toEqual([temp]);
    expect(r.bytes).toBe(old.bytes + oldSource);
    expect(readdirSync(join(root, 'libs'))).toEqual([`${B}.tar.gz`]);
    expect(readdirSync(join(root, 'sources', 'opus'))).toEqual(['opus-1.6.1.tar.xz']);
  });

  it('keeps an old kept source an entry it keeps records, and a recent one nothing records', async () => {
    const root = libraryCache([{ key: A, name: 'dav1d', version: '1.5.4', ageDays: 1 }]);
    const recorded = join(root, 'sources', 'dav1d', 'dav1d-1.5.4.tar.xz');
    age(recorded, 40); // kept long ago, its entry used since
    const ffmpeg = join(root, 'sources', 'ffmpeg', 'ffmpeg-9.1.0.tar.xz');
    mkdirSync(join(root, 'sources', 'ffmpeg'));
    writeFileSync(ffmpeg, 'ffmpeg'); // FFmpeg's source: no entry records it
    const r = await pruneCache(root, 30);
    expect(r).toEqual({ entries: [], sources: [], temps: [], bytes: 0 });
    expect(existsSync(recorded)).toBe(true);
    expect(existsSync(ffmpeg)).toBe(true);
  });

  it('with 0 days removes everything', async () => {
    const root = libraryCache([{ key: A, name: 'dav1d', version: '1.5.4', ageDays: 1 }]);
    const r = await pruneCache(root, 0);
    expect(r.entries.map((e) => e.key)).toEqual([A]);
    expect(r.sources).toEqual(['dav1d/dav1d-1.5.4.tar.xz']);
  });
});

describe('clearing the cache', () => {
  it('empties libs/ and sources/ and leaves the locks', () => {
    const root = libraryCache([
      { key: A, name: 'dav1d', version: '1.5.4' },
      { key: B, name: 'opus', version: '1.6.1' },
    ]);
    const held = takeCache(root, 'clearing');
    try {
      clearCache(root);
      expect(readdirSync(join(root, 'libs'))).toEqual([]);
      expect(readdirSync(join(root, 'sources'))).toEqual([]);
      expect(readdirSync(join(root, 'locks'))).toEqual(['cache.lock']);
    } finally {
      held.release();
    }
  });

  it('does nothing to a cache that has neither', () => {
    const root = mkdtempSync(join(tmpdir(), 'ffmpeg-build-empty-'));
    clearCache(root);
    expect(readdirSync(root)).toEqual([]);
  });
});
