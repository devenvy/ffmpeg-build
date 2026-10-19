import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { fakeGitHub, type FakeGitHub } from './github-fake.ts';
import { fixtureEngineRoot } from './helpers.ts';
import { runCliAsync } from './upstream-helpers.ts';
import { loadEngineData } from '../src/engine-data.ts';
import { formatFolderLock, type LockPins } from '../src/lockfile.ts';
import { packageRoot, packageVersion } from '../src/paths.ts';
import { planReleases } from '../src/release.ts';
import { loadFolder } from '../src/targets.ts';

const data = loadEngineData(fixtureEngineRoot);
const LOCK = {
  engine: '0.2.0',
  ffmpeg: { '9': '9.1.0' },
  libraries: { dav1d: '1.5.4', opus: '1.6.1', x265: '4.1' },
};
const FOLDER = [
  'targets:',
  '  linux-x64-lgplv3: { platform: linux-x64, license: lgplv3, ffmpeg: 9, with: [dav1d, opus] }',
  '  linux-x64-gplv3:  { platform: linux-x64, license: gplv3, ffmpeg: 9, with: [dav1d, x265] }',
  '  studio:              { platform: linux-x64, license: gplv3, ffmpeg: 9, with: [dav1d], release-group: studio }',
  '',
].join('\n');

function folder(text = FOLDER, lock = LOCK): string {
  const d = mkdtempSync(join(tmpdir(), 'ffmpeg-build-releases-'));
  writeFileSync(join(d, 'ffmpeg-build.yml'), text);
  writeFileSync(join(d, 'ffmpeg.lock'), formatFolderLock(lock));
  return d;
}
const facts = (dir: string, lock: typeof LOCK & { pins?: LockPins } = LOCK) => {
  const r = loadFolder(dir);
  if (!r.ok) {
    throw new Error(r.errors.join('\n'));
  }
  return planReleases(r.folder, data, { ...lock }, packageRoot).releases;
};

let gh: FakeGitHub;
let env: Record<string, string>;
beforeEach(async () => {
  gh = await fakeGitHub();
  env = { ...gh.env, FFMPEG_BUILD_DATA: fixtureEngineRoot, GITHUB_REPOSITORY: 'o/r' };
});
afterEach(async () => gh.close());

const ignore = (): void => undefined;

/** Publishes the release the folder would make now, so nothing in it has changed. */
function publishCurrent(
  dir: string,
  base: string,
  build: number,
  edit: (t: Record<string, unknown>) => void = ignore,
  lock: typeof LOCK & { pins?: LockPins } = LOCK,
) {
  const rel = facts(dir, lock).find((r) => r.base === base)!;
  gh.publish(
    `${base}.${build}`,
    rel.targets.map((t) => {
      const target = {
        name: t.target.name,
        platform: t.target.platform,
        license: t.target.license,
        components: t.facts.components,
        pins: t.facts.pins,
        toolchain: t.facts.toolchain,
        definition: t.facts.definition,
        patches: t.facts.patches,
      };
      edit(target);
      return target;
    }),
    { engine: packageVersion() },
  );
}

describe('ffmpeg-build releases without a repository', () => {
  it('says on stderr that every release counts as new, instead of quietly calling them never released', async () => {
    const none = { ...env, GITHUB_REPOSITORY: '' }; // and the folder is no git checkout: no origin remote
    const r = await runCliAsync(['releases', '--json'], { cwd: folder(), env: none });
    expect(r.exitCode).toBe(0);
    expect(r.err).toContain(
      'note: no GitHub repository found; every release counts as new (--offline to silence this)',
    );
    expect(JSON.parse(r.out)).toHaveLength(2);
    const offline = await runCliAsync(['releases', '--json', '--offline'], {
      cwd: folder(),
      env: none,
    });
    expect(offline.err).toBe('');
  });
});

