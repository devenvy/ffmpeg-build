// ffmpeg-build build --in docker|here, and ffmpeg-build.yml's build: section as its default.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { fixtureData, fixtureEngineRoot, runCli } from './helpers.ts';
import { hostEnv } from '../src/build/native.ts';
import { isScript } from '../src/build/run.ts';
import { runTargetBuild } from '../src/commands/build.ts';
import { formatFolderLock } from '../src/lockfile.ts';
import { loadFolder } from '../src/targets.ts';

const data = fixtureData();
const LOCK = { engine: '0.2.0', ffmpeg: { '9': '9.1.0' }, libraries: { dav1d: '1.5.4' } };
const linuxHost = { os: 'linux' as const, arch: 'x64', musl: false };

function folder(build = ''): string {
  const d = mkdtempSync(join(tmpdir(), 'ffmpeg-build-in-'));
  writeFileSync(
    join(d, 'ffmpeg-build.yml'),
    `${build}targets:\n  lin: { platform: linux-x64, license: lgplv3, ffmpeg: 9, with: [dav1d] }\n`,
  );
  writeFileSync(join(d, 'ffmpeg.lock'), formatFolderLock(LOCK));
  return d;
}
const open = (d: string) => {
  const r = loadFolder(d);
  if (!r.ok) {
    throw new Error(r.errors.join('\n'));
  }
  return r.folder;
};
const dry = async (d: string, extra: { in?: 'docker' | 'here'; host?: typeof linuxHost }) =>
  runTargetBuild(open(d), 'lin', data, { out: join(d, 'dist'), dryRun: true, ...extra });

describe('build --in', () => {
  it('builds in Docker unless told otherwise', async () => {
    expect((await dry(folder(), { host: linuxHost })).output).toBe(
      'would build ffmpeg-9.1.0-lin (linux-x64) in ffmpeg-build-linux-x64',
    );
  });

  it('--in here builds natively on a machine that builds the platform', async () => {
    expect((await dry(folder(), { in: 'here', host: linuxHost })).output).toBe(
      'would build ffmpeg-9.1.0-lin (linux-x64) natively on this machine',
    );
  });

  it("takes the build: section's way as the default, and --in over it", async () => {
    const d = folder('build:\n  linux-x64: { in: here }\n');
    expect((await dry(d, { host: linuxHost })).output).toContain('natively on this machine');
    expect((await dry(d, { in: 'docker', host: linuxHost })).output).toContain(
      'in ffmpeg-build-linux-x64',
    );
  });

  it("says why this machine can't build it natively", async () => {
    await expect(
      dry(folder(), { in: 'here', host: { os: 'linux', arch: 'arm64', musl: false } }),
    ).rejects.toMatchObject({
      message:
        'linux-x64 builds natively only on a linux-x64 (glibc) machine; this machine is Linux arm64 (use --in docker)',
      exitCode: 2,
    });
  });

  it('refuses a way that is neither', () => {
    const r = runCli(['build', '--target', 'lin', '--in', 'vm', '--dry-run'], {
      cwd: folder(),
      env: { FFMPEG_BUILD_DATA: fixtureEngineRoot },
    });
    expect(r.exitCode).toBe(2);
    expect(r.stdout).toContain('--in takes docker or here, not vm');
  });
});

describe('a native build on Windows', () => {
  it('keeps what Windows programs need and the MSYS2 environment, and PATH as it is', () => {
    const env = hostEnv(
      {
        Path: 'C:\\msys64\\mingw64\\bin;C:\\Windows',
        SystemRoot: 'C:\\Windows',
        MSYSTEM: 'MINGW64',
        CC: 'cl',
        TEMP: 'C:\\t',
      },
      'win32',
    );
    expect(env).toEqual({
      Path: 'C:\\msys64\\mingw64\\bin;C:\\Windows',
      SystemRoot: 'C:\\Windows',
      MSYSTEM: 'MINGW64',
      TEMP: 'C:\\t',
    });
  });

  it('starts scripts through bash: configure, autogen.sh, the autotools', () => {
    for (const s of [
      './configure',
      'D:/src/x264/configure',
      './autogen.sh',
      'autoreconf',
      'libtoolize',
    ]) {
      expect(isScript(s), s).toBe(true);
    }
    for (const c of ['cmake', 'meson', 'gcc', 'ninja']) {
      expect(isScript(c), c).toBe(false);
    }
  });

  it('on a Mac, puts Homebrew first; on Linux, leaves PATH alone', () => {
    expect(hostEnv({ PATH: '/usr/bin' }, 'darwin')['PATH']).toBe('/opt/homebrew/bin:/usr/bin');
    expect(hostEnv({ PATH: '/usr/bin', CC: 'clang' }, 'linux')).toEqual({ PATH: '/usr/bin' });
  });
});
