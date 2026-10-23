import { describe, expect, it } from 'vitest';

import { loadEngineData } from '../src/engine-data.ts';
import { linkagePlan } from '../src/linkage.ts';
import { packageRoot } from '../src/paths.ts';

const data = loadEngineData(packageRoot);
const LIBRARIES = ['bzip2', 'libxml2'];

describe('compression and XML linking choices', () => {
  it.each(LIBRARIES)('%s keeps static defaults and supports vetted shared Linux x64', (name) => {
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
  it.each(LIBRARIES)('%s rejects shared mode on unverified ARM64', (name) => {
    expect(linkagePlan(data, [name], 'linux-arm64').modes[name]).toBe('static');
    expect(linkagePlan(data, [name], 'linux-arm64', { [name]: 'shared' }).errors).toHaveLength(1);
  });
});
