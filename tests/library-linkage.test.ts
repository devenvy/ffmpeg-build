import { describe, expect, it } from 'vitest';

import { configureFlags, makeBuildPlan } from '../src/build/plan.ts';
import { loadEngineData } from '../src/engine-data.ts';
import { formatPlan, planJson } from '../src/format.ts';
import { linkagePlan } from '../src/linkage.ts';
import { packageRoot } from '../src/paths.ts';
import { parseProfileText } from '../src/profile.ts';
import { targetFacts } from '../src/release.ts';
import { planProfile } from '../src/resolve.ts';
import { parseFolderText, targetProfile } from '../src/targets.ts';

const data = loadEngineData(packageRoot);
const locked = {
  ffmpeg: { '9': '9.0.2' },
  libraries: { libgcrypt: '1.12.4', 'libgpg-error': '1.61', zlib: '1.3.2' },
  pinned: [],
};
const resolve = (link = '') => {
  const parsed = parseProfileText(
    `name: t\nffmpeg: 9\nplatforms: [linux-x64]\nlicense: lgplv2\nwith: [gcrypt, zlib]\n${link}`,
    't.yml',
  );
  if (!parsed.ok) {
    throw new Error(parsed.errors.join('\n'));
  }
  return { profile: parsed.profile, plan: planProfile(parsed.profile, data, locked.ffmpeg) };
};
const build = (link = '') => {
  const { profile, plan } = resolve(link);
  return makeBuildPlan({
    profile,
    data,
    locked,
    cell: plan.cells[0]!,
    variant: 't',
    imageId: 'toolchain',
    cacheDir: '/not-cached',
  });
};

describe('per-library linking', () => {
  it('keeps static defaults and identical configure flags when an override is omitted', () => {
    const normal = build();
    const explicit = build('link: { libgcrypt: static, libgpg-error: static }\n');
    expect(normal.runtime).toEqual([]);
    expect(normal.libraries.map((l) => l.key)).toEqual(explicit.libraries.map((l) => l.key));
    const a = resolve();
    const b = resolve('link: { libgcrypt: static }\n');
    expect(configureFlags(data, a.plan.cells[0]!)).toEqual(configureFlags(data, b.plan.cells[0]!));
  });

  it('changes one library without silently changing its dependency', () => {
    const plan = build('link: { libgcrypt: shared }\n');
    expect(plan.runtime).toEqual(['lib/libgcrypt.so*']);
    expect(plan.libraries.find((l) => l.name === 'libgcrypt')!.build.vars['shared-arg']).toBe(
      '--enable-shared',
    );
    expect(plan.libraries.find((l) => l.name === 'libgpg-error')!.build.vars['shared-arg']).toBe(
      '--disable-shared',
    );
  });

  it('invalidates a changed dependency and its consumers, while unrelated caches remain valid', () => {
    const keys = (link: string) =>
      Object.fromEntries(build(link).libraries.map((l) => [l.name, l.key]));
    const normal = keys('');
    const shared = keys('link: { libgpg-error: shared }\n');
    expect(shared['libgpg-error']).not.toBe(normal['libgpg-error']);
    expect(shared['libgcrypt']).not.toBe(normal['libgcrypt']);
    expect(shared['zlib']).toBe(normal['zlib']);
  });

  it.each(['link: { typo: shared }\n', 'link: { libressl: static }\n'])(
    'rejects an unsupported, unknown or absent library: %s',
    (link) => {
      expect(resolve(link).plan.errors.length).toBeGreaterThan(0);
      expect(() => build(link)).toThrow(/link:/);
    },
  );

  it('lets a target override a base choice by recipe name', () => {
    const parsed = parseFolderText(
      'bases:\n  shared:\n    with: [gcrypt]\n    link: {libgcrypt: shared, libgpg-error: shared}\ntargets:\n  t:\n    base: [shared]\n    platform: linux-x64\n    license: lgplv2\n    ffmpeg: 9\n    link: {libgcrypt: static}\n',
      'ffmpeg-build.yml',
    );
    if (!parsed.ok) {
      throw new Error(parsed.errors.join('\n'));
    }
    const profile = targetProfile(parsed.folder, parsed.folder.targets[0]!);
    expect(profile.link).toEqual({ libgcrypt: 'static', 'libgpg-error': 'shared' });
  });

  it('reports the resolved modes in readable and JSON plans', () => {
    const { profile, plan } = resolve('link: {libgcrypt: shared}\n');
    expect(formatPlan(profile, plan, data)).toContain('libgcrypt shared');
    expect(planJson(profile, plan, data).builds[0]!.linkages).toEqual({
      libgcrypt: 'shared',
      'libgpg-error': 'static',
      zlib: 'static',
    });
  });

  it('refuses modes outside their verified platforms', () => {
    const recipe = data.recipes.get('libgcrypt')!;
    const altered = { ...data, recipes: new Map(data.recipes) };
    altered.recipes.set('libgcrypt', {
      ...recipe,
      linkage: {
        ...recipe.linkage!,
        modes: {
          ...recipe.linkage!.modes,
          shared: { ...recipe.linkage!.modes.shared!, platforms: ['linux-arm64'] },
        },
      },
    });
    expect(
      linkagePlan(altered, ['libgpg-error', 'libgcrypt'], 'linux-x64', { libgcrypt: 'shared' })
        .errors,
    ).toEqual(['link: libgcrypt does not support shared linking on linux-x64']);
  });

  it('treats a link change as a release change and refuses invalid release definitions', () => {
    const parsed = parseFolderText(
      'targets:\n  t:\n    platform: linux-x64\n    license: lgplv2\n    ffmpeg: 9\n    with: [gcrypt]\n',
      'ffmpeg-build.yml',
    );
    if (!parsed.ok) {
      throw new Error(parsed.errors.join('\n'));
    }
    const folder = parsed.folder;
    const target = folder.targets[0]!;
    const lock = { ...locked, engine: '0.0.1' };
    const normal = targetFacts(folder, target, data, lock, packageRoot);
    const explicit = targetFacts(
      folder,
      { ...target, link: { libgcrypt: 'static' } },
      data,
      lock,
      packageRoot,
    );
    const shared = targetFacts(
      folder,
      { ...target, link: { libgcrypt: 'shared' } },
      data,
      lock,
      packageRoot,
    );
    if ('error' in normal || 'error' in explicit || 'error' in shared) {
      throw new Error('valid linking failed');
    }
    expect(explicit.facts.definition).toBe(normal.facts.definition);
    expect(shared.facts.definition).not.toBe(normal.facts.definition);
    expect(
      targetFacts(folder, { ...target, link: { typo: 'shared' } }, data, lock, packageRoot),
    ).toHaveProperty('error');
  });
});
