// Exit codes and error output, as docs/getting-started.md promises them: 0 fine; 1 a target or build problem; 2 usage, data, network
// or tool. Errors and warnings go to stderr, results to stdout; with --json, a failure is {"error": ...}.
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { type FakeGitHub, fakeGitHub, tarGz } from './github-fake.ts';
import { copyStudioFolder, fixtureEngineRoot } from './helpers.ts';
import { runCliAsync } from './upstream-helpers.ts';
import { formatError } from '../src/cli-errors.ts';
import { formatFolderLock } from '../src/lockfile.ts';

const env = {
  FFMPEG_BUILD_DATA: fixtureEngineRoot,
  FFMPEG_BUILD_DOCKER: 'ffmpeg-build-no-such-docker',
};
const LOCK = {
  engine: '0.2.0',
  ffmpeg: { '9': '9.1.0' },
  libraries: {
    dav1d: '1.5.4',
    libdrm: '2.4.134',
    libva: '2.24.1',
    mbedtls: '3.6.5',
    'nv-codec': '13.0.19.1',
    opus: '1.6.1',
    srt: '1.5.8',
  },
};

function studio(lock: object | null = LOCK): string {
  const dir = mkdtempSync(join(tmpdir(), 'ffmpeg-build-errors-'));
  copyStudioFolder(dir);
  if (lock) {
    writeFileSync(join(dir, 'ffmpeg.lock'), formatFolderLock(lock as typeof LOCK));
  }
  return dir;
}
const empty = () => mkdtempSync(join(tmpdir(), 'ffmpeg-build-errors-empty-'));

describe('exit codes', () => {
  it('a missing ffmpeg.lock is 2 for build, as for releases', async () => {
    const build = await runCliAsync(['build', '--target', 'linux-x64'], { cwd: studio(null), env });
    expect(build.exitCode).toBe(2);
    expect(build.err).toContain('ffmpeg.lock has no FFmpeg 9 yet; run ffmpeg-build lock first');
    const releases = await runCliAsync(['releases', '--offline'], { cwd: studio(null), env });
    expect(releases.exitCode).toBe(2);
  });

  it('a lock that no longer matches the targets is 2, for build and check alike', async () => {
    const stale = { ...LOCK, libraries: { ...LOCK.libraries, dav1d: '1.4.0' } };
    const dir = studio(stale);
    writeFileSync(
      join(dir, 'ffmpeg-build.yml'),
      readFileSync(join(dir, 'ffmpeg-build.yml'), 'utf8').replace(
        /^pin:/m,
        'pin:\n  dav1d: "~1.5.4"',
      ),
    );
    const build = await runCliAsync(['build', '--target', 'linux-x64'], { cwd: dir, env });
    expect(build.exitCode).toBe(2);
    expect(build.err).toContain("ffmpeg.lock doesn't match the targets; run ffmpeg-build lock");
    const check = await runCliAsync(['check'], { cwd: dir, env });
    expect(check.exitCode).toBe(2);
    expect(check.stdout).toContain("ffmpeg.lock doesn't match the targets");
  });

  it('Docker missing is 2, said on stderr', async () => {
    const r = await runCliAsync(['build', '--target', 'linux-x64'], { cwd: studio(), env });
    expect(r.exitCode).toBe(2);
    expect(r.err).toContain('ffmpeg-build needs Docker to build linux-x64');
    expect(r.out).toBe('');
  });
});

describe('fetch', () => {
  let gh: FakeGitHub;
  beforeEach(async () => {
    gh = await fakeGitHub();
  });
  afterEach(async () => gh.close());

  it('a release without manifest.yml (not one ffmpeg-build published) is 2', async () => {
    gh.releases.push({
      tag: '9.0.2.3',
      files: { 'ffmpeg-9.0.2-t.tar.gz': tarGz([{ name: 'x', data: 'x' }]) },
    });
    const r = await runCliAsync(['fetch', 'o/r@9.0.2.3', '--target', 't'], {
      cwd: empty(),
      env: gh.env,
    });
    expect(r.exitCode).toBe(2);
    expect(r.err).toContain('o/r@9.0.2.3 has no asset manifest.yml');
  });
});

