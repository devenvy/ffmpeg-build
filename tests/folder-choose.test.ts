import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { fixtureData, fixtureEngineRoot, writeEngine } from './helpers.ts';
import { loadEngineData } from '../src/engine-data.ts';
import { chooseFolder, folderLockMatches } from '../src/folder-choose.ts';
import { packageRoot } from '../src/paths.ts';
import { type Folder, loadFolder } from '../src/targets.ts';

import type { Upstreams } from '../src/choose.ts';
import type { Found } from '../src/upstream.ts';

const data = fixtureData();
const upstreams = (
  ffmpeg: string[] | undefined,
  libraries: Record<string, string[] | string>,
): Upstreams => ({
  ...(ffmpeg ? { ffmpeg } : {}),
  libraries: new Map(
    Object.entries(libraries).map(([k, v]): [string, Found] => [
      k,
      typeof v === 'string' ? { commit: v } : { versions: v },
    ]),
  ),
});
const up = upstreams(['8.1.3', '9.0.2', '9.0.3', '9.1.0'], {
  dav1d: ['1.4.1', '1.5.3', '1.5.4'],
  opus: ['1.5.2', '1.6.1'],
  libdrm: ['2.4.134'],
  libva: ['2.24.1'],
  'nv-codec': ['13.0.19.1', '13.1.15.0'],
});

function folder(text: string): Folder {
  const dir = mkdtempSync(join(tmpdir(), 'ffmpeg-build-folder-'));
  writeFileSync(join(dir, 'ffmpeg-build.yml'), text);
  const r = loadFolder(dir);
  if (!r.ok) {
    throw new Error(r.errors.join('\n'));
  }
  return r.folder;
}
const two = (extra = '', pins = '') =>
  folder(
    [
      'bases:',
      '  common: { with: [dav1d, opus] }',
      ...(pins ? [pins] : []),
      'targets:',
      `  a: { platform: linux-x64, license: gplv3, ffmpeg: 9, base: [common], with: [vaapi]${extra} }`,
      '  b: { platform: win-x64, license: gplv3, ffmpeg: 9, base: [common] }',
      '',
    ].join('\n'),
  );

describe('one version per library for the whole folder', () => {
  it('locks each library once, whichever targets use it, and each FFmpeg series once', () => {
    const c = chooseFolder(two(), data, undefined, up, 'update');
    expect(c.errors).toEqual([]);
    expect(c.lock).toEqual({
      ffmpeg: { '9': '9.1.0' },
      libraries: { dav1d: '1.5.4', libdrm: '2.4.134', libva: '2.24.1', opus: '1.6.1' },
    });
    expect(c.rows.find((r) => r.what === 'libva')!.targets).toEqual(['a']); // not every target uses it
    expect(c.rows.find((r) => r.what === 'dav1d')!.targets).toBeUndefined(); // every target does
  });

  it('meets a folder pin and a target pin together', () => {
    const c = chooseFolder(
      two(', pin: { dav1d: "1.5" }', 'pin:\n  dav1d: "<1.5.4"'),
      data,
      undefined,
      up,
      'update',
    );
    expect(c.errors).toEqual([]);
    expect(c.lock.libraries['dav1d']).toBe('1.5.3');
  });

  it('names both pins when no version meets them', () => {
    const c = chooseFolder(
      two(', pin: { dav1d: "1.4" }', 'pin:\n  dav1d: "~1.5"'),
      data,
      undefined,
      up,
      'update',
    );
    expect(c.errors).toEqual([
      "dav1d: no upstream version fits `~1.5` (folder pin) and `1.4` (target a) and FFmpeg's minimum 1.0.0 (newest upstream: 1.5.4)",
    ]);
  });

  it('refuses a pin for a library no target builds', () => {
    const c = chooseFolder(two('', 'pin:\n  srt: "1.5"'), data, undefined, up, 'update');
    expect(c.errors).toEqual(['pin srt: no target builds srt; remove the pin']);
  });

  it('locks each FFmpeg series the targets use once', () => {
    const f = folder(
      'targets:\n  a: { platform: linux-x64, license: gplv3, ffmpeg: 9, with: [opus] }\n  b: { platform: linux-x64, license: gplv3, ffmpeg: 8, with: [opus] }\n  c: { platform: win-x64, license: gplv3, ffmpeg: 9, with: [opus] }\n',
    );
    expect(chooseFolder(f, data, undefined, up, 'update').lock.ffmpeg).toEqual({
      '8': '8.1.3',
      '9': '9.1.0',
    });
  });

  it('keeps what is locked and asks upstream only for what is missing', () => {
    const f = two();
    const locked = chooseFolder(f, data, undefined, up, 'update').lock;
    const withoutOpus = { ...locked.libraries };
    delete withoutOpus['opus'];
    const c = chooseFolder(
      f,
      data,
      { engine: '0.3.0', ...locked, libraries: withoutOpus },
      upstreams(undefined, {}),
      'keep',
    );
    expect(c.missing).toEqual(['opus']);
    expect(folderLockMatches(f, data, { engine: '0.3.0', ...locked })).toBe(true);
    expect(folderLockMatches(f, data, { engine: '0.3.0', ...locked, libraries: withoutOpus })).toBe(
      false,
    );
  });

  it('lists the new options of an FFmpeg minor per target that does not have them', () => {
    const old = { engine: '0.3.0', ffmpeg: { '9': '9.0.2' }, libraries: {} };
    const f = folder(
      'targets:\n  a: { platform: linux-x64, license: gplv3, ffmpeg: 9, with: [opus, amf] }\n  b: { platform: win-x64, license: gplv3, ffmpeg: 9, with: [opus], without: [amf] }\n  c: { platform: linux-x64, license: lgplv3, ffmpeg: 9, with: [opus] }\n',
    );
    const row = chooseFolder(f, data, old, up, 'update').rows.find((r) => r.what === 'FFmpeg 9')!;
    expect(row.newMinor).toMatchObject({
      from: '9.0',
      to: '9.1',
      adds: ['amf', 'whep'],
      missingIn: { amf: ['c'] },
    });
  });
});

