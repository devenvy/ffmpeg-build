// recipe-check: a changed recipe is built on every platform it claims, through the cheapest option that pulls it in,
// and so is every recipe that builds against it.
import { describe, expect, it } from 'vitest';

import { writeEngine } from './helpers.ts';
import { loadEngineData } from '../src/engine-data.ts';
import { recipeCheckPlan } from '../src/recipe-check.ts';

const recipe = (name: string, extra = '', platforms = 'all') =>
  `name: ${name}\nlicense: MIT\nsource: { git: https://example.com/${name} }\nversions: { git-tags: '^v(.*)$' }\nplatforms: ${platforms}\n${extra}`;

const PLATFORMS = [
  'platforms:',
  '  linux-x64: { image: linux-x64, setup: linux }',
  '  win-x64: { image: cross-windows, setup: windows }',
  '  osx-arm64: { image: macos, setup: apple-macos, runner: macos-15 }',
  '',
].join('\n');

function engine(files: Record<string, string>) {
  return loadEngineData(writeEngine({ 'platforms.yml': PLATFORMS, ...files }));
}

describe('recipeCheckPlan', () => {
  it('builds a recipe on every platform it claims, through its own option', () => {
    const d = engine({
      'ffmpeg/9.yml': 'major: 9\nreleases: [9.0.0]\noptions:\n  a: { needs: a }\n',
      'recipes/a/recipe.yml': recipe('a'),
    });
    const plan = recipeCheckPlan(d, ['a']);
    expect(plan.targets).toEqual([
      { name: 'linux-x64-a', platform: 'linux-x64', ffmpeg: '9', option: 'a', only: ['a'] },
      { name: 'osx-arm64-a', platform: 'osx-arm64', ffmpeg: '9', option: 'a', only: ['a'] },
      { name: 'win-x64-a', platform: 'win-x64', ffmpeg: '9', option: 'a', only: ['a'] },
    ]);
    expect(plan.unbuildable).toEqual([]);
    expect(plan.unbuilt).toEqual([]);
  });

  it('reaches a library no option names through what needs or uses it', () => {
    const d = engine({
      'ffmpeg/9.yml':
        'major: 9\nreleases: [9.0.0]\noptions:\n  big: { needs: big }\n  small: { needs: small }\n',
      'recipes/big/recipe.yml': recipe('big', 'needs: [other]\n'),
      'recipes/small/recipe.yml': recipe('small', 'uses: [dep]\n'),
      'recipes/dep/recipe.yml': recipe('dep'),
      'recipes/other/recipe.yml': recipe('other'),
    });
    const plan = recipeCheckPlan(d, ['dep']);
    expect(plan.recipes).toEqual(['dep', 'small']);
    expect(plan.targets.map((t) => [t.platform, t.option, t.only])).toEqual([
      ['linux-x64', 'small', ['dep', 'small']],
      ['osx-arm64', 'small', ['dep', 'small']],
      ['win-x64', 'small', ['dep', 'small']],
    ]);
  });

  it('takes the fewest builds that check everything, the smallest first', () => {
    const d = engine({
      'ffmpeg/9.yml':
        'major: 9\nreleases: [9.0.0]\noptions:\n  big: { needs: big }\n  small: { needs: lib }\n  zz: { needs: zz }\n',
      'recipes/big/recipe.yml': recipe('big', 'needs: [lib, other]\n'),
      'recipes/zz/recipe.yml': recipe('zz', 'needs: [lib]\n'),
      'recipes/lib/recipe.yml': recipe('lib'),
      'recipes/other/recipe.yml': recipe('other'),
    });
    // big and zz build against lib, so they are checked too; zz's build (two libraries, to big's three) has lib too
    expect(recipeCheckPlan(d, ['lib']).targets.map((t) => [t.name, t.only])).toEqual([
      ['linux-x64-big', ['big']],
      ['linux-x64-zz', ['lib', 'zz']],
      ['osx-arm64-big', ['big']],
      ['osx-arm64-zz', ['lib', 'zz']],
      ['win-x64-big', ['big']],
      ['win-x64-zz', ['lib', 'zz']],
    ]);
    // other has no option of its own: the one that builds it
    expect(recipeCheckPlan(d, ['other']).targets.map((t) => t.name)).toEqual([
      'linux-x64-big',
      'osx-arm64-big',
      'win-x64-big',
    ]);
  });

  it('builds at the FFmpeg release it is given', () => {
    const d = engine({
      'ffmpeg/9.yml':
        'major: 9\nreleases: [9.0.0, 9.1.0]\noptions:\n  a: { needs: a, since: 9.1.0 }\n',
      'recipes/a/recipe.yml': recipe('a'),
    });
    expect(recipeCheckPlan(d, ['a']).targets).toHaveLength(3);
    expect(recipeCheckPlan(d, ['a'], { '9': '9.0.0' }).unbuildable).toEqual(['a']);
  });

  it('builds what builds against a changed recipe, on the platforms where it does', () => {
    const d = engine({
      'ffmpeg/9.yml':
        'major: 9\nreleases: [9.0.0]\noptions:\n  a: { needs: a }\n  z: { needs: z }\n',
      'recipes/a/recipe.yml': recipe('a', 'needs: [{ z: { platforms: [win-*] } }]\n'),
      'recipes/z/recipe.yml': recipe('z'),
    });
    const plan = recipeCheckPlan(d, ['z']);
    expect(plan.recipes).toEqual(['a', 'z']);
    // on Windows, a (which builds z first) covers both; elsewhere z alone
    expect(plan.targets.map((t) => [t.platform, t.option, t.only])).toEqual([
      ['linux-x64', 'z', ['z']],
      ['osx-arm64', 'z', ['z']],
      ['win-x64', 'a', ['a', 'z']],
    ]);
  });

  it('takes the newest FFmpeg major that offers an option for it', () => {
    const d = engine({
      'ffmpeg/8.yml': 'major: 8\nreleases: [8.0.0]\noptions:\n  old: { needs: a }\n',
      'ffmpeg/9.yml': 'major: 9\nreleases: [9.0.0]\noptions:\n  new: { needs: b }\n',
      'recipes/a/recipe.yml': recipe('a'),
      'recipes/b/recipe.yml': recipe('b'),
    });
    expect(recipeCheckPlan(d, ['a']).targets.map((t) => [t.ffmpeg, t.option])).toEqual([
      ['8', 'old'],
      ['8', 'old'],
      ['8', 'old'],
    ]);
  });

  it('says which recipes nothing builds, and which claim platforms nothing builds them on', () => {
    const d = engine({
      'ffmpeg/9.yml':
        'major: 9\nreleases: [9.0.0]\noptions:\n  a: { needs: a, platforms: [linux-*] }\n',
      'recipes/a/recipe.yml': recipe('a', 'needs: [dep]\n', '[linux-*]'),
      'recipes/dep/recipe.yml': recipe('dep'),
      'recipes/lonely/recipe.yml': recipe('lonely'),
    });
    const plan = recipeCheckPlan(d, ['dep', 'lonely']);
    expect(plan.unbuildable).toEqual(['lonely']);
    expect(plan.unbuilt).toEqual([{ recipe: 'dep', platforms: ['osx-arm64', 'win-x64'] }]);
    expect(plan.targets.map((t) => t.name)).toEqual(['linux-x64-a']);
  });

  it('only counts platforms platforms.yml builds', () => {
    const d = engine({
      'ffmpeg/9.yml': 'major: 9\nreleases: [9.0.0]\noptions:\n  a: { needs: a }\n',
      'recipes/a/recipe.yml': recipe('a', '', '[linux-x64, android-arm64]'),
    });
    const plan = recipeCheckPlan(d, ['a']);
    expect(plan.targets.map((t) => t.platform)).toEqual(['linux-x64']);
    expect(plan.unbuilt).toEqual([]);
  });

  it('names an unknown recipe', () => {
    const d = engine({
      'ffmpeg/9.yml': 'major: 9\nreleases: [9.0.0]\noptions:\n  a: { needs: a }\n',
      'recipes/a/recipe.yml': recipe('a'),
    });
    expect(() => recipeCheckPlan(d, ['nope'])).toThrow(/no recipe nope/);
  });
});
