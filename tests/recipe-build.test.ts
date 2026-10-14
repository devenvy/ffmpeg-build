import { describe, expect, it } from 'vitest';

import { RECIPES_ARE_DATA, recipeSchema } from '../src/schema/engine.ts';

const recipe = (build: unknown) => ({
  name: 'sample',
  license: 'MIT',
  'license-files': ['COPYING'],
  source: { git: 'https://example.com/sample' },
  versions: { 'git-tags': '^v(.*)$' },
  platforms: 'all',
  build,
});

describe('recipe build data', () => {
  it('fills the standard-system defaults and keeps platform additions ordered', () => {
    expect(
      recipeSchema.parse(
        recipe({
          system: 'meson',
          args: ['-Dtools=false'],
          platforms: {
            'linux-*': { args: ['-Dlinux=true'] },
            'linux-x64': { env: { CFLAGS: '+= -msse4.1' }, after: [['make', 'verify']] },
          },
        }),
      ).build,
    ).toEqual({
      system: 'meson',
      args: ['-Dtools=false'],
      'configure-script': 'configure',
      'make-targets': [],
      'install-targets': ['install'],
      env: {},
      unset: [],
      vars: {},
      steps: [],
      before: [],
      after: [],
      platforms: {
        'linux-*': { args: ['-Dlinux=true'], env: {}, unset: [], vars: {}, before: [], after: [] },
        'linux-x64': {
          args: [],
          env: { CFLAGS: '+= -msse4.1' },
          unset: [],
          vars: {},
          before: [],
          after: [['make', 'verify']],
        },
      },
    });
  });

  it('requires an explicit build and work for the none system', () => {
    expect(
      recipeSchema.safeParse({ ...recipe({ system: 'cmake' }), build: undefined }).success,
    ).toBe(false);
    expect(recipeSchema.safeParse(recipe({ system: 'none' })).error?.issues[0]?.message).toBe(
      'build.system: none needs at least one step',
    );
    expect(
      recipeSchema.safeParse(recipe({ system: 'none', steps: [['make', '-j{jobs}']] })).success,
    ).toBe(true);
  });

  it('turns a shell: step away: recipes are data', () => {
    for (const where of [
      { steps: [{ shell: 'make' }] },
      { after: [{ shell: 'sed -i x y' }] },
      { platforms: { 'win-*': { before: [{ shell: 'true' }] } } },
    ]) {
      const result = recipeSchema.safeParse(
        recipe({ system: 'cmake', ...where, ...('steps' in where ? { system: 'none' } : {}) }),
      );
      expect(result.success).toBe(false);
      expect(result.error?.issues.map((i) => i.message)).toEqual([RECIPES_ARE_DATA]);
    }
    expect(RECIPES_ARE_DATA).toMatch(/^recipes are data/);
  });

  it('keeps declared file operations inside the source folder', () => {
    expect(
      recipeSchema.safeParse(
        recipe({ system: 'none', steps: [{ 'write-file': { path: '../outside', text: 'x' } }] }),
      ).success,
    ).toBe(false);
    expect(
      recipeSchema.safeParse(
        recipe({
          system: 'none',
          steps: [
            { 'replace-in-file': { path: 'lib/sample.pc', from: '@prefix@', to: '{prefix}' } },
          ],
        }),
      ).success,
    ).toBe(true);
    expect(
      recipeSchema.safeParse(
        recipe({
          system: 'none',
          steps: [{ copy: { from: 'sample.h', to: '{deps}/include/sample.h' } }],
        }),
      ).success,
    ).toBe(true);
    expect(
      recipeSchema.safeParse(
        recipe({
          system: 'none',
          steps: [{ remove: { path: '{deps}/obsolete', recursive: 'true' } }],
        }),
      ).success,
    ).toBe(true);
  });
});