describe('a version group (recipes released together, like the Vulkan SDK)', () => {
  // libva and libdrm stand in for the Vulkan SDK's headers and loader: one version, always
  const grouped = (() => {
    const root = mkdtempSync(join(tmpdir(), 'ffmpeg-build-group-'));
    cpSync(fixtureEngineRoot, root, { recursive: true });
    for (const r of ['libva', 'libdrm']) {
      const file = join(root, 'recipes', r, 'recipe.yml');
      writeFileSync(file, `${readFileSync(file, 'utf8')}version-group: test-sdk\n`);
    }
    return loadEngineData(root);
  })();
  const vaapi = () =>
    folder('targets:\n  a: { platform: linux-x64, license: gplv3, ffmpeg: 9, with: [vaapi] }\n');
  const sdk = (libva: string[], libdrm: string[]) => upstreams(['9.1.0'], { libva, libdrm });

  it('locks every member at the newest version they all have, and says why one stays behind', () => {
    const c = chooseFolder(
      vaapi(),
      grouped,
      undefined,
      sdk(['2.24.1', '2.25.0'], ['2.24.1', '2.25.0', '2.26.0']),
      'update',
    );
    expect(c.errors).toEqual([]);
    expect(c.lock.libraries).toEqual({ libdrm: '2.25.0', libva: '2.25.0' });
    expect(c.rows.find((r) => r.what === 'libdrm')!.skipped).toEqual({
      version: '2.26.0',
      reason: 'moves with libva (version-group test-sdk)',
    });
  });

  it("doesn't take a lock whose members differ, and lock brings them together", () => {
    const f = vaapi();
    const split = {
      engine: '0.3.0',
      ffmpeg: { '9': '9.1.0' },
      libraries: { libdrm: '2.26.0', libva: '2.25.0' },
    };
    expect(folderLockMatches(f, grouped, split)).toBe(false);
    const asks = chooseFolder(f, grouped, split, upstreams(undefined, {}), 'keep');
    expect(asks.missing).toEqual(['libdrm', 'libva']);
    const c = chooseFolder(
      f,
      grouped,
      split,
      sdk(['2.24.1', '2.25.0'], ['2.24.1', '2.25.0', '2.26.0']),
      'keep',
    );
    expect(c.lock.libraries).toEqual({ libdrm: '2.25.0', libva: '2.25.0' }); // a kept one all members have
    expect(folderLockMatches(f, grouped, { ...split, libraries: c.lock.libraries })).toBe(true);
  });

  it('meets a pin on one member for all of them, and says so when they share no version', () => {
    const pinned = folder(
      'pin:\n  libdrm: "2.24"\ntargets:\n  a: { platform: linux-x64, license: gplv3, ffmpeg: 9, with: [vaapi] }\n',
    );
    const c = chooseFolder(
      pinned,
      grouped,
      undefined,
      sdk(['2.24.1', '2.25.0'], ['2.24.1', '2.25.0']),
      'update',
    );
    expect(c.lock.libraries).toEqual({ libdrm: '2.24.1', libva: '2.24.1' });
    const none = chooseFolder(vaapi(), grouped, undefined, sdk(['2.25.0'], ['2.26.0']), 'update');
    expect(none.errors).toEqual([
      'libdrm and libva move together (version-group test-sdk), but no version fits them all (libdrm: 2.26.0; libva: 2.25.0)',
    ]);
  });
});

