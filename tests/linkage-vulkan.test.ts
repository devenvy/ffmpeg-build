import { expect, it } from 'vitest';

import { loadEngineData } from '../src/engine-data.ts';
import { linkageConfigure, linkagePlan, linkedRecipe } from '../src/linkage.ts';
import { packageRoot } from '../src/paths.ts';

const data = loadEngineData(packageRoot);
const recipe = data.recipes.get('vulkan-loader')!;

it('uses the upstream shared Vulkan loader on Linux x64 and rejects patched static builds', () => {
  expect(linkagePlan(data, ['vulkan-loader'], 'linux-x64')).toEqual({
    modes: { 'vulkan-loader': 'shared' },
    errors: [],
  });
  expect(
    linkagePlan(data, ['vulkan-loader'], 'linux-x64', { 'vulkan-loader': 'static' }).errors,
  ).toHaveLength(1);
  expect(linkagePlan(data, ['vulkan-loader'], 'linux-x64', { 'vulkan-loader': 'shared' })).toEqual({
    modes: { 'vulkan-loader': 'shared' },
    errors: [],
  });
  expect(linkageConfigure(recipe, 'shared', 'linux-x64')).toEqual([]);
  expect(linkedRecipe(recipe, 'shared').runtime?.length).toBeGreaterThan(0);
});

it.each(['linux-arm64', 'linux-musl-x64', 'osx-x64'])(
  '%s retains its upstream shared loader',
  (platform) => {
    expect(linkagePlan(data, ['vulkan-loader'], platform).modes['vulkan-loader']).toBe('shared');
    expect(
      linkagePlan(data, ['vulkan-loader'], platform, { 'vulkan-loader': 'static' }).errors,
    ).toHaveLength(1);
  },
);
