import { describe, expect, it } from 'vitest';

import { loadEngineData } from '../src/engine-data.ts';
import { linkagePlan } from '../src/linkage.ts';
import { packageRoot } from '../src/paths.ts';

const data = loadEngineData(packageRoot);
const libraries = ['libdrm', 'libva', 'libvpl'];

describe('hardware dispatcher library linking choices', () => {
  it('keeps static defaults and permits independently vetted Linux x64 shared selections', () => {
    for (const library of libraries) {
      expect(linkagePlan(data, libraries, 'linux-x64').modes[library]).toBe('static');
      const selected = linkagePlan(data, libraries, 'linux-x64', { [library]: 'shared' });
      expect(selected.errors).toEqual([]);
      expect(selected.modes[library]).toBe('shared');
      expect(
        linkagePlan(data, libraries, 'linux-musl-x64', { [library]: 'shared' }).errors,
      ).toHaveLength(1);
    }
  });
});
