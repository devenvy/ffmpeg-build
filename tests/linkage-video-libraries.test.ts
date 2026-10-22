import { describe, expect, it } from 'vitest';

import { loadEngineData } from '../src/engine-data.ts';
import { linkagePlan } from '../src/linkage.ts';
import { packageRoot } from '../src/paths.ts';

const data = loadEngineData(packageRoot);
const LIBRARIES = ['x264', 'openh264', 'xvidcore', 'x265', 'vvenc', 'svtav1'];

describe('video codec library linking choices', () => {
  it.each(LIBRARIES)('%s defaults to static and allows Linux x64 shared mode', (name) => {
    expect(linkagePlan(data, [name], 'linux-x64')).toEqual({
      modes: { [name]: 'static' },
      errors: [],
    });
    expect(linkagePlan(data, [name], 'linux-x64', { [name]: 'shared' })).toEqual({
      modes: { [name]: 'shared' },
      errors: [],
    });
    expect(data.recipes.get(name)!.linkage!.modes.shared!.runtime!.length).toBeGreaterThan(0);
  });

  it.each(LIBRARIES)('%s rejects shared platforms without a full build proof', (name) => {
    expect(linkagePlan(data, [name], 'win-x64', { [name]: 'shared' }).errors).toEqual([
      `link: ${name} does not support shared linking on win-x64`,
    ]);
  });
});