describe('unexpected errors', () => {
  it('bundle --previous with a file that is not there: one line on stderr, exit 2, no stack', async () => {
    const r = await runCliAsync(['bundle', '--release', '9.1.0.0', '--previous', 'missing.yml'], {
      cwd: studio(),
      env,
    });
    expect(r.exitCode).toBe(2);
    expect(r.err.trim().split('\n')).toHaveLength(1);
    expect(r.err).toContain('missing.yml');
    expect(r.err).not.toMatch(/\n\s+at /);
  });

  it('are one line, or the stack with FFMPEG_BUILD_DEBUG=1', () => {
    const e = new TypeError("Cannot read properties of undefined (reading 'x')");
    expect(formatError(e, { json: false, debug: false })).toBe(
      "ffmpeg-build: Cannot read properties of undefined (reading 'x') (FFMPEG_BUILD_DEBUG=1 shows where)",
    );
    expect(formatError(e, { json: false, debug: true })).toContain('    at ');
    expect(JSON.parse(formatError(e, { json: true, debug: false }))).toEqual({
      error: "Cannot read properties of undefined (reading 'x')",
      problems: [],
    });
  });
});

describe('error output', () => {
  it('goes to stderr; stdout stays empty', async () => {
    const r = await runCliAsync(['check'], { cwd: empty(), env });
    expect(r.exitCode).toBe(2);
    expect(r.err).toContain('no ffmpeg-build.yml here');
    expect(r.out).toBe('');
  });

  it('with --json is {"error": ...} on stdout', async () => {
    for (const args of [
      ['check', '--json'],
      ['plan', '--json'],
      ['targets', '--json'],
      ['releases', '--json'],
      ['outdated', '--json'],
      ['profile', 'missing', '--json'],
    ]) {
      const r = await runCliAsync(args, { cwd: empty(), env });
      expect(r.exitCode, args.join(' ')).toBe(2);
      expect(JSON.parse(r.out), args.join(' ')).toEqual({
        error: expect.stringContaining('no ffmpeg-build.yml here'),
        problems: [],
      });
    }
  });

  it('every --json command that exits 1 or 2 prints {"error", "problems"}; a success never has "error"', async () => {
    const dir = studio();
    writeFileSync(
      join(dir, 'ffmpeg-build.yml'),
      `${readFileSync(join(dir, 'ffmpeg-build.yml'), 'utf8')}  broken: { platform: linux-x64, license: gplv3, ffmpeg: 9, with: [frobnicate] }\n`,
    );
    for (const args of [
      ['check', '--json'],
      ['plan', '--json'],
      ['outdated', '--json'],
      ['releases', '--json', '--offline'],
      ['profile', 'missing', '--json'],
    ]) {
      const r = await runCliAsync(args, { cwd: dir, env });
      expect(r.exitCode, args.join(' ')).not.toBe(0);
      const body = JSON.parse(r.out) as { error?: unknown; problems?: unknown };
      expect(Array.isArray(body), args.join(' ')).toBe(false);
      expect(typeof body.error, args.join(' ')).toBe('string');
      expect(Array.isArray(body.problems), args.join(' ')).toBe(true);
    }
    for (const args of [
      ['check', '--json'],
      ['plan', '--json'],
      ['targets', '--json'],
      ['options', '--json'],
    ]) {
      // releases: tests/releases.test.ts
      const r = await runCliAsync(args, { cwd: studio(), env });
      expect(r.exitCode, args.join(' ')).toBe(0);
      expect((JSON.parse(r.out) as { error?: unknown }).error, args.join(' ')).toBeUndefined();
    }
  });

  it('releases --json with a target that fails check is an error with the problems, not a list of releases', async () => {
    const dir = studio();
    writeFileSync(
      join(dir, 'ffmpeg-build.yml'),
      `${readFileSync(join(dir, 'ffmpeg-build.yml'), 'utf8')}  broken: { platform: linux-x64, license: gplv3, ffmpeg: 9, with: [frobnicate] }\n`,
    );
    const r = await runCliAsync(['releases', '--json', '--offline'], { cwd: dir, env });
    expect(r.exitCode).toBe(1);
    const body = JSON.parse(r.out) as { error: string; problems: string[] };
    expect(Array.isArray(body)).toBe(false);
    expect(body.error).toMatch(/check/);
    expect(body.problems.join('\n')).toContain('frobnicate');
  });
});