describe('ffmpeg-build releases', () => {
  it('groups targets by release group and FFmpeg version; a release never made is due, at build 0', async () => {
    const r = await runCliAsync(['releases', '--json'], { cwd: folder(), env });
    expect(r.exitCode).toBe(0);
    const rows = JSON.parse(r.stdout) as {
      tag: string;
      due: boolean;
      reasons: string[];
      targets: { name: string; runner: string; testRunner: string }[];
    }[];
    expect(rows.map((x) => [x.tag, x.due, x.reasons, x.targets.map((t) => t.name)])).toEqual([
      ['9.1.0.0', true, ['never released'], ['linux-x64-lgplv3', 'linux-x64-gplv3']],
      ['studio-9.1.0.0', true, ['never released'], ['studio']],
    ]);
    expect(rows[0]!.targets[0]!.runner).toBe('ubuntu-24.04');
    expect(rows[0]!.targets[0]!.testRunner).toBe('ubuntu-24.04'); // runs on the runner it builds on
    expect((rows[0]!.targets[0] as unknown as { cacheKey: string }).cacheKey).toMatch(
      /^ffmpeg-build-libs-linux-x64-[0-9a-f]{24}$/,
    );
  });

  it('is not due when nothing changed since the last release, and names what did change', async () => {
    const d = folder();
    publishCurrent(d, '9.1.0', 3);
    publishCurrent(d, 'studio-9.1.0', 0);
    const same = JSON.parse(
      (await runCliAsync(['releases', '--json'], { cwd: d, env })).stdout,
    ) as { tag: string; previous: string; due: boolean }[];
    expect(same.map((x) => [x.tag, x.previous, x.due])).toEqual([
      ['9.1.0.4', '9.1.0.3', false],
      ['studio-9.1.0.1', 'studio-9.1.0.0', false],
    ]);
    expect(
      JSON.parse((await runCliAsync(['releases', '--json', '--due'], { cwd: d, env })).stdout),
    ).toEqual([]);
    writeFileSync(
      join(d, 'ffmpeg.lock'),
      formatFolderLock({ ...LOCK, libraries: { ...LOCK.libraries, opus: '1.6.2' } }),
    );
    const r = await runCliAsync(['releases'], { cwd: d, env });
    expect(r.stdout).toContain(
      '9.1.0.4 (last: 9.1.0.3): due, 2 targets\n  linux-x64-lgplv3: opus 1.6.1 -> 1.6.2',
    );
    expect(r.stdout).toContain('studio-9.1.0.1 (last: studio-9.1.0.0): unchanged, 1 target');
  });

  it('is due when a pinned source moved at the same version, and only for the targets built from it', async () => {
    const pinned = {
      ...LOCK,
      pins: {
        ffmpeg: {},
        libraries: { opus: { commit: 'a'.repeat(40) }, x265: { commit: 'c'.repeat(40) } },
      },
    };
    const d = folder(FOLDER, pinned);
    publishCurrent(d, '9.1.0', 3, ignore, pinned);
    const same = JSON.parse(
      (await runCliAsync(['releases', '--json'], { cwd: d, env })).stdout,
    ) as { tag: string; due: boolean }[];
    expect(same.find((x) => x.tag === '9.1.0.4')?.due).toBe(false);
    // upstream moved opus's tag: same version, another commit
    writeFileSync(
      join(d, 'ffmpeg.lock'),
      formatFolderLock({
        ...pinned,
        pins: {
          ...pinned.pins,
          libraries: { ...pinned.pins.libraries, opus: { commit: 'b'.repeat(40) } },
        },
      }),
    );
    const r = await runCliAsync(['releases'], { cwd: d, env });
    expect(r.stdout).toContain(
      '9.1.0.4 (last: 9.1.0.3): due, 2 targets\n  linux-x64-lgplv3: opus pin',
    );
    expect(r.stdout).not.toContain('linux-x64-gplv3: opus'); // that target doesn't build opus
  });

  it('compares pins only with a release that recorded them (one made before pins changes nothing)', async () => {
    const pinned = {
      ...LOCK,
      pins: { ffmpeg: {}, libraries: { opus: { commit: 'a'.repeat(40) } } },
    };
    const d = folder(FOLDER, pinned);
    publishCurrent(
      d,
      '9.1.0',
      3,
      (t) => {
        delete t['pins'];
      },
      pinned,
    );
    const r = JSON.parse((await runCliAsync(['releases', '--json'], { cwd: d, env })).stdout) as {
      tag: string;
      due: boolean;
    }[];
    expect(r.find((x) => x.tag === '9.1.0.4')?.due).toBe(false);
  });

  it("stops when a target would lose something its last release had, unless it's allowed", async () => {
    const d = folder();
    publishCurrent(d, '9.1.0', 0, (t) => {
      if (t['name'] === 'linux-x64-lgplv3') {
        t['components'] = { ...(t['components'] as object), x264: 'abc' };
      }
    });
    const r = await runCliAsync(['releases'], { cwd: d, env });
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain(
      '✗ linux-x64-lgplv3: x264 was in 9.1.0.0 and is gone now; if that is intended, add allow-removal: [x264] to the target',
    );
    writeFileSync(
      join(d, 'ffmpeg-build.yml'),
      FOLDER.replace('with: [dav1d, opus] }', 'with: [dav1d, opus], allow-removal: [x264] }'),
    );
    expect((await runCliAsync(['releases'], { cwd: d, env })).exitCode).toBe(0);
  });

  it('judges a move to a new FFmpeg version against the last release of the same major: nothing disappears unseen', async () => {
    const d = folder();
    // the last release was on FFmpeg 9.0.2, with a library the folder no longer builds; the lock has moved to 9.1.0
    gh.publish(
      '9.0.2.5',
      [
        {
          name: 'linux-x64-lgplv3',
          platform: 'linux-x64',
          components: { dav1d: '1.5.4', opus: '1.6.1', zimg: '3.0' },
        },
      ],
      { engine: packageVersion() },
    );
    const r = await runCliAsync(['releases', '--json'], { cwd: d, env });
    // exit 1 with --json: {"error", "problems"}, the releases beside them
    const body = JSON.parse(r.stdout) as {
      error: string;
      problems: string[];
      releases: { tag: string; previous: string; reasons: string[]; removals: string[] }[];
    };
    expect(body.error).toMatch(/would lose/);
    expect(body.problems).toEqual([
      '9.1.0.0: linux-x64-lgplv3: zimg was in 9.0.2.5 and is gone now; if that is intended, add allow-removal: [zimg] to the target',
    ]);
    const [main] = body.releases;
    expect(main!.tag).toBe('9.1.0.0'); // build numbers count within the FFmpeg version
    expect(main!.previous).toBe('9.0.2.5');
    expect(main!.reasons[0]).toContain('FFmpeg 9.0.2 -> 9.1.0');
    expect(main!.removals).toEqual([
      'linux-x64-lgplv3: zimg was in 9.0.2.5 and is gone now; if that is intended, add allow-removal: [zimg] to the target',
    ]);
    expect(r.exitCode).toBe(1);
  });

  it('refuses, before anything builds, a nonfree target for a public repository and a private one not acknowledged', async () => {
    const nonfree = folder(
      `${FOLDER}  studio-internal: { platform: linux-x64, license: nonfree, ffmpeg: 9, with: [dav1d] }\n`,
    );
    const pub = await runCliAsync(['releases', '--json'], { cwd: nonfree, env });
    expect(pub.exitCode).toBe(1);
    expect(JSON.parse(pub.stdout).error).toContain(
      'studio-internal is nonfree: internal use only, never published to a public repository (o/r is public)',
    );
    gh.private = true;
    const unacknowledged = await runCliAsync(['releases'], { cwd: folder(), env });
    expect(unacknowledged.exitCode).toBe(1);
    expect(unacknowledged.stdout).toContain(
      'o/r is private: its releases, and the source their notices link to, reach only people with access to it',
    );
    expect(
      (
        await runCliAsync(['releases'], {
          cwd: folder(`private-release: internal\n${FOLDER}`),
          env,
        })
      ).exitCode,
    ).toBe(0);
  });

  it('counts a release made before ffmpeg-build (no manifest) for the build number, and treats it as changed', async () => {
    const d = folder();
    gh.releases.push({ tag: '9.1.0.7', files: {} });
    const rows = JSON.parse(
      (await runCliAsync(['releases', '--json'], { cwd: d, env })).stdout,
    ) as { tag: string; reasons: string[] }[];
    expect(rows[0]).toMatchObject({
      tag: '9.1.0.8',
      reasons: ['9.1.0.7 has no manifest.yml (made before ffmpeg-build)'],
    });
  });

  it('--offline asks no one; a folder without a known repository is offline anyway', async () => {
    const d = folder();
    const r = await runCliAsync(['releases', '--offline'], { cwd: d, env });
    expect(r.stdout).toContain('9.1.0.0: due, 2 targets');
    expect(gh.requests).toEqual([]);
    expect(
      (await runCliAsync(['releases'], { cwd: d, env: { ...env, GITHUB_REPOSITORY: '' } })).stdout,
    ).toContain('9.1.0.0: due');
  });

  it('tags an FFmpeg x.y release (no micro) in four parts, as x.y.0: consumers read <a.b.c>.<build>', async () => {
    const lock = { ...LOCK, ffmpeg: { '9': '9.1' } };
    const d = folder(FOLDER, lock);
    const r = loadFolder(d);
    if (!r.ok) {
      throw new Error(r.errors.join('\n'));
    }
    const plans = planReleases(r.folder, data, lock, packageRoot).releases;
    expect(plans.map((p) => [p.base, p.ffmpeg])).toEqual([
      ['9.1.0', '9.1.0'],
      ['studio-9.1.0', '9.1.0'],
    ]);
    // the last release of the line was 9.1.0.2: the next is 9.1.0.3, and nothing changed since
    gh.publish(
      '9.1.0.2',
      plans[0]!.targets.map((t) => ({
        name: t.target.name,
        platform: t.target.platform,
        license: t.target.license,
        components: t.facts.components,
        toolchain: t.facts.toolchain,
        definition: t.facts.definition,
        patches: t.facts.patches,
      })),
      { engine: packageVersion() },
    );
    const out = await runCliAsync(['releases', '--json'], { cwd: d, env });
    const rows = JSON.parse(out.stdout) as { tag: string; previous?: string; due: boolean }[];
    expect(rows.map((x) => [x.tag, x.previous, x.due])).toEqual([
      ['9.1.0.3', '9.1.0.2', false],
      ['studio-9.1.0.0', undefined, true],
    ]);
  });
});

