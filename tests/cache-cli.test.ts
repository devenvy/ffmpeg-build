import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { DAY, libraryCache } from './cache-fixture.ts';
import { runCli } from './helpers.ts';
import {
  CacheBusyError,
  registerBuild,
  takeCache,
  touchEntries,
  touchKeptSources,
} from '../src/cache-admin.ts';

const cli = (root: string, args: string[]) =>
  runCli(['cache', ...args], { cwd: root, env: { FFMPEG_BUILD_CACHE: root } });

describe('ffmpeg-build cache', () => {
  it('path prints the cache folder', () => {
    const root = libraryCache([]);
    const r = cli(root, ['path']);
    expect(r.exitCode).toBe(0);
    expect(r.out.trim()).toBe(root);
  });

  it('list shows each library, its size and age; --json the same as data', () => {
    const root = libraryCache([
      { key: 'a'.repeat(64), name: 'dav1d', version: '1.5.4', ageDays: 3 },
      { key: 'b'.repeat(64), name: 'opus', version: '1.6.1' },
    ]);
    const r = cli(root, ['list']);
    expect(r.exitCode).toBe(0);
    expect(r.out).toMatch(/dav1d 1\.5\.4\s+\S+ (B|KB)\s+3 days/);
    expect(r.out).toMatch(/opus 1\.6\.1\s+\S+ (B|KB)\s+today/);
    const rows = JSON.parse(cli(root, ['list', '--json']).out) as {
      key: string;
      library: string;
      version: string;
      bytes: number;
      ageDays: number;
    }[];
    expect(rows.map((x) => [x.library, x.version, x.ageDays])).toEqual([
      ['dav1d', '1.5.4', 3],
      ['opus', '1.6.1', 0],
    ]);
    expect(rows[0]!.bytes).toBeGreaterThan(0);
  });

  it('verify checks every entry has a record and that its kept source matches its sha256; --fix removes the bad', () => {
    const root = libraryCache([
      { key: 'a'.repeat(64), name: 'dav1d', version: '1.5.4' },
      { key: 'b'.repeat(64), name: 'opus', version: '1.6.1', sourceSha: '0'.repeat(64) },
      { key: 'c'.repeat(64), name: 'srt', version: '1.5.8', record: false },
    ]);
    writeFileSync(join(root, 'libs', `${'d'.repeat(64)}.tar.gz`), 'not an archive');
    const r = cli(root, ['verify']);
    expect(r.exitCode).toBe(1);
    expect(r.out).toContain(
      "opus 1.6.1: its kept source opus/opus-1.6.1.tar.xz doesn't match its sha256",
    );
    expect(r.out).toContain(`${'c'.repeat(12)}: no source record`);
    expect(r.out).toContain(`${'d'.repeat(12)}: unreadable`);
    expect(r.out).toContain('ffmpeg-build cache verify --fix');
    const fixed = cli(root, ['verify', '--fix']);
    expect(fixed.exitCode).toBe(0);
    expect(readdirSync(join(root, 'libs'))).toEqual([`${'a'.repeat(64)}.tar.gz`]);
    expect(cli(root, ['verify']).exitCode).toBe(0);
  });

  it('prune removes entries and sources not used recently, and what crashed runs left', () => {
    const root = libraryCache([
      { key: 'a'.repeat(64), name: 'dav1d', version: '1.5.4', ageDays: 40 },
      { key: 'b'.repeat(64), name: 'opus', version: '1.6.1', ageDays: 2 },
    ]);
    writeFileSync(join(root, 'libs', `${'c'.repeat(64)}.tar.gz.tmp.123.456`), 'half');
    const r = cli(root, ['prune', '--older-than', '30']);
    expect(r.exitCode).toBe(0);
    expect(r.out).toMatch(/removed 1 library entry, 1 source and 1 temporary file/);
    expect(readdirSync(join(root, 'libs'))).toEqual([`${'b'.repeat(64)}.tar.gz`]);
    expect(existsSync(join(root, 'sources', 'dav1d', 'dav1d-1.5.4.tar.xz'))).toBe(false);
    expect(existsSync(join(root, 'sources', 'opus', 'opus-1.6.1.tar.xz'))).toBe(true);
  });

  it('counts what a build used as used now, so prune keeps it', () => {
    const root = libraryCache([
      { key: 'a'.repeat(64), name: 'dav1d', version: '1.5.4', ageDays: 40 },
    ]);
    mkdirSync(join(root, 'sources', 'ffmpeg'));
    writeFileSync(join(root, 'sources', 'ffmpeg', 'ffmpeg-9.1.0.tar.xz'), 'ffmpeg');
    const t = (Date.now() - 40 * DAY) / 1000;
    utimesSync(join(root, 'sources', 'ffmpeg', 'ffmpeg-9.1.0.tar.xz'), t, t);
    const record = join(mkdtempSync(join(tmpdir(), 'ffmpeg-build-out-')), 'x.sources.json');
    writeFileSync(
      record,
      JSON.stringify({
        ffmpeg: { file: 'ffmpeg/ffmpeg-9.1.0.tar.xz' },
        libraries: [{ file: 'dav1d/dav1d-1.5.4.tar.xz' }],
      }),
    );
    touchEntries(root, ['a'.repeat(64)]);
    touchKeptSources(root, record);
    expect(cli(root, ['prune', '--older-than', '30']).out).toMatch(
      /removed 0 library entries, 0 sources/,
    );
  });

  it('clear empties it', () => {
    const root = libraryCache([{ key: 'a'.repeat(64), name: 'dav1d', version: '1.5.4' }]);
    expect(cli(root, ['clear']).exitCode).toBe(0);
    expect(readdirSync(join(root, 'libs'))).toEqual([]);
    expect(readdirSync(join(root, 'sources'))).toEqual([]);
  });

  it('never deletes under a running build; a build never starts under a prune', () => {
    const root = libraryCache([
      { key: 'a'.repeat(64), name: 'dav1d', version: '1.5.4', ageDays: 40 },
    ]);
    const build = registerBuild(root); // this test process is the running build
    try {
      for (const args of [['prune'], ['clear'], ['verify', '--fix']]) {
        const r = cli(root, args);
        expect(r.exitCode, args.join(' ')).toBe(2);
        expect(r.err).toMatch(/a build is using the cache .* \(pid \d+\)/);
      }
      expect(cli(root, ['list']).exitCode).toBe(0); // reading is fine
      expect(readdirSync(join(root, 'libs'))).toHaveLength(1);
    } finally {
      build.release();
    }
    const held = takeCache(root, 'pruning');
    try {
      expect(() => registerBuild(root)).toThrow(CacheBusyError);
    } finally {
      held.release();
    }
    registerBuild(root).release();
  });
});
