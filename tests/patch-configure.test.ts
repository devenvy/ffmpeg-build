// A patch set's about.yml `configure:` flags reach FFmpeg's configure line for every target that uses the set (a patch
// that adds a muxer usually needs its --enable-...), after the target's own flags.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { fixtureData } from './helpers.ts';
import { makeBuildPlan, plannedPatches } from '../src/build/plan.ts';
import { planProfile } from '../src/resolve.ts';
import { parseFolderText, targetProfile } from '../src/targets.ts';

import type { LockedProfile } from '../src/lockfile.ts';

const data = fixtureData();

function folder(configure: string): { dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'ffmpeg-build-patch-cfg-'));
  mkdirSync(join(dir, 'patches', 'acme', '9'), { recursive: true });
  writeFileSync(
    join(dir, 'patches', 'acme', 'about.yml'),
    `name: acme\nlicense: proprietary\nlicense-files: [LICENSE]\nffmpeg: 9\n${configure}`,
  );
  writeFileSync(join(dir, 'patches', 'acme', 'LICENSE'), 'all rights reserved\n');
  writeFileSync(
    join(dir, 'patches', 'acme', '9', '0001-acme.patch'),
    '--- /dev/null\n+++ b/A\n@@ -0,0 +1 @@\n+a\n',
  );
  return { dir };
}

function plan(dir: string) {
  const r = parseFolderText(
    'targets:\n  t: { platform: linux-x64, license: nonfree, ffmpeg: 9, with: [dav1d], patches: [patches/acme] }\n',
    dir,
  );
  if (!r.ok) {
    throw new Error(r.errors.join('\n'));
  }
  const t = r.folder.targets[0]!;
  const profile = targetProfile(r.folder, t);
  const locked: LockedProfile = {
    ffmpeg: { '9': '9.1.0' },
    libraries: { dav1d: '1.5.4' },
    pinned: [],
  };
  const cell = planProfile(profile, data, { '9': '9.1.0' }).cells[0]!;
  return {
    profile,
    built: makeBuildPlan({
      profile,
      data,
      locked,
      cell,
      variant: 't',
      imageId: 'x',
      cacheDir: tmpdir(),
    }),
  };
}

describe("a patch set's configure flags", () => {
  it("go on FFmpeg's configure line, after the target's own", () => {
    const { dir } = folder('configure: [--enable-muxer=acme, --enable-demuxer=acme]\n');
    const { profile, built } = plan(dir);
    expect(plannedPatches(profile, '9')[0]!.configure).toEqual([
      '--enable-muxer=acme',
      '--enable-demuxer=acme',
    ]);
    expect(built.ffmpeg!.configure.slice(-2)).toEqual([
      '--enable-muxer=acme',
      '--enable-demuxer=acme',
    ]);
    expect(built.ffmpeg!.configure).toContain('--enable-libdav1d');
  });

  it('add nothing when the set names none', () => {
    const { dir } = folder('');
    const { built } = plan(dir);
    expect(built.ffmpeg!.configure.some((f) => f.includes('acme'))).toBe(false);
  });
});