describe('a patch set', () => {
  it('has the same sha256 in the release plan as the build records', async () => {
    const { mkdirSync } = await import('node:fs');
    const { plannedPatches } = await import('../src/build/plan.ts');
    const { targetFacts } = await import('../src/release.ts');
    const { targetProfile } = await import('../src/targets.ts');
    const d = folder(
      'targets:\n  t: { platform: linux-x64, license: nonfree, ffmpeg: 9, with: [dav1d], patches: [patches/acme] }\n',
    );
    mkdirSync(join(d, 'patches', 'acme', '9'), { recursive: true });
    writeFileSync(
      join(d, 'patches', 'acme', 'about.yml'),
      'name: acme\nlicense: proprietary\nlicense-files: [LICENSE]\nffmpeg: 9\n',
    );
    writeFileSync(join(d, 'patches', 'acme', 'LICENSE'), 'all rights reserved\n');
    writeFileSync(
      join(d, 'patches', 'acme', '9', '0001-a.patch'),
      '--- /dev/null\n+++ b/A\n@@ -0,0 +1 @@\n+a\n',
    );
    const r = loadFolder(d);
    if (!r.ok) {
      throw new Error(r.errors.join('\n'));
    }
    const t = r.folder.targets.find((x) => x.name === 't')!;
    const f = targetFacts(r.folder, t, data, LOCK, packageRoot);
    if ('error' in f) {
      throw new Error(f.error);
    }
    expect(plannedPatches(targetProfile(r.folder, t), '9').map((p) => p.sha256)).toEqual(
      f.facts.patches.map((p) => p.sha256),
    );
  });
});

