import { describe, expect, it } from 'vitest';

import { loadEngineData } from '../src/engine-data.ts';
import { linkagePlan } from '../src/linkage.ts';
import { packageRoot } from '../src/paths.ts';

const data = loadEngineData(packageRoot);

describe('additional codec linking choices', () => {
  it.each(['codec2', 'kvazaar', 'xavs2', 'davs2'])(
    '%s defaults to static and allows verified Linux x64 shared',
    (name) => {
      expect(linkagePlan(data, [name], 'linux-x64')).toEqual({
        modes: { [name]: 'static' },
        errors: [],
      });
      expect(linkagePlan(data, [name], 'linux-x64', { [name]: 'shared' })).toEqual({
        modes: { [name]: 'shared' },
        errors: [],
      });
      expect(linkagePlan(data, [name], 'linux-arm64', { [name]: 'shared' }).errors).toHaveLength(1);
    },
  );
});
