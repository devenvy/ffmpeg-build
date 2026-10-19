// A build fetches exactly what ffmpeg.lock pins: a git source's commit is checked after the fetch, and a tarball's
// sha256 before it is unpacked, whichever mirror it came from.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

import { tarGz } from './github-fake.ts';
import { addTag, makeGitRepo } from './upstream-helpers.ts';
import { restoreCache } from '../src/build/cache.ts';
import { fetchSource } from '../src/build/fetch.ts';

const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

function folders() {
  const root = mkdtempSync(join(tmpdir(), 'ffmpeg-build-verify-'));
  for (const d of ['sources', 'work', 'dl']) {
    mkdirSync(join(root, d), { recursive: true });
  }
  return {
    root,
    sources: join(root, 'sources'),
    work: join(root, 'work'),
    dest: join(root, 'src'),
  };
}

/** A tarball served from a file: URL, as curl fetches it. */
function tarball(root: string, file: string, content: string): { url: string; bytes: Buffer } {
  const bytes = tarGz([
    { name: 'lame-4.0', type: 'dir' },
    { name: 'lame-4.0/README', data: content },
  ]);
  writeFileSync(join(root, 'dl', file), bytes);
  return { url: pathToFileURL(join(root, 'dl', file)).href, bytes };
}

describe('a pinned git source', () => {
  it('builds the commit the lock pins', async () => {
    const f = folders();
    const repo = makeGitRepo(['1.5.4']);
    const got = await fetchSource(
      { git: repo.url, ref: '1.5.4', commit: repo.head },
      f.dest,
      'dav1d',
      f.sources,
      f.work,
    );
    expect(got.commit).toBe(repo.head);
  });

  it('stops when the tag now names another commit, naming the library and both commits', async () => {
    const f = folders();
    const repo = makeGitRepo([]);
    execFileSync(
      'git',
      ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'moved'],
      { cwd: repo.dir },
    );
    addTag(repo.dir, '1.5.4'); // the tag is on the new commit; the lock pinned the first
    await expect(
      fetchSource(
        { git: repo.url, ref: '1.5.4', commit: repo.head },
        f.dest,
        'dav1d',
        f.sources,
        f.work,
      ),
    ).rejects.toThrow(
      new RegExp(
        `dav1d: ref 1\\.5\\.4 of ${repo.url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} is commit [0-9a-f]{40}, but ffmpeg\\.lock pins ${repo.head}`,
      ),
    );
  });

  it('says how to accept a tag moved upstream: update keeps the pin of a version it already has', async () => {
    const f = folders();
    const repo = makeGitRepo([]);
    execFileSync(
      'git',
      ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'moved'],
      { cwd: repo.dir },
    );
    addTag(repo.dir, '1.5.4');
    const error = await fetchSource(
      { git: repo.url, ref: '1.5.4', commit: repo.head },
      f.dest,
      'dav1d',
      f.sources,
      f.work,
    ).catch((e: unknown) => e as Error);
    expect((error as Error).message).toContain(
      "if upstream moved it on purpose, delete dav1d's entry in ffmpeg.lock and run ffmpeg-build lock to pin the new commit",
    );
    expect((error as Error).message).not.toContain('ffmpeg-build update');
  });

  it('checks a branch library’s commit too', async () => {
    const f = folders();
    const repo = makeGitRepo([]);
    const got = await fetchSource(
      { git: repo.url, commit: repo.head },
      f.dest,
      'x264',
      f.sources,
      f.work,
    );
    expect(got.commit).toBe(repo.head);
  });
});

