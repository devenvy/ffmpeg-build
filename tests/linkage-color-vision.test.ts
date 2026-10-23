import { describe, expect, it } from 'vitest';

import { loadEngineData } from '../src/engine-data.ts';
import { linkagePlan } from '../src/linkage.ts';
import { packageRoot } from '../src/paths.ts';

const data = loadEngineData(packageRoot);
const libraries = [
  'opencolorio',
  'opencv',
  'yaml-cpp',
  'pystring',
  'imath',
  'minizip-ng',
  'libexpat',
  'zlib',
];

describe('Color and vision native SDK linking', () => {
  it('keeps static defaults and allows independent shared root/dependency selections', () => {
    const defaults = linkagePlan(data, libraries, 'linux-x64');
    expect(defaults.modes['opencolorio']).toBe('static');
    expect(defaults.modes['opencv']).toBe('static');
    for (const dependency of ['static', 'shared'] as const) {
      const selected = linkagePlan(data, libraries, 'linux-x64', {
        opencolorio: 'shared',
        opencv: 'shared',
        'yaml-cpp': dependency,
        pystring: dependency,
        imath: dependency,
        'minizip-ng': dependency,
        libexpat: dependency,
        zlib: dependency,
      });
      expect(selected.errors).toEqual([]);
      expect(selected.modes['opencolorio']).toBe('shared');
      expect(selected.modes['opencv']).toBe('shared');
    }
  });

  it('limits new modes to Linux x64 and inventories both OpenCV modules', () => {
    for (const name of ['opencolorio', 'opencv']) {
      expect(linkagePlan(data, libraries, 'linux-arm64', { [name]: 'shared' }).errors).toHaveLength(
        1,
      );
    }
    expect(
      data.recipes.get('opencv')!.linkage!.modes.shared!.runtime!.map((entry) => entry.value),
    ).toEqual(['lib/libopencv_core.so*', 'lib/libopencv_imgproc.so*']);
  });
});
