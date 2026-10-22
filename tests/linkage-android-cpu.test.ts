import { describe, expect, it } from 'vitest';

import { loadEngineData } from '../src/engine-data.ts';
import { linkagePlan } from '../src/linkage.ts';
import { packageRoot } from '../src/paths.ts';

const data = loadEngineData(packageRoot);

describe('Android CPU detection runtime linking', () => {
  it('retains static defaults and bounds the shared SDK to Android x64', () => {
    expect(linkagePlan(data, ['cpu-features'], 'android-x64').modes['cpu-features']).toBe('static');
    expect(
      linkagePlan(data, ['cpu-features'], 'android-x64', { 'cpu-features': 'shared' }).errors,
    ).toEqual([]);
    expect(
      linkagePlan(data, ['cpu-features'], 'android-arm64', { 'cpu-features': 'shared' }).errors,
    ).toHaveLength(1);
  });

  it('ships both native libraries without adding invented ABI versions', () => {
    expect(
      data.recipes.get('cpu-features')!.linkage!.modes.shared!.runtime!.map((entry) => entry.value),
    ).toEqual(['lib/libcpu_features.so', 'lib/libndk_compat.so']);
  });
});
