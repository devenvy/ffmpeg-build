import { describe, expect, it } from 'vitest';

import { loadEngineData } from '../src/engine-data.ts';
import { linkagePlan } from '../src/linkage.ts';
import { packageRoot } from '../src/paths.ts';

const data = loadEngineData(packageRoot);

describe('VMAF and AVS runtime linking choices', () => {
  it('keeps static defaults and permits vetted Linux x64 shared implementations', () => {
    for (const library of ['libvmaf', 'xavs']) {
      expect(linkagePlan(data, [library], 'linux-x64').modes[library]).toBe('static');
      const selected = linkagePlan(data, [library], 'linux-x64', { [library]: 'shared' });
      expect(selected.errors).toEqual([]);
      expect(selected.modes[library]).toBe('shared');
      expect(
        linkagePlan(data, [library], 'linux-musl-x64', { [library]: 'shared' }).errors,
      ).toHaveLength(1);
    }
  });
});
