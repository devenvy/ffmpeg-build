import { describe, expect, it } from 'vitest';

import { loadEngineData } from '../src/engine-data.ts';
import { linkagePlan } from '../src/linkage.ts';
import { packageRoot } from '../src/paths.ts';

const data = loadEngineData(packageRoot);

describe('Native macOS Vulkan owner', () => {
  it('defaults to one direct static owner on macOS arm64', () => {
    const plan = linkagePlan(data, ['vulkan-loader', 'moltenvk'], 'osx-arm64');
    expect(plan.errors).toEqual([]);
    expect(plan.modes).toMatchObject({ 'vulkan-loader': 'static', moltenvk: 'static' });
  });

  it('requires matching macOS runtime owners', () => {
    expect(
      linkagePlan(data, ['vulkan-loader', 'moltenvk'], 'osx-arm64', {
        'vulkan-loader': 'shared',
      }).errors,
    ).toHaveLength(1);
    expect(
      linkagePlan(data, ['vulkan-loader', 'moltenvk'], 'osx-arm64', {
        'vulkan-loader': 'shared',
        moltenvk: 'shared',
      }).errors,
    ).toEqual([]);
  });

  it('preserves existing x64 and iOS routes', () => {
    const desktop = linkagePlan(data, ['vulkan-loader', 'moltenvk'], 'osx-x64');
    expect(desktop.errors).toEqual([]);
    expect(desktop.modes).toMatchObject({ 'vulkan-loader': 'shared', moltenvk: 'shared' });
    const mobile = linkagePlan(data, ['moltenvk'], 'ios-arm64');
    expect(mobile.errors).toEqual([]);
    expect(mobile.modes['moltenvk']).toBe('static');
  });
});
