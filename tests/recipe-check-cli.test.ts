// `ffmpeg-build recipe-check`: the throwaway folder it writes (one target per platform and option, locked at the seed
// lock's versions), the plan CI turns into its matrix, and the library-only builds.
import { appendFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { writeEngine } from './helpers.ts';
import { runTargetBuild } from '../src/commands/build.ts';
import { runRecipeCheck } from '../src/commands/recipe-check.ts';
import { loadEngineData } from '../src/engine-data.ts';
import { formatFolderLock, readFolderLock } from '../src/lockfile.ts';
import { loadFolder } from '../src/targets.ts';

const recipe = (name: string, extra = '', platforms = 'all') =>
  `name: ${name}\nlicense: MIT\nsource: { git: https://example.com/${name} }\nversions: { git-tags: '^v(.*)$' }\nplatforms: ${platforms}\n${extra}`;

const PLATFORMS = [
  'platforms:',
  '  linux-x64: { image: linux-x64, setup: linux }',
  '  maccatalyst-x64: { image: macos, setup: apple-ios, runner: macos-15 }',
  '',
].join('\n');

const COMMIT = 'a'.repeat(40);
const SHA = 'b'.repeat(64);

function setup(extraRecipes: Record<string, string> = {}) {
  const data = loadEngineData(
    writeEngine({
      'platforms.yml': PLATFORMS,
      'ffmpeg/9.yml':
        'major: 9\nreleases: [9.0.0, 9.0.1]\noptions:\n  a: { needs: a }\n  b: { needs: b, platforms: [linux-*] }\n',
      'recipes/a/recipe.yml': recipe('a'),
      'recipes/b/recipe.yml': recipe('b', '', '[linux-*]'),
      ...extraRecipes,
    }),
  );
  const work = mkdtempSync(join(tmpdir(), 'ffmpeg-build-recipe-check-'));
  const seed = join(work, 'seed.lock');
  writeFileSync(
    seed,
    formatFolderLock({
      engine: '0.0.1',
      ffmpeg: { '9': '9.0.0' },
      libraries: { a: '1.0', b: '2.0', dep: '1.1', unused: '3.0' },
      pins: {
        ffmpeg: { '9': { sha256: SHA } },
        libraries: {
          a: { commit: COMMIT },
          b: { commit: COMMIT },
          dep: { commit: COMMIT },
          unused: { commit: COMMIT },
        },
      },
    }),
  );
  return { data, work, seed, dir: join(work, 'check') };
}

// nothing is looked up: the seed lock has every version and pin
const lookedUp = async (): Promise<never> => {
  throw new Error('looked something up');
};
const offline = { fetch: lookedUp, pinSource: { commitOf: lookedUp, sha256Of: lookedUp } };

describe('ffmpeg-build recipe-check', () => {
  it('allows an assigned library-only build from a generated folder with repeated Apple slices', async () => {
    const { data, seed, dir } = setup();
    await runRecipeCheck(data, ['a'], { plan: true, lock: seed, dir }, offline);
    appendFileSync(
      join(dir, 'ffmpeg-build.yml'),
      '  another-catalyst-recipe: { platform: maccatalyst-x64, license: nonfree, ffmpeg: 9, with: [a] }\n',
    );
    const opened = loadFolder(dir);
    expect(opened.ok).toBe(true);
    if (!opened.ok) {
      throw new Error(opened.errors.join('\n'));
    }
    const options = { out: join(dir, 'dist'), dryRun: true };
    const libraries = await runTargetBuild(opened.folder, 'linux-x64-a', data, {
      ...options,
      only: ['a'],
    });
    expect(libraries).toMatchObject({
      exitCode: 0,
      output: 'would build a for linux-x64, without FFmpeg',
    });
    expect(opened.folder.libraryOnly).toBeUndefined();
    await expect(runTargetBuild(opened.folder, 'linux-x64-a', data, options)).rejects.toThrow(
      /xcframework/i,
    );
  });

  it('writes a folder of check targets, locked at the seed lock, and plans one CI job per platform', async () => {
    const { data, seed, dir } = setup();
    const r = await runRecipeCheck(
      data,
      ['a'],
      { plan: true, json: true, lock: seed, dir },
      offline,
    );
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.output)).toEqual({
      recipes: ['a'],
      dir,
      unbuildable: [],
      unbuilt: [],
      platforms: [
        {
          platform: 'linux-x64',
          runner: 'ubuntu-24.04',
          in: 'docker',
          targets: [{ name: 'linux-x64-a', only: ['a'] }],
        },
        {
          platform: 'maccatalyst-x64',
          runner: 'macos-15',
          in: 'here',
          targets: [{ name: 'maccatalyst-x64-a', only: ['a'] }],
        },
      ],
    });
    const folder = readFileSync(join(dir, 'ffmpeg-build.yml'), 'utf8');
    expect(folder).toContain('linux-x64-a: { platform: linux-x64, license: nonfree');
    // the seed lock's versions and pins, and only what the targets build
    const lock = readFolderLock(join(dir, 'ffmpeg.lock'))!;
    expect(lock.ffmpeg).toEqual({ '9': '9.0.0' });
    expect(lock.libraries).toEqual({ a: '1.0' });
    expect(lock.pins?.libraries['a']).toEqual({ commit: COMMIT });
  });

  it('builds from a folder it already wrote for the same recipes, without locking again', async () => {
    const { data, seed, dir } = setup();
    await runRecipeCheck(data, ['a'], { plan: true, lock: seed, dir }, offline);
    const before = readFileSync(join(dir, 'ffmpeg.lock'), 'utf8');
    writeFileSync(join(dir, 'ffmpeg.lock'), before.replace('9.0.0', '9.0.1'));
    const r = await runRecipeCheck(
      data,
      ['a'],
      { dir, dryRun: true, platform: 'linux-*', out: join(dir, 'dist') },
      offline,
    );
    expect(r.output).toBe('linux-x64-a: would build a for linux-x64, without FFmpeg');
    expect(r.exitCode).toBe(0);
    expect(readFileSync(join(dir, 'ffmpeg.lock'), 'utf8')).toContain('9.0.1');
  });

  it('writes the folder again for other recipes', async () => {
    const { data, seed, dir } = setup();
    await runRecipeCheck(data, ['a'], { plan: true, lock: seed, dir }, offline);
    const r = await runRecipeCheck(
      data,
      ['b'],
      { plan: true, json: true, lock: seed, dir },
      offline,
    );
    expect(JSON.parse(r.output).platforms.map((p: { platform: string }) => p.platform)).toEqual([
      'linux-x64',
    ]);
    expect(readFolderLock(join(dir, 'ffmpeg.lock'))!.libraries).toEqual({ b: '2.0' });
  });

  it('fails when a recipe claims platforms nothing builds it on, and notes one nothing builds', async () => {
    const { data, seed, dir } = setup({
      'recipes/dep/recipe.yml': recipe('dep'),
      'recipes/b/recipe.yml': recipe('b', 'needs: [dep]\n', '[linux-*]'),
      'recipes/lonely/recipe.yml': recipe('lonely'),
    });
    const r = await runRecipeCheck(
      data,
      ['dep', 'lonely'],
      { plan: true, json: true, lock: seed, dir },
      offline,
    );
    expect(r.exitCode).toBe(1);
    const out = JSON.parse(r.output);
    expect(out.unbuildable).toEqual(['lonely']);
    expect(out.unbuilt).toEqual([{ recipe: 'dep', platforms: ['maccatalyst-x64'] }]);
  });

  it('says what it would build where, for people', async () => {
    const { data, seed, dir } = setup();
    const r = await runRecipeCheck(data, ['a'], { plan: true, lock: seed, dir }, offline);
    expect(r.output).toContain('linux-x64 (docker on ubuntu-24.04): linux-x64-a builds a');
    expect(r.output).toContain('maccatalyst-x64 (here on macos-15): maccatalyst-x64-a builds a');
    expect(existsSync(join(dir, 'recipe-check.json'))).toBe(true);
  });
});
