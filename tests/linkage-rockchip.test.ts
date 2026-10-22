import { describe, expect, it } from 'vitest';

import { loadEngineData } from '../src/engine-data.ts';
import { linkagePlan } from '../src/linkage.ts';
import { packageRoot } from '../src/paths.ts';

const data = loadEngineData(packageRoot);

describe('Rockchip native runtime linking', () => {
  it('retains static defaults and allows a native ARM64 shared owner', () => {
    expect(linkagePlan(data, ['rockchip-mpp'], 'linux-arm64').modes['rockchip-mpp']).toBe('static');
    expect(
      linkagePlan(data, ['rockchip-mpp'], 'linux-arm64', { 'rockchip-mpp': 'shared' }).errors,
    ).toEqual([]);
    expect(
      linkagePlan(data, ['rockchip-mpp'], 'linux-x64', { 'rockchip-mpp': 'shared' }).errors,
    ).toHaveLength(1);
  });

  it('ships both the native MPP and legacy VPU library families', () => {
    expect(
      data.recipes.get('rockchip-mpp')!.linkage!.modes.shared!.runtime!.map((entry) => entry.value),
    ).toEqual(['lib/librockchip_mpp.so*', 'lib/librockchip_vpu.so*']);
  });
});
