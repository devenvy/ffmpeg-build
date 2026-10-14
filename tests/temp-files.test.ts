import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { saveCache } from '../src/build/cache.ts';
import { keepGitSource } from '../src/build/fetch.ts';
import { cleanTemps } from '../src/cache-admin.ts';

const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));
const git = (cwd: string, ...args: string[]) =>
  execFileSync(
    'git',
    ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args],
    { cwd, stdio: 'ignore' },
  );

describe('temporary files', () => {
  it('saveCache leaves neither its file list nor its half-written entry when tar fails', async () => {
    const work = tmp('ffmpeg-build-work-');
    const deps = tmp('ffmpeg-build-deps-');
    const libs = join(tmp('ffmpeg-build-cache-'), 'libs');
    await expect(
      saveCache(join(libs, 'x-key.tar.gz'), deps, ['no/such/file'], work),
    ).rejects.toThrow(/^tar exited /);
    expect(readdirSync(work)).toEqual([]);
    expect(readdirSync(libs)).toEqual([]);
  });

  it('keepGitSource leaves no archive behind when archiving fails', async () => {
    const src = tmp('ffmpeg-build-src-');
    git(src, 'init', '-q');
    writeFileSync(join(src, 'a.c'), 'int a;');
    git(src, 'add', '.');
    git(src, 'commit', '-q', '-m', 'a');
    mkdirSync(join(src, 'sub'));
    writeFileSync(join(src, 'sub', '.git'), 'gitdir: /no/such/place\n'); // a broken nested repository
    const work = tmp('ffmpeg-build-work-');
    const sources = tmp('ffmpeg-build-sources-');
    await expect(keepGitSource(src, 'x', sources, work)).rejects.toThrow(/^git exited /);
    expect(readdirSync(work)).toEqual([]);
    expect(readdirSync(join(sources, 'x'))).toEqual([]);
  });

  it('cleanTemps clears what crashed runs left in the cache: all of it, or only the old when another build runs', () => {
    const root = tmp('ffmpeg-build-cache-');
    mkdirSync(join(root, 'libs'));
    mkdirSync(join(root, 'sources', 'x264'), { recursive: true });
    const old = join(root, 'libs', 'a-key.tar.gz.tmp.123.456');
    const young = join(root, 'libs', 'b-key.tar.gz.tmp.789.12');
    const keptDir = join(root, 'sources', 'x264', 'x264-abc.tar.gz.tmp.AbC123');
    writeFileSync(old, 'x');
    writeFileSync(young, 'x');
    mkdirSync(keptDir);
    writeFileSync(join(root, 'libs', 'c-key.tar.gz'), 'a real entry');
    const dayAgo = (Date.now() - 2 * 24 * 3600_000) / 1000;
    utimesSync(old, dayAgo, dayAgo);
    expect(cleanTemps(root, { all: false })).toEqual([old]);
    expect(cleanTemps(root, { all: true }).sort()).toEqual([keptDir, young].sort());
    expect(readdirSync(join(root, 'libs'))).toEqual(['c-key.tar.gz']);
  });
});
