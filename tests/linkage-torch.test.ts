import { describe, expect, it } from 'vitest';

import { loadEngineData } from '../src/engine-data.ts';
import { linkagePlan } from '../src/linkage.ts';
import { packageRoot } from '../src/paths.ts';

const data = loadEngineData(packageRoot);

describe('Torch native CPU runtime linking', () => {
  it('retains static defaults and bounds the shared owner to Linux x64', () => {
    expect(linkagePlan(data, ['torch'], 'linux-x64').modes['torch']).toBe('static');
    expect(linkagePlan(data, ['torch'], 'linux-x64', { torch: 'shared' }).errors).toEqual([]);
    expect(linkagePlan(data, ['torch'], 'linux-arm64', { torch: 'shared' }).errors).toHaveLength(1);
  });

  it('inventories the complete installed native shared CPU SDK', () => {
    expect(
      data.recipes.get('torch')!.linkage!.modes.shared!.runtime!.map((entry) => entry.value),
    ).toEqual([
      'lib/libtorch.so*',
      'lib/libtorch_cpu.so*',
      'lib/libc10.so*',
      'lib/libtorch_global_deps.so*',
    ]);
  });
});
