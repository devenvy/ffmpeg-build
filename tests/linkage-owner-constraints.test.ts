import { describe, expect, it } from 'vitest';

import { loadEngineData } from '../src/engine-data.ts';
import { linkagePlan } from '../src/linkage.ts';
import { packageRoot } from '../src/paths.ts';
import { parseProfileText } from '../src/profile.ts';
import { planProfile } from '../src/resolve.ts';

const data = loadEngineData(packageRoot);
const constrained = { ...data, recipes: new Map(data.recipes) };
const consumer = data.recipes.get('libgcrypt')!;
constrained.recipes.set('libgcrypt', {
  ...consumer,
  linkage: {
    ...consumer.linkage!,
    modes: {
      ...consumer.linkage!.modes,
      shared: {
        ...consumer.linkage!.modes.shared!,
        'requires-link': { 'libgpg-error': ['shared', 'system-shared'] },
      },
    },
  },
});

describe('linking requirements for a shared object owner', () => {
  it('reports the conflict in an ordinary target plan before any build', () => {
    const parsed = parseProfileText(
      'name: t\nffmpeg: 9\nplatforms: [linux-x64]\nlicense: lgplv2\nwith: [gcrypt]\nlink: {libgcrypt: shared}\n',
      't.yml',
    );
    if (!parsed.ok) {
      throw new Error(parsed.errors.join('\n'));
    }
    expect(planProfile(parsed.profile, constrained).errors.join('\n')).toContain(
      'libgcrypt shared requires libgpg-error linking as shared or system-shared',
    );
  });

  it('rejects an incompatible default dependency without changing it silently', () => {
    const plan = linkagePlan(constrained, ['libgpg-error', 'libgcrypt'], 'linux-x64', {
      libgcrypt: 'shared',
    });
    expect(plan.modes['libgpg-error']).toBe('static');
    expect(plan.errors).toEqual([
      'link: libgcrypt shared requires libgpg-error linking as shared or system-shared (selected static)',
    ]);
  });

  it.each(['shared', 'system-shared'] as const)('accepts the explicit %s provider', (mode) => {
    expect(
      linkagePlan(constrained, ['libgpg-error', 'libgcrypt'], 'linux-x64', {
        libgcrypt: 'shared',
        'libgpg-error': mode,
      }).errors,
    ).toEqual([]);
  });

  it('keeps unconstrained static and reverse mixed selections available', () => {
    expect(linkagePlan(constrained, ['libgpg-error', 'libgcrypt'], 'linux-x64').errors).toEqual([]);
    expect(
      linkagePlan(constrained, ['libgpg-error', 'libgcrypt'], 'linux-x64', {
        'libgpg-error': 'shared',
      }).errors,
    ).toEqual([]);
  });

  it('reports a required provider absent from the build', () => {
    expect(
      linkagePlan(constrained, ['libgcrypt'], 'linux-x64', { libgcrypt: 'shared' }).errors,
    ).toEqual([
      'link: libgcrypt shared requires libgpg-error linking as shared or system-shared (selected absent)',
    ]);
  });
});