describe('the Vulkan SDK libraries', () => {
  it('are one version group: the lock never mixes SDK releases', () => {
    const shipped = loadEngineData(packageRoot);
    for (const r of ['vulkan-headers', 'vulkan-loader', 'spirv-headers']) {
      expect(shipped.recipes.get(r)!['version-group'], r).toBe('vulkan-sdk');
    }
  });
});

const recipeText = (n: string) =>
  `name: ${n}\nlicense: MIT\nsource: { git: https://example.com/${n}.git, ref: "v{version}" }\nversions: { git-tags: '^v(\\d+\\.\\d+)$' }\nplatforms: all\n`;

describe('ffmpeg: latest across a new major', () => {
  // FFmpeg 8 has options a and b; 9 has only a (b's library is gone)
  const majors = () =>
    loadEngineData(
      writeEngine({
        'ffmpeg/8.yml':
          'major: 8\nreleases: [8.1.0]\noptions:\n  a: { needs: ra }\n  b: { needs: rb }\n',
        'ffmpeg/9.yml': 'major: 9\nreleases: [9.0.0]\noptions:\n  a: { needs: ra }\n',
        'recipes/ra/recipe.yml': recipeText('ra'),
        'recipes/rb/recipe.yml': recipeText('rb'),
      }),
    );
  const libs = upstreams(['8.1.0', '9.0.0'], { ra: ['1.0'], rb: ['1.0'] });
  const old = { engine: '0.0.1', ffmpeg: { latest: '8.1.0' }, libraries: { ra: '1.0' } };

  it('moves to the newest major, saying which targets move from where', () => {
    const f = folder(
      [
        'targets:',
        '  x: { platform: linux-x64, license: gplv3, ffmpeg: latest, with: [a] }',
        '  y: { platform: win-x64, license: gplv3, ffmpeg: latest, with: [a] }',
        '  z: { platform: win-x64, license: gplv3, ffmpeg: 8, with: [a] }',
        '',
      ].join('\n'),
    );
    const c = chooseFolder(
      f,
      majors(),
      { ...old, ffmpeg: { ...old.ffmpeg, '8': '8.1.0' } },
      libs,
      'update',
    );
    expect(c.errors).toEqual([]);
    expect(c.lock.ffmpeg).toEqual({ '8': '8.1.0', latest: '9.0.0' });
    expect(c.rows.find((r) => r.what === 'FFmpeg latest')).toEqual({
      what: 'FFmpeg latest',
      from: '8.1.0',
      to: '9.0.0',
      newMajor: { from: '8', to: '9', targets: ['x', 'y'] },
    });
  });

  it('moves even when a target asks for something the new major lacks: check says so in the PR', () => {
    const f = folder(
      'targets:\n  t: { platform: linux-x64, license: gplv3, ffmpeg: latest, with: [a, b] }\n',
    );
    const c = chooseFolder(f, majors(), old, libs, 'update');
    expect(c.errors).toEqual([]);
    expect(c.lock.ffmpeg).toEqual({ latest: '9.0.0' });
    expect(c.rows[0]!.newMajor).toEqual({ from: '8', to: '9', targets: ['t'] });
  });

  it('stays on its major, saying why, when no lock can be chosen on the new one', () => {
    // the folder pins rb, which nothing builds on FFmpeg 9: no lock fits the folder there
    const f = folder(
      'pin:\n  rb: "1.0"\ntargets:\n  t: { platform: linux-x64, license: gplv3, ffmpeg: latest, with: [a, b] }\n',
    );
    const c = chooseFolder(
      f,
      majors(),
      { ...old, libraries: { ra: '1.0', rb: '1.0' } },
      libs,
      'update',
    );
    expect(c.errors).toEqual([]);
    expect(c.lock.ffmpeg).toEqual({ latest: '8.1.0' });
    expect(c.rows[0]).toEqual({
      what: 'FFmpeg latest',
      from: '8.1.0',
      to: '8.1.0',
      newMajor: {
        from: '8',
        to: '9',
        targets: ['t'],
        held: { version: '9.0.0', errors: ['pin rb: no target builds rb; remove the pin'] },
      },
    });
  });

  it('keeps the locked major under lock (only update moves it)', () => {
    const f = folder(
      'targets:\n  t: { platform: linux-x64, license: gplv3, ffmpeg: latest, with: [a] }\n',
    );
    expect(chooseFolder(f, majors(), old, libs, 'keep').lock.ffmpeg).toEqual({ latest: '8.1.0' });
  });
});