describe('releases for some targets', () => {
  it('lists only the releases with a chosen target, and names the targets left out', async () => {
    const r = await runCliAsync(['releases', '--json', '--target', 'linux-x64-gplv3,studio'], {
      cwd: folder(),
      env,
    });
    expect(r.exitCode).toBe(0);
    const rows = JSON.parse(r.stdout) as {
      tag: string;
      targets: { name: string }[];
      missing: string[];
    }[];
    expect(rows.map((x) => [x.tag, x.targets.map((t) => t.name), x.missing])).toEqual([
      ['9.1.0.0', ['linux-x64-gplv3'], ['linux-x64-lgplv3']],
      ['studio-9.1.0.0', ['studio'], []],
    ]);
  });

  it('with --whole, refuses a release the choice leaves part-built: it would be published without those targets', async () => {
    const r = await runCliAsync(['releases', '--json', '--whole', '--target', 'linux-x64-gplv3'], {
      cwd: folder(),
      env,
    });
    expect(r.exitCode).toBe(1);
    expect(JSON.parse(r.stdout)).toEqual({
      error:
        '9.1.0.0 would be published without linux-x64-lgplv3: build every target of a release together, or give the ones built elsewhere their own release-group:',
      problems: [
        '9.1.0.0 would be published without linux-x64-lgplv3: build every target of a release together, or give the ones built elsewhere their own release-group:',
      ],
    });
    const whole = await runCliAsync(['releases', '--json', '--whole', '--target', 'studio'], {
      cwd: folder(),
      env,
    });
    expect(whole.exitCode).toBe(0);
  });
});
