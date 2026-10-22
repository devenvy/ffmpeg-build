import { rmSync } from 'node:fs';

import { expect, it } from 'vitest';

import { writeEngine } from './helpers.ts';
import { configureFlags, makeBuildPlan, verifyNames } from '../src/build/plan.ts';
import { loadEngineData } from '../src/engine-data.ts';
import { coverage, readCoverageData } from '../src/ffmpeg-coverage.ts';
import { linkagePlan } from '../src/linkage.ts';
import { packageRoot } from '../src/paths.ts';
import { parseProfileText } from '../src/profile.ts';
import { planProfile } from '../src/resolve.ts';
import { recipeSchema } from '../src/schema/engine.ts';

const data = loadEngineData(packageRoot);
const altered = () => ({ ...data, recipes: new Map(data.recipes), ffmpeg: new Map(data.ffmpeg) });
const locked = {
  ffmpeg: { '9': '9.0.2' },
  libraries: { libgcrypt: '1.12.4', 'libgpg-error': '1.61', zlib: '1.3.2' },
  pinned: [],
};
const resolve = (engine = data, link = '') => {
  const parsed = parseProfileText(
    `name: t\nffmpeg: 9\nplatforms: [linux-x64]\nlicense: lgplv2\nwith: [gcrypt, zlib]\n${link}`,
    't.yml',
  );
  if (!parsed.ok) {
    throw new Error(parsed.errors.join('\n'));
  }
  return {
    profile: parsed.profile,
    cell: planProfile(parsed.profile, engine, locked.ffmpeg).cells[0]!,
  };
};

it('applies global, last matching platform, and explicit defaults in that order', () => {
  const engine = altered();
  const recipe = engine.recipes.get('libgcrypt')!;
  engine.recipes.set('libgcrypt', {
    ...recipe,
    linkage: { ...recipe.linkage!, defaults: { 'linux-*': 'shared', 'linux-x64': 'static' } },
  });
  expect(linkagePlan(engine, ['libgcrypt'], 'linux-arm64').modes['libgcrypt']).toBe('shared');
  expect(linkagePlan(engine, ['libgcrypt'], 'linux-x64').modes['libgcrypt']).toBe('static');
  expect(linkagePlan(engine, ['libgcrypt'], 'win-x64').modes['libgcrypt']).toBe('static');
  expect(
    linkagePlan(engine, ['libgcrypt'], 'linux-x64', { libgcrypt: 'shared' }).modes['libgcrypt'],
  ).toBe('shared');
});

it('adds dependency-only mode flags once and retains option-level configure overrides', () => {
  const engine = altered();
  const recipe = engine.recipes.get('libgpg-error')!;
  engine.recipes.set('libgpg-error', {
    ...recipe,
    linkage: {
      ...recipe.linkage!,
      modes: {
        ...recipe.linkage!.modes,
        static: {
          ...recipe.linkage!.modes.static!,
          configure: [
            { value: '--enable-vulkan-static' },
            { value: '--extra-cflags=-I{deps}/mode', platforms: ['linux-x64'] },
          ],
        },
      },
    },
  });
  const ffmpeg = engine.ffmpeg.get('9')!;
  engine.ffmpeg.set('9', {
    ...ffmpeg,
    options: {
      ...ffmpeg.options,
      gcrypt: {
        ...ffmpeg.options['gcrypt']!,
        configure: ['--enable-gcrypt', '--extra-libs=-lgpg-error'],
      },
    },
  });
  const { cell } = resolve(engine);
  const flags = configureFlags(engine, cell, '/native/deps');
  expect(flags.filter((flag) => flag === '--enable-vulkan-static')).toHaveLength(1);
  expect(flags).toContain('--extra-cflags=-I/native/deps/mode');
  expect(flags).toContain('--enable-gcrypt');
  expect(flags).not.toContain('--enable-vulkan');
  expect(verifyNames(engine, cell)).toContain('VULKAN_STATIC');
  const shared = resolve(engine, 'link: { libgpg-error: shared }\n');
  expect(configureFlags(engine, shared.cell)).not.toContain('--enable-vulkan-static');
});

