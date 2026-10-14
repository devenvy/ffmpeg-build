import { spawn } from 'node:child_process';
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { copyStudioFolder, fixtureEngineRoot } from './helpers.ts';
import { runCliAsync } from './upstream-helpers.ts';
import { formatFolderLock } from '../src/lockfile.ts';

const env = {
  FFMPEG_BUILD_DATA: fixtureEngineRoot,
  FFMPEG_BUILD_DOCKER: 'ffmpeg-build-no-such-docker',
};
const lock = {
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

function folder(withLock: boolean, extraTargets = ''): string {
  const dir = mkdtempSync(join(tmpdir(), 'ffmpeg-build-build-'));
  copyStudioFolder(dir);
  if (extraTargets) {
    appendFileSync(join(dir, 'ffmpeg-build.yml'), extraTargets);
  }
  if (withLock) {
    writeFileSync(join(dir, 'ffmpeg.lock'), formatFolderLock(lock));
  }
  return dir;
}

describe('ffmpeg-build build', () => {
  it('builds only the platforms platforms.yml lists', async () => {
    const r = await runCliAsync(['build', '--target', 'linux-arm64'], { cwd: folder(true), env });
    expect(r.exitCode).toBe(2);
    expect(r.stdout).toContain(
      "building for linux-arm64 isn't supported yet (ffmpeg-build builds: linux-x64)",
    );
  });

  it.skipIf(process.platform === 'darwin')('says a macOS platform builds on a Mac', async () => {
    const engine = mkdtempSync(join(tmpdir(), 'ffmpeg-build-engine-mac-'));
    cpSync(fixtureEngineRoot, engine, { recursive: true });
    writeFileSync(
      join(engine, 'platforms.yml'),
      'platforms:\n  linux-x64: { image: linux-x64, setup: linux }\n  osx-arm64: { image: macos, setup: apple }\n',
    );
    const dir = folder(
      true,
      '  mac:\n    platform: osx-arm64\n    license: nonfree\n    ffmpeg: 9\n    with: [dav1d]\n',
    );
    const r = await runCliAsync(['build', '--target', 'mac'], {
      cwd: dir,
      env: { ...env, FFMPEG_BUILD_DATA: engine },
    });
    expect(r.exitCode).toBe(2);
    expect(r.stdout).toContain('osx-arm64 builds only on a Mac, with Xcode');
  });

  it('needs the lock', async () => {
    const r = await runCliAsync(['build', '--target', 'linux-x64'], { cwd: folder(false), env });
    expect(r.exitCode).toBe(2); // a missing lock is a data problem
    expect(r.stdout).toContain('ffmpeg.lock has no FFmpeg 9 yet; run ffmpeg-build lock first');
  });

  it('needs a target, and names the ones there are', async () => {
    const none = await runCliAsync(['build'], { cwd: folder(true), env });
    expect(none.exitCode).toBe(2);
    expect(none.stdout).toContain('say what to build: --target <names> or --platform <patterns>');
    const unknown = await runCliAsync(['build', '--target', 'nope'], { cwd: folder(true), env });
    expect(unknown.exitCode).toBe(2);
    expect(unknown.stdout).toContain(
      'no target nope in ffmpeg-build.yml (targets: linux-x64, linux-arm64)',
    );
  });

  it('stops on a folder-wide problem, naming it', async () => {
    const dir = folder(true);
    writeFileSync(
      join(dir, 'ffmpeg-build.yml'),
      readFileSync(join(dir, 'ffmpeg-build.yml'), 'utf8').replace(
        "  nvenc: '13.0'",
        "  nvenc: '13.0'\n  x265: '4.1'",
      ),
    );
    const r = await runCliAsync(['build', '--target', 'linux-x64'], { cwd: dir, env });
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain('✗ pin x265: no target builds x265; remove the pin');
  });

  it('--only builds just some libraries and what they need, in build order, without FFmpeg', async () => {
    const r = await runCliAsync(
      ['build', '--target', 'linux-x64', '--only', 'srt,libva', '--dry-run'],
      { cwd: folder(true), env },
    );
    expect(r.stdout).toContain(
      'would build libdrm, libva, mbedtls, srt for linux-x64, without FFmpeg',
    );
    const bad = await runCliAsync(
      ['build', '--target', 'linux-x64', '--only', 'x265', '--dry-run'],
      { cwd: folder(true), env },
    );
    expect(bad.exitCode).toBe(2);
    expect(bad.stdout).toContain("this target doesn't build x265");
  });

  it('needs Docker', async () => {
    const r = await runCliAsync(['build', '--target', 'linux-x64'], { cwd: folder(true), env });
    expect(r.exitCode).toBe(2);
    expect(r.stdout).toContain('ffmpeg-build needs Docker to build linux-x64');
    expect(r.stdout).toContain('`ffmpeg-build doctor` says what this machine needs');
  });

  it('says when Docker is installed but not running', async () => {
    const r = await runCliAsync(['build', '--target', 'linux-x64'], {
      cwd: folder(true),
      env: { ...env, FFMPEG_BUILD_DOCKER: process.execPath },
    });
    expect(r.exitCode).toBe(2);
    expect(r.stdout).toContain(
      'Docker is installed but not running; start it (Docker Desktop on Windows/macOS) and try again (`ffmpeg-build doctor` says what this machine needs)',
    );
  });
});

/** A fake docker (tests/fixtures/fake-docker.sh), executable, and the file it records its calls in. */
function fakeDocker(): { docker: string; calls: string } {
  const dir = mkdtempSync(join(tmpdir(), 'ffmpeg-build-fake-docker-'));
  const docker = join(dir, 'docker');
  writeFileSync(
    docker,
    readFileSync(fileURLToPath(new URL('./fixtures/fake-docker.sh', import.meta.url)), 'utf8'),
    { mode: 0o755 },
  );
  return { docker, calls: join(dir, 'calls') };
}

describe.skipIf(process.platform === 'win32')('a build into --out (with a stand-in docker)', () => {
  it('replaces the previous outputs only when it succeeds, and keeps them, with the failed log, when it fails', async () => {
    const dir = folder(true);
    const { docker, calls } = fakeDocker();
    const cache = mkdtempSync(join(tmpdir(), 'ffmpeg-build-cache-'));
    const dry = await runCliAsync(['build', '--target', 'linux-x64', '--dry-run'], {
      cwd: dir,
      env,
    });
    const name = /would build (\S+) /.exec(dry.stdout)![1]!;
    const base = {
      ...env,
      FFMPEG_BUILD_DOCKER: docker,
      FFMPEG_BUILD_CACHE: cache,
      FAKE_DOCKER_CALLS: calls,
      FAKE_DOCKER_NAME: name,
    };
    const first = await runCliAsync(['build', '--target', 'linux-x64'], {
      cwd: dir,
      env: { ...base, FAKE_DOCKER_LABEL: 'first' },
    });
    expect(first.stdout).toContain(`built dist/${name}.tar.gz`);
    expect(first.exitCode).toBe(0);
    const dist = join(dir, 'dist');
    expect(readFileSync(join(dist, `${name}.tar.gz`), 'utf8')).toBe('first');
    expect(readdirSync(dist).filter((f) => f.startsWith('.'))).toEqual([]); // no staging folder or lock left

    const failed = await runCliAsync(['build', '--target', 'linux-x64'], {
      cwd: dir,
      env: { ...base, FAKE_DOCKER_MODE: 'fail' },
    });
    expect(failed.exitCode).toBe(1); // the build ran and failed: a build problem
    expect(failed.stdout).toContain(
      `building ${name} failed: building x265 4.3 failed (see above); the log is dist/${name}.log`,
    );
    expect(readFileSync(join(dist, `${name}.tar.gz`), 'utf8')).toBe('first');
    expect(readFileSync(join(dist, `${name}-dev.tar.gz`), 'utf8')).toBe('first');
    expect(readFileSync(join(dist, `${name}.log`), 'utf8')).toContain(
      'ERROR: building x265 4.3 failed',
    );
    expect(readdirSync(dist).filter((f) => f.startsWith('.'))).toEqual([]);
  });

  it('on SIGTERM, stops the container, waits for it, keeps the previous outputs and frees its locks', async () => {
    const dir = folder(true);
    const { docker, calls } = fakeDocker();
    const cache = mkdtempSync(join(tmpdir(), 'ffmpeg-build-cache-'));
    const dry = await runCliAsync(['build', '--target', 'linux-x64', '--dry-run'], {
      cwd: dir,
      env,
    });
    const name = /would build (\S+) /.exec(dry.stdout)![1]!;
    const base = {
      ...env,
      FFMPEG_BUILD_DOCKER: docker,
      FFMPEG_BUILD_CACHE: cache,
      FAKE_DOCKER_CALLS: calls,
      FAKE_DOCKER_NAME: name,
    };
    expect(
      (
        await runCliAsync(['build', '--target', 'linux-x64'], {
          cwd: dir,
          env: { ...base, FAKE_DOCKER_LABEL: 'first' },
        })
      ).exitCode,
    ).toBe(0);

    const child = spawn(
      process.execPath,
      [fileURLToPath(new URL('../src/cli.ts', import.meta.url)), 'build', '--target', 'linux-x64'],
      { cwd: dir, env: { ...process.env, ...base, FAKE_DOCKER_MODE: 'hang' }, stdio: 'ignore' },
    );
    const exited = new Promise<number | null>((resolve) => {
      child.on('close', (code) => {
        resolve(code);
      });
    });
    for (
      let i = 0;
      i < 200 && !(existsSync(calls) && readFileSync(calls, 'utf8').includes('started'));
      i++
    ) {
      await new Promise((r) => {
        setTimeout(r, 50);
      });
    }
    child.kill('SIGTERM');
    expect(await exited).toBe(143);
    const log = readFileSync(calls, 'utf8');
    expect(log).toContain('got TERM');
    expect(log).toContain('stop --time 10 fakecontainer123');
    expect(log).toContain('rm --force fakecontainer123');
    const dist = join(dir, 'dist');
    expect(readFileSync(join(dist, `${name}.tar.gz`), 'utf8')).toBe('first');
    expect(readdirSync(dist).filter((f) => f.startsWith('.'))).toEqual([]); // staging folder and lock gone
  });
});
