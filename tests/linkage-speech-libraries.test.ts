import { expect, it } from 'vitest';

import { loadEngineData } from '../src/engine-data.ts';
import { linkagePlan } from '../src/linkage.ts';
import { packageRoot } from '../src/paths.ts';

const data = loadEngineData(packageRoot);
const LIBRARIES = ['libtheora', 'opencore-amr', 'vo-amrwbenc', 'libilbc'];

it.each(LIBRARIES)(
  '%s retains static defaults and limits shared builds to verified platforms',
  (name) => {
    expect(linkagePlan(data, [name], 'linux-x64')).toEqual({
      modes: { [name]: 'static' },
      errors: [],
    });
    expect(linkagePlan(data, [name], 'linux-x64', { [name]: 'shared' })).toEqual({
      modes: { [name]: 'shared' },
      errors: [],
    });
    expect(linkagePlan(data, [name], 'win-x64').modes[name]).toBe('static');
    expect(linkagePlan(data, [name], 'win-x64', { [name]: 'shared' }).errors).toEqual([
      `link: ${name} does not support shared linking on win-x64`,
    ]);
  },
);