it('uses freshly resolved defaults for configure, build variables and dependency caches', () => {
  const previous = resolve();
  const engine = altered();
  const recipe = engine.recipes.get('libgpg-error')!;
  engine.recipes.set('libgpg-error', {
    ...recipe,
    linkage: {
      ...recipe.linkage!,
      defaults: { 'linux-x64': 'shared' },
      modes: {
        ...recipe.linkage!.modes,
        shared: {
          ...recipe.linkage!.modes.shared!,
          configure: [{ value: '--enable-vulkan-static' }],
        },
      },
    },
  });
  const args = { locked, variant: 't', imageId: 'toolchain', cacheDir: '/not-cached' };
  const before = makeBuildPlan({ ...args, data, ...previous });
  const after = makeBuildPlan({ ...args, data: engine, ...previous });
  const explicit = makeBuildPlan({
    ...args,
    data: engine,
    ...resolve(engine, 'link: { libgpg-error: shared }\n'),
  });
  expect(after.ffmpeg!.configure).toContain('--enable-vulkan-static');
  expect(after.ffmpeg!.verify).toContain('VULKAN_STATIC');
  expect(after.runtime).toContain('lib/libgpg-error.so*');
  expect(after.libraries.map((library) => library.key)).toEqual(
    explicit.libraries.map((library) => library.key),
  );
  const key = (plan: typeof before, name: string) =>
    plan.libraries.find((library) => library.name === name)!.key;
  expect(key(after, 'libgpg-error')).not.toBe(key(before, 'libgpg-error'));
  expect(key(after, 'libgcrypt')).not.toBe(key(before, 'libgcrypt'));
  expect(key(after, 'zlib')).toBe(key(before, 'zlib'));
});

it('parses mode flags and rejects defaults that name an undeclared mode', () => {
  const recipe = {
    name: 'sample',
    license: 'MIT',
    'license-files': ['LICENSE'],
    source: { url: 'https://example.org/source-{version}.tar.gz' },
    versions: { 'git-tags': '^(\\d+\\.\\d+\\.\\d+)$', repo: 'https://example.org/source.git' },
    platforms: ['linux-x64'],
    build: { system: 'cmake' },
    linkage: {
      default: 'shared',
      defaults: { 'linux-x64': 'static' },
      modes: { static: { configure: ['--enable-vulkan-static'] }, shared: {} },
    },
  };
  expect(recipeSchema.safeParse(recipe).success).toBe(true);
  expect(
    recipeSchema.safeParse({
      ...recipe,
      linkage: { ...recipe.linkage, defaults: { 'linux-x64': 'system-shared' } },
    }).success,
  ).toBe(false);
});

it.each([
  ['linux-x64', 'linux-arm64', /default static linking is not supported on linux-x64/],
  ['linuz-*', 'linux-x64', /linkage.defaults: platform "linuz-\*" matches no platform/],
])('rejects invalid or unavailable platform defaults: %s', (pattern, supported, error) => {
  const root = writeEngine({
    'ffmpeg/9.yml': 'major: 9\nreleases: [9.0.2]\noptions: {}\n',
    'recipes/sample/recipe.yml': `name: sample
license: MIT
source: { git: https://example.org/sample }
versions: { git-tags: '^v(.*)$' }
platforms: [linux-x64]
linkage:
  default: shared
  defaults: { '${pattern}': static }
  modes:
    static: { platforms: ['${supported}'] }
    shared: {}
`,
  });
  try {
    expect(() => loadEngineData(root)).toThrow(error);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it.each(['libgcrypt', 'libgpg-error'])(
  'audits all mode flags from direct and dependency-only recipes: %s',
  (name) => {
    const engine = altered();
    const recipe = engine.recipes.get(name)!;
    engine.recipes.set(name, {
      ...recipe,
      linkage: {
        ...recipe.linkage!,
        modes: {
          ...recipe.linkage!.modes,
          shared: {
            ...recipe.linkage!.modes.shared!,
            configure: [{ value: '--enable-invented-mode-library' }],
          },
        },
      },
    });
    const inventory = readCoverageData(engine);
    expect(
      coverage(engine, inventory.offered, inventory.unsupported).problems.some((problem) =>
        problem.text.includes('invented'),
      ),
    ).toBe(true);
  },
);

it('retains runtime omission and package reporting for an explicit system-shared platform default', () => {
  const engine = altered();
  const recipe = engine.recipes.get('libgcrypt')!;
  engine.recipes.set('libgcrypt', {
    ...recipe,
    linkage: { ...recipe.linkage!, defaults: { 'linux-x64': 'system-shared' } },
  });
  const args = {
    locked,
    variant: 't',
    imageId: 'toolchain',
    cacheDir: '/not-cached',
    data: engine,
  };
  const normal = makeBuildPlan({ ...args, ...resolve(engine) });
  expect(normal.runtime).not.toContain('lib/libgcrypt.so*');
  expect(normal.systemLibraries?.[0]?.name).toBe('libgcrypt');
  expect(normal.systemLibraries?.[0]?.packages['fedora']).toEqual(['libgcrypt']);
  const bundled = makeBuildPlan({ ...args, ...resolve(engine, 'link: { libgcrypt: shared }\n') });
  expect(bundled.runtime).toContain('lib/libgcrypt.so*');
  expect(bundled.systemLibraries).toBeUndefined();
});