describe('a pinned tarball', () => {
  it('is unpacked when its sha256 matches', async () => {
    const f = folders();
    const t = tarball(f.root, 'lame-4.0.tar.gz', 'lame');
    const got = await fetchSource(
      { archives: [t.url], sha256: sha(t.bytes) },
      f.dest,
      'lame',
      f.sources,
      f.work,
    );
    expect(got.kept).toBe('lame/lame-4.0.tar.gz');
    expect(readFileSync(join(f.dest, 'README'), 'utf8')).toBe('lame');
  });

  it('is refused before unpacking when it differs, naming the library, the pin and what came', async () => {
    const f = folders();
    const t = tarball(f.root, 'lame-4.0.tar.gz', 'replaced upstream');
    const pin = 'a'.repeat(64);
    await expect(
      fetchSource({ archives: [t.url], sha256: pin }, f.dest, 'lame', f.sources, f.work),
    ).rejects.toThrow(`lame: ${t.url} has sha256 ${sha(t.bytes)}, but ffmpeg.lock pins ${pin}`);
    // update keeps the pin of a version the lock already has: only a new entry takes the new content
    await expect(
      fetchSource({ archives: [t.url], sha256: pin }, f.dest, 'lame', f.sources, f.work),
    ).rejects.toThrow(
      "if upstream really replaced it, delete lame's entry in ffmpeg.lock and run ffmpeg-build lock to pin the new content",
    );
    expect(existsSync(join(f.dest, 'README'))).toBe(false);
    expect(existsSync(join(f.sources, 'lame', 'lame-4.0.tar.gz'))).toBe(false);
  });

  it('takes a mirror only with the pinned content', async () => {
    const f = folders();
    const good = tarball(f.root, 'lame-4.0.tar.gz', 'lame');
    const bad = tarball(f.root, 'other.tar.gz', 'not lame');
    const got = await fetchSource(
      { archives: [bad.url, good.url], sha256: sha(good.bytes) },
      f.dest,
      'lame',
      f.sources,
      f.work,
    );
    expect(got.origin).toBe(good.url);
  });

  it('uses the copy lock already kept, without downloading again', async () => {
    const f = folders();
    const bytes = tarGz([{ name: 'lame-4.0/README', data: 'kept' }]);
    mkdirSync(join(f.sources, 'lame'), { recursive: true });
    writeFileSync(join(f.sources, 'lame', 'lame-4.0.tar.gz'), bytes);
    const url = pathToFileURL(join(f.root, 'dl', 'missing', 'lame-4.0.tar.gz')).href; // nothing there to download
    const got = await fetchSource(
      { archives: [url], sha256: sha(bytes) },
      f.dest,
      'lame',
      f.sources,
      f.work,
    );
    expect(got).toEqual({ origin: url, kept: 'lame/lame-4.0.tar.gz' });
    expect(readFileSync(join(f.dest, 'README'), 'utf8')).toBe('kept');
  });
});

describe('a cache entry built from other content than the lock pins', () => {
  it('is not used', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ffmpeg-build-verify-'));
    const sources = join(root, 'sources');
    mkdirSync(join(sources, 'dav1d'), { recursive: true });
    writeFileSync(join(sources, 'dav1d', 'dav1d-x.tar.gz'), 'src');
    const entry = join(root, 'entry.tar.gz');
    writeFileSync(entry, tarGz([{ name: 'lib/libdav1d.a', data: 'a' }]));
    const record = {
      name: 'dav1d',
      version: '1.5.4',
      origin: 'https://x/dav1d',
      file: 'dav1d/dav1d-x.tar.gz',
      sha256: sha('src'),
      commit: 'b'.repeat(40),
    };
    const runner = (async (_c: string, args: string[]) =>
      args.includes('-O') ? JSON.stringify(record) : '') as never;
    expect(
      await restoreCache(entry, join(root, 'deps'), sources, 'dav1d', runner, {
        commit: 'c'.repeat(40),
      }),
    ).toBeUndefined();
    writeFileSync(entry, tarGz([{ name: 'lib/libdav1d.a', data: 'a' }]));
    expect(
      await restoreCache(entry, join(root, 'deps'), sources, 'dav1d', runner, {
        commit: 'b'.repeat(40),
      }),
    ).toMatchObject({ commit: 'b'.repeat(40) });
    const tarRecord = { ...record, commit: undefined, file: 'dav1d/dav1d-x.tar.gz' };
    const tarRunner = (async (_c: string, args: string[]) =>
      args.includes('-O') ? JSON.stringify(tarRecord) : '') as never;
    expect(
      await restoreCache(entry, join(root, 'deps'), sources, 'dav1d', tarRunner, {
        sha256: 'd'.repeat(64),
      }),
    ).toBeUndefined();
  });
});
