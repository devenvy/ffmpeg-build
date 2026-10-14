// --target lists and --platform patterns on the commands that work on targets: one ffmpeg-build.yml, a subset per run.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { fixtureEngineRoot, runCli } from './helpers.ts';

const env = {
  FFMPEG_BUILD_DATA: fixtureEngineRoot,
  FFMPEG_BUILD_DOCKER: 'ffmpeg-build-no-such-docker',
};
const FOLDER = [
  'targets:',
  '  lin-lgplv3: { platform: linux-x64, license: lgplv3, ffmpeg: 9, with: [dav1d] }',
  '  lin-gplv3:  { platform: linux-x64, license: gplv3, ffmpeg: 9, with: [dav1d, x265] }',
  '  win-lgplv3: { platform: win-x64, license: lgplv3, ffmpeg: 9, with: [dav1d] }',
  '',
].join('\n');
const LOCK = 'engine: 0.3.0\nffmpeg: { "9": 9.1.0 }\nlibraries:\n  dav1d: 1.5.4\n  x265: 4.1\n';

function dir(): string {
  const d = mkdtempSync(join(tmpdir(), 'ffmpeg-build-select-cli-'));
  writeFileSync(join(d, 'ffmpeg-build.yml'), FOLDER);
  writeFileSync(join(d, 'ffmpeg.lock'), LOCK);
  return d;
}

describe('--target lists and --platform patterns', () => {
  it('check and plan take only the chosen targets', () => {
    const d = dir();
    const c = runCli(['check', '--platform', 'win-*'], { cwd: d, env });
    expect(c.stdout).toContain('target win-lgplv3');
    expect(c.stdout).not.toContain('target lin-');
    const p = runCli(['plan', '--target', 'lin-gplv3,win-lgplv3', '--json'], { cwd: d, env });
    expect((JSON.parse(p.stdout) as { target: string }[]).map((x) => x.target)).toEqual([
      'lin-gplv3',
      'win-lgplv3',
    ]);
  });

  it('targets lists only the chosen ones', () => {
    const r = runCli(['targets', '--platform', 'linux-*', '--json'], { cwd: dir(), env });
    expect((JSON.parse(r.stdout) as { name: string }[]).map((x) => x.name)).toEqual([
      'lin-lgplv3',
      'lin-gplv3',
    ]);
  });

  it('build builds every chosen target in turn', () => {
    const r = runCli(['build', '--platform', 'linux-*', '--dry-run'], { cwd: dir(), env });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('would build ffmpeg-9.1.0-lin-lgplv3 (linux-x64)');
    expect(r.stdout).toContain('would build ffmpeg-9.1.0-lin-gplv3 (linux-x64)');
  });

  it('build still asks what to build when nothing is chosen', () => {
    const r = runCli(['build', '--dry-run'], { cwd: dir(), env });
    expect(r.exitCode).toBe(2);
    expect(r.stdout).toContain('say what to build: --target <names> or --platform <patterns>');
  });

  it('names a pattern that matches no target', () => {
    const r = runCli(['check', '--platform', 'osx-*'], { cwd: dir(), env });
    expect(r.exitCode).toBe(2);
    expect(r.stdout).toContain('no target matches --platform osx-*');
  });
});
