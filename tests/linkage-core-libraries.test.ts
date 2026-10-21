import { describe, expect, it } from 'vitest';

import { loadEngineData } from '../src/engine-data.ts';
import { linkagePlan } from '../src/linkage.ts';
import { packageRoot } from '../src/paths.ts';

const data = loadEngineData(packageRoot);
const LIBRARIES = ['zlib', 'xz', 'aom', 'dav1d', 'soxr', 'libbs2b'];

describe('core library linking choices', () => {
  it.each(LIBRARIES)(
    '%s defaults to static and offers verified Linux x64 shared builds',
    (name) => {
      expect(linkagePlan(data, [name], 'linux-x64')).toEqual({
        modes: { [name]: 'static' },
        errors: [],
      });
      expect(linkagePlan(data, [name], 'linux-x64', { [name]: 'shared' })).toEqual({
        modes: { [name]: 'shared' },
        errors: [],
      });
      expect(data.recipes.get(name)!.linkage!.modes.shared!.runtime!.length).toBeGreaterThan(0);
    },
  );

  it.each(LIBRARIES)(
    '%s refuses unverified shared platforms while retaining their static default',
    (name) => {
      expect(linkagePlan(data, [name], 'win-x64').modes[name]).toBe('static');
      expect(linkagePlan(data, [name], 'win-x64', { [name]: 'shared' }).errors).toEqual([
        `link: ${name} does not support shared linking on win-x64`,
      ]);
    },
  );
});
