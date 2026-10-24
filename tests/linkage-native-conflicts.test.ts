import { describe, expect, it } from 'vitest';

import { buildOrder, loadEngineData } from '../src/engine-data.ts';
import { linkagePlan } from '../src/linkage.ts';
import { packageRoot } from '../src/paths.ts';
import { recipeSchema } from '../src/schema/engine.ts';

function fixture() {
  const data = loadEngineData(packageRoot);
  const common = {
    license: 'MIT',
    'license-files': ['LICENSE'],
    source: { git: 'https://example.com/native' },
    versions: { 'git-tags': '^v(.*)$' },
    platforms: ['linux-x64', 'linux-arm64'],
    build: { system: 'none', steps: [['true']] },
  };
  data.recipes.set(
    'peer',
    recipeSchema.parse({
      ...common,
      name: 'peer',
      linkage: { default: 'static', modes: { static: {}, shared: {} } },
    }),
  );
  data.recipes.set(
    'owner',
    recipeSchema.parse({
      ...common,
      name: 'owner',
      linkage: {
        default: 'static',
        modes: {
          static: {
            'conflicts-link': {
              peer: {
                modes: ['static'],
                platforms: ['linux-arm64'],
                reason: 'Native helper signatures differ; omit either option.',
              },
            },
          },
          shared: {},
        },
      },
    }),
  );
  data.recipes.set(
    'indirect',
    recipeSchema.parse({ ...common, name: 'indirect', needs: ['peer'] }),
  );
  return data;
}

describe('Native library composition conflicts', () => {
  it('keeps each library independently available without adding a dependency', () => {
    const data = fixture();
    expect(buildOrder(data, ['owner'], 'linux-arm64')).toEqual(['owner']);
    expect(linkagePlan(data, ['owner'], 'linux-arm64').errors).toEqual([]);
    expect(linkagePlan(data, ['peer'], 'linux-arm64').errors).toEqual([]);
  });

  it('rejects only the affected platform and pair of selected modes', () => {
    const data = fixture();
    expect(linkagePlan(data, ['owner', 'peer'], 'linux-arm64').errors).toEqual([
      'link: owner static conflicts with peer static on linux-arm64: Native helper signatures differ; omit either option.',
    ]);
    expect(linkagePlan(data, ['owner', 'peer'], 'linux-x64').errors).toEqual([]);
    expect(linkagePlan(data, ['owner', 'peer'], 'linux-arm64', { peer: 'shared' }).errors).toEqual(
      [],
    );
    expect(linkagePlan(data, ['owner', 'peer'], 'linux-arm64', { owner: 'shared' }).errors).toEqual(
      [],
    );
  });

  it('checks a peer selected through a dependency as well as an explicit option', () => {
    const data = fixture();
    const closure = buildOrder(data, ['owner', 'indirect'], 'linux-arm64');
    expect(closure).toContain('peer');
    expect(linkagePlan(data, closure, 'linux-arm64').errors).toHaveLength(1);
  });

  it.each([
    ['oapv', 'xeve', 'linux-arm64', 'linux-x64'],
    ['mpeghdec', 'fdk-aac', 'linux-armhf', 'linux-arm64'],
  ])(
    'bounds the native %s/%s conflict to its affected platform',
    (owner, peer, affected, unaffected) => {
      const data = loadEngineData(packageRoot);
      expect(linkagePlan(data, [owner], affected).errors).toEqual([]);
      expect(linkagePlan(data, [peer], affected).errors).toEqual([]);
      expect(linkagePlan(data, [owner, peer], affected).errors.join('\n')).toContain('Omit either');
      expect(linkagePlan(data, [owner, peer], unaffected).errors).toEqual([]);
    },
  );
});
