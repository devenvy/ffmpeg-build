import { describe, expect, it } from 'vitest';

import { loadEngineData } from '../src/engine-data.ts';
import { linkagePlan } from '../src/linkage.ts';
import { packageRoot } from '../src/paths.ts';

const data = loadEngineData(packageRoot);

describe('AVS3 decoder linking choice', () => {
  it('keeps static defaults and permits Linux x64 bundled shared builds', () => {
    expect(linkagePlan(data, ['uavs3d'], 'linux-x64').modes['uavs3d']).toBe('static');
    expect(linkagePlan(data, ['uavs3d'], 'linux-x64', { uavs3d: 'shared' })).toEqual({
      modes: { uavs3d: 'shared' },
      errors: [],
    });
    expect(linkagePlan(data, ['uavs3d'], 'linux-arm64', { uavs3d: 'shared' }).errors).toHaveLength(
      1,
    );
  });
});
