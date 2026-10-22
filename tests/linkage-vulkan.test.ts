import { expect, it } from 'vitest';

import { loadEngineData } from '../src/engine-data.ts';
import { linkageConfigure, linkagePlan, linkedRecipe } from '../src/linkage.ts';
import { packageRoot } from '../src/paths.ts';

const data = loadEngineData(packageRoot);
const recipe = data.recipes.get('vulkan-loader')!;

it('selects a static Vulkan loader on Linux x64 and retains a shared override', () => {
  expect(linkagePlan(data, ['vulkan-loader'], 'linux-x64')).toEqual({
    modes: { 'vulkan-loader': 'static' },
    errors: [],
  });
  expect(linkageConfigure(recipe, 'static', 'linux-x64')).toEqual(['--enable-vulkan-static']);
  expect(linkedRecipe(recipe, 'static').runtime).toEqual([]);
  expect(linkagePlan(data, ['vulkan-loader'], 'linux-x64', { 'vulkan-loader': 'shared' })).toEqual({
    modes: { 'vulkan-loader': 'shared' },
    errors: [],
  });
  expect(linkageConfigure(recipe, 'shared', 'linux-x64')).toEqual([]);
  expect(linkedRecipe(recipe, 'shared').runtime?.length).toBeGreaterThan(0);
});

it.each(['linux-arm64', 'linux-musl-x64', 'osx-arm64'])(
  '%s retains its existing shared loader until static builds are verified',
  (platform) => {
    expect(linkagePlan(data, ['vulkan-loader'], platform).modes['vulkan-loader']).toBe('shared');
    expect(
      linkagePlan(data, ['vulkan-loader'], platform, { 'vulkan-loader': 'static' }).errors,
    ).toHaveLength(1);
  },
);
