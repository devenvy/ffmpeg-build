// A library cache entry is a .tar.gz anyone with write access to the cache folder could replace. Its source record and
// its members are checked before anything is unpacked or deleted, and a bad entry is only ever deleted itself.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { tarGz } from './github-fake.ts';
import { keptPath, parseSourceRecord, restoreCache } from '../src/build/cache.ts';
import { checkTarMembers, listTarGzMembers, UnsafeArchiveError } from '../src/untar.ts';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const COMMIT = 'a'.repeat(40);

/** A cache folder: sources/ with one kept source, a deps folder, a file outside both, and the cache entry. */
function cacheFolder(
  record: object,
  members: Parameters<typeof tarGz>[0] = [{ name: 'lib/libz.a', data: 'lib' }],
) {
  const root = mkdtempSync(join(tmpdir(), 'ffmpeg-build-cache-safety-'));
  const sources = join(root, 'cache', 'sources');
  mkdirSync(join(sources, 'zlib'), { recursive: true });
  writeFileSync(join(sources, 'zlib', 'zlib-1.3.tar.gz'), 'source');
  mkdirSync(join(root, 'out'), { recursive: true });
  writeFileSync(join(root, 'out', 'x'), 'source'); // same content, so its sha256 matches too
  const deps = join(root, 'deps');
  mkdirSync(deps, { recursive: true });
  const entry = join(root, 'cache', 'libs', 'key.tar.gz');
  mkdirSync(join(root, 'cache', 'libs'), { recursive: true });
  writeFileSync(entry, tarGz(members));
  const json = JSON.stringify(record);
  const calls: string[][] = [];
  // the record is read with tar -O; unpacking is recorded, not run (the members are what is under test)
  const runner = async (_cmd: string, args: string[]) => {
    calls.push(args);
    return args.includes('-O') ? json : '';
  };
  return { root, sources, deps, entry, runner: runner as never, calls };
}

const good = {
  name: 'zlib',
  version: '1.3',
  origin: 'https://zlib.net/zlib-1.3.tar.gz',
  file: 'zlib/zlib-1.3.tar.gz',
  sha256: sha('source'),
};
const unpacked = (calls: string[][]) => calls.some((a) => a.includes('-C'));

