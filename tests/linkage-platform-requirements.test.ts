import { describe, expect, it } from 'vitest';

import { loadEngineData } from '../src/engine-data.ts';
import { linkagePlan } from '../src/linkage.ts';
import { packageRoot } from '../src/paths.ts';
import { recipeSchema } from '../src/schema/engine.ts';

function fixture() {
  const data = loadEngineData(packageRoot);
  const common = {
    license: 'MIT',
    'license-files': ['LICENSE'],
    source: { git: 'https://github.com/example/native-library', ref: 'v{version}' },
    versions: { 'git-tags': '^v(\\d+\\.\\d+\\.\\d+)$' },
    platforms: ['linux-x64', 'osx-arm64', 'ios-arm64'],
    build: { system: 'none', steps: [['true']] },
  };
  data.recipes.set(
    'provider',
    recipeSchema.parse({
      ...common,
      name: 'provider',
      linkage: { default: 'static', modes: { static: {}, shared: {} } },
    }),
  );
  data.recipes.set(
    'consumer',
    recipeSchema.parse({
      ...common,
      name: 'consumer',
      needs: ['provider'],
      linkage: {
        default: 'static',
        modes: {
          static: { 'requires-link': { provider: { modes: ['static'], platforms: ['osx-*'] } } },
          shared: { 'requires-link': { provider: ['shared'] } },
        },
      },
    }),
  );
  return data;
}

describe('Platform-specific native library ownership constraints', () => {
  it('requires a matching owner only on the platform where that route is used', () => {
    const data = fixture();
    expect(linkagePlan(data, ['consumer'], 'linux-x64').errors).toEqual([]);
    expect(linkagePlan(data, ['consumer'], 'ios-arm64').errors).toEqual([]);
    expect(linkagePlan(data, ['consumer'], 'osx-arm64').errors).toHaveLength(1);
    expect(linkagePlan(data, ['consumer', 'provider'], 'osx-arm64').errors).toEqual([]);
    expect(
      linkagePlan(data, ['consumer', 'provider'], 'osx-arm64', { provider: 'shared' }).errors,
    ).toHaveLength(1);
  });

  it('preserves unconditional requirements from existing recipes', () => {
    const data = fixture();
    expect(
      linkagePlan(data, ['consumer', 'provider'], 'linux-x64', { consumer: 'shared' }).errors,
    ).toHaveLength(1);
    expect(
      linkagePlan(data, ['consumer', 'provider'], 'linux-x64', {
        consumer: 'shared',
        provider: 'shared',
      }).errors,
    ).toEqual([]);
  });
});
