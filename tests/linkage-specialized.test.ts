import { describe, expect, it } from 'vitest';

import { loadEngineData } from '../src/engine-data.ts';
import { linkagePlan } from '../src/linkage.ts';
import { packageRoot } from '../src/paths.ts';

const data = loadEngineData(packageRoot);

describe('AAC, professional video and QR linking choices', () => {
  it.each(['fdk-aac', 'oapv', 'svt-jpegxs', 'quirc'])(
    '%s defaults to static and permits explicit Linux x64 bundled shared',
    (name) => {
      expect(linkagePlan(data, [name], 'linux-x64').modes[name]).toBe('static');
      expect(linkagePlan(data, [name], 'linux-x64', { [name]: 'shared' })).toEqual({
        modes: { [name]: 'shared' },
        errors: [],
      });
      expect(linkagePlan(data, [name], 'linux-arm64', { [name]: 'shared' }).errors).toHaveLength(1);
    },
  );
});
