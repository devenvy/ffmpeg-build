import { describe, expect, it } from 'vitest';

import { loadEngineData } from '../src/engine-data.ts';
import { linkagePlan } from '../src/linkage.ts';
import { packageRoot } from '../src/paths.ts';

const data = loadEngineData(packageRoot);
const LIBRARIES = ['freetype', 'libpng', 'fribidi', 'harfbuzz', 'fontconfig', 'libass', 'libexpat'];

describe('font-rendering library linking choices', () => {
  it.each(LIBRARIES)('%s keeps static defaults and offers a bounded shared mode', (name) => {
    expect(linkagePlan(data, [name], 'linux-x64')).toEqual({
      modes: { [name]: 'static' },
      errors: [],
    });
    expect(linkagePlan(data, [name], 'linux-x64', { [name]: 'shared' })).toEqual({
      modes: { [name]: 'shared' },
      errors: [],
    });
    expect(data.recipes.get(name)!.linkage!.modes.shared!.runtime!.length).toBeGreaterThan(0);
    expect(
      linkagePlan(data, [name], 'win-x64', { [name]: 'shared' }).errors.length,
    ).toBeGreaterThan(0);
  });

  it('preserves independent dependency choices', () => {
    const modes = { libass: 'shared', harfbuzz: 'static', freetype: 'static' } as const;
    expect(linkagePlan(data, Object.keys(modes), 'linux-x64', modes)).toEqual({
      modes,
      errors: [],
    });
  });
});