describe('a cache entry’s source record', () => {
  it('rebuilds a legacy cache when the recipe requires supplemental inputs', async () => {
    const c = cacheFolder(good);
    expect(
      await restoreCache(
        c.entry,
        c.deps,
        c.sources,
        'zlib',
        c.runner,
        {},
        { supplementalSources: true },
      ),
    ).toBeUndefined();
    expect(unpacked(c.calls)).toBe(false);
  });
  it('is accepted when it names this library, a source inside sources/, a sha256 and (for git) a commit', () => {
    const sources = mkdtempSync(join(tmpdir(), 'ffmpeg-build-records-'));
    expect(parseSourceRecord(good, 'zlib', sources)).toEqual(good);
    expect(parseSourceRecord({ ...good, commit: COMMIT }, 'zlib', sources)).toEqual({
      ...good,
      commit: COMMIT,
    });
  });

  it.each([
    ['another library’s name', { ...good, name: 'x264' }],
    ['a file outside sources/', { ...good, file: '../../out/x' }],
    ['an absolute file', { ...good, file: '/etc/passwd' }],
    ['a Windows drive path', { ...good, file: 'C:/Windows/x' }],
    ['no file', { ...good, file: '' }],
    ['a short sha256', { ...good, sha256: 'abc' }],
    ['an upper-case sha256', { ...good, sha256: sha('source').toUpperCase() }],
    ['a short commit', { ...good, commit: 'abc123' }],
    ['a non-hex commit', { ...good, commit: 'z'.repeat(40) }],
    ['no origin', { ...good, origin: undefined }],
    ['not an object', 'zlib'],
  ])('is refused with %s', (_why, record) => {
    expect(
      parseSourceRecord(record, 'zlib', mkdtempSync(join(tmpdir(), 'ffmpeg-build-records-'))),
    ).toBeUndefined();
  });

  it('a kept source path must stay inside sources/', () => {
    const sources = join(tmpdir(), 'sources');
    expect(keptPath(sources, 'zlib/zlib-1.3.tar.gz')).toBe(
      join(sources, 'zlib', 'zlib-1.3.tar.gz'),
    );
    expect(() => keptPath(sources, '../out/x')).toThrow(/outside the cache's sources/);
    expect(() => keptPath(sources, 'zlib/../../x')).toThrow(/outside the cache's sources/);
  });
});

describe('restoring a poisoned cache entry', () => {
  it('unpacks a good entry', async () => {
    const c = cacheFolder(good, [
      { name: 'lib', type: 'dir' },
      { name: 'lib/libz.so.1', data: 'so' },
      { name: 'lib/libz.so', type: 'symlink', link: 'libz.so.1' },
      { name: 'lib/libz.so.1.3', type: 'symlink', link: './libz.so.1' },
      { name: 'bin/z', type: 'symlink', link: '../lib/libz.so.1' },
    ]);
    expect(await restoreCache(c.entry, c.deps, c.sources, 'zlib', c.runner)).toEqual({
      ...good,
      cached: true,
    });
    expect(unpacked(c.calls)).toBe(true);
  });

  it('never deletes or reads the outside file a record names; only the entry goes', async () => {
    const c = cacheFolder({ ...good, file: '../../out/x', commit: COMMIT });
    expect(await restoreCache(c.entry, c.deps, c.sources, 'zlib', c.runner)).toBeUndefined();
    expect(readFileSync(join(c.root, 'out', 'x'), 'utf8')).toBe('source');
    expect(existsSync(c.entry)).toBe(false);
    expect(unpacked(c.calls)).toBe(false);
  });

  it('refuses a record for another library', async () => {
    const c = cacheFolder({ ...good, name: 'x264' });
    expect(await restoreCache(c.entry, c.deps, c.sources, 'zlib', c.runner)).toBeUndefined();
    expect(existsSync(c.entry)).toBe(false);
  });

  it.each([
    ['a .. in a member’s path', [{ name: '../evil', data: 'x' }]],
    ['a .. deeper in a member’s path', [{ name: 'lib/../../evil', data: 'x' }]],
    ['an absolute member', [{ name: '/tmp/evil', data: 'x' }]],
    [
      'a symlink out of the deps folder',
      [{ name: 'lib/out', type: 'symlink' as const, link: '../../outside' }],
    ],
    ['an absolute symlink', [{ name: 'lib/out', type: 'symlink' as const, link: '/etc' }]],
    [
      'a symlink whose .. passes through a link of the archive',
      [
        { name: 'lib', type: 'dir' as const },
        { name: 'lib/up', type: 'symlink' as const, link: '..' },
        { name: 'bin/z', type: 'symlink' as const, link: '../lib/up/../x' },
      ],
    ],
    [
      'a drive-relative symlink',
      [{ name: 'lib/out', type: 'symlink' as const, link: 'C:outside' }],
    ],
    [
      'a hard link to a path outside',
      [{ name: 'lib/out', type: 'hardlink' as const, link: '../outside' }],
    ],
    [
      'a member written through a symlink of the archive',
      [
        { name: 'lib', type: 'symlink' as const, link: 'sub' },
        { name: 'lib/a', data: 'x' },
      ],
    ],
  ])('refuses %s: the entry is deleted, nothing unpacked', async (_why, members) => {
    const c = cacheFolder(good, members);
    expect(await restoreCache(c.entry, c.deps, c.sources, 'zlib', c.runner)).toBeUndefined();
    expect(unpacked(c.calls)).toBe(false);
    expect(existsSync(c.entry)).toBe(false);
  });
});

describe("a Rust library's cache entry", () => {
  const crate = {
    name: 'libc',
    version: '0.2.172',
    license: 'MIT OR Apache-2.0',
    source: 'crates.io',
    file: 'crates/libc-0.2.172.crate',
    sha256: sha('crate'),
    linked: true,
    texts: ['LICENSE-MIT'],
  };
  const path = {
    name: 'ivf',
    version: '0.1.4',
    license: 'BSD-2-Clause',
    source: 'path',
    linked: true,
    texts: [],
  };
  const rust = { ...good, crates: [crate, path], rust: { version: '1.98.1', texts: ['C.txt'] } };
  const withCrate = (record: object, content = 'crate') => {
    const c = cacheFolder(record);
    mkdirSync(join(c.sources, 'crates'), { recursive: true });
    writeFileSync(join(c.sources, 'crates', 'libc-0.2.172.crate'), content);
    return c;
  };

  it('keeps its crates and standard library in the record', async () => {
    const c = withCrate(rust);
    expect(parseSourceRecord(rust, 'zlib', c.sources)).toEqual(rust);
    expect(
      await restoreCache(c.entry, c.deps, c.sources, 'zlib', c.runner, {}, { crates: true }),
    ).toEqual({
      ...rust,
      cached: true,
    });
  });

  it.each([
    ['a crate file outside sources/', { ...rust, crates: [{ ...crate, file: '../../out/x' }] }],
    ['a crate without a sha256', { ...rust, crates: [{ ...crate, sha256: undefined }] }],
    ['a crate of another kind of source', { ...rust, crates: [{ ...crate, source: 'git' }] }],
  ])('is refused with %s', (_why, record) => {
    expect(
      parseSourceRecord(record, 'zlib', mkdtempSync(join(tmpdir(), 'ffmpeg-build-records-'))),
    ).toBeUndefined();
  });

  it('is built again when a kept crate is gone or differs', async () => {
    const differs = withCrate(rust, 'other');
    expect(
      await restoreCache(differs.entry, differs.deps, differs.sources, 'zlib', differs.runner),
    ).toBeUndefined();
    expect(existsSync(differs.entry)).toBe(false);
    const gone = cacheFolder(rust);
    expect(
      await restoreCache(gone.entry, gone.deps, gone.sources, 'zlib', gone.runner),
    ).toBeUndefined();
  });

  it('is built again when it lists no crates (an older engine made it)', async () => {
    const c = cacheFolder(good);
    expect(
      await restoreCache(c.entry, c.deps, c.sources, 'zlib', c.runner, {}, { crates: true }),
    ).toBeUndefined();
    expect(existsSync(c.entry)).toBe(false);
    expect(unpacked(c.calls)).toBe(false);
  });
});

describe('checking a tar.gz’s members before a system tar unpacks it', () => {
  it('lists members with their link targets, without unpacking', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ffmpeg-build-members-'));
    const long = `include/${'a'.repeat(120)}.h`;
    writeFileSync(
      join(dir, 'x.tar.gz'),
      tarGz([
        { name: 'lib', type: 'dir' },
        { name: long, data: 'h' },
        { name: 'lib/l', type: 'symlink', link: 'r' },
      ]),
    );
    expect(await listTarGzMembers(join(dir, 'x.tar.gz'))).toEqual([
      { name: 'lib', type: 'dir', link: '' },
      { name: long, type: 'file', link: '' },
      { name: 'lib/l', type: 'symlink', link: 'r' },
    ]);
  });

  it('refuses a symlink in a folder that is a link on disk', () => {
    const dest = mkdtempSync(join(tmpdir(), 'ffmpeg-build-members-'));
    // a link the deps folder already has (from another entry) may not be written through
    expect(() =>
      checkTarMembers(
        [{ name: 'a/b', type: 'file', link: '' }],
        dest,
        (p) => p === join(dest, 'a'),
      ),
    ).toThrow(UnsafeArchiveError);
    expect(() =>
      checkTarMembers([{ name: 'a/b', type: 'file', link: '' }], dest, () => false),
    ).not.toThrow();
  });
});
