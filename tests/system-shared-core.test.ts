import { describe, expect, it } from 'vitest';

import { loadEngineData } from '../src/engine-data.ts';
import { linkagePlan } from '../src/linkage.ts';
import { packageRoot } from '../src/paths.ts';

const data = loadEngineData(packageRoot);

describe('system providers for core C libraries', () => {
  it.each(['zlib', 'xz', 'libogg', 'libvorbis', 'opus', 'speex', 'libexpat'])(
    '%s keeps its static default and permits explicit Linux x64 system shared',
    (name) => {
      expect(linkagePlan(data, [name], 'linux-x64').modes[name]).toBe('static');
      expect(linkagePlan(data, [name], 'linux-x64', { [name]: 'system-shared' })).toEqual({
        modes: { [name]: 'system-shared' },
        errors: [],
      });
      expect(
        linkagePlan(data, [name], 'linux-arm64', { [name]: 'system-shared' }).errors,
      ).toHaveLength(1);
    },
  );
});
